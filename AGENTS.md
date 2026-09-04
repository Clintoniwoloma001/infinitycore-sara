# Base44 Dev Environment — InfinityCore

## Stack
Vite 5 + React 18 + Tailwind 3, backed by Supabase (auth + Postgres + RLS).
No backend process — the app is a pure SPA that talks to a hosted Supabase project.

## Running
```
docker compose -f docker-compose.base44.yml up -d
```
- Web entry point: host port 3000 → container 5173 (Vite dev server).
- Source is bind-mounted; edits hot-reload without rebuilds.
- `npm install` runs on every container start (deps live in a named volume).

## Secrets (required at boot)
- `VITE_SUPABASE_URL` — hosted Supabase project URL
- `VITE_SUPABASE_ANON_KEY` — Supabase anon/public key

Both are delivered via `/run/base44/app.env` (platform-managed, outside the repo).
`.env.base44-defaults` holds placeholders so the container starts before real
credentials arrive; the platform file overrides them (listed last in `env_file:`).

## Vite config notes
- `base` is `/infinitycore-sara/` in production (GitHub Pages) but `/` in dev/preview
  so the preview root URL serves the app correctly.
- `server.host: true` + `allowedHosts: true` so the preview's external hostname works.

## Verification
- `curl -sf http://localhost:3000/` returns the Vite-served HTML with `/src/main.jsx`.
- `curl -sf -H "Host: external-preview.example.com" http://localhost:3000/` must also
  return the app (confirms the preview proxy hostname is accepted).
- Without valid Supabase credentials the app shows a config/auth error screen.
