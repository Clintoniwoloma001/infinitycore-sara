/**
 * Pure helpers for the forgot/reset password flow. No Supabase or DOM access,
 * so the logic is directly unit-testable (tests/passwordReset.test.mjs) and the
 * ResetPassword page stays presentation-only.
 */

// Recommended minimum. The hosted project's password_min_length could not be
// read from the Management API in this environment — keep this in sync with
// Dashboard → Authentication → Settings → Password minimum length.
export const MIN_PASSWORD_LENGTH = 8

export const FORGOT_NEUTRAL_MESSAGE =
  'If an account exists for that email, a reset link is on its way. Check your inbox and spam.'

/**
 * Decides how ResetPassword should boot from the hash-route query.
 * 'verify'         — token_hash + type=recovery present → run verifyOtp once
 * 'invalid'        — token_hash present but wrong type → dead link
 * 'check-session'  — no params → only proceed if a recovery session already
 *                    exists (redirect path / PASSWORD_RECOVERY event)
 */
export function decideRecoveryEntry({ tokenHash, type } = {}) {
  const hash = String(tokenHash || '').trim()
  const kind = String(type || '').trim().toLowerCase()
  if (!hash) return 'check-session'
  if (kind !== 'recovery') return 'invalid'
  return 'verify'
}

/**
 * Live password rules for the reset form.
 * Returns each check (so the UI can render them live) and overall validity.
 */
export function passwordRules(password, confirm, minLength = MIN_PASSWORD_LENGTH) {
  const pwd = String(password || '')
  const conf = String(confirm || '')
  const checks = [
    { id: 'length', label: `At least ${minLength} characters`, ok: pwd.length >= minLength },
    { id: 'match', label: 'Both passwords match', ok: pwd.length > 0 && pwd === conf },
  ]
  return { checks, valid: checks.every((c) => c.ok) }
}

/** Supabase sends an email-cooldown error when the user re-requests too fast. */
export function isCooldownError(error) {
  const message = String(error?.message || error?.error_description || '').toLowerCase()
  const code = String(error?.code || error?.error_code || '').toLowerCase()
  return (
    code === 'over_email_send_rate_limit' ||
    code === 'email_rate_limit_exceeded' ||
    /rate limit|too many requests|for security purposes.*request this after/.test(message)
  )
}

/** Friendly copy for the errors updateUser/verifyOtp can produce. */
export function mapRecoveryError(error, minLength = MIN_PASSWORD_LENGTH) {
  const message = String(error?.message || error?.error_description || '')
  const code = String(error?.code || error?.error_code || '').toLowerCase()
  const lower = message.toLowerCase()
  if (code === 'weak_password' || /password should be at least|weak password/.test(lower)) {
    return `Password is too weak — use at least ${minLength} characters.`
  }
  if (/different from (your|the) old password|same password|should be different/.test(lower)) {
    return 'New password must be different from your old password.'
  }
  if (/session|jwt|not authenticated|missing|token.*expired|link has expired/i.test(lower)) {
    return 'This reset link has expired or was already used. Request a new link.'
  }
  return message || 'Something went wrong. Please try again.'
}

/** True when the error means the recovery session itself is gone/used. */
export function isSessionGoneError(error) {
  const message = String(error?.message || error?.error_description || '').toLowerCase()
  return /session|jwt|not authenticated|missing/.test(message)
}
