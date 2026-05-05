# syntax=docker/dockerfile:1
# Multi-stage build: bundles the TypeScript client with esbuild, then compiles
# the Go server with the bundle baked in via embed.FS, then assembles a
# scratch image with just the CA bundle and the static binary.
ARG GO_VERSION=1.26
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS client
WORKDIR /src/client
COPY client/package.json client/package-lock.json* client/bun.lock* ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --no-audit --no-fund --omit=optional
COPY client ./
ENV OUT_DIR=/out/web
RUN node build.mjs

FROM golang:${GO_VERSION}-bookworm AS server
WORKDIR /src
ENV CGO_ENABLED=0
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download
COPY . .
COPY --from=client /out/web/ ./cmd/wisp/web/
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build -trimpath -ldflags="-s -w" -o /out/wisp ./cmd/wisp

FROM scratch
COPY --from=server /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --chmod=0555 --chown=65532:65532 --from=server /out/wisp /wisp

# Distroless-style UID (no /etc/passwd in scratch; numeric USER is fine).
USER 65532:65532

EXPOSE 8080/tcp

ENTRYPOINT ["/wisp"]
