# syntax=docker/dockerfile:1

FROM --platform=$BUILDPLATFORM node:24-alpine AS frontend-builder

WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

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
      org.opencontainers.image.description="Personal AI Chat workbench with pluggable Go gateway and React Web UI" \
      org.opencontainers.image.source="https://github.com/Evan-1777/LLMStudio"

RUN apk add --no-cache ca-certificates tzdata bash \
  && addgroup -g 10001 -S llmstudio \
  && adduser -u 10001 -S -G llmstudio -H -h /app llmstudio \
  && mkdir -p /app/web /data \
  && chown -R llmstudio:llmstudio /app /data

COPY --from=backend-builder /out/llmstudio /usr/local/bin/llmstudio
COPY --from=frontend-builder --chown=llmstudio:llmstudio /src/frontend/dist /app/web

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
