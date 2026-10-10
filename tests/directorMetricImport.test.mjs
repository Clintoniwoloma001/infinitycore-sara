/**
 * PHASE 1 — Director multi-metric import domain tests.
 * Pure node:test (no Supabase, no React). Pins the fuzzy mapping, validation,
 * row building and the status->bucket mapping to the EXISTING mprEngine buckets.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FIELD_SYNONYMS, proposeMapping, toNumber, validateMetricValue,
  buildImportRows, statusToBucketKey, PAR_BUCKET_KEYS,
} from '../src/domains/directorIntelligence/metricImport.js'
import { PAR_STATUS_BUCKETS } from '../src/domains/performance/mprEngine.js'

test('proposeMapping matches fuzzy header variants to canonical fields', () => {
  const headers = ['Staff Code', 'Account Officer', 'Branch', 'As of Date',
    'Total Outstanding', 'Pass & Watch', 'Sub Standard', 'Doubtful', 'Lost', 'Case Load']
  const m = proposeMapping(headers)
  assert.equal(m.staff_code, 'Staff Code')
  assert.equal(m.staff_name, 'Account Officer')
  assert.equal(m.branch, 'Branch')
  assert.equal(m.as_of_date, 'As of Date')
  assert.equal(m.portfolio, 'Total Outstanding')
  assert.equal(m.pass_watch, 'Pass & Watch')
  assert.equal(m.substandard, 'Sub Standard')
  assert.equal(m.doubtful, 'Doubtful')
  assert.equal(m.lost, 'Lost')
  assert.equal(m.caseload_count, 'Case Load')
})

test('a subset sheet maps only the fields it contains', () => {
  const m = proposeMapping(['Officer', 'Caseload'])
  assert.equal(m.staff_name, 'Officer')
  assert.equal(m.caseload_count, 'Caseload')
  assert.equal(m.portfolio, undefined)
  assert.equal(m.pass_watch, undefined)
})

test('toNumber parses BankOne text shapes and rejects garbage', () => {
  assert.equal(toNumber('3,000,000.00'), 3000000)
  assert.equal(toNumber('(5,000)'), -5000)
  assert.equal(toNumber('7760710.6'), 7760710.6)
  assert.equal(toNumber(''), null)
  assert.equal(toNumber('abc'), null)
})

test('validateMetricValue rejects negative counts and impossible percents', () => {
  assert.equal(validateMetricValue('caseload_count', -1), 'negative count')
  assert.equal(validateMetricValue('par_pct', 120), 'percent over 100')
  assert.equal(validateMetricValue('portfolio', 1000000), null)
  assert.equal(validateMetricValue('caseload_count', 46), null)
})

test('buildImportRows: only metrics present in a row become upsert rows', () => {
  const mapping = { staff_code: 'Code', as_of_date: 'Date', portfolio: 'Portfolio', caseload_count: 'Caseload' }
  const records = [
    { Code: 'IMFB/15/0053', Date: '2026-09-30', Portfolio: '608042499.39', Caseload: '23' },
    // second row has NO caseload cell -> only portfolio should be emitted
    { Code: 'IMFB/13/0033', Date: '2026-09-30', Portfolio: '457438871.69', Caseload: '' },
  ]
  const resolver = (row) => (row.Code === 'IMFB/15/0053' ? 'emp-a' : 'emp-b')
  const { rows, summary } = buildImportRows(records, mapping, resolver)
  assert.equal(rows.length, 3) // 2 portfolio + 1 caseload
  assert.equal(summary.per_metric.portfolio, 2)
  assert.equal(summary.per_metric.caseload_count, 1)
  assert.equal(summary.employees, 2)
  assert.deepEqual(summary.as_of_dates, ['2026-09-30'])
})

test('buildImportRows: unresolved employees go to unmatched, never into rows', () => {
  const mapping = { staff_code: 'Code', portfolio: 'Portfolio' }
  const records = [{ Code: 'UNKNOWN/99', Portfolio: '1000' }]
  const { rows, unmatched } = buildImportRows(records, mapping, () => null, '2026-09-30')
  assert.equal(rows.length, 0)
  assert.equal(unmatched.length, 1)
  assert.match(unmatched[0].reason, /no employee match/)
})

test('statusToBucketKey maps real BankOne statuses to the EXISTING engine buckets', () => {
  // These are the literal status strings found in bankone_import_rows.
  assert.equal(statusToBucketKey('Pass And Watch'), 'pass_watch')
  assert.equal(statusToBucketKey('Sub Standard'), 'substandard')
  assert.equal(statusToBucketKey('Doubtful'), 'doubtful')
  assert.equal(statusToBucketKey('Lost'), 'lost')
  assert.equal(statusToBucketKey('Performing'), null)
  // every mapped key must be a real engine bucket (single source of truth)
  const engineKeys = new Set(PAR_STATUS_BUCKETS.map((b) => b.key))
  for (const k of PAR_BUCKET_KEYS) assert.ok(engineKeys.has(k), `${k} must exist in mprEngine`)
})
