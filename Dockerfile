# syntax=docker/dockerfile:1
#
# Container image for the playground: pista release binaries plus a small
# HTTP server that runs `pista diff` and `pista fmt` on the two schemas a
# request sends.

# The pista releases the playground offers, newest first. The first is the
# default. The Update pista workflow rewrites this line.
ARG PISTA_VERSIONS="1.67.1 1.67.0 1.66.1"

FROM golang:1.27 AS build
WORKDIR /src
COPY server/ /src/
RUN CGO_ENABLED=0 go build -o /out/server .

# Each release is checked against its checksums.txt and installed as
# pista-<version>.
FROM golang:1.27 AS pista
ARG PISTA_VERSIONS
ARG TARGETARCH=amd64
RUN set -eu; \
    mkdir /out; \
    for v in $PISTA_VERSIONS; do \
      dir=$(mktemp -d); cd "$dir"; \
      url=https://github.com/winebarrel/pistachio/releases/download/v$v; \
      tarball=pistachio_${v}_linux_${TARGETARCH}.tar.gz; \
      curl -fsSLO "$url/$tarball"; \
      curl -fsSLO "$url/checksums.txt"; \
      sha256sum --check --ignore-missing checksums.txt; \
      tar xzf "$tarball" pista; \
      mv pista "/out/pista-$v"; \
    done

# The runtime image is as close to read-only as Cloudflare Containers allows;
# it has no setting for a read-only root filesystem.
# - distroless: glibc, which the release binaries link against, and little
#   else. No shell, no package manager, no coreutils.
# - Every file added is owned by root and mode 0555, so the user the server
#   runs as can read and run them but not change them.
# - That user is nonroot (65532). It can write only /tmp, where the server
#   puts each request's schemas and removes them after, and its own home.
FROM gcr.io/distroless/base-debian13:nonroot
ARG PISTA_VERSIONS
ENV PISTA_VERSIONS=${PISTA_VERSIONS}
COPY --from=pista --chown=0:0 --chmod=0555 /out/ /usr/local/bin/
COPY --from=build --chown=0:0 --chmod=0555 /out/server /usr/local/bin/server
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/server"]
