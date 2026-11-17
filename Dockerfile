# syntax=docker/dockerfile:1

FROM --platform=linux/amd64 debian:bookworm-slim AS frontend-builder

ARG FLUTTER_VERSION=3.44.6

ENV CI=true \
    PATH="/opt/flutter/bin:/opt/flutter/bin/cache/dart-sdk/bin:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    unzip \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_${FLUTTER_VERSION}-stable.tar.xz" -o /tmp/flutter.tar.xz \
  && tar -xJf /tmp/flutter.tar.xz -C /opt \
  && rm -f /tmp/flutter.tar.xz \
  && git config --global --add safe.directory /opt/flutter \
  && flutter --disable-analytics --suppress-analytics config --enable-web \
  && flutter --suppress-analytics precache --web

WORKDIR /src/frontend
COPY frontend/pubspec.yaml frontend/pubspec.lock ./
RUN flutter --suppress-analytics pub get

COPY frontend/ ./
RUN flutter --suppress-analytics build web --release

FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS backend-builder

ARG TARGETOS
ARG TARGETARCH

WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download

COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
    go build -trimpath -ldflags="-s -w" -o /out/llmstudio ./cmd/server

FROM alpine:3.21

LABEL org.opencontainers.image.title="LLMStudio" \
      org.opencontainers.image.description="Personal AI Chat workbench with pluggable Go gateway and Flutter Web UI" \
      org.opencontainers.image.source="https://github.com/Evan-1777/LLMStudio"

RUN apk add --no-cache ca-certificates tzdata \
  && addgroup -g 10001 -S llmstudio \
  && adduser -u 10001 -S -G llmstudio -H -h /app llmstudio \
  && mkdir -p /app/web /data \
  && chown -R llmstudio:llmstudio /app /data

COPY --from=backend-builder /out/llmstudio /usr/local/bin/llmstudio
COPY --from=frontend-builder --chown=llmstudio:llmstudio /src/frontend/build/web /app/web

ENV LLMSTUDIO_PORT=8080 \
    LLMSTUDIO_DB_PATH=/data/llmstudio.db \
    LLMSTUDIO_STATIC_DIR=/app/web

WORKDIR /app
USER llmstudio

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]

ENTRYPOINT ["/usr/local/bin/llmstudio"]
