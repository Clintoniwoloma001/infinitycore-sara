# Task: Fix password recovery on SARA (production https://infinitymfbcore.vercel.app)

Saved prompt (ground truth — if context is compacted, re-read ONLY this file).

TASK: Fix password recovery on the SARA web app (production https://infinitymfbcore.vercel.app). Forgot-password emails currently link to the wrong website. Build a complete, self-service forgot/reset flow. Your FIRST action: save this prompt to docs/tasks/password-recovery.md; if context is compacted, re-read only that file.

STOP RULES
- Discovery budget: at most 6 read-only commands in total (listed in step 1). No other audits.
- Run `git status` first. If any unrelated files are modified, STOP and tell me (I will commit or stash them). Work on a branch fix/password-recovery. Never run supabase/manual/*.sql, never run `supabase db push`, never touch the migrations folder (history is out of sync).
- Do NOT change the invite/activate-account flow, email sign-in, or the Employee-ID auth work. Do not change the global supabase client flowType.

STEP 1: DIAGNOSE (the 6 reads; report one-line root causes before changing anything)
 a. Supabase Auth config for the project (ref in supabase/.temp/project-ref): if SUPABASE_ACCESS_TOKEN is available (env or `supabase` login), GET https://api.supabase.com/v1/projects/<ref>/config/auth and report ONLY: site_url, uri_allow_list, smtp_host (set or default), hook_send_email_enabled and its uri, mailer_otp_exp, password_min_length, and whether mailer_templates_recovery_content is customised and which host it uses. If no token exists, say so and continue; the dashboard steps in step 6 then apply.
 b. grep supabase/functions/send-email and any other function for 'recovery' / 'redirect_to' / 'site_url' to see whether a send-email hook builds the links.
 c. cat src/config/siteUrl.js (already known: APP_URL, AUTH_REDIRECT_URL = APP_URL + '/#/activate-account').
 d. In src/hooks/useAuth.jsx find forgotPassword (known: it calls resetPasswordForEmail with redirectTo AUTH_REDIRECT_URL, i.e. the ACTIVATE page, which is wrong for recovery).
 e. In src/App.jsx find the public routes block and how the auth guard treats pending/unauthenticated users, so the new route can sit outside the guards.
 f. ls src/pages | grep -i 'activate\|reset\|forgot' to see what exists.

STEP 2: SERVER-SIDE FIX (Supabase Auth settings)
- Set site_url = https://infinitymfbcore.vercel.app.
- uri_allow_list: MERGE (never overwrite existing entries): https://infinitymfbcore.vercel.app/**, https://infinitymfbcore.vercel.app, http://localhost:5173/**, plus anything already present (mobile deep links etc.).
- Apply with PATCH on config/auth changing ONLY those fields (and the recovery template fields in step 3). Show the before/after values. If there is no access token, output the exact dashboard clicks (Authentication → URL Configuration) and mark this step "needs manual action".
- If the default Supabase SMTP is still in use (smtp_host empty): flag it. Built-in email is rate-limited to a few emails per hour and unsuitable for production; recommend custom SMTP (Resend/other) and tell me what is needed.

STEP 3: RECOVERY EMAIL TEMPLATE (branded, host-safe)
- Create supabase/templates/recovery.html: Infinity Core branded (green #009944 button, plain readable text fallback). Subject "Reset your Infinity Core password". Button/link href EXACTLY:
  {{ .SiteURL }}/#/reset-password?token_hash={{ .TokenHash }}&type=recovery
  Include: "This link expires in 1 hour and can be used once. If you did not request this, ignore this email." Do NOT use {{ .ConfirmationURL }}, and no hard-coded hosts.
- Apply it via the same PATCH (mailer_subjects_recovery, mailer_templates_recovery_content) or give me the dashboard path (Authentication → Emails → Templates → Reset Password). Also add [auth.email.template.recovery] to supabase/config.toml for local dev.
- If a send-email hook generates the email (step 1b), update that function instead so it builds the same URL from email_data.token_hash and the canonical APP_URL (never from email_data.redirect_to or request headers), then deploy only that function.

STEP 4: FRONTEND
1. src/hooks/useAuth.jsx: change forgotPassword(email) to resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo: `${APP_URL}/#/reset-password` }) (redirectTo is now a fallback only). Keep every other auth method unchanged. Add completePasswordReset(newPassword) = supabase.auth.updateUser({ password }).
2. NEW src/pages/ResetPassword.jsx, public route #/reset-password (route placed OUTSIDE the auth guards and the pending-approval gate; users with pending status must still be able to reset):
   - On mount read token_hash and type from the hash-route query (useSearchParams). If present and type === 'recovery': call supabase.auth.verifyOtp({ token_hash, type: 'recovery' }) ONCE (guard against React strict-mode double calls) and, on success, remove the params from the URL. Also handle the fallback where a recovery session already exists (onAuthStateChange event PASSWORD_RECOVERY or an existing session from the redirect path).
   - States: verifying (spinner), ready (form), invalid/expired/used (clear message + "Request a new link" button back to forgot mode), success.
   - Form: New password + Confirm, show/hide toggle, rules shown live (min length from the project's password_min_length, 8 recommended; match confirm), submit disabled until valid, friendly Supabase error mapping (weak password, same as old password, expired session).
   - On success: supabase.auth.signOut({ scope: 'others' }) to end other sessions, show "Password updated", then sign out locally and send the user to #/login after 2 s with the message "Sign in with your new password".
   - Match the existing Login visual style (dark background, white card, green button, Logo component).
3. src/pages/Login.jsx: keep the existing forgot mode but (a) after submit ALWAYS show the same neutral message "If an account exists for that email, a reset link is on its way. Check your inbox and spam." regardless of the result, except surface Supabase's cooldown error as "Please wait a minute before requesting another link"; (b) add a route alias #/forgot-password that opens Login directly in forgot mode (so the link can be shared). Do not change sign-in or sign-up behaviour.
4. src/App.jsx: add ONLY the two public routes (reset-password, forgot-password). Nothing else in that file.

STEP 5: TESTS (one pass)
- Unit/component tests (existing test runner) for ResetPassword: verifyOtp called once with the right args; invalid/expired state; mismatch/too-short validation; success path calls updateUser then signOut('others'); no verifyOtp when params missing and no session.
- Build passes; existing tests pass.
- Config check: GET config/auth again and show site_url, the merged allow-list, and that the recovery template contains {{ .SiteURL }} and {{ .TokenHash }} and no other host.
- Local render check of the template with sample values showing the final link host = infinitymfbcore.vercel.app.
- I will do the real inbox test; give me the exact manual test steps in your report.

STEP 6: SHIP
Commit per step, push the branch, open the Vercel preview and report the URL. Note that email links use the SITE URL (production), so the end-to-end email test must run on production after merge; on the preview, test by opening #/reset-password?token_hash=... manually only if you can generate a token_hash safely (do not fabricate). Do not merge to main until I approve.

OUTPUT: terse. Root causes (one line each, with the evidence), before/after Auth settings (no secrets), files changed, commit hashes, test results, manual steps still needed (dashboard actions, SMTP), preview URL.