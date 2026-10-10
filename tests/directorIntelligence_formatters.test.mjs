// ============================================================================
// Director Intelligence formatters unit tests
// ============================================================================
// Tests the pure value-formatting helpers in formatScorecard.js.
// Run: node tests/directorIntelligence_formatters.test.mjs

import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const formatScorecard = await import('../src/components/directorIntelligence/formatScorecardCore.js')

let failed = 0
const check = (label, fn) => {
  try { fn(); console.log(`  ok  ${label}`) }
  catch (e) { failed += 1; console.error(`  FAIL ${label}: ${e.message}`) }
}

check('formatAmount formats NGN with 2 decimals', () => {
  assert.strictEqual(formatScorecard.formatAmount(1234567.89), '1,234,567.89')
  assert.strictEqual(formatScorecard.formatAmount(0), '0.00')
})
check('formatAmount returns em dash for null', () => {
  assert.strictEqual(formatScorecard.formatAmount(null), '—')
})

check('formatPercent appends % with 2 decimals', () => {
  assert.strictEqual(formatScorecard.formatPercent(0.73), '0.73%')
  assert.strictEqual(formatScorecard.formatPercent(50), '50.00%')
})
check('formatPercent returns em dash for null', () => {
  assert.strictEqual(formatScorecard.formatPercent(null), '—')
})

check('formatCount uses locale thousands separator', () => {
  assert.strictEqual(formatScorecard.formatCount(202), '202')
  assert.strictEqual(formatScorecard.formatCount(12345), '12,345')
})
check('formatCount returns em dash for null', () => {
  assert.strictEqual(formatScorecard.formatCount(null), '—')
})

check('formatCurrencyValue prefixes NGN', () => {
  assert.strictEqual(formatScorecard.formatCurrencyValue(1234567.89), '₦1,234,567.89')
})
check('formatCurrencyValue returns em dash for null', () => {
  assert.strictEqual(formatScorecard.formatCurrencyValue(null), '—')
})

check('formatDelta renders positive change', () => {
  const out = formatScorecard.formatDelta({ current: 110, previous: 100, suffix: ' pts' })
  assert.strictEqual(out, '▲ +10 pts')
})
check('formatDelta renders negative change', () => {
  const out = formatScorecard.formatDelta({ current: 90, previous: 100, suffix: ' pts' })
  assert.strictEqual(out, '▼ -10 pts')
})
check('formatDelta renders zero change', () => {
  const out = formatScorecard.formatDelta({ current: 100, previous: 100, suffix: ' pts' })
  assert.strictEqual(out, '▶ 0 pts')
})
check('formatDelta returns no comparison for null', () => {
  const out = formatScorecard.formatDelta({ current: null, previous: 100 })
  assert.strictEqual(out, 'No comparison')
})

check('formatNoData renders the No data pill', () => {
  assert.strictEqual(formatScorecard.formatNoData(), 'No data imported')
})

console.log(`\nDirector Intelligence formatter unit tests: ${failed === 0 ? 'ALL PASSED' : `${failed} FAILED`}\n`)
process.exit(failed === 0 ? 0 : 1)
