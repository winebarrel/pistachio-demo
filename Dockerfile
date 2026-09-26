# syntax=docker/dockerfile:1
#
# Container image for the playground: pista release binaries plus a small
# HTTP server that runs `pista diff` and `pista fmt` on the two schemas a
# request sends.

# The pista releases the playground offers, newest first. The first is the
# default. The Update pista workflow rewrites this line.
ARG PISTA_VERSIONS="1.66.0 1.65.0 1.64.0"

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

# The release binaries link against glibc, so the runtime image is Debian.
FROM debian:trixie-slim
ARG PISTA_VERSIONS
ENV PISTA_VERSIONS=${PISTA_VERSIONS}
COPY --from=pista /out/ /usr/local/bin/
COPY --from=build /out/server /usr/local/bin/server
USER nobody
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/server"]
