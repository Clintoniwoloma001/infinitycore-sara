import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const migration = read('supabase/migrations/20261117000000_employee_id_auth.sql')
const rollback = read('supabase/migrations/20261117000000_employee_id_auth_rollback.sql')
const signupFn = read('supabase/functions/employee-id-signup/index.ts')
const loginFn = read('supabase/functions/employee-id-login/index.ts')
const config = read('supabase/config.toml')
const useAuth = read('src/hooks/useAuth.jsx')
const loginPage = read('src/pages/Login.jsx')
const taskDoc = read('docs/tasks/employee-id-auth.md')

// --- 1. Migration: privileged resolver is service-role-only ------------------
for (const required of [
  'create or replace function public.resolve_employee_for_auth(p_norm_id text)',
  'language sql',
  'security definer',
  `grant execute on function public.resolve_employee_for_auth(text) to service_role`,
]) {
  assert.ok(migration.includes(required), `migration is missing: ${required}`)
}
assert.match(
  migration,
  /revoke all on function public\.resolve_employee_for_auth\(text\) from anon/,
)
assert.match(
  migration,
  /revoke all on function public\.resolve_employee_for_auth\(text\) from authenticated/,
)
// Exactly-one-match guard (ambiguous IDs must never be guessed) + active,
// non-archived filter.
assert.match(migration, /where \(select count\(\*\) from matched\) = 1/)
assert.match(migration, /e\.employment_status = 'active'/)
assert.match(migration, /coalesce\(e\.is_archived, false\) is distinct from true/)

// --- 2. Migration: rate limiter table + function, service-role-only ----------
assert.match(migration, /create table if not exists public\.auth_rate_limits/)
assert.match(migration, /alter table public\.auth_rate_limits enable row level security/)
assert.ok(
  !/create policy .* on public\.auth_rate_limits/.test(migration),
  'auth_rate_limits must have RLS on and NO policies (service-role only)',
)
assert.match(
  migration,
  /create or replace function public\.auth_rate_limit_hit\(p_key text, p_max int, p_window interval\)/,
)
assert.match(migration, /grant execute on function public\.auth_rate_limit_hit\(text, int, interval\) to service_role/)
assert.match(migration, /revoke all on function public\.auth_rate_limit_hit\(text, int, interval\) from anon/)
assert.match(migration, /revoke all on function public\.auth_rate_limit_hit\(text, int, interval\) from authenticated/)
assert.match(migration, /^begin;$/m, 'migration must be transaction-wrapped')
assert.match(migration, /^commit;$/m, 'migration must be transaction-wrapped')

// --- 3. Rollback companion exists --------------------------------------------
assert.ok(rollback.length > 0, 'rollback migration must exist')
assert.match(rollback, /drop function if exists public\.resolve_employee_for_auth/)

// --- 4. Signup function: uniform generic 200 + invite + rate limit -----------
for (const required of [
  `import { getAuthRedirectUrl } from '../_shared/appUrl.ts'`,
  `admin.auth.admin.inviteUserByEmail`,
  `redirectTo: getAuthRedirectUrl()`,
  `admin.rpc('resolve_employee_for_auth'`,
  `admin.rpc('auth_rate_limit_hit'`,
  `p_max: 10`,
]) {
  assert.ok(signupFn.includes(required), `signup fn is missing: ${required}`)
}
// Security decision 3: identical generic 200 whether or not the ID exists,
// is claimed, or has an email. Every terminal path returns ok: true.
assert.equal(
  (signupFn.match(/return json\(\{ ok: true, employeeId: normalized, message \}\)/g) || []).length,
  3,
  'signup must return the same generic 200 from all three terminal paths',
)

