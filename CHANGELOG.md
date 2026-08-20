# Changelog — InfinityCore (Vite + Supabase mirror)

All notable changes to the standalone Vite app are recorded here. This mirror
tracks the Base44 version feature-for-feature (zero-drift policy).

## [Unreleased] — 2026-08-07

### Added
- **InfinityCore brand logo** — rendered platform-wide (sidebar, login, auth
  screens) via `src/components/Logo.jsx`. Icon: tilted green-gradient square with
  an orange accent, white infinity symbol, and a small orange diamond.
- **Configuration failsafe** — missing `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_ANON_KEY` now shows a "Authentication system not initialized"
  error screen instead of a blank UI. Auth-init failures show the same.
- **Email notifications on decisions** — loan approvals/rejections, loan
  disbursements, and leave approvals/rejections notify the submitter.
  - Base44: `sendDecisionEmail` backend function (platform `SendEmail`, registered
    users only).
  - Vite: `sendDecisionEmail()` in `src/services/supabaseService.js` resolves the
    recipient email, records an in-app notification, and logs the send. For real
    email, point it at a Supabase Edge Function backed by Resend/SMTP.
- **Superadmin auto-promotion** — `tamunosikiiwolomaclinton@gmail.com` is
  auto-promoted to `admin` on signup/login (`promoteSuperadmin()`).
- **Download Vite Build** — the Base44 admin Dashboard has a button that
  packages this `vite-app/` folder as a ZIP (contents cached in the
  `ViteBuildFile` entity; refresh the cache after changes to keep the ZIP
  current).

### Changed
- `src/main.jsx` — renders a `ConfigError` screen when env vars are missing.
- `src/supabaseClient.js` — exports `envMissing`.
- `src/hooks/useAuth.js` — exposes `authError` (set if session init throws).
- `src/App.jsx` — `Protected` shows the failsafe screen on `authError`.
- `src/components/Layout.jsx` + `src/pages/Login.jsx` — use the `Logo` component.
- `src/pages/Loans.jsx` + `src/pages/LeaveRequests.jsx` — `decide()`/`disburse()`
  call `sendDecisionEmail()`.
- `README.md` — features, inline schema (`account_number`), and quick-start
  updated for branding, failsafe, superadmin, and email.

### Notes
- No new Vite env vars are required for the email mirror (notification + log).
  When wiring a real provider via an Edge Function, add `RESEND_API_KEY` to the
  Supabase project (server-side), not to the Vite `.env`.