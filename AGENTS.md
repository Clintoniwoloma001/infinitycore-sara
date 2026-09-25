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

## Phase 62 — QR Terminal Management (list / suspend / resume / revoke / delete)
- SQL migration: `schema_phase62_qr_terminal_management.sql` — run in Supabase SQL
  Editor after Phase 61. Idempotent/additive.
  - `attendance_devices.status` now also admits `'revoked'`; legacy token-less
    `status='suspended'` attendance terminals are re-labelled `revoked`.
  - **Semantics**: `active` = usable at scan points; `suspended` = reversible pause
    (token preserved, Resume needs no reprint); `revoked` = permanent kill (token
    removed — this is what the existing Revoke QR button now records); `delete` is
    reserved for revoked rows only. The public gates
    `validate_attendance_terminal_employee()` / `validate_attendance_terminal_location()`
    / `clock_attendance_terminal()` already require `status='active'`, so suspended
    and revoked rows are rejected automatically (no scan-path change).
  - New SECURITY DEFINER RPCs (super_admin/admin/hr_manager only): `suspend_attendance_terminal`,
    `resume_attendance_terminal`, `delete_attendance_terminal`, plus
    `revoke_attendance_terminal` repointed to the `revoked` state. All write to
    `audit_logs` (`ATTENDANCE_TERMINAL_SUSPENDED/RESUMED/REVOKED/DELETED`).
- `attendanceService.js` gains `suspendTerminal` / `resumeTerminal` / `deleteTerminal`
  wrappers; `listTerminalDevices()` now also selects `created_at`.
- `AttendanceManagement.jsx` QR Attendance tab: existing Generate/Revoke panel kept;
  a **Terminal devices** table is added below it (name, status badge, last seen,
  View QR / Suspend / Resume / Revoke / Delete per row, all with `window.confirm`).
  The View QR modal re-displays a link generated this session, otherwise offers a
  Generate QR button (which reactivates suspended/revoked terminals with a new token).

## Phase 63 — Payroll Master Compensation Editor (fixes ₦0.00 payroll)
- Root cause: `list_payroll_master` / `compute_payroll` read salary + allowances
  straight off `employees`, which are blank — real compensation lives in the Phase 41
  engine (`payroll_salary_components` → `employee_salary_packages` →
  `employee_salary_snapshots`). Payroll Master showed ₦0.00.
- SQL migration: `schema_phase63_payroll_master_compensation.sql` — run in Supabase
  SQL Editor after Phase 62. Idempotent/additive.
  - New pure helper `public._salary_breakdown(basic, allowances, taxable_allowances,
    deductions)` — ONE arithmetic engine (pension + consolidated relief + PAYE bands +
    mid/end split) driven by `payroll_config` (id=1). Shared by `calculate_employee_salary_breakdown`,
    `preview_employee_compensation`, and the rewritten `compute_payroll`.
  - `calculate_employee_salary_breakdown(uuid, text default null)` rewritten to use the
    engine and persist the CURRENT snapshot (same return shape: `{ok, employee_id,
    period_label, breakdown}`). Callers (SalaryStructure) unchanged.
  - `upsert_employee_compensation(employee_id, basic, allowances jsonb, deductions jsonb,
    reason)` — SECURITY DEFINER, **super_admin/admin/hr_manager only**, mandatory
    reason (≥5 chars). Updates `employees.salary`, find-or-creates components and
    packages (component_id-or-name), deactivates zero amounts, resyncs
    `employees.allowances`, recomputes CURRENT snapshot, writes
    `EMPLOYEE_COMPENSATION_UPDATED` to `audit_logs` (before/after + reason).
  - `preview_employee_compensation(...)` — read-only preview (hr roles), same engine,
    NO writes; `get_employee_compensation(uuid)` — bundle {identity, basic_monthly,
    packages[], latest CURRENT snapshot, has_compensation} for editor + Employee 360.
  - `list_payroll_master()` rewritten: derived `salary` (basic), `allowances`, `gross`,
    `deductions_total`, `tax_paye`, `pension`, `other_deductions`, `net`, `mid_month`,
    `end_month`, `has_compensation` from the CURRENT snapshot (package fallback).
    BankOne export mapping (amount = salary + allowances) unchanged.
  - `compute_payroll()` no longer hardcodes `v_allowances := 0` — it sums the active
    allowance/deduction packages and calls `_salary_breakdown`, so Payroll runs +
    BankOne push preview now reflect edited compensation.
- `payrollProfileService.js` gains `getEmployeeCompensation` / `upsertEmployeeCompensation`
  / `previewCompensation`. New `src/components/payroll/CompensationEditorModal.jsx` (basic +
  allowance/deduction rows + live derived preview + mandatory reason).
- `PayrollBankOne.jsx` Payroll Master tab: Basic / Allowances / Gross / Deductions / Net
  columns + per-row **Edit/Set** compensation button (visible to payroll.manage roles).
- `EmployeeProfile.jsx` Payroll tab: **Current Compensation** card (basic, allowances,
  gross, net, package chips) via `get_employee_compensation`.
- Test: `npm run test:payroll-compensation` — `tests/payrollCompensation.test.mjs`
  (migration-content assertions, no live DB).

## Phase 65 — QR Terminal "View QR" persistence + status consistency
- SQL migration: `supabase/migrations/20260920000001_attendance_fix_qr_view_link_status.sql` —
  run in Supabase SQL Editor after `20260920000000_attendance_device_daily_binding.sql`.
  Idempotent/additive.
  - Root cause: `create_attendance_terminal_token` stored only a SHA-256 of the raw token
    in `attendance_devices.device_token`, and the raw token was returned to the browser
    exactly once, so View QR after a reload could never re-render the current QR without
    minting a brand-new token. The temporary `20260919000000` repair had also redefined
    revoke to write a token-nulling `'suspended'` (pre-Phase 62 legacy behaviour), so
    genuinely revoked terminals surfaced as "Suspended" and Resume could revive a
    token-less terminal.
  - Adds `attendance_terminal_view_links` (device_id PK → attendance_devices ON DELETE
    CASCADE, token_hex raw) — RLS-enabled, `revoke all` from anon/authenticated, NO direct
    read path. Only read via `get_attendance_terminal_qr_link(uuid)` SECURITY DEFINER RPC
    (super_admin/admin/hr_manager) so View QR re-renders the exact current QR/link WITHOUT
    regenerating. Raw tokens never sit in any RLS-visible column; purged on revoke/delete.
  - Status model restored: revoke writes `status='revoked'` + nulls token + clears the view
    link; legacy token-less `'suspended'` terminals re-labelled `'revoked'`; suspend keeps
    token + view link (resume needs no reprint); resume only from suspended; delete only
    from revoked. Adds `attendance_devices.token_generated_at` for the Generated column.
  - Public scan gates (`validate_attendance_terminal_employee` /
    `validate_attendance_terminal_location` / `clock_attendance_terminal`, fingerprint-aware
    signatures unchanged) now resolve the terminal by token including non-active states and
    reject a suspended terminal with "This terminal is temporarily suspended. …" instead of
    the misleading "invalid or revoked". No attendance record is ever created for a
    non-active terminal.
- `attendanceService.js`: `listTerminalDevices()` also selects `token_generated_at`; new
  `getTerminalQrLink(deviceId)` wraps the gated RPC.
- `AttendanceManagement.jsx` QR Attendance tab: View QR now loads the CURRENT live link from
  the server (`getTerminalQrLink`) instead of the session-only `linksByDevice` cache, so it
  works after reloads and shows the actual functional QR + copyable link. Only when no live
  token exists (never generated or revoked) does the modal offer Generate. Removed the
  silent "regenerate to view" side effect. Terminals table gains a Generated column
  (`token_generated_at`).
- Test: `npm run test:qr-terminal` — `tests/qrTerminalView.test.mjs` (migration-content
  assertions, no live DB).

