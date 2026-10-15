import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const resetPage = read('src/pages/ResetPassword.jsx')
const loginPage = read('src/pages/Login.jsx')
const useAuth = read('src/hooks/useAuth.jsx')
const app = read('src/App.jsx')
const template = read('supabase/templates/recovery.html')
const configToml = read('supabase/config.toml')

// --- 1. Behavioral: the real pure helper module ------------------------------
const util = await import(pathToFileURL(new URL('src/utils/passwordReset.js', root).pathname).href)

// decideRecoveryEntry: right args → verify; wrong type → invalid; none → session check.
assert.equal(util.decideRecoveryEntry({ tokenHash: 'abc123', type: 'recovery' }), 'verify')
assert.equal(util.decideRecoveryEntry({ tokenHash: 'abc123', type: 'signup' }), 'invalid')
assert.equal(util.decideRecoveryEntry({ tokenHash: 'abc123', type: '' }), 'invalid')
assert.equal(util.decideRecoveryEntry({ tokenHash: '', type: 'recovery' }), 'check-session')
assert.equal(util.decideRecoveryEntry({}), 'check-session')

// passwordRules: too short, mismatch, valid.
{
  const tooShort = util.passwordRules('short', 'short')
  assert.equal(tooShort.valid, false)
  assert.ok(tooShort.checks.find((c) => c.id === 'length').ok === false)
  const mismatch = util.passwordRules('longenough1', 'longenough2')
  assert.equal(mismatch.valid, false)
  assert.ok(mismatch.checks.find((c) => c.id === 'match').ok === false)
  const ok = util.passwordRules('longenough1', 'longenough1')
  assert.equal(ok.valid, true)
  assert.equal(util.MIN_PASSWORD_LENGTH, 8)
}

// Error mapping: weak password, same-as-old, expired session, cooldown.
assert.match(util.mapRecoveryError({ message: 'Password should be at least 8 characters.' }), /at least 8 characters/)
assert.match(util.mapRecoveryError({ code: 'weak_password' }), /too weak/)
assert.match(util.mapRecoveryError({ message: 'New password should be different from the old password.' }), /different from your old password/)
assert.match(util.mapRecoveryError({ message: 'Auth session missing!' }), /expired or was already used/)
assert.match(util.mapRecoveryError({ message: 'Email rate limit exceeded, please wait before retrying' }), /expired|try again|wait/i)
assert.equal(util.isCooldownError({ code: 'over_email_send_rate_limit' }), true)
assert.equal(util.isCooldownError({ message: 'For security purposes, you can only request this after 60 seconds.' }), true)
assert.equal(util.isCooldownError({ message: 'Invalid credentials' }), false)
assert.equal(util.isSessionGoneError({ message: 'Auth session missing!' }), true)
assert.equal(util.isSessionGoneError({ message: 'Password should be at least 6 characters.' }), false)
assert.equal(util.FORGOT_NEUTRAL_MESSAGE, 'If an account exists for that email, a reset link is on its way. Check your inbox and spam.')

