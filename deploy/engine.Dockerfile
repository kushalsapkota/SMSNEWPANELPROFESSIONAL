# syntax=docker/dockerfile:1.7
# Engine image: static Go binaries (engine, smsc-sim, smpp-cli) on a minimal non-root runtime.
#   docker build -f deploy/engine.Dockerfile -t smsgw/engine .      (context = repo root)
# The runtime is alpine rather than scratch so the compose healthcheck can use busybox wget
# and operators get a shell for `smpp-cli`. Binaries are fully static (CGO_ENABLED=0) and
# embed the tz database (-tags timetzdata), so the engine does not depend on image packages.

ARG GO_VERSION=1.23.4
ARG ALPINE_VERSION=3.20

FROM golang:${GO_VERSION}-alpine${ALPINE_VERSION} AS build
WORKDIR /src
ENV CGO_ENABLED=0 GOFLAGS=-trimpath
# Dependencies first for layer caching.
COPY engine/go.mod engine/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download && go mod verify
COPY engine/ ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    set -eux; \
    go vet ./cmd/... ; \
    for cmd in engine smsc-sim smpp-cli; do \
      go build -tags timetzdata -ldflags="-s -w -buildid=" -o /out/$cmd ./cmd/$cmd; \
    done

FROM alpine:${ALPINE_VERSION}
RUN apk add --no-cache ca-certificates \
 && addgroup -S -g 10001 smsgw \
 && adduser -S -D -H -u 10001 -G smsgw -s /sbin/nologin smsgw
COPY --from=build /out/engine /out/smsc-sim /out/smpp-cli /usr/local/bin/
USER 10001:10001
# 2775 client SMPP, 8081 internal HTTP (api only), 9100 Prometheus /metrics + /healthz
EXPOSE 2775 8081 9100
ENV LOG_FORMAT=json \
    ENGINE_HTTP_ADDR=:8081 \
    ENGINE_SMPP_ADDR=:2775 \
    ENGINE_METRICS_ADDR=:9100
STOPSIGNAL SIGTERM
# Liveness only. Readiness (DB + Redis) is /internal/v1/health with X-Internal-Token (see compose).
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:9100/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/engine"]
