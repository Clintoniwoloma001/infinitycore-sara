// ============================================================================
// Director multi-metric import — pure domain logic (no React, no Supabase).
// ============================================================================
// WHY: the MPR sheet an operator uploads may carry ANY SUBSET of the metrics
// (caseload only, or buckets only, or everything). This module turns a parsed
// sheet (array of row objects keyed by header) into:
//   * a column-mapping proposal (fuzzy-matched to the canonical fields),
//   * a list of upsert rows {employee_id, as_of_date, metric_key, value},
//   * preview counts (new / update / unchanged / conflict / unmatched).
//
// RULES ENFORCED HERE
//   * Reuses the EXISTING bucket definition from performance/mprEngine.js — this
//     file never defines its own day ranges or points. Single source of truth.
//   * Never creates an employee: a row whose staff code/name does not resolve to
//     a known employee_id goes to `unmatched`, not into the upsert list.
//   * Rejects negatives for counts and impossible percentages (>100) so bad data
//     surfaces instead of silently corrupting a figure.
//   * as_of_date stays a plain YYYY-MM-DD string end to end (no UTC conversion).
// ============================================================================

import { PAR_STATUS_BUCKETS, bucketForDaysPastDue } from '../performance/mprEngine.js'

// The canonical fields the importer recognises, each with the fuzzy variants it
// accepts. Keys are the metric_key values stored in director_metric_values.
export const FIELD_SYNONYMS = {
  staff_code: ['staff code', 'staff id', 'employee code', 'employee id', 'staff no', 'staff number', 'imfb', 'code'],
  staff_name: ['staff name', 'account officer', 'officer', 'officer name', 'employee name', 'name', 'loan officer'],
  branch: ['branch', 'branch name', 'location'],
  as_of_date: ['as of date', 'as-at date', 'as at', 'date', 'period', 'report date', 'reporting date', 'asofdate'],
  portfolio: ['portfolio', 'total outstanding', 'total outst. prin.', 'outstanding', 'loan portfolio', 'total outstanding principal'],
  par_amount: ['par amount', 'at risk', 'at-risk', 'non performing', 'non-performing', 'par principal'],
  par_pct: ['par %', 'par percent', 'par percentage', 'par ratio', 'portfolio at risk %'],
  pass_watch: ['pass & watch', 'pass and watch', 'pwl', 'watch', 'pass watch'],
  substandard: ['substandard', 'sub standard', 'sub-standard'],
  doubtful: ['doubtful'],
  lost: ['lost'],
  caseload_count: ['caseload', 'case load', 'case-load', 'active client loans', 'active clients', 'number of loans', 'loan count', 'no of loans', 'caseload count'],
  caseload_amount: ['caseload amount', 'case load amount', 'caseload principal'],
  disbursement_amount: ['disbursement', 'disbursed', 'amount disbursed', 'disbursement amount', 'total disbursed', 'loans disbursed'],
  disbursement_count: ['disbursement count', 'number disbursed', 'loans disbursed count', 'disbursed count'],
}

// Metrics whose unit is a count (reject negatives) vs amount/percent.
const COUNT_METRICS = new Set(['caseload_count', 'disbursement_count'])
const PERCENT_METRICS = new Set(['par_pct'])

const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.,()]/g, '')

/** Score how well a header matches a canonical field. 0 = no match. */
export function scoreField(header, field) {
  const h = norm(header)
  if (!h) return 0
  const variants = FIELD_SYNONYMS[field] || []
  for (const v of variants) {
    const nv = norm(v)
    if (h === nv) return 100
    if (h.includes(nv) || nv.includes(h)) return 70
  }
  return 0
}

/**
 * Propose a column mapping from the sheet's headers to canonical fields.
 * Each canonical field gets the single best-scoring header (>=70), so a header
 * is never double-assigned and a field with no match is simply absent.
 * Returns { field: header }.
 */
