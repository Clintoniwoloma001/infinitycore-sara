// Pure, deterministic and testable. The cascade runs top to bottom and STOPS at
// the first stage that produces a decision:
//
//   1. existing permanent mapping   (auto)
//   2. exact normalized name        (auto, only when UNIQUE)
//   3. punctuation/format variant   (auto, only when UNIQUE)
//   4. token reordering             (review - ambiguous by nature)
//   5. known BankOne truncation     (review - always)
//   6. high-confidence candidate    (review)
//   7. manual review                (no decision)
//   8. completely unmatched         (retained, never invented)
//
// The invariant that matters most: a name is NEVER treated as a unique identity.
// Real duplicates exist in the employee data, so any stage that could match more
// than one employee is demoted to `pending_review` instead of picking one.
// Nothing here writes anything - it only decides, and explains why.
import { normalizeName, squashName, nameTokens, tokenKey } from './normalize.js'

export const MATCH = {
  MAPPING: 'existing_mapping',
  EXACT: 'exact_normalized',
  FORMAT: 'normalized_format',
  TOKEN: 'token_reorder',
  TRUNCATION: 'truncation',
  CANDIDATE: 'high_confidence',
  UNRESOLVED: 'unresolved',
}

/** Stages that may be auto-applied without a human decision. */
export const AUTO_STAGES = new Set([MATCH.MAPPING, MATCH.EXACT, MATCH.FORMAT])

/** Minimum token overlap before we even call something a truncation match. */
const CANDIDATE_MIN_OVERLAP = 0.99

/**
 * Build the lookup indexes once, then resolve many names against them.
 * employees: [{ id, full_name, branch?, employment_status? }]
 */
export function createEmployeeIndex(employees) {
  const list = employees || []
  const byExact = new Map()   // normalised name   -> [employee]
  const bySquash = new Map()  // no punctuation    -> [employee]
  const byTokens = new Map()  // sorted token key  -> [employee]
  for (const e of list) {
    if (!normalizeName(e.full_name)) continue
    push(byExact, normalizeName(e.full_name), e)
    push(bySquash, squashName(e.full_name), e)
    push(byTokens, tokenKey(e.full_name), e)
  }
  return { list, byExact, bySquash, byTokens }
}

function push(map, key, value) {
  if (!key) return
  if (!map.has(key)) map.set(key, [])
  map.get(key).push(value)
}

const unique = (arr) => (arr && arr.length === 1 ? arr[0] : null)

/**
 * Resolve one BankOne officer name.
 * @returns { status, matchType, employeeId, employee, confidence, reason, candidates }
 *   status is 'auto_resolved' | 'pending_review' | 'unresolved'
 */
