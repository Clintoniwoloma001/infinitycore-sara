// ============================================================================
// Performance page — period filters, the applied-range request and the
// Portfolio & Disbursement panel
//
// THE BUG THIS PINS
//   Choosing 28 Sep 2026 -> 28 Sep 2026 still loaded 1-30 Sep: `periodRange`
//   rounded the end date up to the END OF ITS MONTH, and the "Apply Filter"
//   button only flipped local React state — no request ever carried the dates.
//   The PAR/disbursement cards read `listLatestDepartmentSnapshots()` with no
//   arguments at all (newest snapshot, always), and an empty result set
//   rendered a generic "Awaiting Data" banner instead of saying which range
//   was empty.
//
// What must hold, and what this file asserts:
//   1. The applied range ends on the chosen DAY (pure logic, extracted to
//      src/domains/performance/filterRange.js so Node can execute it).
//   2. The range travels WITH the request: snapshots are picked as-of the
//      range END, flow is summed inside [start, end] on `disbursementDate`.
//   3. Results read (and the department snapshot read) are paged, because
//      PostgREST caps a single response at max_rows = 1000.
//   4. The UI shows the applied range, blocks From > To, persists the filter
//      in the URL, surfaces errors with Retry, and states explicitly which
//      range is empty (with a jump to the latest available date).
//   5. The Portfolio & Disbursement panel is NOT behind `assessed > 0`.
// ============================================================================
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failed = 0
const check = (label, fn) => {
  try {
    fn()
    console.log(`  ok  ${label}`)
  } catch (e) {
    failed += 1
    console.log(`  FAIL ${label}`)
    console.log(`       ${e.message}`)
  }
}

const page = read('src/pages/Performance.jsx')
const domain = read('src/domains/performance/filterRange.js')
const portfolioSvc = read('src/services/bankonePortfolioService.js')
const perfSvc = read('src/services/performanceService.js')

const filterRange = await import('../src/domains/performance/filterRange.js')
const { periodRange, isoDate, formatDay, rangeOf, asRange, filterFromParams, rowInRange } = filterRange

// ---------------------------------------------------------------------------
// 1. The applied range ends on the chosen DAY
// ---------------------------------------------------------------------------
check('custom range 28->28 Sep 2026 ends on 28 Sep, not 30 Sep', () => {
  const [a, b] = periodRange('custom', { from: '2026-09-28', to: '2026-09-28' })
  assert.strictEqual(isoDate(a), '2026-09-28')
  assert.strictEqual(isoDate(b), '2026-09-28')
})

check('custom range is inclusive of the whole `to` day (end = start of day + 23:59:59)', () => {
  const [, b] = periodRange('custom', { from: '2026-09-01', to: '2026-09-30' })
  assert.strictEqual(isoDate(b), '2026-09-30')
  const midnight = new Date(new Date('2026-09-30').getFullYear(), new Date('2026-09-30').getMonth(), new Date('2026-09-30').getDate()).getTime()
  assert.strictEqual(b, midnight + 86399999, 'end must be the last instant of the chosen day')
})

check('a mid-month custom range does NOT get stretched to the month ends', () => {
  const [a, b] = periodRange('custom', { from: '2026-09-15', to: '2026-09-20' })
  assert.strictEqual(isoDate(a), '2026-09-15')
  assert.strictEqual(isoDate(b), '2026-09-20')
})

check('preset ranges still resolve (today / month / prevMonth / year)', () => {
  for (const preset of ['today', 'week', 'month', 'prevMonth', 'quarter', 'year']) {
    const [a, b] = periodRange(preset)
    assert.ok(Number.isFinite(a) && Number.isFinite(b), `${preset} must resolve`)
    assert.ok(b > a, `${preset} end must be after start`)
  }
  // An unknown preset falls back to the current month, never to nothing.
  const [a, b] = periodRange('nonsense')
  assert.ok(b > a)
})

