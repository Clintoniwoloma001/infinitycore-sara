import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { deriveDefaultPeriod, rowPeriodBounds, isoDate } from '../src/domains/performance/periodDefaults.js'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const datePicker = read('src/components/DatePicker.jsx')
const snapshotSync = read('src/lib/snapshotSync.js')
const importReview = read('src/pages/BankOneImportReview.jsx')
const director = read('src/pages/DirectorDashboard.jsx')
const performance = read('src/pages/Performance.jsx')
const portfolioService = read('src/services/bankonePortfolioService.js')

const NOW = new Date(2026, 9, 6) // 06 Oct 2026 — the "system month"

// ------------------------------------------------------------------
// 1. Derived default period — the fix for "Awaiting Data" when the
//    snapshot month ≠ system month. Pure, clock-injectable.
// ------------------------------------------------------------------
assert.deepEqual(deriveDefaultPeriod([], NOW), { preset: 'month', custom: null })
assert.deepEqual(deriveDefaultPeriod(null, NOW), { preset: 'month', custom: null })

// Latest data is the current month → This Month.
assert.equal(deriveDefaultPeriod([
  { period_label: '2026-10', period_start: '2026-10-01', period_end: '2026-10-06' },
], NOW).preset, 'month')

// Latest data is the previous month → Previous Month.
assert.equal(deriveDefaultPeriod([
  { period_label: '2026-09', period_start: '2026-09-01', period_end: '2026-09-30' },
], NOW).preset, 'prevMonth')

// Oldest month wins only if it is the LATEST — picks the max, not the first.
assert.equal(deriveDefaultPeriod([
  { period_label: '2026-07', period_start: '2026-07-01', period_end: '2026-07-31' },
  { period_label: '2026-09', period_start: '2026-09-01', period_end: '2026-09-30' },
], NOW).preset, 'prevMonth')

// Older month → Custom bounded to exactly that month.
const older = deriveDefaultPeriod([
  { period_label: '2026-06', period_start: '2026-06-01', period_end: '2026-06-30' },
], NOW)
assert.equal(older.preset, 'custom')
assert.deepEqual(older.custom, { from: '2026-06-01', to: '2026-06-30' })

// December row while the clock is in January (year rollover of prevMonth).
assert.equal(deriveDefaultPeriod([
  { period_label: '2025-12', period_start: '2025-12-01', period_end: '2025-12-31' },
], new Date(2026, 0, 5)).preset, 'prevMonth')

// Label-only rows (no dates) still parse: YYYY-MM and full dates.
assert.deepEqual(
  rowPeriodBounds({ period_label: '2026-08' }),
  { start: new Date(2026, 7, 1), end: new Date(2026, 7, 31) }
)
assert.deepEqual(
  rowPeriodBounds({ period_label: '2026-08-15' }),
  { start: new Date(2026, 7, 15), end: new Date(2026, 7, 15) }
)
assert.equal(rowPeriodBounds({}), null)
assert.equal(isoDate(new Date(2026, 0, 5)), '2026-01-05')

