# Task: Employee-ID Sign-up and Sign-in on SARA web app

Branch: `feat/employee-id-auth`. If context is compacted, re-read ONLY this file; never re-run discovery.

## VERIFIED GROUND TRUTH (do not rediscover)
- `src/pages/Login.jsx`: email only. `submit()` calls `signIn(email,password)` / `signUp(email,password)` / `forgotPassword(resetEmail)`; after sign-in it calls `promoteSuperadmin(email)` (email path only).
- `src/hooks/useAuth.jsx`: `signIn` uses `supabase.auth.signInWithPassword`; `signUp` uses `supabase.auth.signUp` with `emailRedirectTo SIGNUP_REDIRECT_URL`; value object exports `signIn, signUp, forgotPassword`, etc.
- `src/utils/employeeId.js`: `normalizeEmployeeId` + `OFFICIAL_PATTERN /^[A-Z0-9]+\/\d+$/` accept only ONE slash, so real IDs like `IMFB/14/0046` fail. Other code (fingerprint terminal) uses these exports: DO NOT change their behaviour; ADD new functions instead.
- Live DB: `employees` has `employee_number, employee_code, staff_id, email, work_email, personal_email, user_id, employment_status (active|onboarding|terminated), is_archived`. Real values: `IMFB/219`, `IMFB/14/0046`, `IMFB/09/0012`, `employee_code` like `EMP-0220`. 196 active, non-archived, with email.
- `public.normalize_employee_id(text)` exists (uppercases; turns `-`, `_`, spaces into `/`). `public.handle_new_user()` trigger exists and works: creates profile as customer/pending and links the employee ONLY if `raw_user_meta_data.employee_id` points to an unclaimed employee whose email columns match the new account's email. Do NOT modify it.
- `audit_logs` columns: `id, action, entity_type, entity_id, user_name, details, severity, created_at`.
- Existing pattern: `supabase/functions/create-user/index.ts` (service-role client, CORS, json helper, `getAuthRedirectUrl` from `../_shared/appUrl.ts`). `supabase/config.toml` has `[functions.*]` blocks with `enabled/verify_jwt/entrypoint`. Project ref is in `supabase/.temp/project-ref`; NEVER hardcode URLs.

## SECURITY DECISIONS (already made; do not redesign)
1. Employee-ID SIGN-UP takes NO password. User enters only the Employee ID. Server finds employee, sends invitation to email ON RECORD; user sets password on existing `/#/activate-account` page.
2. Employee-ID SIGN-IN resolves email SERVER-SIDE. Never return/expose the email to the browser. Edge Function signs in on server, returns only session tokens.
3. Uniform responses: every sign-in failure returns the same 401 body + similar timing; sign-up always returns the same generic 200 message whether or not the ID exists/is claimed/has email.
4. Approval unchanged: new accounts land pending and need the same Super Admin review as email sign-ups.
5. Rate limiting on both functions.