check('isoDate renders the LOCAL calendar date (no toISOString day-shift)', () => {
  const d = new Date(2026, 0, 1, 0, 30) // 00:30 on 1 Jan, local time
  assert.strictEqual(isoDate(d.getTime()), '2026-01-01')
  const d2 = new Date(2026, 11, 31, 23, 30)
  assert.strictEqual(isoDate(d2.getTime()), '2026-12-31')
  // Round trip: a range's endpoints must survive isoDate unchanged.
  const [s, e] = periodRange('custom', { from: '2026-09-01', to: '2026-09-30' })
  assert.strictEqual(isoDate(s), '2026-09-01')
  assert.strictEqual(isoDate(e), '2026-09-30')
})

check('formatDay renders a readable date', () => {
  assert.match(formatDay('2026-09-28'), /^28 Sep(t)? 2026$/) // ICU build may abbreviate September
  assert.strictEqual(formatDay(''), '')
})

// ---------------------------------------------------------------------------
// 2. The range that travels with the request
// ---------------------------------------------------------------------------
check('rangeOf(filter) -> {startDate, endDate} plain dates, inclusive end', () => {
  const r = rangeOf({ preset: 'custom', custom: { from: '2026-09-01', to: '2026-09-30' } })
  assert.deepStrictEqual(r, { startDate: '2026-09-01', endDate: '2026-09-30' })
})

check('rangeOf with no preset -> null (data-derived default, no hard dates)', () => {
  assert.strictEqual(rangeOf(null), null)
  assert.strictEqual(rangeOf({}), null)
  assert.strictEqual(rangeOf({ preset: null }), null)
})

check('asRange ignores React onClick event objects', () => {
  const fb = { startDate: '2026-09-01', endDate: '2026-09-30' }
  const fakeEvent = { type: 'click', nativeEvent: {}, currentTarget: {}, target: {} }
  assert.strictEqual(asRange(fakeEvent, fb), fb, 'event must not be read as a range')
  assert.deepStrictEqual(asRange({ startDate: '2026-08-01', endDate: '2026-08-31' }, fb), {
    startDate: '2026-08-01', endDate: '2026-08-31',
  })
  assert.strictEqual(asRange(null, fb), null, 'an explicit null (reset) must clear the range')
  assert.strictEqual(asRange(undefined, fb), fb)
})

// ---------------------------------------------------------------------------
// 3. URL persistence
// ---------------------------------------------------------------------------
check('filterFromParams: no params -> null (page keeps derived default)', () => {
  assert.strictEqual(filterFromParams(new URLSearchParams('')), null)
})

check('filterFromParams: full params -> filter with preset/custom/scopes', () => {
  const f = filterFromParams(new URLSearchParams(
    'preset=custom&from=2026-09-01&to=2026-09-30&branch=Agege&area=Lagos&dept=Finance&employee=abc&status=PASS'
  ))
  assert.deepStrictEqual(f, {
    preset: 'custom',
    custom: { from: '2026-09-01', to: '2026-09-30' },
    branchF: 'Agege', areaF: 'Lagos', deptF: 'Finance', empF: 'abc', classF: 'PASS',
  })
})

check('filterFromParams: scope-only params still produce a usable filter', () => {
  const f = filterFromParams(new URLSearchParams('branch=Agege'))
  assert.strictEqual(f.preset, 'month')
  assert.strictEqual(f.branchF, 'Agege')
  assert.strictEqual(f.custom.from, '')
})

check('filterFromParams + rangeOf round-trips a shared link', () => {
  const params = new URLSearchParams('preset=custom&from=2026-09-01&to=2026-09-30')
  assert.deepStrictEqual(rangeOf(filterFromParams(params)), {
    startDate: '2026-09-01', endDate: '2026-09-30',
  })
})

