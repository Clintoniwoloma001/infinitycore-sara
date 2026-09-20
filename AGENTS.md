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

## Onboarding Review Center (Phase 8)
- Full-screen review workspace at `src/components/review/OnboardingReviewCenter.jsx`
- Replaces the old compact `OnboardingReviewModal.jsx` (still present, unused)
- Mirrors all 10 sections of `OnboardingForm.jsx` via `src/components/review/sectionConfig.js`
- Field-level correction requests stored in `onboarding_corrections` table (Phase 8 migration)
- Guarantor corrections use the existing Phase 7 `guarantor_corrections` table
- Correction workflow: HR requests → candidate provides value → HR submits → HR approves/rejects
- Approved corrections update the submission payload (active value) server-side via RPC
- Approval is blocked when unresolved corrections exist (both frontend + server-side)
- Storage security fix: removed anon read on guarantor documents (was exposing sensitive docs)
- Migration file: `schema_phase8_onboarding_corrections.sql` (idempotent, additive)

## Verification
- `curl -sf http://localhost:3000/` returns the Vite-served HTML with `/src/main.jsx`.
- `curl -sf -H "Host: external-preview.example.com" http://localhost:3000/` must also
  return the app (confirms the preview proxy hostname is accepted).
- Without valid Supabase credentials the app shows a config/auth error screen.

## E2E browser smoke tests (Playwright)
- `npm run test:e2e` — starts the Vite dev server on port 4173 and runs
  `e2e/smoke.spec.js` (always) plus `e2e/authenticated.spec.js` (only with creds).
- `npm run test:e2e:install` — one-time Chromium download.
- Authenticated suite is read-only and opt-in via env:
  `E2E_EMAIL=… E2E_PASSWORD=… npm run test:e2e`.
  It logs in through the real UI (`e2e/auth.setup.js`) and reuses the session.
- Target an existing deployment instead of the dev server with
  `E2E_BASE_URL=https://… npm run test:e2e`.
- Artifacts: `playwright-report/`, `test-results/` (both gitignored).

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

## Phase 57 — Employee Provisioning & Auth Flow Fix
- SQL migration: `schema_phase57_employee_provisioning_auth_fix.sql` — run in Supabase
  SQL Editor after Phase 53. Idempotent/additive.
  - Adds `profiles.employee_number`/`designation` columns + backfill from `employees`
    (`employee_number` / `"position"` / `designations.title` via helper
    `employee_designation_label`).
  - `provision_employee_account` now uses `coalesce` so employee-provided values win;
    blank phone/department/branch no longer null-wipes existing profile data.
  - Both `approve_user` overloads rewritten: (5-arg `uuid,text,text,text,text` used by
    `Users.jsx`; 4-arg `uuid,text,text,jsonb` used by `userApprovalService.js`/`WorkManagement`).
    Approval looks up the linked employee (user_id → employee_id → email), only
    overwrites department/branch when the approver supplies a value, auto-creates the
    employee record when missing (`generate_employee_code` + `generate_employee_number`),
    snapshots `employee_number`/`designation` onto the profile, and the 4-arg form now
    sets `approved = true` + clears `rejected_reason`.
- Auth redirect hardening: `src/config/siteUrl.js` only accepts
  `https://infinitymfbcore.vercel.app` (or localhost dev); anything else falls back to
  the canonical URL. Mirrors the edge-side `getAuthRedirectUrl()` in
  `supabase/functions/_shared/appUrl.ts`.
- Forgot-password flow: "Forgot password?" on `Login.jsx` → `useAuth.forgotPassword()`
  → `resetPasswordForEmail` with `redirectTo` = canonical `/activate-account`.
- `ActivateAccount.jsx` handles `type=recovery`: skips the invitation gate, sets only
  the password (best-effort `activate_employee_invitation`), mode-aware copy.
- `Users.jsx` ReviewUserModal prefills department/branch and shows the employee record
  (employee number / designation / department / branch).
- Hosted Supabase Auth Site URL + email templates for invite/recovery are dashboard
  config outside this repo — must include `https://infinitymfbcore.vercel.app`.

## Phase 58 — Training Delivery Type + Real Meeting Links
- SQL migration: `schema_phase58_training_delivery_meeting_links.sql` — run in Supabase
  SQL Editor after Phase 57. Idempotent/additive.
  - Adds `training_sessions.delivery_type` (`physical|virtual`, required, default
    physical), `venue_id` (FK→branches), `venue_name`, `venue_address`,
    `meeting_platform` (`google_meet|zoom`), `meeting_url`, `meeting_provider_id`,
    `meeting_created_at`. Backfills virtual sessions from the legacy `virtual_link`
    and venue fields from `branches`.
  - Zoom `start_url` is intentionally NOT persisted (host-control link stays server-only).
- `Training.jsx` creation form: required "Training delivery" select; Physical shows a
  venue dropdown sourced from `branches` (via `get_dashboard_filter_options`), Virtual
  shows platform select + real meeting generation. Free-typed meeting links are
  rejected at save.
- Meeting creation is server-side only via the existing edge functions
  `create-google-meet` / `create-zoom-meeting` (Google Calendar / Zoom APIs, OAuth on
  `integration_connections`, no provider secrets in the browser). Not-configured /
  not-connected states return clear admin messages instead of fake URLs.
- `trainingService.generateMeetingLink()` invokes the provider edge function;
  `trainingService.attachMeeting()` persists the join URL (also into `virtual_link` so
  MyTraining/attendance views keep working). Sessions list + `MyTraining.jsx` show
  venue/delivery and a join link for virtual sessions; session-meeting panel supports
  Copy/Open/Regenerate (regenerate only before the session starts).
- No new assessment/certificate/attendance tables — the existing training_* flow is
  untouched.

## Phase 61 — Delete Pending Invite + Production Invite-Link Verification
- SQL migration: `schema_phase61_delete_pending_invite.sql` — run in Supabase SQL
  Editor after Phase 60. Idempotent/additive.
  - Adds `delete_pending_invite(uuid)` SECURITY DEFINER RPC, **super_admin only**.
    Full retract of a pending/invited account: revokes open `employee_account_invites`
    (audit history preserved), unlinks `employees.user_id`, removes
    `user_access_profiles` + `notifications`, deletes the `profiles` row and the
    Supabase Auth identity + user. Writes `USER_INVITE_DELETED` to `audit_logs`.
  - The Employee record is never deleted or modified beyond clearing the account link —
    the person stays re-invitable via "Create Users from Employees". Only
    pending/status-less accounts are allowed; active/inactive/suspended/rejected
    accounts raise an error.
- `Users.jsx` Pending Approval rows gain a **Delete Invite** button (visible to
  super_admin only, next to Review/Approve/Reject) with a `window.confirm` and a
  best-effort client `logAction` mirroring `USER_APPROVED`.
- Invite-link verification (why invites must never hit vercel.com): both
  `invite-employees` and `create-user` edge functions build `redirectTo` from
  `getAuthRedirectUrl()` in `supabase/functions/_shared/appUrl.ts`, which only
  ever accepts `https://infinitymfbcore.vercel.app` (or localhost) and falls back
  to that production URL otherwise — `VERCEL_URL` / preview origins are rejected
  by design. A "No Vercel account for this email" landing page is Vercel's own
  Deployment Protection gate, NOT an app bug: turn off "Vercel Authentication" for
  the Production environment in Vercel Project Settings, and keep Supabase Auth
  Site URL + Redirect URLs set to `https://infinitymfbcore.vercel.app` (never a
  `*.vercel.app` preview/branch URL).
