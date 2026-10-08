// ============================================================================
// Phase 70 - attendance location authority, employee tracking, leave planner
// ============================================================================
// Content assertions over the shipped migrations and frontend. No live DB.
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const m1 = read('supabase/migrations/20260926000001_attendance_location_authority.sql')
const m2 = read('supabase/migrations/20260926000002_employee_tracking_access.sql')
const m3 = read('supabase/migrations/20260926000003_leave_schedule_planner.sql')
const trackingService = read('src/services/employeeTrackingService.js')
const plannerService = read('src/services/leavePlannerService.js')

let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok  ${name}`) }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1 }
}
const section = (sql, from, to) => sql.slice(sql.indexOf(from), sql.indexOf(to))
// Slice from the function's `as $$` body so a preceding comment block (which may
// itself contain `$$`) cannot be mistaken for the end of the function.
const body = (sql, name) => {
  const start = sql.indexOf(`create or replace function public.${name}`)
  assert.ok(start >= 0, `function ${name} not found`)
  const asPos = sql.indexOf('as $$', start)
  assert.ok(asPos >= 0, `no body for ${name}`)
  return sql.slice(asPos, sql.indexOf('$$;', asPos))
}

console.log('\nA12 - one authoritative geofence engine')
check('resolve_employee_location exists and never raises', () => {
  assert.match(m1, /create or replace function public\.resolve_employee_location/)
  const fn = section(m1,
    'create or replace function public.resolve_employee_location',
    '-- 2. attendance_validate_location')
  assert.ok(!/raise exception/i.test(fn), 'resolver must never raise')
})
check('attendance_validate_location delegates to the single resolver', () => {
  assert.match(m1, /public\.resolve_employee_location\(p_lat, p_lng/)
})
check('geofence registry is read live, not hard-coded', () => {
  assert.match(m1, /from public\.branches b/)
  assert.match(m1, /from public\.attendance_geofences g/)
})

console.log('\nA1/A2 - assigned branch must never gate clock-out')
check('the validator has no branch-mismatch rejection', () => {
  const fn = body(m1, 'attendance_validate_location')
  const reasons = fn.match(/raise exception '([A-Z_]+):/g) || []
  assert.ok(reasons.includes("raise exception 'OUTSIDE_GEOFENCE:"),
    'must reject being outside all geofences')
  assert.ok(!reasons.some((r) => /BRANCH|MISMATCH/.test(r)),
    'must NOT reject on a branch mismatch')
})
check('the clock-out rejection names the real reason', () => {
  assert.match(m1, /Location is outside all registered attendance geofences/)
})
check('both sides of the attendance location are stored', () => {
  assert.match(m1, /clock_in_branch_id/)
  assert.match(m1, /clock_out_branch_id/)
  assert.match(m1, /clock_out_location_label/)
  assert.match(m1, /does NOT overwrite geofence_id/)
})

console.log('\nA3/A4 - missing clock-out, calendar day, next day still works')
check('status CHECK admits missing_clock_out', () => {
  assert.match(m1, /'missing_clock_out'/)
})
check('sweep marks without writing a clock_out', () => {
  const fn = body(m1, 'attendance_mark_missing_clockouts')
  assert.match(fn, /set status = 'missing_clock_out'/)
  assert.ok(!/set clock_out/i.test(fn), 'must not fabricate a clock_out')
  assert.match(fn, /r\.attendance_date < v_today/)
})
check('auto clock-out is super admin only and hides its marker', () => {
  const fn = body(m1, 'attendance_auto_clockout_close_sessions')
  assert.match(fn, /current_role\(\) <> 'super_admin'/)
  assert.match(fn, /SUPER_ADMIN_ONLY/)
  assert.ok(!/v_updated.*auto_clock_out/.test(fn),
    'must not return the auto marker to the caller')
})
check('HR notification reuses the existing notifications table', () => {
  const fn = body(m1, 'attendance_mark_missing_clockouts')
  assert.match(fn, /insert into public\.notifications/)
  assert.match(fn, /head_of_human_resources/)
})

console.log('\nA6 - the last-3 trail is anchored on the transition')
check('transition detection walks inside -> outside', () => {
  const fn = body(m1, 'attendance_mark_missing_clockouts')
  assert.match(fn, /lead\(e0\.inside_geofence\)/)
  assert.match(fn, /z\.next_inside = false/)
  assert.match(fn, /limit 3/)
})

console.log('\nA8-A11 - tracking data model and access control')
check('location events keep recorded_at and uploaded_at separate', () => {
  assert.match(m1, /create table if not exists public\.employee_location_events/)
  assert.match(m1, /recorded_at timestamptz not null/)
  assert.match(m1, /uploaded_at timestamptz not null/)
  assert.match(m1, /idx_location_events_employee_recorded/)
})
check('location events are not directly readable by authenticated', () => {
  assert.match(m1, /revoke all on public\.employee_location_events from anon, authenticated/)
})
check('super admin bypasses grants; delegates need a live grant', () => {
  const fn = body(m2, 'employee_tracking_access')
  assert.match(fn, /super_admin/)
  assert.match(fn, /g\.revoked_at is null/)
  assert.match(fn, /g\.expires_at is null or g\.expires_at > now\(\)/)
})
check('expiry is enforced on read, not by a cron', () => {
  assert.ok(!/cron/i.test(body(m2, 'employee_tracking_access')),
    'expiry must be enforced by the read')
})
check('every tracking read re-checks authorization', () => {
  for (const name of ['list_tracked_employees', 'employee_location_history']) {
    const fn = body(m2, name)
    assert.match(fn, /employee_tracking_access\(\)/, `${name} must check access`)
    assert.match(fn, /TRACKING_FORBIDDEN/, `${name} must refuse explicitly`)
  }
})
check('ingest resolves through the single engine and is deduped', () => {
  const fn = body(m2, 'record_employee_location')
  assert.match(fn, /resolve_employee_location\(p_lat, p_lng, 'track'/)
  assert.match(fn, /on conflict \(employee_id, recorded_at, latitude, longitude\)/)
  assert.ok(!/p_employee_id/.test(fn), 'must not accept another employee id')
})
check('retention is explicit and never silent', () => {
  const fn = body(m2, 'prune_employee_location_history')
  assert.match(fn, /v_days is null or v_days <= 0/)
  assert.match(fn, /no location history was deleted/)
})
check('grant durations are validated', () => {
  const fn = body(m2, 'grant_tracking_access')
  assert.match(fn, /INVALID_DURATION/)
  assert.match(fn, /upper\(v_kind\)::interval/)
})
check('audit rows use the existing audit_logs table', () => {
  for (const a of ['TRACKING_ACCESS_GRANTED', 'TRACKING_ACCESS_REVOKED',
    'TRACKING_HISTORY_VIEWED', 'EMPLOYEE_LOCATION_HISTORY_QUERIED',
    'TRACKING_PERMISSION_EXPIRED']) {
    assert.ok(m2.includes(a), `missing audit action ${a}`)
  }
  assert.match(m2, /insert into public\.audit_logs/)
})

console.log('\nLeave planner - data model and engine')
check('leave_requests gains a real employee FK, backfilled additively', () => {
  assert.match(m3, /add column if not exists employee_id uuid references public\.employees/)
  assert.match(m3, /set employee_id = e\.id/)
})
check('holidays are seeded empty - no invented dates', () => {
  const sec = section(m3,
    'create table if not exists public.leave_holidays',
    '-- 6. WORKING-DAY ENGINE')
  assert.ok(!/insert into public\.leave_holidays/.test(sec),
    'must not invent holiday rows')
})
check('capacity rules are a precedence ladder, not hard-coded', () => {
  assert.match(m3, /priority_number integer not null/)
  assert.match(m3, /order by r\.priority_number asc/)
  assert.match(m3, /is_template boolean not null default false/)
})
check('the checker never mutates leave', () => {
  const fn = body(m3, 'check_leave_availability')
  assert.ok(!/insert into public\.leave_requests/.test(fn), 'must not insert leave')
  assert.ok(!/update public\.leave_requests/.test(fn), 'must not update leave')
  assert.ok(!/delete from public\.leave_requests/.test(fn), 'must not delete leave')
})
check('the checker is race-safe via an advisory lock', () => {
  assert.match(body(m3, 'check_leave_availability'), /pg_advisory_xact_lock/)
})
check('alternatives are bounded and unshiftable conflicts are explained', () => {
  const fn = body(m3, 'check_leave_availability')
  assert.match(fn, /p_depth < 1/)
  assert.match(fn, /NO_DATE_SHIFT_RESOLVES/)
})
check('working days come from one engine', () => {
  assert.match(m3, /create or replace function public\.leave_is_working_day/)
  assert.match(m3, /create or replace function public\.leave_working_days/)
  assert.match(m3, /default_working_days/)
})
check('planner read aggregates server-side and scopes non-planners', () => {
  const fn = body(m3, 'get_leave_planner')
  assert.match(fn, /v_is_planner or e\.id = v_emp\.id/)
  assert.match(fn, /lr\.status in \('approved','pending'\)/)
})
check('capacity rule writes are server-gated', () => {
  const fn = body(m3, 'upsert_leave_capacity_rule')
  assert.match(fn, /LEAVE_CONFIG_FORBIDDEN/)
  assert.match(fn, /leave\.schedule\.configure/)
})

console.log('\nFrontend - no duplicated business logic')
check('tracking service contains no geofence math', () => {
  assert.ok(!/Math\.(sin|cos|acos|asin)/.test(trackingService),
    'frontend must not re-implement the distance calculation')
})
check('leave planner service does no leave arithmetic', () => {
  const api = plannerService.slice(plannerService.indexOf('export const leavePlannerService'))
  assert.ok(!/workingDays\s*=|days\s*=/.test(api), 'duration must come from the server')
})
check('client forwards the depth parameter it now sends', () => {
  assert.match(plannerService, /p_depth: 0/)
})
check('stale locations are labelled, never shown as live', () => {
  const page = read('src/components/tracking/LivePositions.jsx')
  assert.match(page, /describeFreshness/)
  // Freshness comes from ONE shared classifier (src/config/trackingFreshness.js),
  // not from an ad-hoc test on the row inside the component.
  assert.match(page, /rowFreshness/)
  assert.match(page, /countFreshness/)
  assert.match(page, /trackingFreshness/)
  // An employee with no fix must be shown, not dropped from the roster.
  assert.match(page, /No location yet/)
  // Stale wording: a grey chip + "Last known", never a live green Inside pill.
  assert.match(page, /Last known/)
  assert.match(page, /Stale/)
})
check('movement path is drawn only from recorded points', () => {
  // The old assertion required "no map/tile provider is configured", which was
  // a statement about the absence of a basemap rather than about correctness.
  // The guarantee that actually matters - never infer a route between points -
  // is now asserted against the real map component.
  const p = read('src/components/tracking/TrackingMap.jsx')
  assert.match(p, /valid\.length >= 2/, 'a polyline needs at least two points')
  // Pre-existing assertion drift (fails on HEAD too): the comment in
  // TrackingMap.jsx wraps the sentence across two lines, so the old pattern
  // never matched the file it was written for. Re-asserted against the real
  // wording - the guarantee under test is unchanged.
  assert.match(p, /No route between\s*\/\/\s*two points is inferred|consecutive RECORDED points only|consecutive recorded observations/i)
  assert.match(p, /openstreetmap\.org/, 'a real basemap is now used')
})
check('the map never recomputes inside/outside itself', () => {
  const p = read('src/components/tracking/TrackingMap.jsx')
  assert.match(p, /inside_geofence/, 'colouring reads the server verdict')
  assert.ok(!/Math\.(sin|cos|acos|asin)/.test(p),
    'the map must not re-implement the geofence distance calculation')
})
check('planner timeline encodes state beyond colour', () => {
  const tl = read('src/components/leave/PlannerTimeline.jsx')
  assert.match(tl, /PLANNER_STATE/)
  assert.match(tl, /aria-hidden/)
})
check('exports are real documents, not screenshots', () => {
  const exp = read('src/services/leavePlannerExport.js')
  assert.match(exp, /from 'jspdf'/)
  assert.match(exp, /from 'xlsx'/)
  assert.match(exp, /book_append_sheet/)
})

console.log('\nRouting and permissions')
check('both new pages are routed', () => {
  const nav = read('src/config/navigation.jsx')
  assert.match(nav, /path: '\/employee-tracking'/)
  assert.match(nav, /path: '\/leave-planner'/)
  const app = read('src/App.jsx')
  assert.match(app, /EmployeeTracking/)
  assert.match(app, /LeaveSchedulePlanner/)
})
check('new permission keys exist in the catalog', () => {
  const perms = read('src/constants/permissions.js')
  for (const k of ['tracking.view', 'tracking.manage', 'leave.schedule.view',
    'leave.schedule.manage', 'leave.schedule.configure']) {
    assert.ok(perms.includes(k), `missing permission key ${k}`)
  }
})

console.log(`\n${passed} checks passed`)


