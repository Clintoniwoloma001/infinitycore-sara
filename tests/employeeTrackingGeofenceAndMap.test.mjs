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

// ---------------------------------------------------------------------------
// The access-control fix (migration 20261101000005) and the frontend wiring.
// ---------------------------------------------------------------------------
const m5 = read('supabase/migrations/20261101000005_tracking_access_single_decision.sql')
const page = read('src/pages/EmployeeTracking.jsx')
const layout = read('src/components/Layout.jsx')
const nav = read('src/config/navigation.jsx')
const accessControl = read('src/config/accessControl.js')
const useAuth = read('src/hooks/useAuth.jsx')

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
  // The distance is rendered from the server's own fields — one line, once.
  assert.match(live, /formatDistance\(/)
  assert.match(live, /distance_to_center_m \?\? row\.meters_outside \?\? row\.nearest_distance/)
  assert.match(live, /from the centre/)
  assert.ok(!/Outside registered locations/.test(live),
    'the grid must not fall back to the old bare wording')
})

console.log('\nAuthorization is about the CALLER, never the subject')
check('history authorizes the caller, not the employee being viewed', () => {
  const b = body(m5, 'employee_location_history')
  // The call must take NO argument, so it resolves to auth.uid().
  assert.match(b, /employee_tracking_access\(\)/,
    'the access call must pass no id so it resolves to the caller')
  // Strip `--` comments first: the migration deliberately QUOTES the old buggy
  // call in its explanatory comments, and that must not be mistaken for code.
  const code = b.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n')
  assert.ok(!/employee_tracking_access\(p_\w+\)/.test(code),
    'the subject employee id must NEVER be passed to the access function')
  // The employee id is still used to SELECT rows.
  assert.match(b, /where le\.employee_id = p_employee_id/)
})

check('readers read can_view, not the never-returned key `allowed`', () => {
  for (const fn of ['employee_location_history', 'employee_current_locations', 'list_tracked_employees']) {
    const b = body(m5, fn)
    assert.match(b, /->> 'can_view'/, `${fn} must gate on can_view`)
    assert.ok(!/->> 'allowed'/.test(b), `${fn} must not gate on 'allowed'`)
  }
})

check('`allowed` is published as an explicit alias of can_view', () => {
  const b = body(m5, 'employee_tracking_access')
  assert.match(b, /'can_view', true, 'allowed', true/)
  assert.match(b, /'can_view', false, 'allowed', false/)
})

