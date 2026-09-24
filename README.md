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
- `Dockerfile` puts the pista release binary and the server into one image.
  `PISTA_VERSION` picks the release.

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

The `Update pista` workflow checks the pistachio releases every day. When a
release is newer than `PISTA_VERSION` in `Dockerfile`, it opens a pull request
that bumps it. It can also be run by hand from the Actions tab.

The workflow uses `GITHUB_TOKEN`, and a pull request opened with it does not
trigger CI. The workflow therefore starts CI on the new branch itself, with
`workflow_dispatch`.

## API

`POST /api/diff` takes

```json
{
  "current": "CREATE TABLE ...",
  "desired": "CREATE TABLE ...",
  "allow_drop": ["column"],
  "manage_routine": true,
  "bulk_alter": false,
  "explain": false
}
```

and returns `{"output": "..."}`, or `{"error": "..."}` when pista fails.

`POST /api/fmt` takes `{"current": "...", "desired": "..."}`, formats both with
`pista fmt`, and returns them in the same shape. When either fails to parse it
returns only `{"error": "..."}`, naming the file.
