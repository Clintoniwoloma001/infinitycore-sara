// ============================================================================
// Employee Tracking "Live positions" tab — ONE source of truth for chips,
// rows and counts.
//
// THE BUG THIS PINS (production screenshot, employee IWOLOMA CLINTON
// TAMUNOSIKI, IMFB/26/0526, standing 11.7 km outside Head Office):
//
//   Header chips read "1 Inside / 0 Outside / 231 Stale / 224 No data".
//   With "Inside" selected the table still showed his row BADGED "Outside".
//   The row badge was correct; the chips were wrong.
//
// ROOT CAUSE:
//   LivePositions.jsx labelled its four chips `Inside` / `Outside` / `Stale` /
//   `No data` but fed them `countFreshness().live` / `.delayed` / `.stale` /
//   `.none` — i.e. the chips counted FRESHNESS (how old the fix is) while the
//   badges rendered the GEOFENCE VERDICT (inside_geofence). Two different
//   sources for the same two words. "1 Inside" meant "one LIVE fix", not "one
//   employee inside a fence".
//
//   Two more defects came with it:
//     * countFreshness() added rows with no fix to BOTH `none` and `stale`, so
//       "224 No data" was double-counted inside "231 Stale" and the chips could
//       never add up (1+0+231+224 ≠ 232 rows).
//     * employee_live_positions_v3 returned ALL 232 employees
//       (`left join latest_fix`) with NO ORDER BY, so 224 "No location yet"
//       rows pushed the employees who actually report to the bottom of an
//       effectively-alphabetical page.
//     * "(low GPS accuracy)" was printed whenever `accuracy > radius`, which
//       is true for a 100 m fix against a 20 m fence — and therefore appeared
//       on a point 11.7 km OUTSIDE the fence, where accuracy cannot change the
//       verdict at all.
//
// WHAT MUST HOLD, and what this file asserts:
//   1. The page calls employee_live_positions_v4, and does NOT merge the full
//      employee list client-side.
//   2. Chips and badges both read ONE server field, display_category.
//   3. inside + outside + stale + unconfigured === rows listed (the chips add
//      up, and never overlap — no "No data" chip).
//   4. Selecting a chip filters to rows with that exact category; selecting it
//      again clears it.
//   5. No row without a fix is ever listed.
//   6. Sort order comes from the server: live, delayed, stale; then newest;
//      then name. The client does not re-sort.
//   7. "(low GPS accuracy)" only when the server says boundary_ambiguous.
//   8. The SQL enforces 48 h, MAX(recorded_at) never uploaded_at, and excludes
//      only the exact emulator coordinate.
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

const page = read('src/components/tracking/LivePositions.jsx')
const service = read('src/services/employeeTrackingService.js')
const migration = read(
  'supabase/migrations/20261110000005_live_positions_v4.sql',
)

// ---------------------------------------------------------------------------
// Load the REAL page helpers so the fixture assertions below run against the
// shipped code, not a transcription. The JSX is transpiled to plain JS with
// only the imports stripped, so the pure helpers exported by the component
// (DISPLAY_CATEGORY, countDisplayCategories, sumCounted, clockNow) execute.
// ---------------------------------------------------------------------------
const pageJs = page
  .replace(/^import[\s\S]*?from '[^']*'\s*$/gm, '')
  .replace(/export default function LivePositions[\s\S]*$/, '')
// The component body and its JSX are stripped; the pure helpers it declares
// are already `export`ed inline, so nothing further needs re-exporting.
const pageMod = await import(
  `data:text/javascript,${encodeURIComponent(pageJs)}`,
)

const {
  DISPLAY_CATEGORY,
  COUNTED_CATEGORIES,
  RECENT_HOURS,
  SHOW_NO_DATA_COUNT,
  countDisplayCategories,
  sumCounted,
} = pageMod

// ---------------------------------------------------------------------------
// Fixture rows exactly as employee_live_positions_v4 returns them. One row
// per fixture shape; every field the page reads is present.
// ---------------------------------------------------------------------------
const base = {
  employee_id: 'e1',
  full_name: 'Fixture Employee',
  employee_number: 'IMFB/00/0000',
  position: 'Officer',
  department: 'Operations',
  branch_id: 'b1',
  branch_name: 'Head Office',
  latitude: 6.62,
  longitude: 3.49,
  accuracy_m: 12,
  recorded_at: '2026-10-10T10:00:00.000Z',
  uploaded_at: '2026-10-10T10:00:01.000Z',
  age_seconds: 40,
  server_now: '2026-10-10T10:00:40.000Z',
  freshness: 'live',
  geofence_status: 'inside',
  geofence_name: 'Head Office',
  nearest_location_name: 'Head Office',
  distance_to_center_m: 4,
  radius_m: 20,
  nearest_distance: 4,
  nearest_radius: 20,
  meters_outside: null,
  boundary_ambiguous: false,
  confidence: 'high',
  location_label: 'Head Office (4 m from centre)',
  sync_status: 'synced',
  display_category: 'inside',
  has_fix: true,
}

