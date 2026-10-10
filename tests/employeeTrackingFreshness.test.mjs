// ============================================================================
// Employee Tracking — freshness, history ordering and the SQL that feeds them
//
// THE BUG THIS PINS
//   Live positions reported "8 recently updated · 0 stale" while the newest
//   fix was two days old. Two causes: the RPC decided staleness with a 45
//   minute threshold and did not return the server's age, and the service
//   silently DROPPED `is_stale` during normalization, so the component's
//   `rows.filter(r => !r.is_stale)` counted every row as fresh.
//
// What must hold, and what this file asserts:
//   1. ONE config file owns every threshold (src/config/trackingFreshness.js).
//   2. Age is anchored to the SERVER clock (age_seconds), never the browser's.
//   3. The service forwards every server field verbatim.
//   4. The SQL returns EVERY in-scope employee (so "No location yet" is
//      possible), uses the 30 minute threshold, and keeps its access gate.
//   5. History is ordered by recorded_at only, gaps are stated, late uploads
//      are labelled, and no route between points is ever inferred.
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

// ---------------------------------------------------------------------------
// Load the REAL shipped modules. The service imports ./supabaseClient
// (extensionless + browser deps) which plain node cannot resolve, so both
// files are concatenated and the one browser import is stubbed — everything
// else is the shipped source, evaluated, not transcribed.
// ---------------------------------------------------------------------------
const serviceSource = read('src/services/employeeTrackingService.js')
const configSource = read('src/config/trackingFreshness.js')

const combined = [
  configSource,
  serviceSource
    .replace(
      /import \{ supabase \} from '\.\.\/supabaseClient'/,
      'const supabase = { rpc: async () => ({ data: [], error: null }) }',
    )
    .replace(/import \{[\s\S]*?\} from '\.\.\/config\/trackingFreshness'/, ''),
].join('\n')

const mod = await import(
  `data:text/javascript,${encodeURIComponent(combined)}`
)
const cfg = await import(
  `data:text/javascript,${encodeURIComponent(configSource)}`
)

const page = read('src/components/tracking/LivePositions.jsx')
const drawer = read('src/components/tracking/HistoryDrawer.jsx')
const migration = read(
  'supabase/migrations/20261109000001_list_tracked_employees_freshness.sql',
)

