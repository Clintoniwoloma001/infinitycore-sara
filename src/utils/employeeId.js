/**
 * Employee identifier helpers — central normalization + validation for the
 * canonical business employee number (IMFB/26).
 *
 * The slash is part of the official employee number and is NEVER stripped.
 * Lookups are case-insensitive and tolerant of stray whitespace, but the
 * canonical value stored in the database is preserved exactly.
 */

// Matches "IMFB/26", " imfb/26 ", "IMFB / 26" — collapses spaces around the
// slash and elsewhere, uppercases, and returns the canonical "IMFB/26".
export function normalizeEmployeeId(input) {
  if (!input || typeof input !== 'string') return ''
  return input
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*\/\s*/g, '/')
    .toUpperCase()
}

const OFFICIAL_PATTERN = /^[A-Z0-9]+\/\d+$/
const MULTI_GROUP_IDENTIFIER_PATTERN = /^[A-Z0-9]+\/\d+\/\d+$/

export function isEmployeeIdFormat(input) {
  const v = normalizeEmployeeId(input)
  if (!v) return false
  if (OFFICIAL_PATTERN.test(v)) return true
  // Also accept bare numeric/PIN-style inputs used by fingerprint devices
  // (e.g. "238") so the terminal keeps working for device user-ids.
  return /^\d{1,9}$/.test(v)
}

// Returns the display-safe canonical form, or null when it does not look
// like an employee/device id at all.
export function canonicalEmployeeId(input) {
  const v = normalizeEmployeeId(input)
  if (!v) return null
  if (OFFICIAL_PATTERN.test(v) || /^\d{1,9}$/.test(v)) return v
  return null
}

// ---------------------------------------------------------------------------
// Employee-ID sign-up / sign-in helpers (added for the employee-id-auth flow).
// Existing exports below are unchanged.
// ---------------------------------------------------------------------------

// Normalized, case/space-insensitive employee or device identifier used for
// the login endpoint (email or employee ID). Mirrors the server-side
// normalizeEmployeeId behaviour so the browser and the database never disagree.
export function normalizeLoginEmployeeId(input) {
  if (!input || typeof input !== 'string') return ''
  return input
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*\/\s*/g, '/')
    .toUpperCase()
}

// True when the normalized value is an employee or device identifier — the
// official /[A-Z0-9]+/\d+/ shape, a multi-group form such as IMFB/14/0046, or
// a bare numeric PIN used by fingerprint devices (e.g. "238").
export function isLoginEmployeeId(input) {
  const v = normalizeLoginEmployeeId(input)
  if (!v) return false
  if (OFFICIAL_PATTERN.test(v)) return true
  if (MULTI_GROUP_IDENTIFIER_PATTERN.test(v)) return true
  // Fingerprint/device PIN-style ids (e.g. "238") so the terminal keeps working.
  return /^\d{1,9}$/.test(v)
}

// True for a plausible email address — used by the login/sign-up UI to decide
// the sign-up tab mode and to keep the two identifier families apart.
export function looksLikeEmail(input) {
  if (!input || typeof input !== 'string') return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.trim())
}