// --- 2. ResetPassword page wiring ---------------------------------------------
// verifyOtp EXACTLY once, with the right args.
assert.equal((resetPage.match(/verifyOtp\(/g) || []).length, 1, 'verifyOtp must be called exactly once')
assert.match(resetPage, /verifyOtp\(\{ token_hash: tokenHash, type: 'recovery' \}\)/)
// Strict-mode double-call guard (ref, not state) + params cleanup on success.
assert.match(resetPage, /const bootedRef = useRef\(false\)/)
assert.match(resetPage, /if \(!bootedRef\.current\) \{/)
assert.match(resetPage, /setSearchParams\(\{\}, \{ replace: true \}\)/)
// No verifyOtp when params missing → session check instead.
assert.match(resetPage, /entry === 'check-session'|const \{ data \} = await supabase\.auth\.getSession\(\)/)
assert.match(resetPage, /data\?\.session \? 'ready' : 'invalid'/)
// PASSWORD_RECOVERY fallback listener.
assert.match(resetPage, /onAuthStateChange/)
assert.match(resetPage, /event === 'PASSWORD_RECOVERY'/)
// States: verifying/ready/invalid/success + "Request a new link" + neutral invalid copy.
for (const s of ["'verifying'", "'ready'", "'invalid'", "'success'"]) {
  assert.ok(resetPage.includes(`status === ${s}`), `missing state ${s}`)
}
assert.match(resetPage, /Request a new link/)
assert.match(resetPage, /This reset link is no longer valid/)
assert.match(resetPage, /Verifying your reset link/)
// Form: rules live, submit disabled until valid, show/hide toggle.
assert.match(resetPage, /passwordRules\(password, confirm, MIN_PASSWORD_LENGTH\)/)
assert.match(resetPage, /disabled=\{!rules\.valid \|\| submitting\}/)
assert.match(resetPage, /EyeOff/)
assert.match(resetPage, /aria-label=\{showPassword \? 'Hide password' : 'Show password'\}/)
// Success path: completePasswordReset → signOut others → success → local signOut + #/login after 2 s.
assert.match(resetPage, /await completePasswordReset\(password\)/)
assert.match(resetPage, /signOut\(\{ scope: 'others' \}\)/)
assert.match(resetPage, /Password updated/)
assert.match(resetPage, /Sign in with your new password/)
assert.match(resetPage, /window\.location\.hash = '#\/login'/)
assert.match(resetPage, /}, 2000\)/)
// Visual consistency with Login.
assert.match(resetPage, /bg-\[#0a0b0d\]/)
assert.match(resetPage, /bg-\[#009944\]/)
assert.match(resetPage, /<Logo size=\{60\}/)

console.log('password-recovery assertions (part 1) passed.')
// --- 3. useAuth: forgotPassword targets #/reset-password, completes via updateUser ---
assert.match(useAuth, /resetPasswordForEmail\(\s*\n?\s*String\(email \|\| ''\)\.trim\(\)\.toLowerCase\(\),/)
assert.match(useAuth, /redirectTo: `\$\{APP_URL\}\/#\/reset-password`/)
assert.ok(!useAuth.includes('AUTH_REDIRECT_URL'), 'forgotPassword must not point at the activate page anymore')
assert.match(useAuth, /const completePasswordReset = async \(newPassword\) => \{/)
assert.match(useAuth, /supabase\.auth\.updateUser\(\{ password: newPassword \}\)/)
assert.match(useAuth, /^\s*completePasswordReset,$/m)

// --- 4. Login: neutral forgot message, cooldown surface, #/forgot-password alias ---
assert.match(loginPage, /import \{ FORGOT_NEUTRAL_MESSAGE, isCooldownError \} from '\.\.\/utils\/passwordReset'/)
assert.match(loginPage, /await forgotPassword\(identifier\)/)
assert.match(loginPage, /if \(isCooldownError\(err\)\) setError\('Please wait a minute before requesting another link'\)/)
assert.match(loginPage, /\{FORGOT_NEUTRAL_MESSAGE\}/)
assert.ok(
  !loginPage.includes('If that email is registered'),
  'old non-neutral forgot copy must be gone',
)
assert.match(loginPage, /location\.pathname === '\/forgot-password' \? 'forgot' : 'signin'/)
// Sign-in / sign-up behaviour untouched.
assert.match(loginPage, /await signInWithIdentifier\(identifier\)/)
assert.match(loginPage, /await requestEmployeeIdSignup\(identifier\)/)
assert.match(loginPage, /await signIn\(identifier, password\)/)

// --- 5. App.jsx: exactly the two public routes, outside the guards --------------
for (const route of ['/reset-password', '/forgot-password']) {
  assert.ok(
    app.includes(`<Route path="${route}"`),
    `App.jsx is missing the public route ${route}`,
  )
}
assert.match(app, /import ResetPassword from '\.\/pages\/ResetPassword'/)
const routesIdx = app.indexOf('<Route path="/reset-password"')
const protectedIdx = app.indexOf('protectedRoutes.filter')
assert.ok(routesIdx > -1 && protectedIdx > -1 && routesIdx < protectedIdx, 'public routes must sit before the protected block')
// Guard logic itself untouched.
assert.match(app, /if \(!user\) return <Navigate to="\/login" replace \/>/)

// --- 6. Recovery template: exact link shape, host-safe, no ConfirmationURL -----
assert.ok(!template.includes('ConfirmationURL'), 'template must not use {{ .ConfirmationURL }}')
const HREF = '{{ .SiteURL }}/#/reset-password?token_hash={{ .TokenHash }}&amp;type=recovery'
assert.ok(template.includes(HREF), 'template href must be the exact token_hash recovery URL')
assert.ok(template.includes('{{ .SiteURL }}') && template.includes('{{ .TokenHash }}'))
// No hard-coded host anywhere in the template.
assert.ok(!/https?:\/\/(?!www\.w3\.org)[a-z0-9.-]+/i.test(template.replace(/&amp;/g, '&').replace(/https:\/\/www\.w3\.org/g, '')), 'template must not hard-code any host')
assert.match(template, /This link expires in 1 hour and can be used once\. If you did not request this, ignore this email\./)
assert.match(template, /#009944/)

// --- 7. Local render check: final link host = infinitymfbcore.vercel.app ------
{
  const rendered = template
    .replaceAll('{{ .SiteURL }}', 'https://infinitymfbcore.vercel.app')
    .replaceAll('{{ .TokenHash }}', 'sampletokenhash123')
    .replaceAll('&amp;', '&')
  const link = 'https://infinitymfbcore.vercel.app/#/reset-password?token_hash=sampletokenhash123&type=recovery'
  assert.ok(rendered.includes(link), 'rendered template must contain the production-host reset link')
  const hosts = [...new Set([...rendered.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]))]
  assert.deepEqual(hosts, ['infinitymfbcore.vercel.app'], 'rendered template must reference exactly one host')
  assert.equal(new URL(link.split('#')[0]).host, 'infinitymfbcore.vercel.app')
  assert.equal(new URL(`https://x/${link.split('#')[1]}`).searchParams.get('type'), 'recovery')
}

// --- 8. config.toml local-dev template registration ----------------------------
assert.match(configToml, /\[auth\.email\.template\.recovery\]/)
assert.match(configToml, /subject = "Reset your Infinity Core password"/)
assert.match(configToml, /content_path = "\.\/supabase\/templates\/recovery\.html"/)

console.log('password-recovery assertions passed.')