// ------------------------------------------------------------------
// 2. DatePicker — portalled so the horizontally scrolling Director
//    filter bar can never clip it; anchored via getBoundingClientRect.
// ------------------------------------------------------------------
assert.match(datePicker, /createPortal/)
assert.match(datePicker, /getElementById\('portal-root'\)/)
assert.match(datePicker, /getBoundingClientRect\(\)/)
assert.match(datePicker, /position: 'fixed'/)
assert.match(datePicker, /addEventListener\('mousedown'/)
assert.match(datePicker, /Escape/)
assert.match(datePicker, /aria-label="Previous month"/)
assert.match(datePicker, /aria-label="Next month"/)
assert.match(datePicker, />\s*Today\s*</)
assert.match(datePicker, />\s*Clear\s*</)
assert.match(datePicker, /export const toIsoDate/)

// ------------------------------------------------------------------
// 3. Snapshot refresh bus + the publish hook that fires it.
// ------------------------------------------------------------------
assert.match(snapshotSync, /bankone:snapshot_published/)
assert.match(snapshotSync, /export function notifySnapshotPublished/)
assert.match(snapshotSync, /export function subscribeSnapshotRefresh/)
assert.match(snapshotSync, /type: 'broadcast'/)
assert.match(snapshotSync, /removeChannel/)

assert.match(importReview, /import \{ notifySnapshotPublished \} from '\.\.\/lib\/snapshotSync'/)
// Called on the success path, after the publish RPC returned.
const publishBlock = importReview.slice(importReview.indexOf('const publish = async'), importReview.indexOf('const publish = async') + 900)
assert.match(publishBlock, /await bankonePortfolioService\.publish\(/)
assert.match(publishBlock, /notifySnapshotPublished\(res\)/)
assert.ok(
  publishBlock.indexOf('notifySnapshotPublished(res)') > publishBlock.indexOf('bankonePortfolioService.publish'),
  'the refresh signal must fire after the publish response'
)

// ------------------------------------------------------------------
// 4. Director dashboard — plural RPC option keys, Custom calendar,
//    and a live subscription to published snapshots.
// ------------------------------------------------------------------
assert.match(director, /department: 'departments'/)
assert.match(director, /area: 'areas'/)
assert.match(director, /role: 'roles'/)
assert.match(director, /designationId: 'designations'/)
assert.match(director, /employeeId: 'employees'/)
assert.match(director, /branchId: 'branches'/)
// The old singular lookup (which rendered empty dropdowns) must be gone.
assert.doesNotMatch(director, /options\?\.\[key === 'branchId' \? 'branches' : key\]/)
// Custom opens the portal'd DatePicker with a seeded range.
assert.match(director, /import DatePicker, \{ toIsoDate \} from '\.\.\/components\/DatePicker'/)
assert.match(director, /const openCustom = \(\) =>/)
assert.match(director, /<DatePicker isOpen=\{startOpen\}/)
assert.match(director, /<DatePicker isOpen=\{endOpen\}/)
assert.match(director, /subscribeSnapshotRefresh\(\(\) => loadRef\.current\(\)\)/)

// ------------------------------------------------------------------
// 5. Performance page — derived period default, Apply/Reset that
//    re-query the database, department scorecards, empty-state CTA.
// ------------------------------------------------------------------
assert.match(performance, /import \{ deriveDefaultPeriod \} from '\.\.\/domains\/performance\/periodDefaults'/)
assert.match(performance, /import bankonePortfolioService from '\.\.\/services\/bankonePortfolioService'/)
assert.match(performance, /import \{ subscribeSnapshotRefresh \} from '\.\.\/lib\/snapshotSync'/)
// No hard-coded/stored preset: the default comes from the rows.
assert.doesNotMatch(performance, /localStorage\.getItem\('perf_preset'\)/)
assert.match(performance, /const derived = useMemo\(\(\) => deriveDefaultPeriod\(results\), \[results\]\)/)
assert.match(performance, /applied \?\? \{/)
// Apply + Reset both re-query; Reset returns to the derived default.
const applyBlock = performance.slice(performance.indexOf('const applyFilters'), performance.indexOf('const resetFilters'))
const resetBlock = performance.slice(performance.indexOf('const resetFilters'), performance.indexOf('const exportCsv'))
assert.match(applyBlock, /await onRefresh\(\)/)
assert.match(resetBlock, /setApplied\(null\)/)
assert.match(resetBlock, /await onRefresh\(\)/)
assert.doesNotMatch(resetBlock, /preset: 'month'/)
// Department scorecards table + snapshot metric columns.
assert.match(performance, /Department Scorecards/)
assert.match(performance, /hasDeptSnapshots/)
assert.match(performance, /'outstanding', 'Outstanding'/)
assert.match(performance, /'disbursed', 'Disbursed'/)
assert.match(performance, /'repaid', 'Repaid'/)
assert.match(performance, /'par', 'PAR %'/)
assert.match(performance, /deptSnapshots=\{deptSnapshots\}/)
// Empty state points at the import surfaces and no longer says "run a
// calculation"; the "no match" case is no longer a blank screen.
assert.match(performance, /#\/bankone-portfolio-review/)
assert.match(performance, /#\/bankone-imports/)
assert.doesNotMatch(performance, /then run a BankOne calculation/)
assert.doesNotMatch(performance, /Run a calculation to generate results/)
assert.match(performance, /No employees match the current/)
assert.match(performance, /subscribeSnapshotRefresh\(\(\) => loadRef\.current\(\)\)/)

// ------------------------------------------------------------------
// 6. Service reads published snapshots' department rows — par-first, so
//    a newer disbursement snapshot can never hide the department data —
//    and degrades to [] while the rollup migration is not yet applied.
// ------------------------------------------------------------------
assert.match(portfolioService, /async listLatestDepartmentSnapshots\(\)/)
assert.match(portfolioService, /\.from\('bankone_portfolio_snapshots'\)/)
assert.match(portfolioService, /\.eq\('status', 'published'\)/)
assert.match(portfolioService, /\.from\('bankone_department_snapshots'\)/)
assert.match(portfolioService, /if \(error\) return \[\]/)
assert.match(portfolioService, /report_type === 'par'/)
assert.match(portfolioService, /\.limit\(20\)/)

// ------------------------------------------------------------------
// 7. Migration 20261102000001 — publish aggregates, department rollup,
//    backfill, and the snapshot-sourced director financials. Content
//    assertions only (the behavioral pass lives in
//    tests/acceptance/bankoneDepartmentRollup.sql, run by
//    npm run test:bankone-rollup against the local Supabase docker DB).
// ------------------------------------------------------------------
const migration = read('supabase/migrations/20261102000001_bankone_publish_rollup_and_executive_sync.sql')

// Snapshot aggregate columns (idempotent, additive).
assert.match(migration, /add column if not exists loan_count integer/)
assert.match(migration, /add column if not exists total_disbursed numeric/)
assert.match(migration, /add column if not exists total_repaid numeric/)

// Department rollup table: idempotent create, unique per (snapshot, dept),
// readable by performance readers as well as BankOne managers.
assert.match(migration, /create table if not exists public\.bankone_department_snapshots/)
assert.match(migration, /create unique index if not exists uq_bankone_dept_snap/)
assert.match(migration, /"bankone_department_snapshots_read"/)
assert.match(migration, /performance\.read/)

// Rollup function is PAR-only: disbursement batches have no honest
// outstanding/status, so they must never produce department rows.
assert.match(migration, /public\.bankone_rollup_departments/)
assert.match(migration, /if v_report <> 'par' then/)

// Publish re-issue: same gates/revoke contract as the authoritative
// 20260931000002 body, plus it invokes the rollup for every snapshot.
const publishAt = migration.indexOf('function public.bankone_publish_snapshot')
assert.ok(publishAt >= 0, 'publish function must be re-issued')
const publishHead = migration.slice(publishAt, publishAt + 1400)
assert.match(publishHead, /can_manage_bankone\(\)|can_review_work_tasks\(\)/)
assert.match(migration, /revoke all on function public\.bankone_publish_snapshot\(uuid\) from anon/)
assert.match(migration, /perform public\.bankone_rollup_departments\(v_snap_id\)/)

// Backfill is guarded to PAR snapshots only and audited once.
assert.match(migration, /DEPARTMENT_ROLLUP_BACKFILLED/)
const backfillAt = migration.indexOf('DEPARTMENT_ROLLUP_BACKFILLED')
const backfillWindow = migration.slice(Math.max(0, backfillAt - 1500), backfillAt)
assert.match(backfillWindow, /report_type = 'par'/)

// Director re-issue: snapshot chosen par-first, financials derived from the
// booked CTE, legacy expressions only behind `v_snap_id is null`, and the
// proven-safe pieces of the body are untouched.
assert.match(migration, /order by \(s\.report_type <> 'par'\)/)
assert.match(migration, /v_snap_batch/)
assert.match(migration, /'loans_disbursed',case when v_snap_id is null/)
assert.match(migration, /'loan_portfolio',case when v_snap_id is null/)
assert.match(migration, /20::int/)
assert.match(migration, /resolved_employee_id/)
assert.match(migration, /jsonb_agg\(to_jsonb\(x\) order by to_jsonb\(x\)->>'name'\)/)

console.log('snapshot-publish-refresh: all assertions passed')
