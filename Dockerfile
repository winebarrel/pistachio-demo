# syntax=docker/dockerfile:1
#
# Container image for the playground: the pista release binary plus a small
# HTTP server that runs `pista diff` on the two schemas a request sends.
#
FROM golang:1.27 AS build
WORKDIR /src
COPY server/ /src/
RUN CGO_ENABLED=0 go build -o /out/server .

FROM debian:trixie-slim AS pista
ARG PISTA_VERSION=1.66.0
ARG TARGETARCH=amd64
ADD https://github.com/winebarrel/pistachio/releases/download/v${PISTA_VERSION}/pistachio_${PISTA_VERSION}_linux_${TARGETARCH}.tar.gz \
    https://github.com/winebarrel/pistachio/releases/download/v${PISTA_VERSION}/checksums.txt \
    /tmp/
RUN cd /tmp && \
    sha256sum --check --ignore-missing checksums.txt && \
    tar xzf pistachio_${PISTA_VERSION}_linux_${TARGETARCH}.tar.gz pista && \
    mv pista /usr/local/bin/pista

# The release binary links against glibc, so the runtime image is Debian.
FROM debian:trixie-slim
COPY --from=pista /usr/local/bin/pista /usr/local/bin/pista
COPY --from=build /out/server /usr/local/bin/server
USER nobody
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/server"]
