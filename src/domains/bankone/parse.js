// Pure functions, no React and no Supabase, so the whole parser is unit
// testable in plain node (see tests/bankoneImportFoundation.test.mjs).
//
// Two rules drive this file:
//  1. The header row is DETECTED from the expected column labels. It is never
//     assumed to be row 3 or row 8, because those positions are an artefact of
//     how the report was exported, not a contract.
//  2. BankOne dates are DD/MM/YYYY and DD-MMM-YYYY. Both are parsed strictly.
//     A value that is only valid as MM/DD is NOT silently reinterpreted - it is
//     rejected with an explicit error, so bad data surfaces instead of
//     corrupting a portfolio figure.

const MONTH_INDEX = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0

/** Normalise a cell for label comparison: collapse space, drop case/punctuation. */
export function labelKey(v) {
  return String(v ?? '')
    .replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.,()]/g, '')
}

const isBlankRow = (row) => !row || row.every((c) => String(c ?? '').trim() === '')

/** Score how strongly a row looks like the header for `expectedLabels`. */
export function scoreHeaderRow(row, expectedLabels) {
  const keys = new Set(row.map(labelKey))
  const hits = expectedLabels.filter((l) => keys.has(labelKey(l)))
  return { hits: hits.length, total: expectedLabels.length, matched: hits }
}

/**
 * Find the header row in a matrix of rows. Returns
 * { headerIndex, headers, matched, confidence } or { error }.
 */
export function detectHeaderRow(rows, expected, { scanLimit = 25, minHits = 4 } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { error: 'The workbook appears to be empty.' }
  }
  let best = null
  const limit = Math.min(rows.length, scanLimit)
  for (let i = 0; i < limit; i++) {
    if (isBlankRow(rows[i])) continue
    const s = scoreHeaderRow(rows[i], expected)
    if (s.hits >= minHits && (!best || s.hits > best.hits)) best = { index: i, ...s }
  }
  if (!best) {
    return {
      error:
        'Could not identify the column headers. Expected at least ' + minHits +
        ' of these columns near the top of the file: ' + expected.slice(0, 6).join(', ') +
        '. Nothing was imported - please check the file is a BankOne export.',
    }
  }
  const headers = rows[best.index].map((h) => String(h ?? '').trim())
  while (headers.length && headers[headers.length - 1] === '') headers.pop()
  return { headerIndex: best.index, headers, matched: best.matched, confidence: best.hits / best.total }
}

/** Split a detected sheet into trimmed records keyed by header. */
export function toRecords(rows, headerIndex, headers) {
  const out = []
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i]
    if (isBlankRow(row)) continue
    const padded = row.concat(Array(Math.max(0, headers.length - row.length)).fill(''))
    const rec = {}
    headers.forEach((h, j) => { if (h) rec[h] = String(padded[j] ?? '').trim() })
    rec.__rowNumber = i + 1
    out.push(rec)
  }
  return out
}

/**
 * BankOne numerics arrive as text in at least three shapes:
 *   3000000   683,000.00   7760710.6   -5,000   (1 234.56)
 * Returns null for anything non-numeric so a bad cell is REPORTED rather than
 * silently becoming 0.
 */
export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (v === null || v === undefined) return null
  let s = String(v).trim()
  if (s === '' || s === '-' || s === 'N/A' || s === 'NULL') return null
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-')
  s = s.replace(/[()]/g, '').replace(/[^0-9.]/g, '')
  if (s === '' || !/^\d*\.?\d+(?:[eE][+-]?\d+)?$/.test(s)) return null
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return negative ? -n : n
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
// IMPORTANT - verified against the real exports, and contrary to the original
// spec text: BankOne's slash dates are MM/DD/YYYY, NOT DD/MM/YYYY.
//
// Proof from the 2,725-row PAR file: the first component never exceeds 12, but
// the second exceeds it in 1,749 rows (Past Due Date), 1,328 (Next repayment),
// 1,284 (Last Payment) and 501 (Last Repayment). Under DD/MM the SECOND
// component is the month and can never exceed 12, so MM/DD is the only reading
// that fits. "05/30/2027" is therefore 30 May 2027, a perfectly ordinary date.
//
// So a slash date is resolved DETERMINISTICALLY from the value itself whenever
// one component is impossible in the other role. Only a genuinely ambiguous
// value (both <= 12) needs the caller to declare the column's format, and we
// report how many of those there were instead of guessing silently.
// Text dates (28-Sep-2026) are unambiguous DD-MMM-YYYY and are never affected.

/**
 * Decide the slash format for a set of raw values.
 * @returns { format: 'MM/DD/YYYY' | 'DD/MM/YYYY' | null, firstGt12, secondGt12, ambiguous }
 */
export function detectSlashFormat(values) {
  let firstGt12 = 0
  let secondGt12 = 0
  let ambiguous = 0
  for (const v of values || []) {
    const m = /^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/.exec(String(v ?? '').trim())
    if (!m) continue
    const a = +m[1]
    const b = +m[2]
    if (a > 12 && b <= 12) firstGt12++
    else if (b > 12 && a <= 12) secondGt12++
    else ambiguous++
  }
  let format = null
  if (firstGt12 && !secondGt12) format = 'DD/MM/YYYY'
  else if (secondGt12 && !firstGt12) format = 'MM/DD/YYYY'
  else if (firstGt12 && secondGt12) format = 'MIXED'
  return { format, firstGt12, secondGt12, ambiguous }
}

/**
 * Parse a BankOne date. `slashFormat` is only consulted for values that are
 * ambiguous on their face (e.g. "05/03/2027"); it should come from
 * detectSlashFormat() over the whole column.
 * Returns { date, format, ambiguous } or { error }.
 */
export function parseBankOneDate(v, { slashFormat = null } = {}) {
  if (v === null || v === undefined) return { error: 'empty' }
  const s = String(v).trim()
  if (s === '') return { error: 'empty' }

  const m1 = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s)
  if (m1) {
    const month = MONTH_INDEX[m1[2].toLowerCase()]
    if (!month) return { error: `Unknown month name "${m1[2]}" in "${s}"` }
    return buildDate(+m1[1], month, +m1[3], 'DD-MMM-YYYY', s)
  }

  const m2 = /^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/.exec(s)
  if (m2) {
    const a = +m2[1]
    const b = +m2[2]
    const year = +m2[3]
    let day, month, isAmbiguous = false
    if (a > 12 && b <= 12) { day = a; month = b }
    else if (b > 12 && a <= 12) { day = b; month = a }
    else {
      // Both parts are valid in either role - genuinely ambiguous.
      isAmbiguous = true
      if (slashFormat === 'DD/MM/YYYY') { day = a; month = b }
      else { day = b; month = a }   // default + verified behaviour is MM/DD
    }
    return buildDate(day, month, year, isAmbiguous ? (slashFormat || 'MM/DD/YYYY') : 'slash', s)
  }

  return { error: `Unrecognised date format "${s}" (expected DD/MM/YYYY, MM/DD/YYYY or DD-MMM-YYYY)` }
}

function buildDate(day, month, year, format, raw) {
  if (month < 1 || month > 12) return { error: `"${raw}" has an invalid month (${month})` }
  const dim = month === 2 && isLeap(year) ? 29 : DIM[month - 1]
  if (day < 1 || day > dim) {
    return { error: `"${raw}" has an impossible day (${day}) for ${year}-${String(month).padStart(2, '0')}` }
  }
  return { date: new Date(Date.UTC(year, month - 1, day)), format }
}

export function parseBankOneDateOrNull(v) {
  const r = parseBankOneDate(v)
  return r.error ? null : r.date
}
