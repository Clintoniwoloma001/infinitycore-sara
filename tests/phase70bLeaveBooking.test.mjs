// ============================================================================
// Phase 70b - Director SQL fix, leave planner fixes, booking links, PWA
// ============================================================================
// Content assertions, no live database. The two SQL bugs are the ones that
// actually shipped broken, so this file pins their ROOT CAUSES (not just the
// patched text) and guards the invariants the booking workflow depends on.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const mig = read('supabase/migrations/20260926000004_director_leave_planner_fixes_and_booking_links.sql')

// The migration explains the bug it fixes, so its COMMENTS legitimately quote
// the broken code. Negative assertions run against the code with comments
// stripped, otherwise the documentation of a bug fails the test for that bug.
const sql = mig.replace(/--[^\n]*/g, '')

let n = 0
const check = (name, fn) => { fn(); n++; console.log('  ok - ' + name) }
const section = (t) => console.log('\n' + t)

/** The body of a `create or replace function` inside the migration. */
const fnBody = (name) => {
  const s = mig.indexOf(`create or replace function public.${name}(`)
  assert.ok(s > -1, name + ' not found in the migration')
  return mig.slice(s, mig.indexOf('\n$$;', s))
}

// ---------------------------------------------------------------------------
section('1. Director Intelligence: the ambiguous employee_id')
// ---------------------------------------------------------------------------

const snapshot = fnBody('get_director_executive_snapshot')

check('the snapshot is actually reissued in this migration', () => {
  assert.ok(snapshot.length > 1000, 'snapshot body not found')
})

check('no bare `e.id employee_id` projection survives', () => {
  // THIS was the bug: `select lr.*, e.id employee_id` produced two columns
  // named employee_id once leave_requests gained one, so every later
  // `l.employee_id` reference was ambiguous.
  assert.doesNotMatch(snapshot, /e\.id employee_id/)
  assert.doesNotMatch(sql, /e\.id employee_id/)
})

check('the employee is resolved once, under a distinct name', () => {
  assert.match(snapshot, /coalesce\(lr\.employee_id, e\.id\) as resolved_employee_id/)
})

check('the join is a LEFT join so employee_id-only rows are not dropped', () => {
  assert.match(snapshot, /left join public\.employees e on e\.user_id = lr\.created_by/)
})

check('the filter uses the resolved column, not the ambiguous one', () => {
  assert.match(snapshot, /where coalesce\(lr\.employee_id, e\.id\) in \(select id from ids\)/)
  assert.match(snapshot, /l\.resolved_employee_id=s\.id/)
  assert.doesNotMatch(snapshot, /\bl\.employee_id\b/)
})

check('the reissue PRESERVES the later executive role gate', () => {
  // Reissuing from 20260924000001 would silently narrow this back to
  // director/super_admin and lock the chairman and MD/CEO out.
  assert.match(snapshot, /current_role\(\) not in \('md_ceo','chairman','director','super_admin'\)/)
})

check('the reissue PRESERVES the fixed 20-day expected attendance', () => {
  // 20260925160359 replaced this. Reissuing the raw 20260924000005 body would
  // regress "expected = 1" and a 100% attendance rate on a 1-day window.
  assert.match(snapshot, /20::int expected_days/)
  assert.doesNotMatch(snapshot, /\(select count\(\*\) from range_days\)::int expected_days/)
})

check('the drill-down resolves the employee the same way', () => {
  const detail = fnBody('get_director_employee_detail')
  assert.match(detail, /coalesce\(l\.employee_id, e\.id\)=p_employee_id/)
})

// ---------------------------------------------------------------------------
section('2. Leave planner: the missing working_days column')
// ---------------------------------------------------------------------------

const workingDayFn = fnBody('leave_is_working_day')

check('reads default_working_days, the column that actually exists', () => {
  assert.match(
    workingDayFn,
    /select coalesce\(default_working_days, array\['mon','tue','wed','thu','fri'\]\)/,
  )
})