/** A fresh fix OUTSIDE the fence — the reported Iwoloma shape. */
const freshOutside = {
  ...base,
  employee_id: 'e2',
  full_name: 'Iwoloma Clinton Tamunosiki',
  employee_number: 'IMFB/26/0526',
  geofence_status: 'outside',
  inside_geofence: false,
  geofence_name: 'Head Office',
  distance_to_center_m: null,
  meters_outside: 11604,
  nearest_distance: 11604,
  accuracy_m: 100,
  boundary_ambiguous: false,
  display_category: 'outside',
  location_label: 'Outside Head Office (11604 m away)',
}

const freshInside = { ...base, employee_id: 'e3', display_category: 'inside' }
const delayedInside = {
  ...freshInside,
  employee_id: 'e4',
  full_name: 'Delayed Inside',
  freshness: 'delayed',
  age_seconds: 700,
  display_category: 'inside',
}
const staleInside = {
  ...freshInside,
  employee_id: 'e5',
  full_name: 'Stale Inside',
  freshness: 'stale',
  age_seconds: 90000,
  recorded_at: '2026-10-09T06:00:00.000Z',
  display_category: 'stale',
}
const staleOutside = {
  ...freshOutside,
  employee_id: 'e6',
  full_name: 'Stale Outside',
  freshness: 'stale',
  age_seconds: 60000,
  recorded_at: '2026-10-09T08:00:00.000Z',
  display_category: 'stale',
}
const unconfigured = {
  ...base,
  employee_id: 'e7',
  full_name: 'No Fence Branch',
  geofence_status: 'unconfigured',
  inside_geofence: false,
  geofence_name: null,
  nearest_location_name: null,
  distance_to_center_m: null,
  nearest_distance: null,
  meters_outside: null,
  display_category: 'unconfigured',
  location_label: 'No geofence configured',
}

/** A row with NO fix. v4 must never return one — that is the whole point. */
const noFixRow = {
  ...base,
  employee_id: 'e8',
  full_name: 'Never Reported',
  latitude: null,
  longitude: null,
  recorded_at: null,
  uploaded_at: null,
  age_seconds: null,
  freshness: 'stale',
  geofence_status: null,
  inside_geofence: false,
  display_category: 'stale',
  has_fix: false,
}

// The service module, loaded the same way, so isLowAccuracy() is exercised
// against the shipped implementation rather than a copy of it.
const serviceMod = await import(
  `data:text/javascript,${encodeURIComponent(
    read('src/config/trackingFreshness.js')
    + service
      .replace(/import \{ supabase \} from '\.\.\/supabaseClient'/,
        'const supabase = { rpc: async () => ({ data: [], error: null }) }')
      .replace(/import \{[\s\S]*?\} from '\.\.\/config\/trackingFreshness'/, ''),
  )}`,
)

