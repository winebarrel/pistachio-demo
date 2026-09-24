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

```sh
npm run deploy
```

## API

`POST /api/diff` takes

```json
{
  "current": "CREATE TABLE ...",
  "desired": "CREATE TABLE ...",
  "allow_drop": ["column"],
  "manage_routine": true,
  "bulk_alter": false
}
```

and returns `{"output": "..."}`, or `{"error": "..."}` when pista fails.