## Phase 66 — One Employee Per Terminal Per Day + Durable QR Token History
- SQL migration: `supabase/migrations/20260921000001_attendance_terminal_day_binding_qr_history.sql`
  — run in Supabase SQL Editor AFTER 20260921000000. Idempotent/additive.
  - **CRITICAL fix (one device clocked in ~3 employees):** QR/enrolment gates bound ONE
    BROWSER fingerprint to one employee, but three employees scanning the same printed QR
    from three phones each carry distinct fingerprints — so the same terminal could record
    attendance for multiple people. Now the ATTENDANCE DEVICE is bound to a single employee
    per app day independent of the browser:
    - Partial unique index `uid_attendance_device_bindings_terminal_day` on
      `attendance_device_bindings(terminal_id, binding_date)` where `terminal_id is not null`
      — hard DB guarantee.
    - New `attendance_terminal_day_binding_check(terminal_id, employee_id, event_type)` returns
      `allowed/reason(bound|unbound|terminal_taken)/bound_to/error`.
    - Both public gates (`validate_attendance_terminal_employee` 3-arg and
      `clock_attendance_terminal` 7-arg) run the terminal-day check BEFORE any record write,
      return `device_binding_blocked=true` + the exact HR-facing message
      ("…already been clocked-in by a different employee today…"), and audit
      `ATTENDANCE_DEVICE_BINDING_BLOCKED` (attempted + bound employee names). No attendance
      record is ever created for the second employee.
    - `attendance_device_bind` is now a no-op (never raises) on a terminal-taken conflict.
  - **Durable QR token history — tokens are NEVER destroyed:**
    - New table `attendance_terminal_token_history` (id, device_id FK on delete cascade,
      token_hash, token_preview = `left(raw,8) || '…'`, status check
      `active|revoked|expired|deleted`, expires_at, created_at/by, revoked_at/by). RLS on,
      revoked from anon/authenticated. Raw tokens never stored — only SHA-256 + masked preview.
    - `create_attendance_terminal_token` archives the current `active` row to `revoked`
      (revoked_at/by) then inserts the new `active` row. Regenerating supersedes, never deletes.
    - `revoke_attendance_terminal` flips the active row to `revoked` (rows kept), device
      status `revoked`, token nulled, view link purged.
    - `delete_attendance_terminal` is now a SOFT delete (only from `revoked`): device status
      `deleted` (added to the `attendance_devices.status` CHECK via drop/add), row + full
      history preserved. `'deleted'` is a status VALUE, never an actual DELETE.
    - New `list_attendance_terminal_qr_history(device_id, status)` — role-gated
      (super_admin/admin/hr_manager/hr_officer/branch_manager), optional status filter
      (invalid values rejected), newest-first, joins profiles for generated/revoked-by names.
      History is recorded from this migration onward only (no retroactive reconstruction).
  - Assumption flagged: tokens have NO TTL today (expires_at reserved, stays null); a token is
    `active` until superseded or revoked. License to add `expired` later is reserved, not used.
- `attendanceService.js` gains `listTerminalQrHistory(deviceId, status)`.
- `AttendanceManagement.jsx` QR Attendance tab: per-row **QR History** button → modal with
  status filter chips (All/Active/Revoked/Deleted), masked token, generated at/by, revoked
  at/by, newest first. `statusMeta` handles `deleted` ("Deleted (history kept)");
  Revoke/Delete confirm copy no longer claims tokens/rows are destroyed.
- Frontend rename: `index.html` title/meta and all user-facing `src/**` strings now read
  **Infinity Microfinance Bank** (email domain `infinitybank.com` and backend/edge-function
  strings intentionally untouched — out of scope).
- Tests: `npm run test:terminal-history` — `tests/attendanceTerminalHistory.test.mjs`
  (migration + frontend + rename content assertions) plus local-docker behavioral pass for
  the full lifecycle (generate→regen→revoke→soft-delete→list, active-only filter) and the
  critical one-employee-per-terminal block (second employee → `device_binding_blocked`,
  zero records, audited; owner re-scan passes the gate, rejected only by the daily guard).

## Phase 64 — Training & Development extension (Meet OAuth fix, invites, KSS channel, AI questions)
Cross-cutting completion of the Training & Development roadmap. No SQL migration for
Phase 1/4 (frontend + edge-function only) — but `schema_phase63_kss_channel_training_invites.sql`
must be applied in Supabase SQL Editor for Phases 2/3, and the edge functions
`send-training-invites`, `create-google-meet`, `create-zoom-meeting`,
`generate-training-questions` deployed (`supabase functions deploy`).

### Phase 1 — Google Meet OAuth fix + permanent manual-link fallback
- Root cause: `create-google-meet` returned `not_connected` because the invoking user had
  never completed Google OAuth (no `integration_connections` row for `google_calendar`);
  the Training page had no Connect action and `SessionMeetingPanel` had no manual fallback.
- `src/lib/meetingLink.js` — SHARED URL validators used by both UI and tests:
  `isValidHttpUrl` (http/https only) and `isValidMeetingUrl` (host exactly
  `meet.google.com` or `www.meet.google.com`, path non-empty; no over-validation — the
  underlying Google payload is validated server-side on save anyway).
- `Training.jsx`:
  - `SessionMeetingPanel` now accepts `userId`; on `connectionFailed`
    (`/OAuth|not connected|not_configured/i`) shows a **Connect / Reconnect Google
    account** button that `window.open`s the OAuth URL from
    `interviewService.connectGoogleCalendar(userId)`, plus a **Use a manual link** paste
    box (placeholder `https://meet.google.com/xxx-xxxx-xxx`); `saveManualLink` validates
    with `isValidMeetingUrl` and persists via `trainingService.attachMeeting(session.id,
    { meetingUrl, platform, externalMeetingId: null })`. Manual links work for BOTH
    physical and virtual sessions; `meeting_url` remains the single source of truth.
  - `CreateTraining` similarly shows the Connect button when its provider call fails.
- **Clinton (manual action):** complete the Google consent the first time from the
  Training page — provider-generated Meet/Zoom links cannot be minted without a
  connected OAuth account. Edge functions must be deployed.

### Phase 2 — Multi-channel training invitations
- `send-training-invites` was already fully wired (Resend email + in-app
  notifications + KSS channel post). One fix: attendance link is now appended for ALL
  delivery modes (`if (attendanceLink)` instead of `if (isVirtual && attendanceLink)`),
  so physical-session invites also carry the QR/attendance link. `TRAINING_MANAGE_ROLES`
  = super_admin/admin/branch_manager (matches frontend `canManage`).
- Covered by `schema_phase63_kss_channel_training_invites.sql` (invites + KSS channel).

### Phase 3 — KSS channel + automatic membership
- No new code needed: `schema_phase63_kss_channel_training_invites.sql` adds the
  `kss-announcements` auto channel (`ensure_kss_channel()`, `kss_channel_add_member`
  `on conflict do nothing`, `trg_profiles_active_kss_member`, grants, bootstrap select);
  membership pushes into the existing Phase 40/60 engine
  (`send_mention_message`, `sync_auto_channel_members` override that no longer hardcodes
  the branch_manger role). Offboarding / off-boarded-employee membership removal is
  already handled by Phase 60 triggers
  (`trg_employee_auto_channel_sync`, `trg_profile_auto_channel_sync`,
  `reconcile_auto_channel_membership_for_employee` deletes only `auto_added = true` rows).

### Phase 4 — AI-assisted KSS question generation
- New edge function `supabase/functions/generate-training-questions/index.ts`:
  - POST `{ title, description?, fileName, fileBase64, sessionId? }`; Bearer auth;
    role allow-list `super_admin/admin/branch_manager/hr_manager/hr_officer`;
    `.txt/.pdf/.docx` only; ≤ 2 MB.
  - Extracts text **server-side** (TXT text-decode, PDF via `npm:unpdf@1.8.1`
    `extractText`, DOCX via `npm:mammoth@1.12.3` `extractRawText` — both dynamically
    imported in try/catch). Raw files never reach OpenAI; only extracted text is sent.
  - Refuses to call the AI when extraction yields < 40 meaningful chars, returning the
    exact copy: "Unable to extract readable text from this document. Please upload a
    text-based PDF/DOCX/TXT file or enter the questions manually."
  - Rate-limited via the existing `consume_sara_ai_usage(30, 2)`; OpenAI `gpt-4o-mini`
    with `response_format: json_object`, temperature 0.2, 30s abort.
  - Strict validation lives in `supabase/functions/_shared/kssQuestionValidator.js`
    (shared with the test suite): exactly 3 questions, non-empty fields, exactly 3
    non-empty options, `correct_answer` present verbatim among options, no duplicates.
    On failure returns the exact copy: "AI generated questions could not be validated.
    Please retry or enter questions manually."
  - Output uses the EXISTING KSS bank line format
    `Question | Correct answer | Option 1, Option 2, Option 3` and is fed into the
    existing question-bank editor + rotation/grading pipeline — never bypasses it.
  - Writes `AI_QUESTION_GENERATION` audit rows (metadata only; document text never
    logged, stored, or returned).
- `trainingService.generateQuestionsFromDocument({ title, description, fileName,
  fileBase64, sessionId })` wraps the invoke.
- `Training.jsx` **CreateTraining**: "Generate Questions from Document" panel under the
  KSS question-bank textarea — file input (`.txt,.pdf,.docx`, client-side 2 MB check),
  fills `form.question_text` with the three drafted lines for HR review/editing;
  nothing is auto-submitted/auto-assigned. Exact extraction/validation errors surface
  verbatim.
- The function NEVER writes to `training_questions`, never creates sessions, never
  assigns participants.
- Tests: `npm run test:meeting-link`, `npm run test:kss-channel`,
  `npm run test:question-generation` (node assertions incl. validator unit tests).
