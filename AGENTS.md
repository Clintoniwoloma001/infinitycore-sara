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
