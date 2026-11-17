# LLMStudio Web

React 19 + TypeScript + Vite web client for LLMStudio, served behind the Go gateway in production.

## Prerequisites

- Node.js 24 (`>=24.0.0 <25.0.0`)
- npm 11 (`>=11.0.0 <12.0.0`)

## Development

Start the Go gateway first (`cd ../backend && LLMSTUDIO_DEV_MODE=true go run ./cmd/server`), then start the Vite dev server (proxies `/api` and `/healthz` to `VITE_GATEWAY_TARGET`, default `http://127.0.0.1:8080`):

```bash
npm ci
npm run dev
```

## Checks & Production Build

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Production build outputs static assets to `dist/`, which the Go gateway serves when `LLMSTUDIO_STATIC_DIR` points to that directory (e.g. `/app/web` in Docker).
