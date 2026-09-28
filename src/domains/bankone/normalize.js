// ============================================================================
// BankOne name normalisation - shared by the employee and branch resolvers
// ============================================================================
// Pure string helpers. Kept in one file so an employee name and a branch name
// are always folded by the SAME rules, and so the rules are unit testable.

// BankOne emits names as "SURNAME, OTHER NAMES"; InfinityCore stores
// "SURNAME OTHER NAMES". The comma is punctuation, not meaning.
export function normalizeName(v) {
  return String(v ?? '')
    .replace(/,/g, ' ')
    .replace(/[.\-_/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
}

/** Everything that is not a letter or digit, removed. Catches hyphen/space variants. */
export function squashName(v) {
  return String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function nameTokens(v) {
  const n = normalizeName(v)
  return n ? n.split(' ').filter(Boolean) : []
}

/** Order-insensitive key, so "ADEOTI MONSURAT FUNMILAYO" == "ADEOTI FUNMILAYO MONSURAT". */
export function tokenKey(v) {
  const t = nameTokens(v).sort()
  return t.length ? t.join(' ') : ''
}

/** Branch names additionally treat "&", "/" and "-" as structure, not text. */
export function normalizeBranch(v) {
  return String(v ?? '')
    .replace(/[.\-_/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
}
