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

## Phase 10 — User Approval & Workforce Operations
- SQL migration: `schema_phase10_user_workforce.sql` — run in Supabase SQL Editor.
  Adds: `profiles.status`/`department`/`approved_by`/`approved_at` columns,
  `user_access_profiles`, `user_approval_audit`, `kpi_definitions`, `kpi_assignments`,
  `kpi_submissions`, `work_plans`, `task_progress_reports`, `attendance_exceptions`,
  `attendance_issues`, `attendance_config` tables, plus SECURITY DEFINER RPCs
  (`approve_user`, `reject_user`, `suspend_user`, `activate_user`, `update_user_access`).
  All idempotent — safe to re-run.
- New pages: `WorkManagement.jsx` (HR work center), redesigned `Users.jsx` (approval
  workflow with wizard), `Attendance.jsx` (clock in/out + late modal + issue reporting),
  `AttendanceManagement.jsx` (exceptions/issues/config tabs), `MyWork.jsx` (KPIs +
  targets + performance + report submissions).
- New services: `userApprovalService.js`, `workManagementService.js`.
- User status flow: signup → pending → admin approves (role + dept + access wizard) →
  active. Pending/suspended/rejected users see a blocked screen (App.jsx).
- Per-user module access: `user_access_profiles.modules` JSONB array, loaded in
  `useAuth` as `accessModules`, checked in `canAccessRoute`.
- SARA integration: `saraStats.js` now exposes `getWorkforceStats()` for pending
  exceptions, issues, task reports, KPI submissions, and user approvals.