// ---------------------------------------------------------------------------
// 4. Results overlap semantics
// ---------------------------------------------------------------------------
check('rowInRange keeps an OVERLAPPING result row, drops a non-overlapping one', () => {
  const [a, b] = periodRange('custom', { from: '2026-09-28', to: '2026-09-28' })
  const range = [a, b]
  const sept = { period_start: '2026-09-01', period_end: '2026-09-30' }
  const aug = { period_start: '2026-08-01', period_end: '2026-08-31' }
  assert.strictEqual(rowInRange(sept, range), true)
  assert.strictEqual(rowInRange(aug, range), false)
  assert.strictEqual(rowInRange(sept, null), true, 'no range = no date filtering')
  // Label-only rows fall back to the 15th of the labelled month — checked
  // against a whole-month range, where that 15th sits inside the window.
  const [m0, m1] = periodRange('custom', { from: '2026-09-01', to: '2026-09-30' })
  const month = [m0, m1]
  assert.strictEqual(rowInRange({ period_label: '2026-09' }, month), true)
  assert.strictEqual(rowInRange({ period_label: '2026-07' }, month), false)
  assert.strictEqual(rowInRange({ period_label: '2026-09' }, range), false, '15 Sep is outside a 28 Sep-only range')
})

// ---------------------------------------------------------------------------
// 5. The service carries the range
// ---------------------------------------------------------------------------
check('getPortfolioForRange exists and bounds the snapshot by the range END', () => {
  assert.ok(portfolioSvc.includes('async getPortfolioForRange('), 'service must expose getPortfolioForRange')
  assert.ok(
    portfolioSvc.includes(".lte('as_at_date', endDate)"),
    'snapshot selection must be as-of the range end (as_at_date <= endDate)'
  )
  assert.ok(
    portfolioSvc.includes('a.report_type === \'par\' ? 0 : 1'),
    'published PAR snapshots must be preferred (department rows only exist for PAR)'
  )
  assert.ok(
    portfolioSvc.includes('listLatestDepartmentSnapshots(opts)'),
    'the old entry point stays for Director Intelligence (back-compat)'
  )
  assert.ok(
    portfolioSvc.includes('const slice = await this.getPortfolioForRange(opts || {})'),
    'listLatestDepartmentSnapshots must delegate, not re-implement the selection'
  )
})

check('flow is summed on `disbursementDate` inside [start, end] of ONE batch', () => {
  assert.ok(portfolioSvc.includes('async function sumDisbursementFlow('), 'windowed flow helper must exist')
  assert.ok(
    portfolioSvc.includes(".gte('normalized_data->>disbursementDate', startDate)"),
    'flow must filter on the per-loan disbursementDate lower bound'
  )
  assert.ok(
    portfolioSvc.includes(".lte('normalized_data->>disbursementDate', endDate)"),
    'flow must filter on the per-loan disbursementDate upper bound'
  )
  assert.ok(
    portfolioSvc.includes(".eq('batch_id', batchId)"),
    'flow must be scoped to the chosen snapshot batch (never the whole table)'
  )
  assert.ok(
    portfolioSvc.includes('ISO_DATE.test(booked)'),
    'rows whose disbursementDate is not a clean ISO date must not count as booked'
  )
})

check('flow and result reads are paged (PostgREST max_rows = 1000)', () => {
  assert.ok(/const PAGE = 1000/.test(portfolioSvc), 'flow helper must page at the PostgREST row cap')
  assert.ok(/\.range\(offset, offset \+ PAGE - 1\)/.test(portfolioSvc), 'flow helper must request explicit pages')
  assert.ok(/const PAGE = 1000/.test(perfSvc), 'getResults must page at the PostgREST row cap')
  assert.ok(/\.range\(offset, offset \+ PAGE - 1\)/.test(perfSvc), 'getResults must request explicit pages')
  assert.ok(/if \(!data \|\| data.length < PAGE\) break/.test(perfSvc), 'getResults must stop on the last page')
})

check('getResults keeps its documented argument contract', () => {
  assert.ok(perfSvc.includes('async getResults({ periodLabel, startDate, endDate, employeeId, metricId } = {})'))
  assert.ok(perfSvc.includes("if (error) throw error"), 'fetch errors still surface to the caller')
})

// ---------------------------------------------------------------------------
// 6. The page: applied range in the UI, validation, URL, empty state
// ---------------------------------------------------------------------------
check('Apply passes the range to the refresh and guards From > To', () => {
  assert.ok(page.includes('await onRefresh(rangeOf(next))'), 'the applied range must travel with the refresh')
  assert.ok(page.includes('const rangeInvalid ='), 'From > To must be detected')
  assert.ok(
    page.includes('From date must be on or before the To date.'),
    'the invalid range must be explained to the user'
  )
  assert.ok(
    page.includes('disabled={applying || rangeInvalid}'),
    'Apply must be disabled while loading or when the range is invalid'
  )
  assert.ok(page.includes('setApplying(true)'), 'Apply must show a loading state')
})