- **Clinton (manual action):** add `OPENAI_API_KEY` project secret if absent (shared
  with SARA), deploy the edge function, apply `schema_phase63_kss_channel_training_invites.sql`.

## Phase 67 — No-code Performance Rules Builder
- Redesigns the raw-JSON Performance Settings page into a business-rules builder while
  preserving the existing versioned `performance_config` JSONB structure, the same
  performance engine, and the exact bank default values. No SQL migration — frontend +
  pure domain layer only.
- Domain layer (plain ESM, `.js` extensions, node-testable):
  - `src/domains/performance/rules/registry.js` — single source of truth for VARIABLES
    (with `available` flag), OPERATORS, CLOSED_RANGE_OPERATORS, ACTIONS, UNITS,
    MPR_COMPONENTS, DESIGNATION_FREQUENCIES. Variables that exist in the data model but
    are NOT yet consumable by the engine (attendance %, late/absence counts, leave
    balance/utilization, outstanding principal, loan count, days past due) stay in the
    catalog with `available:false` so nobody can build a rule the engine could never
    evaluate. UI reads from here; components hard-code no business strings.
  - `format.js` — deterministic (non-AI) sentence previews: `describeCondition`,
    `describeRule` ("When MPR Score is between 60% and 74%, the employee receives a
    productivity bonus equal to 30% of gross salary.").
  - `validate.js` — pure range/weight/overlap/order validation; `findRangeOverlaps`
    (inclusive, null max = +inf), `findRuleOverlaps`/`ruleInterval`
    (bonus-tier exclusivity), `bonusEntryFromRule`/`bonusRuleFromEntry` (1:1 band ⇄ rule),
    `sumField`. Gaps between bands/grades are preserved (coverage is informational).
  - `translators.js` — per-config_key `{fromConfig, toConfig, validate, describe,
    summarize, editable}`. `toConfig` reproduces the EXACT stored JSON (round-trip
    guaranteed; verified for every seeded default). `bankone.performance_engine` is
    `editable:false` (info card, no fake data). Fallback translator handles unknown keys.
- UI (presentation-only; translates config ⇄ drafts, never computes MPR/bonuses):
  - `src/components/performance/controls.jsx` — Field/TextInput/SelectInput/NumInput/
    ConditionValueInput/VariableSelect/OperatorSelect/EntityMultiSelect (searchable +
    custom-add)/FrequencySelect, plus `unitSuffixText` (removed a fragile
    `UnitSuffix(...).props.children` hack).
  - `ReorderList.jsx` — native HTML5 drag-drop + up/down buttons, deterministic
    `onMove(from,to)`.
  - `RulesBuilder.jsx` — generic WHEN (ALL/ANY) + condition rows + THEN action/value +
    frozen sentence preview; unsupported saved rules render as preserved cards.
  - `editors.jsx` — generic `RowTableEditor` + per-section editors (MPR components, PAR
    bands, loan ageing, grades, mobility, sanctions, regulatory) and a custom
    `BonusEditor` (eligible-designation multi-select, wait months, payment-frequency
    matrix, reorderable productivity-bonus rule cards restricted to closed-range MPR
    operators / `productivity_bonus` action so stored bands keep their shape).
  - `SectionEditor.jsx` — per-item shell: version badge, human-readable preview (live in
    edit mode), editor, inline validation errors, mandatory audited reason, guarded
    Save (validation + actual change + reason), per-item Reset to bank default.
- `PerformanceSettings.jsx` rewritten as three tabs: **Business Rules** (default,
  sidebar sections → SectionEditor), **Advanced (JSON)** (escape hatch, visible to
  admin/super_admin only), **Change History** (each audit diff rendered as human
  summary via `summarize(old)` vs `summarize(new)` + actor name resolved from
  `profiles`). Reset-to-bank-defaults button retained (future calculations only).
- Designation multi-select unions master `designations` with any configured titles
  (e.g. UNIT HEAD) so nothing is destroyed.
- Tests: `npm run test:rules-builder` — `tests/performanceRulesBuilder.test.mjs`
  (parses the real phase-26 migration seed, then asserts round-trip + zero validation
  errors on every default, exact frozen sentences, weight-sum/overlap/sanction-order/
  bonus-overlap rejections, unavailable-variable discipline, and UI wiring). No live DB.
  Verified with `npm run build` and the test suite.

## Phase 68 — Profile Email Uniqueness Guard (prevents silent `.single()` breaks)
- Root cause prevented: a manually-run script duplicated rows in `profiles`, breaking
  every `.single()` profile fetch with PGRST116. `profiles.id` is already a PK (FK→
  auth.users); `email` was the unenforced natural key (`id` IS the auth_user_id).
- SQL migration: `supabase/migrations/20260921000004_profiles_email_unique.sql` — run
  in Supabase SQL Editor. Idempotent/additive.
  - Pre-flight DO block: if duplicate non-null emails (`lower(btrim(email))`) remain,
    it prints each one and ABORTS with `profiles_email_unique_aborted: resolve the N
    duplicate email(s) above first…` — so a premature apply is loud and self-diagnosing,
    and the raw index statement also fails with 23505 if run alone.
  - `create unique index uq_profiles_email_lower on profiles (lower(btrim(email)))` —
    case/whitespace-insensitive (matches invite ILIKE + reconciliation compares), NULLs
    exempt. A future bad INSERT now dies with `duplicate key value violates unique
    constraint "uq_profiles_email_lower"` at insert time, not as a frontend crash later.
  - Adds nothing else; never touches existing profile rows.
- `useAuth.jsx` `fetchProfile` normalizes PGRST116 → "Your profile record could not be
  found. Please contact an administrator."; `App.jsx` already renders the `!profile`
  "Profile unavailable" screen (no page crash).
- Known remaining same-class gaps (REPORTED, not fixed — data/decisions needed):
  `employees.email`, `employees.user_id`, `profiles.employee_id`, `branches.branch_name`,
  and `customers.email`/`account_number`/`national_id` have no uniqueness. Already safe:
  `user_access_profiles(user_id)`, `leave_balances(employee_id,year,leave_type)`,
  `designations`, `attendance_records(employee_id,attendance_date)`,
  `employee_digital_files(employee_id)`, `departments.code`.
- Test: `npm run test:profiles-unique` — `tests/profilesEmailUnique.test.mjs`
  (migration + useAuth/App assertions + pure-JS mirror of the duplicate-detection SQL).
  Also verified behaviorally against a scratch Postgres on the local Supabase docker
  instance (dup abort, clean apply, 23505 on exact + case/space variants, NULLs allowed,
  idempotent re-run).

## Phase 69 — Profile FK Integrity (auth + employee) & email-link audit
- Incident prevented: a manually-run script wiped `profiles` rows (Super Admin access +
  recruitment/approval flows broke until a manual restore via `auth.users` + `employees`
  cross-reference). Base schema already declares both FKs, but nothing stops a bad script
  or a partially-restored DB from dropping/never-creating them — this migration re-asserts.
- SQL migration: `supabase/migrations/20260921000005_profiles_auth_foreign_keys.sql` — run
  in Supabase SQL Editor after `20260921000004`. Idempotent/additive.
  - Pre-flight DO blocks abort LOUDLY with the exact offending ids if any `profiles.id`
    has no `auth.users` row, or any `profiles.employee_id` (when the column exists) has no
    `employees` row — never applies over broken data.
  - Re-asserts `profiles_id_fkey  (id) -> auth.users(id) ON DELETE CASCADE` and
    `profiles_employee_id_fkey (employee_id) -> public.employees(id) ON DELETE SET NULL`
    (also `add column if not exists employee_id uuid`). Verified on a scratch Postgres:
    orphan profile insert → FK violation; nonexistent-employee link → FK violation; auth
    user delete cascades the profile (no orphan); employee delete nulls the link.
- Point-3 audit (REPORTED, not changed — await Clinton): the live `handle_new_user()`
  (schema_phase60) and both `approve_user` overloads link by LOGIN email only —
  `lower(e.email) = lower(new.email)` / `lower(v_target.email)` — and
  `provision_employee_account` hard-rejects login↔work email mismatch. `work_email`
  columns exist (phase27) but are never consulted by these paths, so any user whose
  login email ≠ `employees.email` stays unlinked ("employee never auto-links"). Fixes to
  confirm before implementing: also match `employees.work_email`/`profiles.work_email`
  under the same "exactly one unambiguous match, never a conflicting relink" guard,
  relax provision's hard equality, and add an HR reconciliation RPC.
- Backups/PITR (hosted-project status NOT readable from the repo — check Dashboard):
  Free=no automatic backups; Pro/Team/Enterprise=daily backups (7/14/30-day retention);
  PITR is a PAID add-on (~$100-400/mo by retention, requires ≥ Small compute) that
  REPLACES daily backups (WAL, ~2-min RPO worst case, restore takes the project offline);
  backups exclude Storage files. At minimum, schedule periodic
  `supabase db dump --data-only` off-site dumps for this project until PITR is budgeted.
- Tests: `npm run test:profiles-fk` — `tests/profilesAuthFk.test.mjs` (migration + schema
  content assertions). Behavioral pass on a scratch Postgres (local supabase docker):
  orphan pre-flight abort, clean apply, FK rejections, cascade + set-null, idempotency.

## Phase 7a — Platform Role Expansion (operations_manager → head_of_operations + 5 head roles)
- SQL migration: `supabase/migrations/20260921000007_roles_head_of_operations_and_new_roles.sql`
  — run in Supabase SQL Editor AFTER 20260921000006. Idempotent/additive, transaction-wrapped.
  - Renames the legacy internal role `operations_manager` → `head_of_operations` ("Head of
    Operations") in `roles` (id preserved → `role_permissions` stay attached) and migrates
    live `profiles.role` rows; rebuilds `profiles_role_check` to its 18-role set.
  - Adds five department-head roles (from designations master): `head_of_e_business`
    (HEAD, E-BANKING / HEAD OF DIGITAL BANKING), `financial_controller` (FINANCIAL
    CONTROLLER), `head_of_risk_compliance` (HEAD, RISK MANAGEMENT / HEAD OF COMPLIANCE),
    `head_of_legal` (HEAD OF LEGAL), `head_of_audit` (HEAD OF AUDIT / HEAD OF INTERNAL
    CONTROL) + `designation_role_mappings` upserts. Backfills the never-seeded
    `area_manager`/`head_of_business` `roles` rows.
  - Head roles share the org-wide "management" class: `can_author_announcement`,
    `training_is_manager`, management auto-channels (`sync_auto_channel_members` /
    `reconcile_auto_channel_membership_for_employee`), `get_man_hour_intelligence`,
    `reset_annual_leave_balances` 15-day class, `approve_user` (both overloads), and
    `assign_permission_to_role` inheritance (`hr.attendance.self`, `hr.training.read`,
    `workforce.manhour.read`). `enforce_role_change_policy` + `trg_enforce_role_change`:
    only super_admin/admin may assign the senior/head roles; branch/area managers stay
    limited to front-line roles.
  - Finance owns BankOne: `can_manage_bankone`/`can_manage_reconciliation` now include
    `financial_controller` (and `head_of_operations`); all `bankone_*`/`recon_*`/
    `transport_allow` WRITE policies rewritten accordingly (reads stay role-free customer
    token). `branches_read_authorized`, `leave_balances`, `tasks*`, `task_reports*`
    policies rewritten to head-role-aware lists.
- `src/constants/roles.js` rewritten for the 18-role catalog (ROLES/HIERARCHY/METADATA/
  PERMISSIONS/MODULES/assignableRoles). `attendance.terminal` added to ADMIN /
  HR_MANAGER / HEAD_OF_BUSINESS / HEAD_OF_OPERATIONS permission grants (Attendant
  Terminal nav). `leaveRulesService.js` intentionally keeps legacy `operations_manager`
  + all head roles (backward compat). `src/` has zero remaining `OPERATIONS_MANAGER`
  references.
- Edge functions mirror the DB gates (no second authz system): `bankone-core.mjs`
  `BANKONE_QUERY_ROLES` = super_admin/admin/hr_manager/hr_officer/head_of_operations/
  financial_controller; `sara-intent` `LOAN_READ_ROLES` drops `operations_manager` for
  `head_of_operations`; `TERMINATION_ROLES` stays super_admin/hr_manager.
- Repo-root `schema_phase*.sql` retains legacy `operations_manager` (immutable history) —
  00007 supersedes it in a clean DB. Test: `npm run test:roles-head-operations` —
  `tests/rolesHeadOperations.test.mjs` (migration + edge + roles.js content assertions).

## Phase — HR job postings: archive / edit / delete / stop applications
- SQL migration: `supabase/migrations/20260921000009_hr_jobs_archive_edit_delete.sql` — run in
  Supabase SQL Editor after 20260921000006/7/8. Idempotent/additive.
  - Extends `hr_jobs.status` CHECK from `draft|published|closed` to also admit `archived`
    (drop/add constraint by the same name), adds `archived_at`, and adds the previously
    missing **RLS delete policy** `hr_jobs_delete` (super_admin/admin/hr_manager only).
    Deleting a job nulls candidates' `job_id` (their records survive) and cascades the
    screening config + job questions. No apply-path change needed: the public gate
    (`public_apply_for_job`) and public listing already require `status='published'`, so
    **closed and archived both stop the collection of applications**.
- `HRJobs.jsx` job cards now support the full lifecycle: **Edit** (reopens the create modal
  prefilled via `jobToForm`, saves through the same `handleSubmit` — inserts on new, updates
  in-place on edit), **Archive** (draft/published/closed → `archived`), **Restore**
  (archived → draft), **Delete** (`window.confirm`, RLS-gated), and the published "Close"
  button is relabelled **Stop applications**. `STATUS_COLOR`/status filter gain `archived`.
- Test: `npm run test:hr-jobs` — `tests/hrJobsLifecycle.test.mjs` (migration + frontend
  content assertions, no live DB). Verified with `npm run build`.

## Phase — BankOne Account Name Enquiry & Payroll Bank Linking
- New edge function `supabase/functions/bankone-name-enquiry/index.ts` — mirrors
  `bankone-transaction-status`: `verify_jwt = true` + in-function `supabase.auth.getUser()`
  + `BANKONE_QUERY_ROLES` role gate, injects `BANKONE_API_TOKEN` server-side, POSTs the
  documented Qore Channels endpoint
  `{base}/thirdpartyapiservice/apiservice/AccountEnquiry/GetAccountData`
  (`BANKONE_NAME_ENQUIRY_ENDPOINT`, roadmap #4) with `{ AccountNumber, BankCode, Token }`.
  Audits `BANKONE_NAME_ENQUIRY_OK/ERROR`; the token is never returned, logged, or echoed.
  Register in `supabase/config.toml` (`[functions.bankone-name-enquiry]`, `verify_jwt = true`)
  and deploy with `supabase functions deploy bankone-name-enquiry`.
- `supabase/functions/_shared/bankone-core.mjs` gains `BANKONE_NAME_ENQUIRY_ENDPOINT`,
  `validateNameEnquiryRequest` (10-digit NUBAN + bank code), `buildNameEnquiryRequest`,
  `extractAccountName`/`extractAccountDetails` (tolerant recursive field search across Qore
  envelope variants), and `normalizeNameEnquiryResponse` (success requires a resolved
  account name; token-free). Account fields added to `PROVIDER_RESULT_KEYS`.
- `src/services/bankone/bankoneNameEnquiryService.js` — `nameEnquiry({ accountNumber,
  bankCode, bankName })` via `invokeBankoneFunction` (no token in the browser).
- `src/constants/nigerianBanks.js` — CBN/NIBSS bank code ⇄ name catalogue.
- `src/components/payroll/BankOneLinkModal.jsx` — select employee → bank + 10-digit account
  → **Look up account name** (must succeed) → **Confirm & Link** saves via
  `employeeService.updateHrFields` (`bank_name`, `account_number`, `account_name`,
  `bank_sort_code`; phase14 allow-list already covers these — no SQL migration needed).
- `PayrollBankOne.jsx` Payroll Master tab: **Link Bank Account** button
  (`PAYROLL_BANK_LINK_ROLES` = super_admin/admin/hr_manager/hr_officer), modal refreshes the
  master list on success.
- Test: `npm run test:name-enquiry` — `tests/bankoneNameEnquiry.test.mjs`. Manual action:
  set `BANKONE_API_TOKEN`/`BANKONE_API_BASE_URL` project secrets and confirm the exact Qore
  `GetAccountData` request/response sample before the first live smoke test.

## Phase — Role rename: HR Manager → Head of Human Resources
- SQL migration: `supabase/migrations/20260921000010_roles_head_of_human_resources.sql` — run in
  Supabase SQL Editor after `20260921000009_hr_jobs_archive_edit_delete.sql`. Idempotent/additive
  (wrapped in `begin; … commit;`).
  - Renames the `roles` row in place (`role_name = 'head_of_human_resources'`,
    `display_name = 'Head of Human Resources'`) — the row id is preserved so
    `role_permissions` stay attached.
  - Migrates live `profiles.role` rows and rebuilds `profiles_role_check` with the 18-role
    catalog (now `head_of_human_resources`, no `hr_manager`).
  - Re-issues **145 RLS policies** and **146 SECURITY DEFINER functions/RPCs** that enumerated
    `hr_manager`, including `approve_user` (both overloads), `enforce_role_change_policy`,
    `can_author_announcement`, `training_is_manager`, leave/attendance/payroll/recruitment
    gates, etc. A generator extracted the *latest* definition of every affected object from
    the repo's chronological SQL history, so superseded definitions are never restored.
  - Re-runs the Phase 6 dynamic `execute format('create policy "%s_read" …')` loop so the
    new role reaches `employee_education`, `employee_work_history`, `employee_fidelity_bonds`
    (the `employee_guarantors` override from Phase 49 still wins because explicit policies are
    re-issued after the dynamic block).
- Frontend: `src/constants/roles.js` renames the constant to
  `HEAD_OF_HUMAN_RESOURCES: 'head_of_human_resources'` and updates the UI label to
  "Head of Human Resources". Every `ROLES.HR_MANAGER` consumer (`dashboardPermissions.js`,
  `RoleSwitcher.jsx`, `useAuth.jsx`) and every src string literal `'hr_manager'` were updated.
- Edge functions: role literals in `bankone-core.mjs`, `sara-intent`, `send-assessment-email`,
  `generate-training-questions`, `create-user`, `escalate-leave-requests`, `bankone-name-enquiry`,
  `bankone-transaction-status`, `sara-candidate-analysis`, `webauthn-register-options`, and
  `invite-employees` now use `head_of_human_resources`.
- Intentionally untouched: the `employees.hr_manager_signature_path` DB column / UI field
  keeps its physical name (only the platform role changed).
- Tests: `npm run test:roles-head-hr` — `tests/rolesHeadOfHr.test.mjs`; existing
  `test:roles-head-operations` was updated to expect the renamed role in the frontend +
  edge-function role lists. `npm run build` passes. Run in the SQL Editor before the change
  takes effect in the hosted project.

## Phase — HR Organisation Module UX updates
- SQL migration: `supabase/migrations/20260921000013_hr_organisation_module_updates.sql` — run in
  Supabase SQL Editor after `20260921000012_leave_balance_authoritative.sql`. Idempotent/additive
  (wrapped in `begin; … commit;`).
  - Adds write RLS policies (`*_write`) on `employee_supervisors`, `hierarchy_exceptions`,
    `data_quality_exceptions`, and `departments` gated to `super_admin`/`admin`/`head_of_human_resources`.
  - New SECURITY DEFINER RPCs: `upsert_employee_supervisor`, `delete_employee_supervisor`,
    `resolve_hierarchy_exception` (optionally materialises the supervisor mapping),
    `resolve_data_quality_exception`, `upsert_department`, `delete_department` (blocked if
    employees are still assigned), and `assign_employee_department` (updates both `employees`
    and linked `profiles` rows, audited).
- `src/services/hrOrganisationService.js` gains matching methods and enriches
  `listSupervisors()` with employee/supervisor details. Write RPCs now surface `{ ok: false, ... }`
  responses as thrown errors so the UI cannot silently swallow save failures.
- `src/pages/HROrganisation.jsx`:
  - **Hierarchy & Supervisors** tab: editable supervisor mapping table with inline Employee,
    Level, Supervisor and Title fields; department-filtered supervisor dropdown (always includes
    MD / Head of HR / Head of Business via global role heuristic); blank-supervisor rows
    highlighted; **Add Row** opens a full mapping modal; **Edit** button per row opens the same
    modal for atomic update (deletes the old mapping and inserts the new one when the key
    fields change). Save failures are surfaced instead of appearing to revert.
  - **Hierarchy Exceptions**: Resolve now opens a supervisor picker and materialises a real
    `employee_supervisors` row for exceptions that have a linked employee; Dismiss/Reopen remain
    direct. No-employee import artifacts (`employee_id` is null) are hidden from the active
    exceptions UI rather than shown as unresolvable rows.
  - **Structure** tab: expandable department rows showing assigned employees, **Edit**
    department modal, **Add Department**, and inline assignment of unassigned/other-department
    employees. Unassigned employees grouped separately.
  - **Area ↔ Branch Assignment** (Structure tab): native-HTML5 drag-and-drop Kanban board with
    one column per Area plus an Unassigned column. Branch cards can be dragged between columns;
    the underlying `branch_area_assignments` table is updated via the existing `set_area_branches`
    RPC. Head Office branches are excluded from the board.
- **Data Quality Issues** tab: rows are clickable and open a detail modal with linked
     employee info (when `entity_type='employee'`) and Resolve/Dismiss/Reopen actions.
- Test: `npm run test:hr-organisation` — `tests/hrOrganisationModule.test.mjs`. `npm run build`
  passes.

## Phase — Data Quality Branch Correction (auto-resolve workflow)
- SQL migration: `supabase/migrations/20260921000014_data_quality_branch_correction.sql` — run in
  Supabase SQL Editor after `20260921000013`. Idempotent/additive (begin/commit).
  - Adds `resolution jsonb`, `resolved_by uuid`, `resolved_at timestamptz` to
    `data_quality_exceptions`; re-issues `resolve_data_quality_exception` (same signature,
    now records who/when/why) — "Keep as it is" = `('dismissed')`.
  - New SECURITY DEFINER RPC `correct_data_quality_exception(p_exception_id, p_action,
    p_new_value, p_new_values text[], p_staff_assignments jsonb, p_reason)` —
    super_admin/admin/head_of_human_resources only, branch issues only, open only.
    `correct_single`: renames the location across `branches`/`employees`/`profiles`/
    `employee_onboarding_links` + submission `payload` jsonb (no `branch` column there),
    requires a different name, auto-resolves. `split`: ≥2 distinct non-blank names,
    find-or-creates branch rows (`BR-##` code, no duplicate-name unique constraint),
    validates every `{employee_id, branch_name}` assignment targets a split name, moves
    employees + linked profiles, errors if any staff still reference the old value,
    deactivates the combined branch for history, auto-resolves. Writes
    `DATA_QUALITY_EXCEPTION_CORRECTED`/`_SPLIT` audit rows (format() strings, repo
    convention). Exceptions are a static seed insert — no rescan, so resolved stays resolved.
- `src/services/hrOrganisationService.js` gains `correctDataQualityException({ exceptionId,
  action, newValue, newValues, staffAssignments, reason })`.
- `src/pages/HROrganisation.jsx` `QualityIssueModal` (keyed by issue id) reworked for branch
  issues: overview shows linked-staff count; open branch issues offer **Keep as it is**
  (dismiss) or **Correct**; Correct step toggles **Correct as a single entry** vs
  **Split into entries** (split-name inputs + per-person target selects + **Assign all**
  bulk buttons + Clear, validation: ≥2 distinct names, all staff assigned), optional reason,
  then **Correct & Save** / **Split & Save** → `onCorrect` → parent `exec` + reload. Non-branch
  issues keep Mark Resolved / Keep as it is / Reopen.
- Test: `npm run test:hr-organisation` — extended for 00014 (RPC, service wrapper, modal
  correction/split UI). `npm run build` passes.

## Phase — Leave Entitlement Override & Centralized Defaults
- SQL migration: `supabase/migrations/20260921000011_leave_entitlement_override.sql` — run in
  Supabase SQL Editor after existing leave migrations. Idempotent/additive.
  - Adds `leave_balances.default_entitlement`, `manual_override`, `effective_entitlement`,
    `pending_days`, `override_reason`, `override_updated_by`, `override_updated_at`.
  - Adds pure helpers `get_annual_leave_category(text)`, `get_annual_leave_default_days(text)`,
    and SECURITY DEFINER RPC `get_employee_leave_entitlement(uuid, text)` — the single source
    of truth for per-employee leave entitlement.
  - Annual leave defaults are driven by designation: MD/CEO = 20, MD / any HEAD designation = 15,
    all others = 10. Non-annual leave types continue to fall back to `leave_rules`.
  - Backfills current-year rows with the new defaults, never overwriting a non-null
    `manual_override`, and keeps the legacy `entitled_days` column synced with
    `effective_entitlement` for older consumers.
  - Adds `audit_leave_entitlement_change(uuid, jsonb, jsonb, text)` for entitlement edits.
- Frontend: `src/domains/leave/entitlements.js` — pure domain layer for category detection and
  `balanceFor` (used by `leaveBalanceService.js`, `leaveRulesService.js`, and node tests).
- `src/services/leaveBalanceService.js` updated to expose `getEmployeeLeaveEntitlement`,
  create missing balance rows via the centralized engine, and support override/reset modes in
  `adjustBalance`.
- `src/pages/LeaveBalances.jsx` redesigned: shows default / override / effective / used /
  pending / remaining per employee, supports single-employee override edits with live effective
  preview, batch override adjustments, and a **Reset to Default** action. Correctly uses
  `auth.users.id` as `leave_balances.employee_id`.
- `src/pages/Dashboard.jsx` and `src/domains/dashboard/dashboardService.js` updated to consume
  `effective_entitlement` and `pending_days`.
- `src/pages/LeaveRequests.jsx` simplified to use the centralized `getEmployeeBalances`.
- Test: `npm run test:leave-entitlements` — `tests/leaveEntitlements.test.mjs`. `npm run build`
  passes.

## Phase — Attendance Management filter scoping + auto-clock-out reconciliation
- SQL migration: `supabase/migrations/20260921000021_attendance_summary_head_hr.sql` — run in
  Supabase SQL Editor after `20260921000010`. Idempotent/additive (begin/commit).
  - Re-issues `get_attendance_management_summary()` with `head_of_human_resources` added to the
    authorized role list alongside `super_admin`/`admin`/`hr_manager`/`hr_officer`/`head_of_business`.
- `src/pages/AttendanceManagement.jsx`:
  - Records tab now fetches a bounded date window (7 days ending on the selected date, or
    30 days ending on today when no date is selected) instead of the latest 500 unbounded
    records. Selecting a past date retrieves real historical records for that date.
  - KPI cards (Total Employees, Present, Absent, Late, Attendance %, Avg Hours) and the 7-Day
    Attendance Trend chart now recalculate against the active Branch/Department/Employee filter
    subset. Total headcount is derived from the filtered employee list; present/absent/late and
    trend are derived from attendance records matching the same population scope.
  - Lazy auto-clock-out reconciliation (`attendanceService.reconcileAutoClockouts()`) is
    triggered once when the management page mounts, so stale open sessions are closed even when
    no employee has recently logged in.
- Test: `npm run test:attendance-management` — `tests/attendanceManagement.test.mjs`. `npm run build`
  passes.

## Phase — Messages identity fixes ("Unknown User" extermination) + peer search + bulk add
- SQL migration: `supabase/migrations/20260921000020_messages_identity_directory_left_join.sql` — run
  in Supabase SQL Editor AFTER 20260921000005 (any order afterwards, additive). Idempotent (create-or-replace).
  - Root cause: `message_channel_members.member_id` FKs `auth.users`, but `resolve_user_identity`
    and `get_messaging_directory` INNER JOINed `profiles` — a missing `profiles` row (Phase 69
    incident class) DROPPED the member row entirely, and `indexIdentityById` coerced name==email →
    "Unknown User". Display-only fix; the auto-sync functions (`sync_auto_channel_members` /
    `reconcile_auto_channel_membership_for_employee`) are untouched.
  - `resolve_user_identity(uuid[])` rewritten: drives from `unnest(p_user_ids)`, LEFT JOINs
    `profiles` + lateral `employees` (newest-first), so every requested id gets EXACTLY one row.
    New `has_account` bool (app `profiles` row exists). `profile_status` retained so the UI can
    label "No account yet" / "Pending approval" and disable "Message" instead of faking a name.
  - `get_messaging_directory(text)` rewritten: LEFT JOINs `auth.users` → `profiles` →
    lateral `employees`; filter is `(p.id is null and e.id is not null) or coalesce(p.role,'customer')
    <> 'customer'` (parenthesized correctly — the parens grouping matters for WHERE precedence),
    search over coalesced full_name/email/department, `limit 1000`. Employee-linked profile-less
    accounts (auto channel members) now resolve their real name + picture; bare auth rows, customers,
    anon/service roles stay excluded.
- `src/services/corporateChatService.js` `indexIdentityById` no longer coerces — `name =
  fullName || email || null`, carries `hasAccount`. (The separate explicit `displayName(userId, ident)`
  escape hatch for a genuinely unknown participant is preserved for legacy callers.)
- `src/components/messages/personUtils.js` new `isActiveAccount(person)`: admin/super_admin always
  active; `hasAccount === false` → inactive ("No account yet"); `profileStatus` `active` or `''`
  (profile row exists, status-less legacy) → active; pending/suspended/rejected → inactive.
- `src/components/messages/PeoplePicker.jsx` NEW — the ONE shared user-search/multi-select picker
  (`z-[60]` overlay so it sits above the MemberPanel's `z-50`), reusing `PersonAvatar` +
  `personMatches`; `mode="single"` (click row) for Direct New Message, `mode="multi"` (checkbox +
  "Add selected (N)") for channel/group Add People.
- `MessagesPage.jsx` `indexDirectory` maps `has_account` → `hasAccount` (fallback `true` for
  profile-derived entries / self) so `isActiveAccount` never wrongly disables everyone.
- `Conversations.jsx`: list search input (Channels/Groups names) with empty-state copy; MemberPanel
  replaces the inline single-add list with `PeoplePicker mode="multi"` (`excludeIds` = current
  members, loops `svc.addMember` on pick); every member row shows "No account yet"/status label and
  the **Message** button is disabled (with tooltip) for members without an active account; message
  bubbles render `PersonAvatar` + resolve name via identity/people (never hardcoded "Unknown User").
- `DirectTab.jsx`: thread-list search input (filter by the other member's display name); New Message
  modal replaced by `PeoplePicker mode="single"`; `personName` resolves `displayPersonName(identity[id]
  || people.find(...))`; bubbles get the `person` prop for avatars.
- `MessageBubble.jsx`: new optional `person` prop renders `PersonAvatar` beside non-mine bubbles.
- `Layout.jsx`: sidebar chip now uses `PersonAvatar` fed by self identity from
  `resolveDirectory([user.id])` (real name + profile photo when set; initials fallback).
- Test: `npm run test:messages-identity` — `tests/messagesIdentity.test.mjs` (migration content,
  `indexIdentityById` no-coercion, `isActiveAccount` truth table, PeoplePicker wiring, bubble/layout
  avatars). `npm run build` passes.

## Phase — Midnight Auto Clock-Out @ 17:00 (verified + scheduled)
- SQL migration: `supabase/migrations/20260922000009_attendance_auto_clockout_midnight.sql` — run in
  Supabase SQL Editor after `20260922000008` (or the latest migration before it). Idempotent/additive.
  - Adds `attendance_records.auto_clock_out boolean default false` (with partial index) and
    re-issues `attendance_auto_clockout_close_sessions()` so still-open sessions from days before
    today are closed at the shift day's work-end time: default 17:00 from
    `hr_platform_settings.default_work_end_time` with an exact `17:00` fallback. Role gate includes
    the renamed `head_of_human_resources` alongside the original `hr_manager`/`hr_officer`.
  - The clock_out timestamp is `(attendance_date + work_end) at time zone att_app_timezone()` —
    i.e. **17:00 on the shift day**, never the time the job actually ran. Updates set
    `auto_clock_out=true`, write an `attendance_events` row, and audit `ATTENDANCE_AUTO_CLOCK_OUT`.
  - Registers pg_cron job `infinitycore-attendance-auto-clockout` for `5 0 * * *`, guarded by
    `pg_extension extname='pg_cron'` presence.
- `src/pages/AttendanceManagement.jsx` records table now shows an **Auto** badge next to the
  clock-out time for auto-closed rows.
- Test: `npm run test:auto-clockout-midnight` — `tests/attendanceAutoClockout.test.mjs`.
  `npm run build` passes.

## Phase — Leave Approval Workflow Builder + 30-min Reminders + Mandatory Feedback
- SQL migration: `supabase/migrations/20260922000010_leave_approval_workflow_feedback.sql` — run in
  Supabase SQL Editor after `20260922000009` (or the latest migration before it). Idempotent/additive.
  - Adds `hr_platform_settings.leave_approval_workflow` (builder-owned JSONB array of role/user
    levels with SLA hours and auto-escalate), `leave_requests.current_approval_level`,
    `stage_entered_at`, `last_reminded_at`, `feedback_submitted`, and the `leave_feedback` table.
  - New RPCs: `get_leave_workflow_chain_for_employee()`, `get_leave_approval_workflow()`,
    `save_leave_approval_workflow()`, `submit_leave_feedback()`, `_leave_stage_approver_ids()`,
    and `notify_leave_approvers()`.
  - Re-issues `get_leave_approval_chain_for_request()` and `process_leave_decision()` to prefer the
    workflow (falling back to the legacy template) and to sync reminder/SLA columns. Forwarding a
    request resets `stage_entered_at`/`last_reminded_at` and immediately notifies the next approver.
  - Registers pg_cron `infinitycore-leave-approver-reminders` for `*/30 * * * *`, sending
    `type='urgent'` in-app notifications to current-stage approvers; escalates to the next level
    when the configured SLA is exceeded and auto-escalate is enabled.
- Frontend:
  - `src/services/leaveApprovalsService.js`: `WORKFLOW_ROLES`, `getApprovalWorkflow`,
    `saveApprovalWorkflow`, `submitLeaveFeedback`.
  - `src/pages/Settings.jsx` Leave Rules tab: new `LeaveWorkflowBuilder` card (add role/user
    levels, reorder, SLA, escalate toggle, audited save reason) using the shared `PeoplePicker`
    for user selection.
  - `src/components/leave/LeaveApprovalReminder.jsx` + `src/components/Layout.jsx`: persistent
    urgent banner + Sara speech + browser notification + vibration, refreshing every 30 minutes
    while the user still has pending approvals.
  - `src/components/leave/LeaveFeedbackModal.jsx` + `src/components/Layout.jsx`: mandatory blocking
    modal for requesters after a leave is approved/rejected; requires 1–5 star turnaround/ease
    ratings and a 10+ character feedback note.
  - `src/pages/LeaveRequests.jsx`: create/cancellation payloads seed `current_approval_level` and
    `stage_entered_at`.
- Test: `npm run test:leave-workflow` — `tests/leaveWorkflowFeedback.test.mjs`.
  `npm run build` passes.

## Phase — Mobile biometric security guard + canonical attendance clock functions
- SQL migration: `supabase/migrations/20260922000007_mobile_device_biometric_security.sql`
  (idempotent/additive) now begins with `create table if not exists public.mobile_device_sessions`
  so the biometric migration is safe to run even when `20260922000006_mobile_device_sessions.sql`
  has not yet been applied in a given environment.
- SQL migration: `supabase/migrations/20260922000011_attendance_clock_in_canonical.sql` — run in
  Supabase SQL Editor after `20260922000010`. Idempotent/additive.
  - Drops all overloaded variants of `public.attendance_clock_in_for_employee` and
    `public.attendance_clock_out_for_employee`.
  - Creates a single canonical 10-parameter version of each function with explicit,
    strongly typed parameters and trailing defaults (`p_geofence_override uuid`,
    `p_allow_outside boolean`). Web (8-arg), terminal (10-arg), and mobile (10-arg)
    callers all resolve unambiguously to the same function, eliminating the
    "function is not unique" error caused by ambiguous overload resolution.
  - Revokes direct `authenticated` access to the internal helpers; authenticated
    clients continue to call the guarded `clock_in_secure` / `clock_out_secure` wrappers.
- `src/services/attendanceService.js`: `clockIn` / `clockOut` now explicitly cast
  latitude, longitude, and accuracy to `float` and the device fingerprint to `string`
  before sending the RPC payload.
- Tests: `npm run test:clock-in-canonical` — `tests/attendanceClockInCanonical.test.mjs`.
  `npm run build` passes.

## Phase — QR terminal gate field crash fix (`record "v_terminal" has no field "id"`)
- SQL migration: `supabase/migrations/20260923000002_terminal_gate_field_fix.sql` — run in
  Supabase SQL Editor after `20260923000001`. Idempotent/additive.
  - Root cause: `attendance_terminal_for_token()` (20260920000001) populates `v_terminal`
    with the device PK as **`device_id`** — it has no `id` and no `device_name` field. The
    live gates that `select * into v_terminal` from it referenced the missing fields and
    threw `record "v_terminal" has no field "id"` on EVERY valid active-terminal scan
    (blocking all QR clock-ins, e.g. employee IMFB/24/0365), plus a latent
    `record "v_terminal" has no field "device_name"` in `validate_attendance_terminal_employee`
    (20260921000016, device-binding-blocked branch).
  - Fix: re-issues both gates. Explicit `if not found` guard immediately after the
    SELECT INTO returns `Terminal not found or inactive. This attendance terminal link is
    invalid or revoked.` (previously relied on `or` short-circuit). The location gate's
    `_terminal_geofence()` call now uses `v_terminal.device_id` (was `v_terminal.id`);
    the employee gate resolves `device_name` via a `(select d.device_name …)` lookup
    (was `v_terminal.device_name`). Status/active policy and all grants unchanged.
    `attendance_terminal_for_token()` itself is untouched.
  - Audited ALL scanner/clock paths: `clock_attendance_terminal` (20260922000001) uses an
    `attendance_devices%rowtype` + `if not found` guard (safe); canonical web
    `attendance_clock_in/out_for_employee` (20260922000011) and `mobile_clock_in/out`
    (20260922000013) have their own guards (safe). Only the two above `v_terminal` gates
    had the bug.
- `src/pages/AttendanceTerminal.jsx` + `src/services/attendanceService.js`: public terminal
  no longer mislabels a backend/server failure as "Location is required". The service tags
  RPC failures with `e.kind` (`'server'` / `'rejected'` / `'business'`); the page shows
  **Location is required** only for genuine geolocation denials (`isLocationBlockedError`),
  **outside permitted area** for geofence rejections, and a generic **Something went
  wrong. Contact IT.** for server errors. New `geoStatus='error'` display state.
- Test: `npm run test:terminal-gate-field` — `tests/terminalGateFieldFix.test.mjs`
  (migration + frontend content assertions, plus last-definition + field-set cross-checks).
  Verified on the scratch Postgres docker DB: exact crash reproduced pre-fix and the
  fixed gates resolve the geofence and return the clear not-found error. `npm run build`
  passes.

## Phase — Granular Access & Privileges (centralized authorization mirror)
- Replaces ad-hoc UI-level role checks with a single, audited, granular
  authorization layer layered ON TOP of the existing RBAC. One deliverable —
  still a pure SPA + hosted Supabase — with enforcement at the DB edges
  (SECURITY DEFINER functions + RLS), everywhere the frontend already calls.
- SQL migration: `supabase/migrations/20260923000001_granular_privilege_access.sql` —
  run in Supabase SQL Editor **after** `20260922000013`. One transaction
  (`begin;` … `commit;`), idempotent + additive, **no** `hr_manager` strings.
  Verified end-to-end on a scratch Postgres (compile + behavioral).
- **Catalog**: `permissions` is now the single permission surface (120 keys,
  seeded by `scripts/gen-privilege-seed.mjs`, markers
  `-- BEGIN/END GENERATED PRIVILEGE SEED --`; regenerate with
  `node scripts/gen-privilege-seed.mjs` when `src/constants/roles.js` drifts).
  Baseline role↔permission grants + scopes (the role baseline remains the
  "default allow" — never trimmed, only ever additive).
- **Precedence**: super_admin → ALLOW > user DENY > user ALLOW > role baseline >
  default DENY. `has_permission(key)` / `has_permission_for(user,key)` /
  `require_permission(key)` implement it; `get_my_permissions()` is the
  authority document (`{epoch, role, is_super_user, allowed, denied, fields,
  modules}`) consumed by Web, Flutter and SARA; `permission_version(id=1)`
  epochs every change so clients refresh their doc.
- **Targets**: `user_permissions` (user overrides, `scope_type` in
  global/branch/department/selected_users), `permission_field_rules`
  (table.column show/hide; `has_field_access(table,column)` /
  `require_field_access`), `permission_delegation` (which roles/users may
  administer WHICH modules at WHAT max scope).
- **Holder rule** (`_can_manage_permission`): a manager can only change
  permissions they hold themselves, only within delegated modules, only at or
  below their delegation ceiling. `get_privilege_authority()` drives the UI.
  `set_delegation`/`revoke_delegation` are **super_admin only**.
- **All changes are audited** (`permission_audit` + `audit_logs` via
  `_write_privilege_audit`) with a mandatory reason (≥5 chars). RLS: the five
  new tables are readable only by privilege managers (users may read their own
  `user_permissions`); write RLS is never granted.
- **Payroll retrofit** (the first granular-enforcement surface): `list_payroll_master`
  keeps its role gate but adds `require_permission('payroll.salary.view')`
  and redacts bank columns when the caller lacks `has_field_access('employees',
  'bank_account')`. `calculate_employee_salary_breakdown`, `get_employee_compensation`,
  `preview_employee_compensation` and the 11-arg `upsert_employee_compensation`
  are renamed to `_*_impl` (bodies untouched, EXECUTE revoked from
  public/authenticated) behind guarded wrappers; the 5-arg upsert is fully
  re-emitted verbatim with its original role gate + a granular edit-or-view
  guard. `financial_controller`, `hr_officer`, `head_of_human_resources`
  behavior is unchanged from today (baseline already covers them).
- **Delegations seeded**: super_admin + admin → every module, max `global`;
  `head_of_human_resources` → HR-adjacent modules (attendance, appraisal,
  communications, hr, hr_config, medical, messaging, payroll, performance,
  reports, sara, work, workforce) and an explicit
  `seed_role_permission('head_of_human_resources', 'administration.privileges.manage')`
  (the generated baseline only reaches super_admin/admin).
- **Frontend**: `src/services/privilegeService.js` (RPC wrappers, no raw
  `employees` access), `src/pages/PrivilegeManagement.jsx` (route `/privileges`,
  nav group Management, guard `administration.privileges.manage`; tabs Role
  Privileges / User Privileges / Effective Access / Field Visibility /
  Delegation / History; audited ReasonModal for every change;
  super_admin-only delegation + role-grant free-form).
- **useAuth integration (zero-regression)**: `fetchPermissions` loads
  `get_my_permissions()`; `hasPermission` = super_user → true, explicit deny →
  false, explicit allow → true, else legacy `ROLE_PERMISSIONS` fallback (so a
  not-yet-migrated env keeps working); `deniedKeys`/`allowedKeys` exposed;
  `canAccessRoute` denies a route when any required permission is explicitly
  denied. `refreshPermissions()` re-syncs after privilege edits.
- **SARA**: `sara-intent` calls `get_my_permissions()` and prunes intents whose
  backing key is explicitly denied (`INTENT_PERMISSION_KEYS`) before the NLU
  call — execution rights stay with RLS/callers (advisory, never the surface).
- Tests: `npm run test:privileges` — `tests/privilegeManagement.test.mjs`
  (migration + service + page + useAuth + navigation + sara content
  assertions), plus the local-docker behavioral pass (precedence order, deny
  beats baseline, clear restores, epoch bumps, role grant/revoke, field-rule
  redaction on `list_payroll_master`, delegation holder rule). `npm run build`
  passes.

## Phase — Chairman + MD/CEO roles, and "MD/CEO is a role, not a department"
- SQL migration: `supabase/migrations/20260924000003_chairman_md_ceo_roles_department_hygiene.sql`
  — run in Supabase SQL Editor after `20260924000002` (and after `20260924000001`).
  Idempotent + additive, `begin; … commit;`. No DELETE, no rewrite of
  `employees`/`profiles` rows.
- **Executive viewer family**: `md_ceo` (MD/CEO), `chairman` (Chairman) and
  `director` now share ONE read-only access profile (`director.executive.read` +
  self-service attendance). `src/constants/roles.js` adds `ROLES.MD_CEO` /
  `ROLES.CHAIRMAN` (metadata, hierarchy, `ROLE_PERMISSIONS`, `ROLE_MODULES`) and
  exports `EXECUTIVE_VIEWER_ROLES` + `isExecutiveViewerRole()` — every surface
  gates on that helper, never on a single role literal.
  - All role lists (Users review/approval modal, create user, create-from-employees,
    inline role selects, PrivilegeManagement, RoleSwitcher "view as") render
    `Object.values(ROLES)`, so Director/Chairman/MD-CEO appear platform-wide
    automatically. `assignableRoles()` still hides the three executive roles
    from Area Manager / Head of HR.
  - Granular baseline seeded for all three roles (generated by
    `scripts/gen-privilege-seed.mjs` from `roles.js`): `director.executive.read`,
    `hr.attendance.self`, `attendance.view/clock_in/clock_out/history`,
    `hr.leave.view/request`, `messaging.*`, `sara.use`. This also REPAIRS the
    director role, which previously had only `director.executive.read` in
    `role_permissions` and was therefore default-denied on attendance
    (`public._permission_state` = default deny).
  - `enforce_role_change_policy()` re-issued: the senior/management role sets may
    only GROW (`admin` + every 20260924000001 entry + the three executive roles);
    only super_admin/admin may assign them. Mirrored in the `invite-employees`
    and `create-user` edge functions.
  - `get_director_executive_snapshot` / `get_director_employee_detail`
    re-issued (from 20260924000001 bodies) with the widened role gate.
  - Final hosted-response hardening: `normalizeDirectorSnapshot` in
    `src/domains/directorIntelligence/snapshot.js` guarantees a complete UI
    read-model when Supabase returns a successful partial/legacy payload with
    JSON null fields (including the observed `filters: null` crash). The service
    applies it at the RPC boundary and the page also uses null-safe access.
  - Forward SQL repair: `20260924000004_director_snapshot_jsonb_summary_fix.sql`
    reissues the already-applied Director RPC with `to_jsonb(o)` on the left
    side of its summary concatenation. The previous `row_to_json(o) || jsonb`
    expression failed for every call because PostgreSQL has no `json || jsonb`
    operator. Transaction-wrapped, idempotent, data-free, and preserves the
    existing function owner/grants/security attributes. The original 00001 and
    00003 clean-install definitions are corrected as well.
  - Second operator defect (same RPC, different key): `20260924000005_director_snapshot_roles_record_operator_fix.sql`
    reissues the RPC again for the `roles` aggregate. `jsonb_agg(x order by x->>'role')`
    failed with `operator does not exist: record ->> unknown`, because the
    `x` subquery projects FIVE columns (`role`, `staff`, `kpi_completion`,
    `attendance_rate`, `target_completion`) so `x` is a **record**, not `jsonb`.
    Every call raised, even after 00004. Fixed to
    `jsonb_agg(to_jsonb(x) order by to_jsonb(x)->>'role')`, keeping the rows,
    keys and the alphabetical sort identical. The three proven-safe
    single-column `x->>` aggregates (`departments`, `branches`, `areas`) are
    left alone — a one-column subquery does resolve to `jsonb`. Transaction-wrapped,
    idempotent, data-free, preserves function owner/grants/security attributes;
    00001 and 00003 clean-install definitions corrected identically, so a fresh
    install is correct without running 00004/00005 at all.
    Verified on a scratch PostgreSQL 16: the pre-00003 shape reproduces
    `operator does not exist: json || jsonb` and the pre-00005 shape reproduces
    `operator does not exist: record ->> unknown`; 00001 / 00003→00004→00005 /
    00001→00003→00004→00005 all apply cleanly and the RPC returns a sorted
    `roles` array. `tests/directorIntelligence.test.mjs` contains a structural
    guard that re-parses every `jsonb_agg(x order by … x->>…)` and fails if the
    fed subquery is not single-column or the row is not wrapped in `to_jsonb`.
  - Third correction (applied live, recorded): `supabase/migrations/20260925160359_director_expected_attendance_20_days.sql`
    — expected attendance is a FIXED **20 days for every employee**, not the length
    of the selected date window. `(select count(*) from range_days)::int expected_days`
    made "today" and a 1–2 day window show `expected = 1` and an inflated 100% rate.
    The migration patches ONLY that one expression inside
    `get_director_executive_snapshot` (`pg_get_functiondef` + `create or replace` via
    `execute replace`), so the deployed body, owner, grants, `security definer` and
    `search_path` are preserved; it aborts loudly if the expression is missing or
    appears more than once, and is idempotent (already-fixed definition is a no-op).
    Every consumer shares the same `expected_days` column, so the fix propagates to
    staff rows, `attendance_rate`, and the summary/departments/branches/areas/roles
    aggregates. Date filters still scope the ACTUAL attendance counts (`days_present`).
    Verified live on `atzomqicwjufuxhfexxd` (migration `director_expected_attendance_20_days`,
    version `20260925160359`): 211 staff, min = max = 20 expected days, 0 staff rows
    whose rate differs from `present/20`, and the summary rate matching the recomputed
    aggregate, for both the `today` and `month` windows.
- **Department hygiene** — `src/constants/departments.js` (pure ESM, node-testable)
  is the single source of truth: `isRoleLikeDepartment`, `filterDepartmentOptions`,
  `cleanDepartmentValue`, `NON_DEPARTMENT_VALUES` (MD/CEO, MD, M.D., CEO,
  MANAGING DIRECTOR, CHAIRMAN, DIRECTOR, BOARD…). Server mirrors it with
  `public.is_role_like_department()` / `public.department_label()`.
  - `MD/CEO` (and any other executive title) can no longer be selected in ANY
    department dropdown: Users review/approval modal, Work Management, HR
    Organisation structure, Dashboard, Training, Man-Hour Intelligence,
    Attendance Management, Director intelligence.
  - `get_dashboard_filter_options` + the director RPCs re-issued so the server
    option lists exclude the title too; a stored title value is reported as
    `Unassigned` rather than being presented as a department.
  - A `departments` master row named after an executive title is deactivated
    (`is_active = false`, audited `DEPARTMENT_TITLE_DEACTIVATED`) — never
    deleted, and employees are never silently reassigned: HR still owns which
    real department an executive belongs to.
  - New approvals/creations run `cleanDepartmentValue()`, so a title can never be
    written back into the `department` column.
- Tests: `npm run test:chairman-role` — `tests/chairmanRoleDepartments.test.mjs`
  (role family parity, role-list coverage, senior/management role-set GROWTH
  regression guard, migration content, every department source wired to the
  filter, plus behavioural unit tests of the pure module).
  `tests/directorIntelligence.test.mjs` + `tests/reinviteReviewModal.test.mjs`
  updated for the shared role helper / filtered department list. `npm run build`
  passes.
- NOT changed (needs a decision, flagged): existing `employees.department =
  'MD/CEO'` rows are left as-is (shown as Unassigned in executive views), no
  profile is auto-promoted to `md_ceo`/`chairman`, and the Flutter/mobile client
  lives outside this repo — it must recognise `md_ceo`/`chairman` and route them
  to the executive workspace instead of the standard dashboard.
