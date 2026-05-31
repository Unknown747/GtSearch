# GH Dork

GitHub code search tool for finding exposed blockchain/crypto credentials (private keys, mnemonics, API keys).

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — build + start server (port 8080)
- `pnpm --filter @workspace/api-server run build` — build only (esbuild → dist/)
- `pnpm run typecheck` — typecheck all packages

## Stack

- Node.js 24, TypeScript 5.9, pnpm workspaces
- Backend: Express 5 (serves API + static frontend)
- Frontend: Single `index.html` — vanilla JS, no build step, no framework
- Logging: pino + pino-http

## Where things live

```
artifacts/api-server/
  src/
    app.ts           — Express setup, static file serving
    index.ts         — Server entry point (reads PORT env)
    routes/
      github.ts      — All GitHub API proxy routes
      health.ts      — /api/healthz
    lib/logger.ts    — pino logger
  public/
    index.html       — Complete frontend (single file)
  build.mjs          — esbuild bundler + copies public/ → dist/public/
  dist/              — compiled output (git-ignored)
```

## API Routes

- `GET /api/github/search?q=&page=&per_page=&notify=` — GitHub code search proxy
- `GET /api/github/config` — token/telegram status
- `GET /api/github/rate-limit` — current GitHub rate limit
- `POST /api/github/notify-test` — test Telegram notification
- `GET /api/healthz` — health check

## Required Secrets (Replit Secrets)

- `GITHUB_TOKEN` — primary GitHub PAT, OR
- `TOKEN_1` … `TOKEN_20` — multiple tokens for rotation
- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` — optional Telegram alerts

## Architecture decisions

- Frontend is a single `index.html` served statically by Express — no React, no Vite, no build pipeline for the UI.
- Token rotation: server picks the next token whenever remaining rate-limit drops below 5.
- Severity classification happens server-side (in `github.ts`) and is returned enriched in search results.
- Telegram notifications fire server-side only for CRITICAL/HIGH findings, async (non-blocking).
- History stored in browser `localStorage`, max 50 entries.

## User preferences

_Populate as you build._

## Gotchas

- Express 5 requires `/{*path}` for catch-all routes, not `*`.
- `PORT` must be set before starting (dev script exports it as 8080).
- `public/` folder is copied to `dist/public/` by `build.mjs` — changes to `index.html` require a rebuild.
