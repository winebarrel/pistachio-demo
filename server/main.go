// Command server is the HTTP front of the demo container. It takes two schema
// files in a JSON request, runs `pista diff` on them, and returns the output.
// No database is involved.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	maxBodyBytes = 512 << 10
	runTimeout   = 10 * time.Second
)

type diffRequest struct {
	Current       string   `json:"current"`
	Desired       string   `json:"desired"`
	AllowDrop     []string `json:"allow_drop"`
	ManageRoutine bool     `json:"manage_routine"`
	BulkAlter     bool     `json:"bulk_alter"`
}

type diffResponse struct {
	Output string `json:"output,omitempty"`
	Error  string `json:"error,omitempty"`
}

func main() {
	pista := os.Getenv("PISTA_BIN")
	if pista == "" {
		pista = "pista"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("ok\n")) //nolint:errcheck
	})
	mux.HandleFunc("POST /api/diff", func(w http.ResponseWriter, r *http.Request) {
		var req diffRequest
		r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, diffResponse{Error: "invalid request: " + err.Error()})
			return
		}

		out, err := runDiff(r.Context(), pista, &req)
		if err != nil {
			writeJSON(w, http.StatusOK, diffResponse{Error: err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, diffResponse{Output: out})
	})

	addr := ":8080"
	log.Printf("listening on %s", addr)
	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	log.Fatal(srv.ListenAndServe())
}

func runDiff(ctx context.Context, pista string, req *diffRequest) (string, error) {
	dir, err := os.MkdirTemp("", "pista-demo-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir) //nolint:errcheck

	current := filepath.Join(dir, "current.sql")
	desired := filepath.Join(dir, "desired.sql")
	if err := os.WriteFile(current, []byte(req.Current), 0o600); err != nil {
		return "", err
	}
	if err := os.WriteFile(desired, []byte(req.Desired), 0o600); err != nil {
		return "", err
	}

	// Each option goes in one argument with "=", so a value can never be
	// read as a flag of its own. pista validates the values itself.
	args := []string{"diff"}
	if len(req.AllowDrop) > 0 {
		args = append(args, "--allow-drop="+strings.Join(req.AllowDrop, ","))
	}
	if req.ManageRoutine {
		args = append(args, "--manage-routine")
	}
	if req.BulkAlter {
		args = append(args, "--bulk-alter")
	}
	args = append(args, "--", current, desired)

	ctx, cancel := context.WithTimeout(ctx, runTimeout)
	defer cancel()

	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, pista, args...)
	cmd.Dir = dir
	// Start from an empty environment so no PISTA_* variable changes the run.
	cmd.Env = []string{}
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", errors.New("pista diff timed out")
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		// Show the file names the user sees, not the temporary paths.
		msg = strings.ReplaceAll(msg, dir+string(filepath.Separator), "")
		return "", errors.New(msg)
	}

	return stdout.String(), nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}