check('the applied range is visible (chip) and persisted in the URL', () => {
  assert.ok(page.includes('data-testid="applied-range-chip"'), 'applied range chip')
  assert.ok(page.includes('setSearchParams(params, { replace: true })'), 'filter written to the URL')
  assert.ok(page.includes('onFilterChange?.(next)'), 'filter change reported to the router')
  assert.ok(page.includes('onFilterChange?.(null)'), 'Reset clears the URL params')
  assert.ok(page.includes('filterFromParams(searchParams)'), 'filter restored from the URL')
  assert.ok(page.includes("initialFilter?.preset || 'month'"), 'restored filter seeds the visible controls')
})

check('the empty state names the range and offers a jump to the latest data', () => {
  assert.ok(page.includes('data-testid="empty-range"'), 'explicit empty state')
  assert.ok(page.includes('No data for '), 'required copy: "No data for <range>"')
  assert.ok(page.includes('Latest available:'), 'required copy: latest available date')
  assert.ok(page.includes('Jump to latest available date'), 'one-click jump button')
  assert.ok(page.includes('const jumpToLatest = async () =>'), 'jump handler exists')
  assert.ok(page.includes('Latest available: ${formatDay(portfolio.latestAvailable)}.'), 'latest date is real data, not a guess')
  assert.ok(page.includes('No published BankOne snapshot yet.'), 'and says so when nothing is published')
})

check('fetch errors are surfaced with a Retry (not swallowed)', () => {
  assert.ok(page.includes('if (slice.error) setError(`BankOne portfolio: ${slice.error}`)'), 'portfolio errors reach the UI')
  assert.ok(page.includes('onRefresh={load}'), 'refresh re-runs the load')
  const errIdx = page.indexOf('<ErrorState message={error}>')
  const retryIdx = page.indexOf('Retry', errIdx)
  assert.ok(errIdx > 0 && retryIdx > errIdx, 'the error banner renders a Retry control')
})

check('the Portfolio & Disbursement panel sits OUTSIDE the `assessed > 0` gate', () => {
  const strip = page.indexOf('data-testid="portfolio-outstanding"')
  const gate = page.indexOf('{assessed > 0 && (')
  assert.ok(strip > 0, 'portfolio panel must render')
  assert.ok(gate > 0, 'assessed gate still exists for the scorecards')
  assert.ok(strip < gate, 'portfolio panel must NOT be behind the `assessed > 0` gate')
  assert.ok(page.includes('data-testid="portfolio-par"'), 'PAR % card')
  assert.ok(page.includes('data-testid="portfolio-disbursed"'), 'Disbursed in period card')
})

check('department disbursed uses the windowed flow, with the snapshot as fallback', () => {
  assert.ok(page.includes('const flowByDept = useMemo('), 'flow grouped by department')
  assert.ok(page.includes('disbursed: hasFlow'), 'windowed flow preferred when readable')
  assert.ok(page.includes('flowByDept[flowKey] ?? 0'), 'a department with no bookings shows 0, not a stale total')
  assert.ok(page.includes('num(snap?.total_disbursed)'), 'pre-migration/no-access fallback kept')
})

check('no timezone-unsafe toISOString date formatting on the page or in the domain', () => {
  assert.ok(!domain.includes('.toISOString('), 'filterRange must never use toISOString')
  assert.ok(!page.includes('.toISOString('), 'Performance.jsx must never use toISOString for dates')
})

check('Director Intelligence still uses the back-compatible list entry point', () => {
  const director = read('src/pages/DirectorDashboard.jsx')
  assert.ok(
    director.includes('listLatestDepartmentSnapshots('),
    'Director page keeps its call site (now delegating to getPortfolioForRange)'
  )
})

// ---------------------------------------------------------------------------
console.log('')
if (failed) {
  console.error(`${failed} check(s) failed`)
  process.exit(1)
}
console.log('All checks passed')