check('a passed argument cannot widen access (the whole defect class)', () => {
  const b = body(m5, 'employee_tracking_access')
  // The decision must come from auth.uid(), never from the parameter.
  assert.match(b, /v_uid uuid := auth\.uid\(\)/,
    'the decision must be the caller, read from the JWT')
  assert.ok(!/v_uid uuid := coalesce\(p_user_id/.test(b),
    'the parameter must not be able to override the caller identity')
  assert.match(b, /g\.target_user_id = v_uid/)
})

check('the ungated current-locations bypass is now gated', () => {
  const b = body(m5, 'employee_current_locations')
  assert.match(b, /employee_tracking_access\(\)/,
    'employee_current_locations had no access gate at all')
  assert.match(m5, /revoke all on function public\.employee_current_locations\(text, uuid, integer\) from public/)
})
check('every tracking reader is closed to PUBLIC and opened to authenticated', () => {
  for (const sig of [
    'employee_tracking_access(uuid)',
    'employee_location_history(uuid, date, time, time, text)',
    'employee_current_locations(text, uuid, integer)',
    'list_tracked_employees(integer, text, uuid)',
  ]) {
    const esc = sig.replace(/[()]/g, '\\$&')
    assert.match(m5, new RegExp(`revoke all on function public\\.${esc} from public`),
      `${sig} must be revoked from PUBLIC`)
    assert.match(m5, new RegExp(`grant execute on function public\\.${esc} to authenticated`),
      `${sig} must be granted to authenticated`)
  }
})

check('grants fail closed: expired and revoked never count', () => {
  const b = body(m5, 'employee_tracking_access')
  assert.match(b, /g\.revoked_at is null/)
  assert.match(b, /g\.expires_at is null or g\.expires_at > now\(\)/)
})

check('a grantee can view but never re-share (can_manage is Super Admin only)', () => {
  const b = body(m5, 'employee_tracking_access')
  assert.match(b, /'can_manage', true[\s\S]*?'via', 'super_admin'/)
  assert.match(b, /'can_manage', false[\s\S]*?'via', 'delegated:/)
})

check('the migration ships a deployment guard for future regressions', () => {
  assert.match(m5, /pg_get_functiondef/)
  assert.match(m5, /tracking_access_gate_violation/)
  assert.match(m5, /begin;/)
  assert.match(m5, /commit;/)
})

check('the migration is idempotent (drops before recreating the renamed signature)', () => {
  // The deployed signature is (p_employee_id uuid) and CREATE OR REPLACE cannot
  // rename a parameter, so the drop is load-bearing, not cosmetic.
  assert.match(m5, /drop function if exists public\.employee_tracking_access\(uuid\)/)
  assert.ok(!/@@APPEND@@|MIGRATION_CHUNK_MARKER/.test(m5),
    'no build sentinels may be left in the migration')
})

console.log('\nThe frontend follows the database decision, and fails closed')
check('the menu is gated on the live decision, not a static permission', () => {
  assert.match(nav, /path: '\/employee-tracking'[\s\S]*?trackingGate: true/)
  assert.match(accessControl, /if \(route\.trackingGate\)/)
  assert.match(accessControl, /return auth\.trackingAccess\?\.can_view === true/,
    'the gate must compare strictly to true so null/loading means "no"')
})

check('useAuth caches the decision and exposes view/manage flags', () => {
  assert.match(useAuth, /supabase\.rpc\('employee_tracking_access'\)/)
  assert.match(useAuth, /canViewTracking: trackingAccess\?\.can_view === true/)
  assert.match(useAuth, /canManageTracking: trackingAccess\?\.can_manage === true/)
})

check('the page reads the shared decision instead of re-probing', () => {
  assert.match(page, /trackingAccess: access/)
  assert.ok(!/trackingService\.myAccess\(\)/.test(page),
    'the page must not issue a second, possibly divergent access probe')
})

check('delegated viewers cannot reach the sharing controls', () => {
  assert.match(page, /access\.can_manage \? \[\{ id: 'access'/,
    'the Shared access tab must be rendered only for a manager')
  assert.match(page, /tab === 'access' && access\.can_manage && <SharedAccess \/>/,
    'and the tab must not render its component without can_manage')
})

check('an expired grant is re-probed so the menu disappears without a refresh', () => {
  assert.match(layout, /refreshTrackingAccess/)
  assert.match(layout, /expires_at/)
  assert.match(layout, /addEventListener\('focus'/)
})

check('the debug AUTH STATUS text is gone from the shell', () => {
  assert.ok(!/AUTH STATUS/.test(layout), 'no debug auth text may be rendered')
})

console.log('\nAccess control is unchanged')
check('no new surface bypasses the gate', () => {
  assert.match(m3, /revoke all on function public\.list_tracking_geofences\(\) from public/)
  assert.match(m2, /revoke all on function public\.employee_location_history/)
})

// ---------------------------------------------------------------------------
// REGRESSION for the "no location recorded yet" screen that showed while the
// database held real, authorised positions.
//
// The server was never broken. list_tracked_employees() returns a BARE jsonb
// array of rows, but the service unwrapped `.employees` off the result - a key
// that does not exist - so every authorised row was discarded and the UI fell
// through to its honest empty state. These checks pin each reader's unwrapping
// to the shape its SQL actually returns, so a mismatch fails loudly here instead
// of silently rendering an empty map in production.
// ---------------------------------------------------------------------------
console.log('\nRPC payload shapes match what the service unwraps')
check('a bare-array RPC is not unwrapped as an object', () => {
  assert.ok(
    !/\}\s*\)\.employees/.test(service),
    'livePositions must not read `.employees` off a bare-array response',
  )
  assert.match(service, /unwrap\(data, error, \[\]\)/,
    'livePositions must unwrap to an array fallback')
  assert.match(service, /Array\.isArray\(result\)/,
    'a shape change must be raised, not rendered as "no locations"')
})

check('the empty-state copy is only reachable from a genuinely empty array', () => {
  // The tab only ever receives employees who HAVE a fix in the window (v4
  // inner-joins the newest fix), so the empty state means "nobody reported",
  // never "232 employees, 224 without a location".
  assert.match(live, /No one has reported in the last \$\{RECENT_HOURS\} h/)
  // The rows it renders come straight from the service result - nothing filters
  // the authorised set down to nothing on the client.
  assert.match(live, /setRows\(result\)/)
  assert.ok(!/setRows\(await trackingService\.livePositions\(/.test(live),
    'the live tab must read v4 (recent fixes only), not the all-employees v3 view')
  assert.ok(!/rows\.filter\(.*points_in_window/.test(live),
    'points_in_window is an activity signal, never a visibility filter')
})

check('object-shaped RPCs keep reading their own key', () => {
  // list_tracking_geofences -> { ok, geofences, default_radius }
  assert.match(body(m3, 'list_tracking_geofences'), /jsonb_build_object\('ok', true, 'geofences'/)
  assert.match(service, /\.geofences \|\| \[\]/)
  // employee_location_history -> { ok, date, points, point_count }
  assert.match(service, /\{ points: \[\], point_count: 0 \}/)
})

check('the deployed SQL returns an array, proving the object unwrap was wrong', () => {
  const b = body(m5, 'list_tracked_employees')
  assert.match(b, /coalesce\(jsonb_agg\(to_jsonb\(x\)/,
    'list_tracked_employees aggregates into a bare array')
  assert.ok(!/jsonb_build_object\('ok'/.test(b),
    'so the service must never expect an `employees` key')
})

console.log(`\n${passed} checks passed`)