console.log('\n1. Thresholds live in exactly one config file')
check('the live / delayed boundaries are 6 and 30 minutes', () => {
  assert.strictEqual(cfg.FRESHNESS_SECONDS.LIVE, 6 * 60)
  assert.strictEqual(cfg.FRESHNESS_SECONDS.DELAYED, 30 * 60)
})
check('classification is boundary-inclusive and never invents a state', () => {
  assert.strictEqual(cfg.classifyAgeSeconds(0), cfg.FRESHNESS.LIVE)
  assert.strictEqual(cfg.classifyAgeSeconds(360), cfg.FRESHNESS.LIVE)
  assert.strictEqual(cfg.classifyAgeSeconds(361), cfg.FRESHNESS.DELAYED)
  assert.strictEqual(cfg.classifyAgeSeconds(1800), cfg.FRESHNESS.DELAYED)
  assert.strictEqual(cfg.classifyAgeSeconds(1801), cfg.FRESHNESS.STALE)
  assert.strictEqual(cfg.classifyAgeSeconds(null), cfg.FRESHNESS.NONE)
  assert.strictEqual(cfg.classifyAgeSeconds('not-a-number'), cfg.FRESHNESS.NONE)
})
check('the live tab imports its thresholds from the config, not its own copy', () => {
  assert.match(page, /from '\.\.\/\.\.\/config\/trackingFreshness'/)
  // The suffix wording and the aging helpers still come from the config, so no
  // component declares its own copy of either.
  assert.match(page, /LOW_ACCURACY_SUFFIX/)
  assert.match(page, /classifyAgeSeconds\(ageSecondsOf\(/)
  assert.match(page, /describeFreshness/)
  // The chip/verdict logic itself moved to the server's display_category, so a
  // component-level freshness counter is deliberately gone: what counted
  // freshness while labelling the chips "Inside/Outside" was the reported defect.
  assert.ok(!/countFreshness/.test(page))
  assert.ok(!/rowFreshness/.test(page))
  // No component may hard-code the numbers.
  assert.ok(
    !/\b30\s*\*\s*60\b|\b6\s*\*\s*60\b|\b45\s*minutes?\b/.test(page),
    'LivePositions must not declare its own thresholds',
  )
})
check('the history thresholds come from the same file', () => {
  assert.match(drawer, /LATE_UPLOAD_MINUTES/)
  assert.match(configSource, /LATE_UPLOAD_MINUTES = 5/)
  assert.match(configSource, /TIMELINE_GAP_MINUTES = 10/)
})

console.log('\n2. Age is anchored to the server clock')
check('age_seconds is preferred over minutes_ago, elapsed is added as a delta', () => {
  assert.strictEqual(cfg.ageSecondsOf({ age_seconds: 120 }), 120)
  assert.strictEqual(cfg.ageSecondsOf({ age_seconds: 120 }, 30_000), 150)
  // Fallback for a not-yet-migrated server that only ships minutes_ago.
  assert.strictEqual(cfg.ageSecondsOf({ minutes_ago: 2 }), 120)
  assert.strictEqual(cfg.ageSecondsOf({}), null)
  assert.strictEqual(cfg.ageSecondsOf(null), null)
  // A negative elapsed (clock moved backwards) never makes a fix younger.
  assert.strictEqual(cfg.ageSecondsOf({ age_seconds: 120 }, -60_000), 120)
})
check('no freshness helper reads the browser clock', () => {
  const fn = configSource.slice(configSource.indexOf('export function ageSecondsOf'))
  const body = fn.slice(0, fn.indexOf('\nexport function'))
  assert.ok(!/Date\.now|new Date\(/.test(body),
    'the age must come from the server, plus an elapsed delta')
})
check('a row ages into the next state between polls', () => {
  const row = { age_seconds: 350, recorded_at: '2026-10-08T09:00:00Z' }
  assert.strictEqual(cfg.rowFreshness(row, 0), cfg.FRESHNESS.LIVE)
  // 350s + 20s = 370s > 360s -> delayed, without refetching.
  assert.strictEqual(cfg.rowFreshness(row, 20_000), cfg.FRESHNESS.DELAYED)
})

console.log('\n3. Every row is classified; no fix is never counted as fresh')
check('a row with no fix is NONE, not live', () => {
  assert.strictEqual(cfg.rowFreshness({ recorded_at: null, last_seen: null }), cfg.FRESHNESS.NONE)
  assert.strictEqual(cfg.rowFreshness({}), cfg.FRESHNESS.NONE)
  assert.strictEqual(cfg.rowFreshness(null), cfg.FRESHNESS.NONE)
})
check('the header counts live / delayed / stale with no-fix rows inside stale', () => {
  const rows = [
    { age_seconds: 30, recorded_at: 'x' },      // live
    { age_seconds: 600, recorded_at: 'x' },     // delayed
    { age_seconds: 90_000, recorded_at: 'x' },  // stale
    { recorded_at: null, last_seen: null },     // no fix -> stale
  ]
  const counts = cfg.countFreshness(rows, 0)
  assert.deepStrictEqual(counts, { live: 1, delayed: 1, stale: 2, none: 1 })
  assert.strictEqual(
    counts.live + counts.delayed + counts.stale,
    rows.length,
    'every row lands in exactly one header bucket',
  )
})
check('an all-stale roster reports zero live (the reported bug)', () => {
  const rows = Array.from({ length: 8 }, () => ({ age_seconds: 172_800, recorded_at: 'x' }))
  const counts = cfg.countFreshness(rows, 0)
  assert.strictEqual(counts.live, 0)
  assert.strictEqual(counts.stale, 8)
})
check('describeFreshness never says "live" for an old fix', () => {
  const old = { age_seconds: 172_800, recorded_at: '2026-10-06T10:00:00Z' }
  assert.strictEqual(mod.describeFreshness(old, 0), 'Last seen 2 days ago')
  assert.strictEqual(mod.describeFreshness({ age_seconds: 42 }, 0), 'Just now')
  assert.strictEqual(mod.describeFreshness({ age_seconds: 60 }, 0), 'Last seen 1 minute ago')
  assert.strictEqual(mod.describeFreshness({ age_seconds: 42 * 60 }, 0), 'Last seen 42 minutes ago')
  assert.strictEqual(mod.describeFreshness({ age_seconds: 3 * 3600 }, 0), 'Last seen 3 hours ago')
  assert.strictEqual(mod.describeFreshness({ recorded_at: null, last_seen: null }), 'No location yet')
  // The label keeps counting up between polls.
  assert.strictEqual(mod.describeFreshness(old, 60_000), 'Last seen 2 days ago')
})

console.log('\n4. The SQL returns every employee, on the 30 minute threshold')
check('staleness is decided at 30 minutes, and the legacy 45 is gone', () => {
  assert.match(migration, /interval '30 minutes'/)
  assert.ok(!/interval '45 minutes'/.test(migration),
    'the 45 minute threshold is what made an old fix look fresh')
})
check('the roster is driven from employees, not from the events table', () => {
  assert.match(migration, /from public\.employees e/)
  assert.match(migration, /left join lateral/i,
    'an employee with no fix must still appear, as "No location yet"')
  assert.ok(!/from public\.employee_location_events le\s*\n\s*join public\.employees e/.test(migration),
    'the old inner-join shape dropped employees without a fix')
})
check('the latest fix is picked by recorded_at, not by insertion order', () => {
  assert.match(migration, /order by l\.recorded_at desc nulls last/)
})
check('the server clock is published for the client to classify against', () => {
  assert.match(migration, /age_seconds/)
  assert.match(migration, /now\(\) as server_now/)
  assert.match(migration, /le\.recorded_at is not null as has_fix/)
  assert.match(migration, /le\.recorded_at,/)
})
check('the access gate, grants and filters are untouched', () => {
  assert.match(migration, /employee_tracking_access\(\)/)
  assert.match(migration, /TRACKING_FORBIDDEN/)
  assert.match(migration, /revoke all on function public\.list_tracked_employees\(integer, text, uuid\) from public/)
  assert.match(migration, /grant execute on function public\.list_tracked_employees\(integer, text, uuid\) to authenticated/)
  assert.match(migration, /p_department is null/)
  assert.match(migration, /p_branch_id is null/)
})
check('the migration proves what landed instead of hoping', () => {
  assert.match(migration, /pg_get_functiondef/)
  assert.match(migration, /list_tracked_freshness_incomplete/)
  assert.match(migration, /^begin;/m)
  assert.match(migration, /^commit;/m)
})

console.log('\n5. The service forwards every server field, and filters nothing')
check('is_stale, age_seconds, server_now and uploaded_at survive normalization', () => {
  assert.match(serviceSource, /age_seconds: item\.age_seconds/)
  assert.match(serviceSource, /server_now: item\.server_now/)
  assert.match(serviceSource, /is_stale: item\.is_stale/)
  assert.match(serviceSource, /uploaded_at: item\.uploaded_at/)
  assert.ok(!/latitude: Number\(item\.latitude \|\| 0\)/.test(serviceSource),
    'a missing coordinate must stay null, never become 0,0 in the Gulf of Guinea')
  assert.match(serviceSource, /latitude: item\.latitude == null \? null/)
})
check('the empty-state path is a genuinely empty array, nothing else', () => {
  assert.match(serviceSource, /unwrap\(data, error, \[\]\)/)
  assert.match(serviceSource, /Array\.isArray\(result\)/)
  // The page may re-derive the visible set ONLY behind explicit, user-activated
  // controls: the scope selects (department / position / branch) and the
  // freshness chip (activeFilter). With neither applied the full authorised row
  // set must reach the table untouched — nothing narrows it silently (the
  // original sin: rows.filter(r => !r.is_stale)).
  assert.match(page, /if \(!activeFilter\) return scoped/,
    'an unfiltered view must return every authorised row')
  const visibleDef = page.slice(page.indexOf('const visible = useMemo'), page.indexOf('}, [scoped, elapsed, activeFilter])'))
  assert.ok(/scoped\.filter\(/.test(visibleDef),
    'chip filtering re-derives from the same row set')
  // The only thing that may narrow the row set before the chip filter is the
  // operator's own scope selection — and it is always visible in the UI, with
  // a Clear action and a "no employees match these filters" empty state.
  assert.match(page, /matchesScope\(row, scope\)/, 'scope narrowing is the named, explicit helper')
  assert.ok(!/is_stale\)/.test(visibleDef),
    'freshness is never dropped client-side; chips filter, they never hide')
  assert.ok(!/rows\.filter\(\(?r?\)? => !r\.is_stale/.test(page),
    'the original silent stale-hiding filter is gone')
})
check('the service still does no geofence math', () => {
  assert.ok(!/Math\.(sin|cos|acos|asin)/.test(serviceSource),
    'inside/outside is decided by resolve_employee_location() only')
})

console.log('\n6. The live tab says what is actually true')
check('the header chips count the SAME category the badges show', () => {
  // THIS IS THE REPORTED BUG, AND THE OLD VERSION OF THIS TEST PINNED IT.
  //
  // The chips used to be labelled `Inside` / `Outside` / `Stale` / `No data`
  // while being fed `countFreshness().live/.delayed/.stale/.none` — i.e. they
  // counted HOW OLD each fix is, but promised HOW NEAR each fix was. So a
  // device with exactly one live fix printed "1 Inside" even though that fix
  // was 11.7 km outside Head Office and its row badge correctly read Outside.
  //
  // Both sides now read the ONE server field `display_category`. The chips
  // count it, the badges switch on it, and the sum adds up because the
  // categories are mutually exclusive.
  assert.match(page, /countDisplayCategories\(/)
  assert.match(page, /\{scopedCounts\.inside\} Inside/)
  assert.match(page, /\{scopedCounts\.outside\} Outside/)
  assert.match(page, /\{scopedCounts\.stale\} Stale/)
  assert.match(page, /display-category-counts/)
  // No freshness bucket may feed a chip label any more.
  assert.ok(!/counts\.live\} Inside/.test(page))
  assert.ok(!/counts\.delayed\} Outside/.test(page))
  assert.ok(!/counts\.none\} No data/.test(page))
  // Exactly one category per row, so the arithmetic is checkable:
  // inside + outside + stale + unconfigured === rows listed.
  assert.ok(!/'no_data'/.test(page))
})
check('a stale fix is grey + "Last known", never a green Inside pill', () => {
  assert.match(page, /Last known/)
  assert.match(page, /\bStale\b/)
  assert.ok(!/bg-emerald-100 text-emerald-800'[^}]*Stale/.test(page))
  // The bright pill is only rendered for live/delayed rows.
  assert.ok(/FRESHNESS\.STALE/.test(page), 'stale is branched on explicitly')
})
check('an employee with no fix is not listed by the live tab at all', () => {
  // employee_live_positions_v4 inner-joins the newest fix, so the 224 employees
  // who have never reported are simply not rows of this table. The single-source
  // test pins the full contract; here we assert the page no longer renders a
  // placeholder row for them and never claims to be showing all employees.
  assert.ok(!/No location yet/.test(page))
  assert.match(page, /reporting in the last \$\{RECENT_HOURS\} h/)
  assert.ok(!/\$\{total\} tracked/.test(page))
})
check('the list refreshes every 30s while visible and on focus', () => {
  assert.match(page, /POLL_MS = 30000/)
  assert.match(page, /setInterval\(refresh, POLL_MS\)/)
  assert.match(page, /visibilitychange/)
  assert.match(page, /window\.addEventListener\('focus'/)
  assert.match(page, /silent: true/)
})
check('realtime is not claimed: the events table is not in the publication', () => {
  // postgres_changes would deliver NOTHING (RLS + not published), which reads
  // as "the app is broken"; polling is the honest mechanism today.
  assert.ok(!/postgres_changes/.test(page), 'no dead realtime subscription')
  assert.ok(!/\.channel\(/.test(page))
})
check('a failed background poll never blanks the table on screen', () => {
  assert.match(page, /must never blank a table/)
  assert.ok(!/setRows\(\[\]\)/.test(page))
})

console.log('\n7. History is ordered, gaps are stated, late uploads are labelled')
check('points are sorted by recorded_at ascending, everywhere', () => {
  assert.match(serviceSource, /export function sortByRecordedAt/)
  assert.match(serviceSource, /points: sortByRecordedAt\(res\?\.points\)/)
  const sorted = mod.sortByRecordedAt([
    { recorded_at: '2026-10-08T10:30:00Z' },
    { recorded_at: '2026-10-08T09:00:00Z' },
    { recorded_at: '2026-10-08T12:00:00Z' },
  ])
  assert.deepStrictEqual(
    sorted.map((p) => p.recorded_at),
    ['2026-10-08T09:00:00Z', '2026-10-08T10:30:00Z', '2026-10-08T12:00:00Z'],
  )
  // A backfilled row recorded earlier can never be drawn after a later fix.
  const backfilled = mod.sortByRecordedAt([
    { recorded_at: '2026-10-08T17:00:00Z', uploaded_at: '2026-10-08T17:00:00Z' },
    { recorded_at: '2026-10-08T14:00:00Z', uploaded_at: '2026-10-08T17:30:00Z' },
  ])
  assert.strictEqual(backfilled[0].recorded_at, '2026-10-08T14:00:00Z')
  assert.deepStrictEqual(mod.sortByRecordedAt(null), [])
  assert.deepStrictEqual(mod.sortByRecordedAt('not an array'), [])
  // Unparseable timestamps sort last rather than throwing.
  const mixed = mod.sortByRecordedAt([
    { recorded_at: 'garbage' },
    { recorded_at: '2026-10-08T09:00:00Z' },
  ])
  assert.strictEqual(mixed[0].recorded_at, '2026-10-08T09:00:00Z')
})
check('a silent stretch longer than the threshold becomes a gap row', () => {
  const timeline = [
    { recordedAt: '2026-10-08T09:00:00Z', id: 1 },
    { recordedAt: '2026-10-08T09:05:00Z', id: 2 },   // 5m  -> no gap
    { recordedAt: '2026-10-08T10:30:00Z', id: 3 },   // 85m -> gap
  ]
  const gapped = mod.insertTimelineGaps(timeline, 10)
  assert.strictEqual(gapped.length, 4)
  const gap = gapped.find((t) => t.isGap)
  assert.ok(gap, 'the 85 minute silence must be stated')
  assert.match(gap.label, /^No data for 1h 25m$/)
  // No point is ever dropped or reordered.
  assert.deepStrictEqual(
    gapped.filter((t) => !t.isGap).map((t) => t.id),
    [1, 2, 3],
  )
  // Exactly at the threshold there is no gap.
  const atThreshold = mod.insertTimelineGaps([
    { recordedAt: '2026-10-08T09:00:00Z', id: 1 },
    { recordedAt: '2026-10-08T09:10:00Z', id: 2 },
  ], 10)
  assert.strictEqual(atThreshold.length, 2)
  assert.deepStrictEqual(mod.insertTimelineGaps([]), [])
  assert.deepStrictEqual(mod.insertTimelineGaps([timeline[0]]), [timeline[0]])
})
check('a backfilled upload is labelled, a normal one is not', () => {
  assert.strictEqual(
    mod.isUploadedLate('2026-10-08T14:00:00Z', '2026-10-08T14:06:00Z'), true)
  assert.strictEqual(
    mod.isUploadedLate('2026-10-08T14:00:00Z', '2026-10-08T14:04:00Z'), false)
  assert.strictEqual(
    mod.isUploadedLate('2026-10-08T14:00:00Z', '2026-10-08T14:00:30Z'), false)
  assert.strictEqual(mod.isUploadedLate('2026-10-08T14:00:00Z', null), false)
  assert.strictEqual(mod.isUploadedLate(null, '2026-10-08T14:00:00Z'), false)
  assert.match(drawer, /uploaded late/)
  assert.match(drawer, /isUploadedLate\(t\.recordedAt, t\.uploadedAt, LATE_UPLOAD_MINUTES\)/)
})
check('the drawer states gaps and never draws a route between points', () => {
  assert.match(drawer, /insertTimelineGaps\(buildMovementTimeline\(points, addresses\)\)/)
  assert.match(drawer, /t\.isGap/)
  const map = read('src/components/tracking/TrackingMap.jsx')
  assert.match(map, /valid\.length >= 2/)
  assert.ok(!/Math\.(sin|cos|acos|asin)/.test(map), 'the map never recomputes inside/outside')
})
check('a low-accuracy fix says so only when it is genuinely ambiguous', () => {
  assert.match(configSource, /LOW_ACCURACY_SUFFIX = '\(low GPS accuracy\)'/)
  assert.match(serviceSource, /export function isLowAccuracy/)
  // THE DEFECT: the note used to appear whenever accuracy > radius. A 120 m fix
  // against a 50 m fence qualified — and so did a fix 9.2 km OUTSIDE it, where
  // accuracy cannot possibly change the verdict.
  const farOutside = { accuracy: 120, nearest_radius: 50, nearest_distance: 9200, distance_to_center_m: null, boundary_ambiguous: false }
  assert.strictEqual(mod.isLowAccuracy(farOutside), false)
  // It is shown only when the error circle actually straddles the boundary.
  const ambiguous = { accuracy: 30, nearest_radius: 50, distance_to_center_m: 40, boundary_ambiguous: true }
  assert.strictEqual(mod.isLowAccuracy(ambiguous), true)
  // An older row without the server flag falls back to the same boundary test.
  const legacyAmbiguous = { accuracy: 30, nearest_radius: 50, distance_to_center_m: 40 }
  assert.strictEqual(mod.isLowAccuracy(legacyAmbiguous), true)
  const legacyPrecise = { accuracy: 30, nearest_radius: 50, distance_to_center_m: 9200 }
  assert.strictEqual(mod.isLowAccuracy(legacyPrecise), false)
  // The verdict itself is untouched by the accuracy note.
  const status = mod.describeGeofenceStatus({
    inside_geofence: false,
    accuracy: 120,
    nearest_radius: 50,
    nearest_location_name: 'HEAD OFFICE',
    nearest_distance: 9200,
  })
  assert.strictEqual(status.tone, 'outside')
  const inside = mod.describeGeofenceStatus({
    inside_geofence: true,
    accuracy: 10,
    nearest_radius: 50,
    location_label: 'HEAD OFFICE',
    nearest_distance: 12,
  })
  assert.strictEqual(inside.tone, 'inside')
})

console.log('')
if (failed) {
  console.error(`${failed} check(s) failed`)
  process.exit(1)
}
console.log('All checks passed')
