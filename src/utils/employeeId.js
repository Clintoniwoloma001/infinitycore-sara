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