// --- 5. Login function: uniform 401 + server-side resolution -----------------
for (const required of [
  `admin.rpc('resolve_employee_for_auth'`,
  `admin.rpc('auth_rate_limit_hit'`,
  `p_max: 30`,
  'normalizeEmployeeId(raw)',
  `shouldCreateUser: false`,
  `emailRedirectTo: getAppUrl()`,
]) {
  assert.ok(loginFn.includes(required), `login fn is missing: ${required}`)
}
// Regression guard: GoTrueAdminApi has NO signInWithOtp — using it threw a
// TypeError (HTTP 500) on every real login. Must go through the public client.
assert.ok(
  !loginFn.includes('admin.signInWithOtp'),
  'login fn must not call auth.admin.signInWithOtp (does not exist on GoTrueAdminApi)',
)
assert.match(loginFn, /authClient\.auth\.signInWithOtp\(\{/)
// The OTP endpoint never returns a session for email magic links — success is
// "magic link sent", never a 401 and never session tokens.
assert.match(loginFn, /return json\(\{ ok: true, magicLink: true \}\)/)
assert.ok(
  !/return json\(\{ ok: true, session/.test(loginFn),
  'login fn must not claim to return a session from the OTP endpoint',
)
// Every sign-in failure shares the same 401 body (security decision 3).
const failureBodies = loginFn.match(/return json\(\{ error: 'invalid_credentials', message[^)]*\}, 401\)/g) || []
assert.ok(failureBodies.length >= 4, `expected >=4 uniform 401 failure bodies, found ${failureBodies.length}`)
for (const body of failureBodies) {
  assert.match(body, /'invalid_credentials'/)
  assert.match(body, /, 401\)$/)
}
// The failures share ONE message constant (no distinguishing detail).
assert.match(loginFn, /const message = 'Invalid Employee ID or email\.'/)
assert.ok(
  !/json\([^)]*authEmail/.test(loginFn),
  'the resolved email must never appear in a response body',
)

// --- 6. Config: both functions registered with verify_jwt = false ------------
for (const fn of ['employee-id-signup', 'employee-id-login']) {
  const block = config.split(`[functions.${fn}]`)[1]
  assert.ok(block, `config.toml is missing [functions.${fn}]`)
  assert.match(block.slice(0, 200), /enabled = true/)
  assert.match(block.slice(0, 200), /verify_jwt = false/)
  assert.ok(block.includes(`./functions/${fn}/index.ts`), `config entrypoint wrong for ${fn}`)
}

// --- 7. useAuth: both helpers wired to the edge functions ---------------------
assert.match(useAuth, /supabase\.functions\.invoke\('employee-id-login'/)
assert.match(useAuth, /supabase\.functions\.invoke\('employee-id-signup'/)
assert.match(useAuth, /^\s*signInWithIdentifier,$/m)
assert.match(useAuth, /^\s*requestEmployeeIdSignup,$/m)

// --- 8. Login page: single identifier field, ID path is passwordless ---------
assert.match(loginPage, /import \{ isLoginEmployeeId \} from '\.\.\/utils\/employeeId'/)
assert.match(loginPage, /await signInWithIdentifier\(identifier\)/)
assert.match(loginPage, /await requestEmployeeIdSignup\(identifier\)/)
assert.match(loginPage, /if \(isLoginEmployeeId\(identifier\)\)/)
// Password input is hidden for employee-ID input; no legacy signUp() call.
assert.match(loginPage, /!isLoginEmployeeId\(identifier\) && \(/)
assert.ok(!/await signUp\(/.test(loginPage), 'Login must not call the legacy password signUp')
// Success states keep the user on the page (magic link / invitation by email).
assert.match(loginPage, /sent \? \(/)
assert.match(loginPage, /Magic link sent/)
// promoteSuperadmin stays email-path-only (skipped for the ID path).
assert.match(loginPage, /promoteSuperadmin/)

// --- 9. Task doc persisted as ground truth ------------------------------------
assert.match(taskDoc, /Employee-ID Sign-up and Sign-in/)

// --- 10. Behavioral: the real employeeId.js module ----------------------------
const util = await import(pathToFileURL(new URL('src/utils/employeeId.js', root).pathname).href)

// Legacy behaviour (ground truth — fingerprint terminal depends on it).
assert.equal(util.normalizeEmployeeId(' imfb / 26 '), 'IMFB/26')
assert.equal(util.isEmployeeIdFormat('IMFB/26'), true)
assert.equal(util.isEmployeeIdFormat('IMFB/14/0046'), false, 'legacy OFFICIAL_PATTERN stays one-slash')
assert.equal(util.isEmployeeIdFormat('238'), true, 'legacy PIN acceptance unchanged')
assert.equal(util.canonicalEmployeeId('IMFB/26'), 'IMFB/26')
assert.equal(util.canonicalEmployeeId('not/an/id'), null)
assert.equal(util.canonicalEmployeeId(''), null)

// New login helpers: multi-group IDs, PINs, emails.
assert.equal(util.normalizeLoginEmployeeId(' imfb / 14 / 0046 '), 'IMFB/14/0046')
assert.equal(util.isLoginEmployeeId('IMFB/26'), true)
assert.equal(util.isLoginEmployeeId(' imfb/14/0046 '), true)
assert.equal(util.isLoginEmployeeId('IMFB/09/0012'), true)
assert.equal(util.isLoginEmployeeId('238'), true, 'bare numeric PIN must keep working')
assert.equal(util.isLoginEmployeeId('user@example.com'), false)
assert.equal(util.isLoginEmployeeId(''), false)
assert.equal(util.isLoginEmployeeId('some name'), false)
assert.equal(util.looksLikeEmail('user@example.com'), true)
assert.equal(util.looksLikeEmail('IMFB/26'), false)
assert.equal(util.looksLikeEmail('a@b'), false)
assert.equal(util.looksLikeEmail(' imfb/14/0046 '), false)

console.log('employee-id-auth assertions passed.')