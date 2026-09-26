# pistachio-demo

A playground for [pistachio](https://github.com/winebarrel/pistachio) on
Cloudflare Workers. Visitors edit two schema files and see the DDL
`pista diff` prints for them. No database is involved.

pistachio parses SQL with pg_query_go, which calls libpg_query through cgo, so
it does not run inside a Worker. The Worker serves the page and forwards
`/api/*` to a [Cloudflare Container](https://developers.cloudflare.com/containers/)
that runs `pista`:

- `public/` holds the page and the sample schemas it starts with. The editors
  use CodeMirror, loaded from jsDelivr.
- `src/index.ts` is the Worker. It sends each `/api/*` request to one of a few
  container instances; `pista diff` keeps no state, so any instance can serve
  any request.
- `server/` is the HTTP server inside the container. `POST /api/diff` writes
  the two schemas to a temporary directory and runs `pista diff` on them.
- `Dockerfile` puts the pista release binaries and the server into one image.
  `PISTA_VERSIONS` names the releases, newest first; each is installed as
  `pista-<version>`.
  The runtime image is distroless (no shell or package manager), every file
  it adds is read-only, and the server runs as an unprivileged user that can
  write only the temporary directories.

## Requirements

- A Cloudflare account on the Workers Paid plan (Containers need it)
- Docker, for wrangler to build the container image
- Node.js

## Run locally

```sh
npm install
npm run dev
```

The first request waits for the container to start.

## Checks

```sh
npm run lint       # Biome
npm run typecheck  # tsc
npm run build      # bundle the Worker and build the container image, without deploying
```

The Go server is checked with golangci-lint, using `.golangci.yml` at the
root. CI runs all of these on each pull request.

## Deploy

CI deploys `main` once the checks pass. It reads these from the repository
settings:

- `CLOUDFLARE_ACCOUNT_ID` (variable): the account to deploy to
- `CLOUDFLARE_API_TOKEN` (secret): an API token that can edit Workers scripts
  and Containers on that account

To deploy from your machine instead, run `npx wrangler login`, then:

```sh
npm run deploy
```

## Share links

The Share button saves both schemas and the options to Workers KV and copies
a link of the form `/p/<id>`. The ID is the start of the SHA-256 of what was
saved, so the same input always gets the same link. A share is kept with no
expiry and can be up to 128 KiB.

The KV namespace is the `SHARES` binding in `wrangler.jsonc`. It has no `id`,
so wrangler creates the namespace on the first deploy. For that, the API token
also needs Workers KV Storage: Edit.

## AI examples and fixes

The "Try an AI example" button next to the title asks Workers AI
(`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) for a small current schema and a
desired one that differs by one change, fills the editors with them and runs
the diff. The Worker picks the subject and the change at random from lists in
`src/index.ts`, so examples vary. What the model writes can be invalid SQL;
pista then says so in the output.

When pista reports an error, a "Fix with AI" button appears by the output. It
sends both files and the error to the same model, which returns the file the
error is about with the fix. The page puts that file in its editor and runs
the diff again. The request may be up to 24 KiB.

Each client address gets 5 AI calls a minute, examples and fixes together,
through the `AI_LIMIT` rate limit binding, and all clients together get 1000 a
day (UTC), counted in the `USAGE` KV namespace. The daily cap bounds what
Workers AI costs. KV is not atomic, so requests at the same moment can go
slightly over it.

## Star count

The GitHub link in the header shows the star count of winebarrel/pistachio.
The Worker reads it from the GitHub API at `GET /api/stars` and caches it for
an hour. When the count cannot be read, the link shows without it.

Without a token, GitHub allows 60 requests an hour per IP address, and
Workers share their outgoing addresses, so the count may often be missing.
Set a token as a Worker secret to avoid that. A fine-grained personal access
token with no permissions is enough, since it only reads a public repository:

```sh
npx wrangler secret put GITHUB_TOKEN
```

The secret stays across deploys, so this is needed once.

## Updating pista

The playground offers the newest three pistachio releases. The page picks
one from the Options box; the newest is the default, and an option that a
release does not have is greyed out.

The `Update pista` workflow checks the pistachio releases every day. When the
newest three differ from `PISTA_VERSIONS` in `Dockerfile`, it opens a pull
request that replaces the list. It can also be run by hand from the Actions
tab. It needs **Allow GitHub Actions to create and approve pull requests**
under Settings > Actions > General.

The workflow uses `GITHUB_TOKEN`, and a pull request opened with it does not
trigger CI. The workflow therefore starts CI on the new branch itself, with
`workflow_dispatch`.

## API

`POST /api/diff` takes

```json
{
  "version": "1.66.0",
  "current": "CREATE TABLE ...",
  "desired": "CREATE TABLE ...",
  "allow_drop": ["column"],
  "manage_routine": true,
  "bulk_alter": false,
  "explain": false
}
```

and returns `{"output": "..."}`, or `{"error": "..."}` when pista fails.
Without `version` it runs the newest release; a version the image does not
have is answered with 400.

`GET /api/versions` returns the releases in the image, newest first, each
with the `pista diff` options it has:
`{"versions": [{"version": "1.66.0", "options": ["manage-routine", ...]}]}`.

`POST /api/fmt` takes `{"version": "...", "current": "...", "desired": "..."}`,
formats both with `pista fmt`, and returns them in the same shape. When either
fails to parse it returns only `{"error": "..."}`, naming the file.