export function proposeMapping(headers = []) {
  const candidates = []
  for (const field of Object.keys(FIELD_SYNONYMS)) {
    for (const header of headers) {
      const score = scoreField(header, field)
      if (score >= 70) candidates.push({ field, header, score })
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  const usedHeaders = new Set()
  const usedFields = new Set()
  const mapping = {}
  for (const c of candidates) {
    if (usedHeaders.has(c.header) || usedFields.has(c.field)) continue
    mapping[c.field] = c.header
    usedHeaders.add(c.header)
    usedFields.add(c.field)
  }
  return mapping
}

/** Parse a cell into a number, or null if non-numeric (never coerced to 0). */
export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  if (s === '') return null
  const neg = /^\(.*\)$/.test(s)
  const cleaned = s.replace(/[(),\s]/g, '').replace(/^\((.*)\)$/, '$1')
  const n = Number(cleaned)
  if (!Number.isFinite(n)) return null
  return neg ? -Math.abs(n) : n
}

/** Validate a value for a metric. Returns null if OK, else a reason string. */
export function validateMetricValue(metricKey, value) {
  if (value === null || value === undefined) return 'not a number'
  if (COUNT_METRICS.has(metricKey) && value < 0) return 'negative count'
  if (value < 0) return 'negative value'
  if (PERCENT_METRICS.has(metricKey) && value > 100) return 'percent over 100'
  return null
}

// Metric keys that are PAR-bucket amounts, in the order the engine sums them.
export const PAR_BUCKET_KEYS = ['pass_watch', 'substandard', 'doubtful', 'lost']

/**
 * Turn parsed sheet rows + a column mapping + an employee resolver into upsert
 * rows and a preview summary. Employee matching is by staff code first, then
 * normalized name (the resolver does that); anything unresolved is reported.
 *
 * @param {object[]} records   parsed rows keyed by header
 * @param {object}   mapping   { field: header }
 * @param {function} resolveEmployee (row) => employee_id | null
 * @param {string}   defaultAsOf  YYYY-MM-DD used when the sheet has no date col
 * @returns {{ rows, summary, unmatched }}
 */
export function buildImportRows(records = [], mapping = {}, resolveEmployee, defaultAsOf = null) {
  const rows = []
  const unmatched = []
  const metricFields = Object.keys(FIELD_SYNONYMS).filter(
    (f) => !['staff_code', 'staff_name', 'branch', 'as_of_date'].includes(f)
  )

  for (const rec of records) {
    const employeeId = resolveEmployee ? resolveEmployee(rec) : null
    if (!employeeId) {
      unmatched.push({ row: rec, reason: 'no employee match' })
      continue
    }
    // as_of_date: from the mapped column if present, else the default.
    let asOf = defaultAsOf
    if (mapping.as_of_date && rec[mapping.as_of_date]) {
      const raw = String(rec[mapping.as_of_date]).trim()
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) asOf = raw
    }
    if (!asOf) {
      unmatched.push({ row: rec, reason: 'no as_of_date' })
      continue
    }

    for (const field of metricFields) {
      const header = mapping[field]
      if (!header) continue
      const value = toNumber(rec[header])
      if (value === null) continue // blank cell = metric not present for this row
      const err = validateMetricValue(field, value)
      if (err) {
        unmatched.push({ row: rec, reason: `${field}: ${err}` })
        continue
      }
      rows.push({ employee_id: employeeId, as_of_date: asOf, metric_key: field, value })
    }
  }

  const perMetric = {}
  for (const r of rows) perMetric[r.metric_key] = (perMetric[r.metric_key] || 0) + 1
  return {
    rows,
    unmatched,
    summary: {
      proposed: rows.length,
      per_metric: perMetric,
      unmatched_count: unmatched.length,
      employees: new Set(rows.map((r) => r.employee_id)).size,
      as_of_dates: [...new Set(rows.map((r) => r.as_of_date))].sort(),
    },
  }
}

/**
 * Compute a SHA-256 hex digest of a file's bytes. Uses the Web Crypto API when
 * available (browser + Node 18+) so the same function works in both the app and
 * the node unit test. Returns a Promise<string>.
 */
export async function sha256Hex(bytes) {
  const buf = bytes instanceof ArrayBuffer ? bytes : bytes?.buffer ?? bytes
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', buf)
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(Buffer.from(buf)).digest('hex')
}

/**
 * Map a raw BankOne loan STATUS string to a PAR bucket metric_key, reusing the
 * engine's bucket keys. Returns null for performing / unknown (not in PAR).
 */
export function statusToBucketKey(status) {
  const s = norm(status)
  if (!s) return null
  if (s === 'performing' || s === 'current' || s === 'active') return null
  // Match against the engine's bucket keys via the same fuzzy variants the
  // import uses, so "Pass And Watch" == the engine label "Pass & Watch".
  for (const key of PAR_BUCKET_KEYS) {
    const variants = FIELD_SYNONYMS[key] || []
    for (const v of variants) {
      const nv = norm(v)
      if (s === nv) return key
    }
  }
  // Fall back to the engine's own label/key (single source of truth).
  const bucket = PAR_STATUS_BUCKETS.find((b) => norm(b.label) === s || b.key === s.replace(/\s+/g, '_'))
  return bucket ? bucket.key : null
}

export { bucketForDaysPastDue }