check('no bare `working_days` column read remains anywhere', () => {
  // `working_days` is a column on leave_schedule_entries, a DIFFERENT table.
  assert.doesNotMatch(sql, /coalesce\(working_days,/)
})

check('the working-day engine is the single authority the checker uses', () => {
  // leave_working_days() is not reissued here - it lives in 20260926000003 and
  // is unchanged. What matters is that it still routes through the function this
  // migration repairs, so fixing leave_is_working_day fixes every caller.
  const planner = read('supabase/migrations/20260926000003_leave_schedule_planner.sql')
  assert.match(planner, /create or replace function public\.leave_working_days\(/)
  assert.match(planner, /where public\.leave_is_working_day\(d::date, p_branch_id\)/)
  // And this migration repairs the function those calls land in.
  assert.match(mig, /create or replace function public\.leave_is_working_day\(/)
})

// ---------------------------------------------------------------------------
section('3. Booking links reuse the existing token pattern')
// ---------------------------------------------------------------------------

check('only the hash is stored; the raw key is returned exactly once', () => {
  assert.match(mig, /token_hash text not null unique/)
  assert.match(mig, /encode\(extensions\.digest\(v_raw, 'sha256'\), 'hex'\)/)
  assert.match(mig, /'token', v_raw/)
})

check('link resolution re-checks the link on submit, not just on display', () => {
  const submit = fnBody('submit_leave_booking')
  assert.match(submit, /if not v_link\.is_active then/)
  assert.match(submit, /LINK_CLOSED/)
  assert.match(submit, /LINK_EXPIRED/)
})

check('a revoked link stops taking bookings but keeps existing ones', () => {
  const revoke = fnBody('revoke_leave_booking_link')
  assert.match(revoke, /set is_active = false, revoked_at = now\(\)/)
  assert.doesNotMatch(revoke, /delete from/i)
})

check('link management is gated to HR, like the rest of leave config', () => {
  for (const fn of ['create_leave_booking_link', 'list_leave_booking_links', 'revoke_leave_booking_link']) {
    const body = fnBody(fn)
    assert.match(body, /has_permission\('leave\.schedule\.configure'\)/, fn + ' is not permission gated')
    assert.match(body, /LEAVE_CONFIG_FORBIDDEN/, fn + ' has no forbidden error')
  }
})

// ---------------------------------------------------------------------------
section('4. A booking is NOT a request, and there is still one approval path')
// ---------------------------------------------------------------------------

check('a booking row carries no approval state', () => {
  const t = mig.slice(
    mig.indexOf('create table if not exists public.leave_bookings'),
    mig.indexOf('create index if not exists idx_leave_bookings_employee'),
  )
  assert.match(t, /status text not null default 'booked'/)
  assert.doesNotMatch(t, /approval_level/)
  assert.doesNotMatch(t, /approved_by/)
})

check('conversion writes the SAME leave_requests row the manual form writes', () => {
  const fn = fnBody('convert_leave_booking_to_request')
  assert.match(fn, /insert into public\.leave_requests/)
  // Identical shape to src/pages/LeaveRequests.jsx submit().
  assert.match(fn, /'pending', 1, 1, now\(\)/)
  assert.match(fn, /is_cancellation/)
  assert.match(fn, /created_by, created_at/)
  assert.match(fn, /current_approval_level/)
})

check('the eligibility window is enforced SERVER-side, not only by the button', () => {
  const fn = fnBody('convert_leave_booking_to_request')
  assert.match(fn, /if current_date < \(v_booking\.start_date - v_window\) then/)
  assert.match(fn, /TOO_EARLY/)
  assert.match(fn, /BOOKING_EXPIRED/)
  assert.match(fn, /BOOKING_NOT_PENDING/)
})

check('the window is one shared function, so UI and gate cannot disagree', () => {
  assert.match(mig, /create or replace function public\.leave_booking_window_days\(\)/)
  const get = fnBody('get_my_leave_bookings')
  // to_jsonb(x) turns the aliases into the JSON keys the service reads.
  assert.match(get, /as can_request/)
  assert.match(get, /as opens_on/)
  assert.match(get, /as status_message/)
  // The same function backs the number the UI shows and the number that gates.
  assert.match(get, /v_window integer := public\.leave_booking_window_days\(\)/)
  assert.match(get, /'window_days', v_window/)
  assert.match(get, /current_date >= \(b\.start_date - v_window\)/)
})

check('the window is HR-configurable, value + unit, with a mandatory reason', () => {
  assert.match(mig, /add column if not exists leave_booking_request_lead_value integer not null default 14/)
  assert.match(mig, /leave_booking_request_lead_unit text not null default 'days'/)
  const save = fnBody('save_leave_booking_window')
  assert.match(save, /REASON_REQUIRED/)
  assert.match(save, /LEAVE_BOOKING_WINDOW_UPDATED/)
})

check('a booking cannot be converted twice', () => {
  assert.match(fnBody('convert_leave_booking_to_request'), /if v_booking\.status <> 'booked' then/)
})

check('duplicate bookings are refused rather than double-booked', () => {
  assert.match(fnBody('submit_leave_booking'), /ALREADY_BOOKED/)
})

check('the booking is announced as a booking, in words the UI can show', () => {
  const fn = fnBody('submit_leave_booking')
  assert.match(fn, /'notice'/)
  // The notice is assembled from concatenated literals; assert on the wording
  // the employee actually reads.
  assert.match(fn, /it is not a '/)
  assert.match(fn, /leave request\. You will need to formally request this leave closer to the date\./)
})


// ---------------------------------------------------------------------------
section('5. Planner reads bookings (timeline + capacity)')
// ---------------------------------------------------------------------------

const planner = fnBody('get_leave_planner')

check('the timeline unions bookings, tagged so they are never mistaken for requests', () => {
  assert.match(planner, /union all/)
  assert.match(planner, /'booking' as source/)
  assert.match(planner, /when e2\.source = 'booking' then 'booked'/)
  assert.match(planner, /null::uuid as request_id/)
})

check('capacity shows planned coverage without faking a breach', () => {
  assert.match(planner, /booked_count/)
  assert.match(planner, /total_planned_count/)
  // The verdict still keys off APPROVED leave only.
  assert.match(planner, /coalesce\(ola\.cnt, 0\) > r\.max_people_on_leave/)
})

check('the two day-grain sets are pre-aggregated (no join fan-out)', () => {
  assert.match(planner, /on_leave_agg as \(/)
  assert.match(planner, /booked_agg as \(/)
  assert.match(planner, /select branch_id, day, count\(\*\)::int as cnt from on_leave group by branch_id, day/)
})

check('the existing conflict and date-filter logic is preserved', () => {
  assert.match(planner, /lr\.status in \('approved','pending'\)/)
  assert.match(planner, /daterange\(lr\.start_date, coalesce\(lr\.end_date, lr\.start_date\), '\[\]'\)/)
  assert.match(planner, /r\.scope_type = 'branch' and r\.branch_id = pb\.branch_id/)
})

// ---------------------------------------------------------------------------
section('6. Migration hygiene')
// ---------------------------------------------------------------------------

check('transaction-wrapped, idempotent, no destructive statements', () => {
  assert.match(mig, /^begin;/m)
  assert.match(mig, /^commit;/m)
  assert.match(mig, /add column if not exists/)
  assert.match(mig, /create table if not exists/)
  assert.doesNotMatch(sql, /^\s*drop table/i)
  assert.doesNotMatch(sql, /^\s*delete from/i)
  assert.doesNotMatch(sql, /truncate/i)
})

check('no production leave record is rewritten', () => {
  assert.doesNotMatch(sql, /^\s*update public\.leave_requests\s+set/im)
})

// These two were only found by RUNNING the functions, not by reading them:
// a SECURITY DEFINER body pins search_path to public, and pgcrypto lives in
// `extensions` on Supabase, so the bare names fail at runtime. The repo's own
// QR token code already schema-qualifies for exactly this reason.
check('pgcrypto calls are schema-qualified (they fail at runtime otherwise)', () => {
  assert.doesNotMatch(sql, /[^.a-z_]gen_random_bytes\(/)
  assert.doesNotMatch(sql, /encode\(digest\(/)
  assert.match(sql, /extensions\.gen_random_bytes\(/)
  assert.match(sql, /extensions\.digest\(/)
})

check('text is compared with length(), not with a bare number', () => {
  // `btrim(p_reason) < 5` is text < integer and does not compile.
  assert.doesNotMatch(sql, /btrim\(p_reason\) < \d/)
  assert.match(sql, /length\(btrim\(p_reason\)\) < 5/)
})

check('every new function is revoked from public', () => {
  const fns = [...mig.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1])
  assert.ok(fns.length >= 10, 'expected the reissues plus the new booking RPCs')
  for (const fn of fns) {
    assert.match(
      mig,
      new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public;`),
      fn + ' is not revoked from public',
    )
  }
})

check('grants are declared for every new booking function', () => {
  for (const fn of [
    'create_leave_booking_link', 'list_leave_booking_links', 'revoke_leave_booking_link',
    'save_leave_booking_window', 'get_leave_booking_window', 'get_leave_booking_link',
    'submit_leave_booking', 'get_my_leave_bookings', 'convert_leave_booking_to_request',
    'leave_booking_window_days',
  ]) {
    assert.match(mig, new RegExp(`grant execute on function public\\.${fn}\\(`), fn + ' is not granted')
  }
})


// ---------------------------------------------------------------------------
section('7. Frontend wiring')
// ---------------------------------------------------------------------------

const app = read('src/App.jsx')
const requests = read('src/pages/LeaveRequests.jsx')
const bookingPage = read('src/pages/LeaveBooking.jsx')
const plannerPage = read('src/pages/LeaveSchedulePlanner.jsx')
const manager = read('src/components/leave/BookingLinkManager.jsx')
const svc = read('src/services/leaveBookingService.js')
const filters = read('src/components/leave/PlannerFilters.jsx')
const checker = read('src/components/leave/AvailabilityChecker.jsx')
const heatmap = read('src/components/leave/CapacityHeatmap.jsx')
const ruleTable = read('src/components/leave/RuleTable.jsx')
const typeSelect = read('src/components/leave/LeaveTypeSelect.jsx')
const settings = read('src/pages/Settings.jsx')

check('the booking link has a route', () => {
  assert.match(app, /path="\/leave-booking\/:token"/)
  assert.match(app, /import LeaveBooking from '\.\/pages\/LeaveBooking'/)
})

check('the employee page states plainly that a booking is not a request', () => {
  assert.match(bookingPage, /not a\s*leave\s*request/i)
  assert.match(bookingPage, /formally request this leave closer to the date/i)
  assert.match(bookingPage, /LEAVE_TYPE_LABELS/)
})

check('the employee requests page shows bookings with the gated button', () => {
  assert.match(requests, /Booked dates \(planned\)/)
  assert.match(requests, /Request this leave/)
  assert.match(requests, /disabled=\{!b\.can_request/)
  assert.match(requests, /convertToRequest/)
  // It reuses the existing page; it does not open a second approval flow.
  assert.doesNotMatch(requests, /window\.open/)
})

check('the HR link manager can create, list and revoke', () => {
  assert.match(manager, /createLink/)
  assert.match(manager, /revokeLink/)
  assert.match(manager, /shown only once/)
  assert.match(manager, /window\.confirm/)
})

check('the planner exposes the manager to planners only', () => {
  assert.match(plannerPage, /Booking links/)
  assert.match(plannerPage, /<BookingLinkManager/)
  assert.match(plannerPage, /isPlanner &&/)
})

check('the window is configurable from Settings', () => {
  assert.match(settings, /LeaveBookingWindowCard/)
  assert.match(settings, /saveWindow/)
  assert.match(settings, /weeks before/)
})

check('the service calls RPCs only - no direct table writes from the browser', () => {
  for (const fn of [
    'create_leave_booking_link', 'list_leave_booking_links', 'revoke_leave_booking_link',
    'get_leave_booking_link', 'submit_leave_booking', 'get_my_leave_bookings',
    'convert_leave_booking_to_request', 'save_leave_booking_window', 'get_leave_booking_window',
  ]) {
    assert.match(svc, new RegExp(`rpc\\('${fn}'`), fn + ' is not called as an RPC')
  }
  assert.doesNotMatch(svc, /\.from\('leave_bookings'\)/)
  assert.doesNotMatch(svc, /\.from\('leave_booking_links'\)/)
})

check('leave type is a dropdown sourced from the real catalogue', () => {
  assert.match(typeSelect, /LEAVE_TYPE_LABELS/)
  assert.match(filters, /LeaveTypeSelect/)
  assert.match(checker, /LeaveTypeSelect/)
  // The free-text inputs that caused silent no-result filters are gone.
  assert.doesNotMatch(filters, /placeholder="e\.g\. annual"/)
  assert.doesNotMatch(checker, /<input type="text" value=\{leaveType\}/)
})

check('the capacity table is aligned and explains "Not configured"', () => {
  assert.match(heatmap, /text-right tabular-nums/)
  assert.match(heatmap, /Not configured/)
  assert.match(heatmap, /<em> not<\/em> a breach/)
  assert.match(heatmap, /booked_count|booked/)
})

check('the rules table explains precedence and the template state', () => {
  assert.match(ruleTable, /the higher number wins/)
  assert.match(ruleTable, /Applies to/)
  assert.match(ruleTable, /currently has no effect at all/)
  assert.match(ruleTable, /Not configured/)
})


// ---------------------------------------------------------------------------
section('8. PWA')
// ---------------------------------------------------------------------------

const manifest = JSON.parse(read('public/manifest.json'))
const sw = read('public/sw.js')
const indexHtml = read('index.html')
const mainJsx = read('src/main.jsx')

check('manifest is installable and branded', () => {
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.theme_color, '#009944')
  assert.ok(manifest.name && manifest.short_name)
  const sizes = manifest.icons.map((i) => i.sizes)
  assert.ok(sizes.includes('192x192'), 'missing 192 icon')
  assert.ok(sizes.includes('512x512'), 'missing 512 icon')
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'missing maskable icon')
})

check('every declared icon actually exists and is a real PNG', () => {
  for (const icon of manifest.icons) {
    const p = path.join(root, 'public', icon.src)
    assert.ok(fs.existsSync(p), icon.src + ' is missing')
    const buf = fs.readFileSync(p)
    assert.deepEqual(
      [...buf.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      icon.src + ' is not a PNG',
    )
  }
})

check('the document links the manifest and sets the theme colour', () => {
  assert.match(indexHtml, /<link rel="manifest"/)
  assert.match(indexHtml, /name="theme-color" content="#009944"/)
  assert.match(indexHtml, /apple-touch-icon/)
})

check('the service worker is registered in production only', () => {
  assert.match(mainJsx, /import\.meta\.env\.PROD && 'serviceWorker' in navigator/)
  assert.match(mainJsx, /serviceWorker\.register/)
  // A cached shell in dev would serve stale modules over HMR.
  assert.doesNotMatch(read('vite.config.js'), /serviceWorker/)
})

check('the service worker caches the app shell and never the API', () => {
  assert.match(sw, /request\.mode === 'navigate'/)
  assert.match(sw, /SHELL_CACHE/)
  // Caching authenticated Supabase traffic would show a stale roster.
  assert.match(sw, /isApiRequest/)
  assert.match(sw, /rest\/v1/)
  assert.match(sw, /supabase\.co/)
})

console.log('\nAll ' + n + ' checks passed.')

