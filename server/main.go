// Command server is the HTTP front of the demo container. It takes two schema
// files in a JSON request and runs pista on them: `pista diff` for the DDL
// that takes one to the other, and `pista fmt` to format both. No database is
// involved.
//
// The image holds several pista releases, named in PISTA_VERSIONS newest
// first and installed as pista-<version> in PISTA_BIN_DIR. A request picks
// one by version; without one it gets the newest.
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
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	maxBodyBytes = 512 << 10
	runTimeout   = 10 * time.Second
)

// The two schemas are written under these names, which are also the names
// pista uses in its messages.
const (
	currentFile = "current.sql"
	desiredFile = "desired.sql"
)

type diffRequest struct {
	Version       string   `json:"version"`
	Current       string   `json:"current"`
	Desired       string   `json:"desired"`
	AllowDrop     []string `json:"allow_drop"`
	ManageRoutine bool     `json:"manage_routine"`
	BulkAlter     bool     `json:"bulk_alter"`
	Explain       bool     `json:"explain"`
}

type diffResponse struct {
	Output string `json:"output,omitempty"`
	Error  string `json:"error,omitempty"`
}

type fmtRequest struct {
	Version string `json:"version"`
	Current string `json:"current"`
	Desired string `json:"desired"`
}

// A failed format carries only Error, so the page can tell it apart from two
// schemas that format to empty text.
type fmtResponse struct {
	Current *string `json:"current,omitempty"`
	Desired *string `json:"desired,omitempty"`
	Error   string  `json:"error,omitempty"`
}

// diffOptions are the `pista diff` flags the page offers. A release that is
// older than a flag does not list it in its help.
var diffOptions = []string{"manage-routine", "bulk-alter", "explain", "allow-drop"}

type release struct {
	Version string   `json:"version"`
	Options []string `json:"options"`
}

// releases are the pista binaries in the image, newest first.
type releases struct {
	dir      string
	versions []string
	options  func() ([]release, error)
}

func newReleases(dir string, versions []string) *releases {
	r := &releases{dir: dir, versions: versions}
	// Which options each release has cannot change while the server runs, so
	// it is read from their help once.
	r.options = sync.OnceValues(func() ([]release, error) {
		var list []release
		for _, v := range r.versions {
			help, err := runPista(context.Background(), r.bin(v), "", "diff", "--help")
			if err != nil {
				return nil, err
			}
			rel := release{Version: v, Options: []string{}}
			for _, opt := range diffOptions {
				if strings.Contains(help, "--"+opt) {
					rel.Options = append(rel.Options, opt)
				}
			}
			list = append(list, rel)
		}
		return list, nil
	})
	return r
}

func (r *releases) bin(version string) string {
	return filepath.Join(r.dir, "pista-"+version)
}

// resolve returns the binary for version, the newest when version is empty.
func (r *releases) resolve(version string) (string, error) {
	if version == "" {
		return r.bin(r.versions[0]), nil
	}
	if slices.Contains(r.versions, version) {
		return r.bin(version), nil
	}
	return "", errors.New("pista " + version + " is not available here; choose one of " + strings.Join(r.versions, ", "))
}

func main() {
	versions := strings.Fields(os.Getenv("PISTA_VERSIONS"))
	if len(versions) == 0 {
		log.Fatal("PISTA_VERSIONS names no pista release")
	}
	dir := os.Getenv("PISTA_BIN_DIR")
	if dir == "" {
		dir = "/usr/local/bin"
	}
	rels := newReleases(dir, versions)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("ok\n")) //nolint:errcheck
	})
	mux.HandleFunc("GET /api/versions", func(w http.ResponseWriter, _ *http.Request) {
		list, err := rels.options()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"versions": list})
	})
	mux.HandleFunc("POST /api/diff", func(w http.ResponseWriter, r *http.Request) {
		var req diffRequest
		if !decode(w, r, &req) {
			return
		}
		pista, err := rels.resolve(req.Version)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, diffResponse{Error: err.Error()})
			return
		}

		out, err := runDiff(r.Context(), pista, &req)
		if err != nil {
			writeJSON(w, http.StatusOK, diffResponse{Error: err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, diffResponse{Output: out})
	})
	mux.HandleFunc("POST /api/fmt", func(w http.ResponseWriter, r *http.Request) {
		var req fmtRequest
		if !decode(w, r, &req) {
			return
		}
		pista, err := rels.resolve(req.Version)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, fmtResponse{Error: err.Error()})
			return
		}

		res, err := runFmt(r.Context(), pista, &req)
		if err != nil {
			writeJSON(w, http.StatusOK, fmtResponse{Error: err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, res)
	})

	addr := ":8080"
	log.Printf("listening on %s with pista %s", addr, strings.Join(versions, ", "))
	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	log.Fatal(srv.ListenAndServe())
}

// decode reads the JSON request body into v. On failure it answers 400 and
// returns false.
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeJSON(w, http.StatusBadRequest, diffResponse{Error: "invalid request: " + err.Error()})
		return false
	}
	return true
}

// withSchemas writes the two schemas to a fresh temporary directory, calls fn
// with it, and removes it afterwards.
func withSchemas(current, desired string, fn func(dir string) error) error {
	dir, err := os.MkdirTemp("", "pista-demo-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir) //nolint:errcheck

	if err := os.WriteFile(filepath.Join(dir, currentFile), []byte(current), 0o600); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, desiredFile), []byte(desired), 0o600); err != nil {
		return err
	}
	return fn(dir)
}

// runPista runs pista in dir and returns its stdout. On failure the error
// carries pista's stderr. The files are passed by name relative to dir, so
// messages name them as the page does.
func runPista(ctx context.Context, pista, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, runTimeout)
	defer cancel()

	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, pista, args...)
	// Every release is installed as pista-<version>; its messages still name
	// the command pista.
	cmd.Args[0] = "pista"
	cmd.Dir = dir
	// Start from an empty environment so no PISTA_* variable changes the run.
	cmd.Env = []string{}
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", errors.New("pista " + args[0] + " timed out")
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", errors.New(msg)
	}

	return stdout.String(), nil
}

func runDiff(ctx context.Context, pista string, req *diffRequest) (string, error) {
	var out string
	err := withSchemas(req.Current, req.Desired, func(dir string) error {
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
		if req.Explain {
			args = append(args, "--explain")
		}
		args = append(args, "--", currentFile, desiredFile)

		var err error
		out, err = runPista(ctx, pista, dir, args...)
		return err
	})
	return out, err
}

// runFmt formats both schemas in place with `pista fmt` and reads them back.
// When either fails to parse, neither is returned, so the page keeps both as
// they were.
func runFmt(ctx context.Context, pista string, req *fmtRequest) (*fmtResponse, error) {
	var res fmtResponse
	err := withSchemas(req.Current, req.Desired, func(dir string) error {
		if _, err := runPista(ctx, pista, dir, "fmt", "--", currentFile, desiredFile); err != nil {
			// pista names each file that failed with its error, then adds a
			// summary line that says nothing more.
			var lines []string
			for line := range strings.SplitSeq(err.Error(), "\n") {
				if !strings.HasPrefix(line, "pista: error: failed to format") {
					lines = append(lines, line)
				}
			}
			return errors.New(strings.Join(lines, "\n"))
		}

		current, err := os.ReadFile(filepath.Join(dir, currentFile))
		if err != nil {
			return err
		}
		desired, err := os.ReadFile(filepath.Join(dir, desiredFile))
		if err != nil {
			return err
		}
		c, d := string(current), string(desired)
		res.Current, res.Desired = &c, &d
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &res, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}