export function resolveOfficer(rawName, index, savedMappings = new Map()) {
  const normalized = normalizeName(rawName)
  const base = { sourceName: rawName, normalizedSourceName: normalized }

  if (!normalized) {
    return { ...base, status: 'unresolved', matchType: MATCH.UNRESOLVED, confidence: 0, reason: 'No officer name was present on the row.' }
  }

  // 1. A permanent mapping an administrator already confirmed. This is what
  //    makes a SECOND import resolve with no new question.
  const saved = savedMappings.get(normalized)
  if (saved && saved.status === 'active' && saved.employee_id) {
    const emp = index.list.find((e) => e.id === saved.employee_id)
    if (emp) {
      return {
        ...base, status: 'auto_resolved', matchType: MATCH.MAPPING,
        employeeId: emp.id, employee: emp, confidence: 1,
        reason: 'Resolved by a saved BankOne mapping (confirmed previously).',
      }
    }
    return {
      ...base, status: 'pending_review', matchType: MATCH.MAPPING,
      confidence: 1, candidates: [],
      reason: 'A saved mapping points at an employee that no longer exists. It needs re-confirmation.',
    }
  }

  // 2. Exact normalised name - auto ONLY when exactly one employee matches.
  const exact = unique(index.byExact.get(normalized))
  if (exact) {
    return {
      ...base, status: 'auto_resolved', matchType: MATCH.EXACT,
      employeeId: exact.id, employee: exact, confidence: 1,
      reason: 'Exact name match after normalising case, spacing and the source comma.',
    }
  }
  const exactMany = index.byExact.get(normalized) || []

  // 3. Punctuation / formatting variant (e.g. hyphen vs space).
  const fmt = unique(index.bySquash.get(squashName(rawName)))
  if (fmt) {
    return {
      ...base, status: 'auto_resolved', matchType: MATCH.FORMAT,
      employeeId: fmt.id, employee: fmt, confidence: 0.98,
      reason: 'Matched after ignoring punctuation and spacing differences.',
    }
  }

  // 4. Same name tokens in a different order - ambiguous by nature, so review.
  const tokenMatches = index.byTokens.get(tokenKey(rawName)) || []
  if (tokenMatches.length === 1) {
    return {
      ...base, status: 'pending_review', matchType: MATCH.TOKEN,
      confidence: 0.9, candidates: tokenMatches,
      reason: 'The same name words appear in a different order. Confirm this is the same person.',
    }
  }
  if (tokenMatches.length > 1) {
    return {
      ...base, status: 'pending_review', matchType: MATCH.TOKEN,
      confidence: 0.5, candidates: tokenMatches,
      reason: `${tokenMatches.length} employees share these name words; an administrator must choose.`,
    }
  }

  // 5. BankOne TRUNCATION: the source name is an ORDERED PREFIX of exactly one
  //    employee name - BankOne truncates, it does not reorder. This is distinct
  //    from stage 4 and always goes to review, because a prefix match is strong
  //    evidence but is not proof of identity.
  const trunc = truncationMatch(rawName, index.list)
  if (trunc.length === 1) {
    return {
      ...base, status: 'pending_review', matchType: MATCH.TRUNCATION,
      confidence: 0.95, candidates: [trunc[0].employee],
      reason: 'The BankOne source name appears truncated; it is a prefix of one employee name.',
    }
  }
  if (trunc.length > 1) {
    return {
      ...base, status: 'pending_review', matchType: MATCH.TRUNCATION,
      confidence: 0.5, candidates: trunc.map((c) => c.employee),
      reason: `${trunc.length} employees start with this name; an administrator must choose.`,
    }
  }

  // 6. High-confidence candidate: all source tokens present, but not a prefix.
  const cands = partialCandidates(rawName, index.list)
  if (cands.length >= 1) {
    return {
      ...base, status: 'pending_review', matchType: MATCH.CANDIDATE,
      confidence: cands[0].overlap, candidates: cands.slice(0, 5).map((c) => c.employee),
      reason: 'Closest possible employee found, but the names do not fully agree.',
    }
  }

  // 8. Nothing plausible. Retained as unresolved - NEVER auto-created.
  return {
    ...base, status: 'unresolved', matchType: MATCH.UNRESOLVED, confidence: 0,
    candidates: exactMany,
    reason: 'No InfinityCore employee matches this BankOne name.',
  }
}

/**
 * Employees whose ORDERED token list begins with the source name's token list.
 * "ABIWON TOLULOPE" is a prefix of "ABIWON TOLULOPE AYODEJI" -> truncated.
 * A mere reordering is NOT a truncation; stage 4 already caught that.
 */
function truncationMatch(rawName, employees) {
  const src = nameTokens(rawName)
  if (src.length === 0) return []
  const out = []
  for (const e of employees) {
    const full = nameTokens(e.full_name)
    if (full.length <= src.length) continue            // not a truncation if equal/shorter
    if (src.every((t, i) => full[i] === t)) out.push({ employee: e, extra: full.length - src.length })
  }
  // Prefer the SHORTEST completion: the closest full name to the truncated one.
  return out.sort((a, b) => a.extra - b.extra)
}

/** Employees whose normalised name contains every token of the BankOne name. */
function partialCandidates(rawName, employees) {
  const parts = nameTokens(rawName).filter((t) => t.length > 2)
  if (parts.length === 0) return []
  const out = []
  for (const e of employees) {
    const full = normalizeName(e.full_name)
    if (!full) continue
    if (parts.every((p) => full.includes(p))) {
      out.push({ employee: e, overlap: parts.length / Math.max(parts.length, nameTokens(e.full_name).length) })
    }
  }
  return out.sort((a, b) => b.overlap - a.overlap)
}

/** Resolve every distinct officer name in a batch, keyed by normalised name. */
export function resolveAll(names, employees, savedMappings = new Map()) {
  const index = createEmployeeIndex(employees)
  const out = new Map()
  for (const n of names) {
    const key = normalizeName(n)
    if (!key || out.has(key)) continue
    out.set(key, resolveOfficer(n, index, savedMappings))
  }
  return out
}

export const isAutoResolvable = (matchType) => AUTO_STAGES.has(matchType)