console.log('\n1. The page reads v4 and never merges the full employee list')
check('the page calls livePositionsRecent (v4), not livePositions (v3)', () => {
  assert.match(page, /trackingService\.livePositionsRecent\(/)
  assert.ok(
    !/trackingService\.livePositions\(/.test(page),
    'the Live positions tab must not read the all-employees v3 view',
  )
})
check('the recency window is 48 h and comes from one constant', () => {
  assert.strictEqual(RECENT_HOURS, 48)
  assert.match(page, /recentHours: RECENT_HOURS/)
})
check('the service asks v4 for only the recent window', () => {
  assert.match(service, /supabase\.rpc\('employee_live_positions_v4'/)
  assert.match(service, /p_recent_hours: recentHours/)
})

console.log('\n2. Chips and badges read ONE field')
check('display_category is the single source for both', () => {
  // The chips count it.
  assert.match(page, /countDisplayCategories\(/)
  // The rows are filtered by it, exactly.
  assert.match(page, /r\.display_category === activeFilter/)
  // The row badge is switched on it.
  assert.match(page, /const category = row\.display_category/)
})
check('the old freshness-labelled chips are gone', () => {
  assert.ok(!/counts\.live} Inside/.test(page))
  assert.ok(!/counts\.delayed} Outside/.test(page))
  assert.ok(!/counts\.none} No data/.test(page))
})
check('there is no "No data" chip and no second counting pipeline', () => {
  assert.ok(!/'no_data'/.test(page))
  assert.ok(!/countFreshness/.test(page), 'freshness counting must not feed the chips')
  assert.ok(!/rowFreshness/.test(page))
})

console.log('\n3. The chips add up (the reported "1+0+231+224 != 232" defect)')
check('one mutually exclusive category per row', () => {
  assert.deepStrictEqual(COUNTED_CATEGORIES, ['inside', 'outside', 'stale', 'unconfigured'])
})
check('inside + outside + stale + unconfigured === rows listed', () => {
  const rows = [freshOutside, freshInside, delayedInside, staleInside, staleOutside, unconfigured]
  const counts = countDisplayCategories(rows)
  assert.strictEqual(sumCounted(counts), rows.length)
})
check('a "no fix" row is not silently absorbed into a second bucket', () => {
  // The old countFreshness() added NONE rows to BOTH stale and none.
  const counts = countDisplayCategories([...Array(3).fill(noFixRow)])
  assert.strictEqual(sumCounted(counts), 3)
  assert.strictEqual(counts.stale, 3)
})
check('SHOW_NO_DATA_COUNT is a single off-by-default constant', () => {
  assert.strictEqual(SHOW_NO_DATA_COUNT, false)
})
check('the page labels the tab by reporting count, not total tracked', () => {
  assert.match(page, /reporting in the last \$\{RECENT_HOURS\} h/)
  assert.ok(!/tracked</.test(page), 'the "232 tracked" label is gone')
})

console.log('\n4. Selecting a chip filters by category only')
check('filtering is an exact match on display_category', () => {
  const rows = [freshOutside, freshInside, staleInside, unconfigured]
  const apply = (filter) => (!filter ? rows : rows.filter((r) => r.display_category === filter))
  assert.deepStrictEqual(apply('inside').map((r) => r.full_name), ['Fixture Employee'])
  assert.deepStrictEqual(apply('outside').map((r) => r.full_name), ['Iwoloma Clinton Tamunosiki'])
  assert.deepStrictEqual(apply('stale').map((r) => r.full_name), ['Stale Inside'])
  assert.deepStrictEqual(apply('unconfigured').map((r) => r.full_name), ['No Fence Branch'])
  assert.strictEqual(apply('inside').length + apply('outside').length
    + apply('stale').length + apply('unconfigured').length, rows.length)
})
check('toggling the same chip clears it', () => {
  assert.match(page, /activeFilter === c\.key \? null : c\.key/)
})

console.log('\n5. No row without a fix is ever listed')
check('v4 inner-joins the latest fix', () => {
  assert.match(migration, /join latest_fix le on le\.employee_id = e\.id/)
  assert.ok(
    !/left join latest_fix/i.test(migration),
    'a LEFT join is what returned all 232 employees',
  )
})
check('v4 bounds the window in SQL', () => {
  assert.match(migration, /l\.recorded_at >= now\(\) - make_interval\(hours => greatest\(1, p_recent_hours\)\)/)
})

console.log('\n6. Sort order comes from the server')
check('v4 orders by freshness rank, then newest, then name', () => {
  const order = migration.match(/order by[\s\S]*?c\.full_name;/)
  assert.ok(order, 'v4 must have an ORDER BY')
  assert.match(migration, /when c\.recorded_at > now\(\) - interval '6 minutes' then 0/)
  assert.match(migration, /when c\.recorded_at > now\(\) - interval '30 minutes' then 1/)
  assert.match(migration, /c\.recorded_at desc/)
  assert.match(migration, /c\.full_name;/)
})
check('the client never re-sorts the rows', () => {
  // Sorting the FILTER OPTION lists by label is legitimate presentation; what
  // must never happen is the row list being re-ordered on the client, because
  // that is how an alphabetical wall reappeared over the server's ordering.
  const reordersRows = /\.sort\(/.test(page)
    && !/entries\.sort\(\(a, b\) => String\(a\[1\]\)\.localeCompare/.test(page)
  assert.ok(!reordersRows, 'the row list must keep the server order')
  assert.ok(!/rows\.sort\(|visible\.sort\(|scoped\.sort\(/.test(page))
})

console.log('\n7. "(low GPS accuracy)" only when genuinely ambiguous')
check('isLowAccuracy trusts the server boundary_ambiguous first', () => {
  // 11.7 km outside a 20 m fence with 100 m accuracy: NOT ambiguous.
  assert.strictEqual(serviceMod.isLowAccuracy(freshOutside), false)
  // Same shape, but the error circle straddles the boundary: ambiguous.
  // boundary_ambiguous must be ABSENT, and the fields must be in the LEGACY
  // v3 shape (`accuracy`, not `accuracy_m`), so the fallback branch is what is
  // under test rather than the server-provided flag.
  const legacyV3Row = { accuracy: 30, nearest_radius: 20, distance_to_center_m: 12 }
  assert.strictEqual(serviceMod.isLowAccuracy(legacyV3Row), true)
  // And the same reading well outside the boundary is still NOT ambiguous.
  const legacyV3Far = { accuracy: 30, nearest_radius: 20, distance_to_center_m: 300 }
  assert.strictEqual(serviceMod.isLowAccuracy(legacyV3Far), false)
})
check('the old accuracy > radius rule is gone', () => {
  assert.ok(!/return a > r/.test(service))
})
check('the note is rendered from that helper, once', () => {
  assert.match(page, /isLowAccuracy\(row\) && \(/)
  assert.match(page, /LOW_ACCURACY_SUFFIX/)
})

console.log('\n8. The SQL aggregates and excludes correctly')
check('one row per employee by MAX(recorded_at), never uploaded_at', () => {
  assert.match(migration, /distinct on \(l\.employee_id\)/)
  assert.match(migration, /order by l\.employee_id, l\.recorded_at desc nulls last, l\.id desc/)
  assert.ok(
    !/order by l\.employee_id, l\.uploaded_at/.test(migration),
    'a backfilled older fix must never displace a newer live one',
  )
})
check('only the exact emulator coordinate is excluded', () => {
  assert.match(migration, /not \(l\.latitude = v_emulator_lat and l\.longitude = v_emulator_lng\)/)
  assert.match(migration, /v_emulator_lat numeric := 37\.4219983/)
  assert.match(migration, /v_emulator_lng numeric := -122\.0840000/)
  // Never a radius or a bounding box around it.
  assert.ok(!/distance.*emulator|st_dwithin.*emulator/i.test(migration))
})
check('older v3 is left in place for older clients', () => {
  assert.ok(
    !/drop function.*employee_live_positions_v3/i.test(migration),
    'dropping v3 would break installed older app builds',
  )
})
check('every geofence column is derived here, never from a stored flag', () => {
  assert.match(migration, /from public\.classify_geofence\(/)
  assert.ok(
    !/le\.inside_geofence|l\.inside_geofence/.test(migration),
    'a stored inside_geofence written at capture time is never trusted',
  )
})
check('the access gate and caller-scope enforcement are unchanged', () => {
  assert.match(migration, /v_access := public\.employee_tracking_access\(\);/)
  assert.match(migration, /TRACKING_FORBIDDEN:%/)
  assert.ok(
    !/p_user_id/.test(migration),
    'identity must come from auth.uid(), never a parameter',
  )
})
check('display_category assigns exactly one value per row', () => {
  // Stale always wins, so an old fix is never presented as a current position.
  assert.match(migration, /c\.recorded_at <= now\(\) - interval '30 minutes' then 'stale'/)
  assert.match(migration, /when c\.nearest_registered_name is null then 'unconfigured'/)
  assert.match(migration, /when coalesce\(c\.inside, false\) then 'inside'/)
  assert.match(migration, /else 'outside'/)
})
check('boundary_ambiguous is the boundary test, not accuracy > radius', () => {
  assert.match(
    migration,
    /abs\(coalesce\(c\.distance_to_center_m, c\.nearest_distance\) - c\.nearest_radius\)\s*\n?\s*<= c\.accuracy/,
  )
  assert.ok(!/p_accuracy > .*radius|accuracy > nearest_radius/.test(migration))
})
check('the migration is additive and declares the v4 columns', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.employee_live_positions_v4\(/)
  assert.match(migration, /display_category text/)
  assert.match(migration, /boundary_ambiguous boolean/)
})

console.log('')
if (failed > 0) {
  console.log(`${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('All live-positions single-source checks passed.')
