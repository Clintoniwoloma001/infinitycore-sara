// ============================================================================
// Employee Tracking - geofence verdict honesty + map view
//
// REGRESSION for the screen that showed "HEAD OFFICE" in the Location column
// while the Geofence column said "Outside". The coordinates were never wrong;
// the LABEL was, because resolve_employee_location() fell back to the NEAREST
// fence name while inside = false.
//
// The concrete case that surfaced it, kept here so the geometry is verifiable
// rather than argued about:
//   HEAD OFFICE  6.605829, 3.392538  radius 20 m
//   observation  6.524398, 3.379198
//   -> 9173.8 m apart, i.e. ~459x the radius. "Outside" was correct.
// ============================================================================
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const m2 = read('supabase/migrations/20260926000002_employee_tracking_access.sql')
const m3 = read('supabase/migrations/20260929000003_tracking_geofence_context_and_map.sql')
const service = read('src/services/employeeTrackingService.js')
const drawer = read('src/components/tracking/HistoryDrawer.jsx')
const live = read('src/components/tracking/LivePositions.jsx')
const map = read('src/components/tracking/TrackingMap.jsx')
const summary = read('src/components/tracking/MovementSummary.jsx')
const geocode = read('src/services/reverseGeocodeService.js')

let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok  ${name}`) }
  catch (e) {
    // Keep the message readable: a raw SQL body would otherwise dump kilobytes.
    const msg = String(e.message).slice(0, 300)
    console.error(`  FAIL ${name}\n       ${msg}`)
    process.exitCode = 1
  }
}
/** Slice from a function's `as $$` body to its closing `$$;`. */
const body = (sql, name) => {
  const start = sql.indexOf(`create or replace function public.${name}`)
  assert.ok(start >= 0, `function ${name} not found`)
  const asPos = sql.indexOf('as $$', start)
  return sql.slice(asPos, sql.indexOf('$$;', asPos))
}

// ---- the geometry that proved the original verdict was right -------------
const toRad = (d) => (d * Math.PI) / 180
function separation(aLat, aLng, bLat, bLng) {
  const dLat = toRad(bLat - aLat)
  const dLng = toRad(bLng - aLng)
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * 6371000 * Math.asin(Math.sqrt(s))
}

console.log('\nThe reported coordinates really are far outside the fence')
check('the observation is ~9.2 km from a 20 m geofence', () => {
  const d = separation(6.605829, 3.392538, 6.524398, 3.379198)
  assert.ok(d > 9000 && d < 9300, `expected ~9173 m, got ${d.toFixed(1)}`)
  assert.ok(d > 20 * 100, 'far beyond the configured radius, so "Outside" was correct')
})
check('the geofence radius was never the cause', () => {
  // A 20 m radius was not the bug: the LABEL was. The radius is recorded so a
  // reader can check the verdict against it.
  assert.match(m3, /nearest_radius/)
})

console.log('\nRegression: a location is never named without its distance')
check('the resolver returns an honest outside_label', () => {
  const fn = body(m3, 'resolve_employee_location')
  assert.match(fn, /'outside_label'/, 'must expose outside_label')
  assert.match(fn, /'Outside ' \|\| v_nearest_name/, 'names the nearest fence')
  assert.match(fn, /km away/, 'and states the real separation')
  assert.match(fn, /m away/, 'in metres below 1 km')
})
check('outside_label never overrides the name for an inside point', () => {
  const fn = body(m3, 'resolve_employee_location')
  // Use the LAST occurrence: the first is the invalid-coordinate early return,
  // which legitimately returns a fixed 'Unknown location'.
  const start = fn.lastIndexOf("'outside_label'")
  assert.ok(start > 0, 'outside_label must appear in the main return')
  const clause = fn.slice(start, fn.indexOf('end);', start))
  assert.match(clause, /when v_best_name is not null then v_best_name/,
    'an inside point keeps the plain fence name')
  assert.match(clause, /v_nearest_name is null then 'Outside registered locations'/,
    'with no fence nearby it must not name one')
})
check('ingest stores the honest label and the measured distance', () => {
  const fn = body(m3, 'record_employee_location')
  assert.match(fn, /else coalesce\(nullif\(v_resolved ->> 'outside_label'/)
  assert.match(fn, /nearest_distance/, 'persists the measured distance')
  assert.match(fn, /nearest_location_name/, 'persists the nearest fence')
})
check('outside rows can no longer be labelled as if inside', () => {
  // The original defect: location_label named a fence AND inside_geofence was
  // false, with nothing stored to check the claim against.
  assert.match(m3, /alter table public\.employee_location_events/)
  for (const col of ['nearest_location_name', 'nearest_distance', 'nearest_radius']) {
    assert.match(m3, new RegExp(`add column if not exists ${col}`), `missing column ${col}`)
  }
})
check('existing rows are repaired through the same engine', () => {
  assert.match(m3, /update public\.employee_location_events/)
  assert.match(m3, /resolve_employee_location\(\s*\n?\s*le2\.latitude/,
    'backfill must call the resolver, not recompute a distance')
  const backfill = m3.slice(m3.indexOf('update public.employee_location_events'))
  assert.ok(!/geo_distance/.test(backfill),
    'backfill must not introduce a second distance calculation')
})

console.log('\nReads expose the context the UI needs')
check('both read surfaces return the nearest context', () => {
  for (const fn of ['list_tracked_employees', 'employee_location_history']) {
    const b = body(m3, fn)
    assert.match(b, /nearest_distance/, `${fn} must return nearest_distance`)
    assert.match(b, /nearest_location_name/, `${fn} must return nearest_location_name`)
  }
})
check('history keeps its date and time-window filters', () => {
  const b = body(m3, 'employee_location_history')
  assert.match(b, /p_from_time/)
  assert.match(b, /p_to_time/)
  assert.match(b, /att_app_timezone/, 'time filtering stays in the app timezone')
})
check('the map geofence registry shares the access gate', () => {
  const b = body(m3, 'list_tracking_geofences')
  assert.match(b, /employee_tracking_access\(\)/, 'must re-check authorization')
  assert.match(b, /TRACKING_FORBIDDEN/)
  assert.match(b, /attendance_geofences/, "reads the engine's own registry")
  assert.match(b, /branches b/, 'and the branch geofences')
})

console.log('\nThe UI can filter by date AND time')
check('the drawer sends the time window to the server', () => {
  assert.match(drawer, /type="date"/)
  assert.match(drawer, /type="time"/)
  assert.match(drawer, /fromTime: fromTime \|\| null/)
  assert.match(drawer, /toTime: toTime \|\| null/)
  assert.match(drawer, /insideOnly/, 'and an inside/outside filter')
})
check('filtering is not faked on the client', () => {
  // The server filters; slicing points in the drawer would bypass the audit and
  // could show a shape the authorised query never returned.
  assert.ok(!/points\.filter\(/.test(drawer),
    'the client must not re-filter the audited result')
})

console.log('\nThe map is a real map with addresses')
check('a basemap is rendered with attribution', () => {
  assert.match(map, /tile\.openstreetmap\.org/)
  assert.match(map, /OpenStreetMap/, 'OSM requires visible attribution')
})
check('addresses are reverse geocoded and rate limited', () => {
  assert.match(geocode, /nominatim\.openstreetmap\.org/)
  assert.match(geocode, /MIN_INTERVAL_MS = 1100/, 'Nominatim allows 1 req/s')
  assert.ok(/enqueue/.test(geocode), 'requests must be serialized, not parallel')
  assert.match(geocode, /cache/, 'repeat lookups must be cached')
})
check('geocoding failures never break tracking', () => {
  assert.match(geocode, /return null/, 'a failed lookup degrades to null')
  assert.ok(!/throw /.test(geocode), 'it must never throw into the render path')
})
check('the map does not compute inside/outside itself', () => {
  assert.match(map, /inside_geofence/)
  assert.ok(!/Math\.(sin|cos|acos|asin)/.test(map), 'no client-side geofence math')
})

console.log('\nMovement summary is derived, not invented')
check('the summary states straight-line travel explicitly', () => {
  assert.match(summary, /straight-line/i)
  assert.ok(/No route between two points is\s*\n?\s*inferred/.test(summary)
    || /not a\s*\n?\s*travelled route/.test(summary))
})
check('a single point makes no movement claim', () => {
  assert.match(summary, /single moment, so no movement can be described/)
})
check('the grid shows the measured distance, not a bare "Outside"', () => {
  assert.match(live, /describeGeofenceStatus/)
  assert.match(service, /formatDistance/)
  assert.ok(!/Outside registered locations/.test(live),
    'the grid must not fall back to the old bare wording')
})

console.log('\nAccess control is unchanged')
check('no new surface bypasses the gate', () => {
  assert.match(m3, /revoke all on function public\.list_tracking_geofences\(\) from public/)
  assert.match(m2, /revoke all on function public\.employee_location_history/)
})

console.log(`\n${passed} checks passed`)
