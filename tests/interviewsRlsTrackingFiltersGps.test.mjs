// ============================================================================
// Interviews RLS + tracking scope filters + geofence GPS acquisition.
//
// WHAT THIS FILE PINS
//  1. SUPABASE SQL (`20261110000004_hr_interviews_insert_super_admin.sql`)
//     widens the hr_interviews INSERT policy to super_admin (and the head
//     roles). Before this, scheduling an interview from the Interviews page
//     as Super Admin died with
//       new row violates row-level security policy for table "hr_interviews"
//     because the only INSERT policy listed admin/head_of_human_resources/
//     hr_officer — super_admin was missing while SELECT and UPDATE allowed it.
//  2. The client keeps working before that migration is applied:
//     hrService.scheduleInterview() detects the RLS refusal and writes the same
//     row through the guarded SECURITY DEFINER RPC
//     (hr_schedule_recruitment_interview), then patches the columns the RPC
//     does not carry with an UPDATE (whose policy already admits super_admin).
//  3. The Interviews result panel renders each error once (it rendered the same
//     error twice, which is why the screenshot showed the RLS line duplicated).
//  4. Employee Tracking → Live positions gains department / position / branch
//     filters derived from the authorised row set, plus a distinct empty state
//     when the picks exclude everyone.
//  5. Geofencing "Use my location" no longer silently fails: the button is
//     reachable without an existing fix, acquisition is bounded with no cached
//     position, and the real reason (denied / unavailable / timeout / insecure
//     origin) is shown.
// ============================================================================
import assert from 'node:assert/strict'
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

// ===========================================================================
console.log('\n1. The migration widens the INSERT policy, nothing else')
// ===========================================================================

const migration = read('supabase/migrations/20261110000004_hr_interviews_insert_super_admin.sql')

check('it targets the hr_interviews INSERT policy and re-issues it', () => {
  assert.match(migration, /drop policy if exists "hr_interviews_insert" on public\.hr_interviews/)
  assert.match(migration, /create policy "hr_interviews_insert" on public\.hr_interviews/)
  assert.match(migration, /for insert with check/)
})
check('super_admin is in the INSERT policy', () => {
  const start = migration.indexOf('create policy "hr_interviews_insert"')
  const end = migration.indexOf(');', start)
  const body = migration.slice(start, end)
  assert.match(body, /'super_admin'/)
})
check('it keeps every role that could already insert, and adds the head roles', () => {
  const start = migration.indexOf('create policy "hr_interviews_insert"')
  const body = migration.slice(start, migration.indexOf(');', start))
  for (const role of ['admin', 'head_of_human_resources', 'hr_officer', 'head_of_business', 'head_of_operations']) {
    assert.ok(body.includes(`'${role}'`), `missing ${role}`)
  }
})
check('SELECT and UPDATE policies are NOT touched by this migration', () => {
  assert.ok(!/hr_interviews_select|hr_interviews_read/.test(migration))
  assert.ok(!/create policy "hr_interviews_update"/.test(migration))
})
check('it is idempotent, transactional and additive', () => {
  assert.match(migration, /^begin;/m)
  assert.match(migration, /^commit;/m)
  assert.ok(!/drop table|delete from|truncate/i.test(migration))
})
check('the guarded RPC is re-granted to authenticated', () => {
  assert.match(migration, /grant execute on function public\.hr_schedule_recruitment_interview\(uuid, jsonb\) to authenticated/)

  // The RPC's own role gate must admit super_admin, otherwise the fallback
  // would refuse the same user the direct INSERT refused.
  const pipeline = read('supabase/migrations/20260921000010_roles_head_of_human_resources.sql')
  const rpc = pipeline.slice(
    pipeline.indexOf('create or replace function public.hr_schedule_recruitment_interview'),
    pipeline.indexOf('create or replace function public.hr_complete_recruitment_interview'),
  )
  assert.match(rpc, /if v_role not in \('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'\)/)
})

// ===========================================================================
console.log('\n2. The client survives the un-patched database')
// ===========================================================================

const hrService = read('src/services/hrService.js')

check('scheduleInterview still writes directly when the policy allows it', () => {
  const fn = hrService.slice(hrService.indexOf('async scheduleInterview('))
  assert.match(fn, /from\('hr_interviews'\)/)
  assert.match(fn, /\.insert\(\[interviewData\]\)/)
})
check('an RLS refusal routes to the guarded RPC instead of failing', () => {
  assert.match(hrService, /isRowLevelSecurityError\(error\)/)
  assert.match(hrService, /scheduleInterviewViaRpc\(interviewData\)/)
  assert.match(hrService, /const row = await scheduleInterviewViaRpc\(interviewData\)/)
})
check('RLS detection matches the code and the message', () => {
  const fn = hrService.slice(hrService.indexOf('function isRowLevelSecurityError'))
  assert.match(fn, /error\.code === '42501'/)
  assert.match(fn, /row\[- \]level security/i)
})
check('the RPC path maps the same fields, including instructions as notes', () => {
  const fn = hrService.slice(hrService.indexOf('async function scheduleInterviewViaRpc'))
  for (const field of ['candidate_id', 'scheduled_date', 'duration_minutes', 'interview_type', 'position', 'location', 'platform', 'meeting_url', 'interviewer_id', 'interview_round']) {
    assert.ok(new RegExp(`${field}: d\\.${field}`).test(fn), `missing ${field}`)
  }
  assert.match(fn, /notes: d\.interview_instructions/)
})
check('columns the RPC does not carry are patched with an UPDATE', () => {
  const fn = hrService.slice(hrService.indexOf('async function scheduleInterviewViaRpc'))
  assert.match(fn, /await hrService\.updateInterview\(row\.id, leftovers\)/)
  // Blank values are dropped: an empty string would fail a timestamptz update.
  assert.match(fn, /value === '' \|\| value === undefined/)
})
check('a missing RPC surfaces the original RLS error, not "function not found"', () => {
  const fn = hrService.slice(hrService.indexOf('async function scheduleInterviewViaRpc'))
  assert.match(fn, /PGRST202/)
  assert.match(fn, /error\.code === '404'/)
  assert.match(fn, /throw error/)
  // The caller re-throws the ORIGINAL RLS refusal when the fallback is absent.
  const caller = hrService.slice(hrService.indexOf('async scheduleInterview('), hrService.indexOf('async listInterviews('))
  assert.match(caller, /if \(row == null\) throw error/)
})

// ===========================================================================
console.log('\n3. The result panel lists each error once')
// ===========================================================================

const interviews = read('src/pages/Interviews.jsx')

check('createResult.errors is rendered exactly once', () => {
  const matches = interviews.match(/createResult\.errors\.map\(/g) || []
  assert.equal(matches.length, 1, `rendered ${matches.length} times`)
})
check('the error list keeps its tone and key', () => {
  const idx = interviews.indexOf('createResult.errors.map(')
  const block = interviews.slice(idx, idx + 200)
  assert.match(block, /className="text-rose-600"/)
  assert.match(block, /key=\{i\}/)
})

// ===========================================================================
console.log('\n4. Live positions can be scoped by department / position / branch')
// ===========================================================================

const live = read('src/components/tracking/LivePositions.jsx')
const trackingService = read('src/services/employeeTrackingService.js')

check('the service forwards the branch id the filter needs', () => {
  assert.match(trackingService, /branch_id: item\.branch_id \?\? null/)
})
check('three selects exist and are labelled', () => {
  for (const [id, label] of [
    ['tracking-filter-department', 'Department'],
    ['tracking-filter-position', 'Position'],
    ['tracking-filter-branch', 'Branch'],
  ]) {
    assert.ok(live.includes(`id="${id}"`), `missing ${id}`)
    assert.ok(live.includes(`htmlFor="${id}">${label}`), `missing label for ${id}`)
  }
  assert.match(live, /All departments/)
  assert.match(live, /All positions/)
  assert.match(live, /All branches/)
})
check('the options come from the authorised rows, not a client-side roster read', () => {
  assert.match(live, /scopeOptionsOf\(rows\)/)
  assert.ok(!/from\('employees'\)/.test(live), 'the page must never read employees directly')
})
check('the scope filter runs before the freshness chip and never hides the set', () => {
  assert.match(live, /const scoped = useMemo\(/)
  assert.match(live, /if \(!activeFilter\) return scoped/)
  assert.match(live, /matchesScope\(r, scope\)/)
  // Counts describe the same rows, and recompute after the scope pick, so the
  // chips can never drift from the table. One field, one source.
  assert.match(live, /countDisplayCategories\(rows\)/)
  assert.match(live, /countDisplayCategories\(scoped\)/)
  assert.match(live, /scopedCounts\.inside\} Inside/)
})
check('an over-filtered view has its own empty state with a Clear action', () => {
  assert.match(live, /No employees match these filters/)
  assert.match(live, /setScope\(EMPTY_SCOPE\)/)
  // The generic empty state stays reachable only when there are genuinely no
  // rows at all, and now says what it actually means: nobody reported.
  assert.match(live, /No one has reported in the last \$\{RECENT_HOURS\} h/)
})
check('mobile cards follow the same visible set', () => {
  assert.match(live, /<MobileRows rows=\{visible\}/)
})

// ===========================================================================
console.log('\n5. Geofencing "Use my location" acquires GPS and says why not')
// ===========================================================================

const gpsLib = read('src/lib/geolocation.js')
const geoPage = read('src/pages/GeofenceSettings.jsx')
const addDialog = read('src/components/geofences/AddFenceDialog.jsx')
const editor = read('src/components/geofences/GeofenceMapEditor.jsx')
const tester = read('src/components/geofences/CoverageTester.jsx')

check('one shared GPS module bounds the request and forbids a cached fix', () => {
  assert.match(gpsLib, /maximumAge: 0/)
  assert.match(gpsLib, /enableHighAccuracy: true/)
  assert.match(gpsLib, /timeout: 15000/)
  assert.match(gpsLib, /export function requestGpsPosition/)
  assert.match(gpsLib, /export function gpsErrorMessage/)
})
check('every failure reason is named, including the non-HTTPS origin', () => {
  for (const fragment of [/isSecureContext === false/, /case 1:/, /case 2:/, /case 3:/]) {
    assert.match(gpsLib, fragment)
  }
  assert.match(gpsLib, /Location access was denied/)
  assert.match(gpsLib, /could not be determined/)
  assert.match(gpsLib, /timed out/)
})
check('the Add-Fence "Use my location" button no longer requires an existing fix', () => {
  // Before: the button rendered only when `myPosition && onUseMyLocation`, so a
  // first fix could never be requested from that dialog.
  assert.ok(!/\{myPosition && onUseMyLocation \? \(/.test(addDialog))
  assert.match(addDialog, /\{onUseMyLocation \? \(/)
  assert.match(addDialog, /disabled=\{myLocationBusy\}/)
  assert.match(addDialog, /myLocationBusy \? 'Finding you…' : myPosition \? 'Re-locate me' : 'Use my location'/)
  assert.match(addDialog, /myLocationError/)
})
check('the geofence settings page delegates to the shared acquisition', () => {
  assert.match(geoPage, /requestGpsPosition\(\)/)
  assert.match(geoPage, /positionToCentre\(position\)/)
  assert.match(geoPage, /gpsErrorMessage\(err\)/)
  assert.ok(!/navigator\.geolocation\.getCurrentPosition/.test(geoPage),
    'the page must not call the raw API and drop the error again')
  assert.match(geoPage, /myLocationBusy=\{myLocationBusy\}/)
  assert.match(geoPage, /myLocationError=\{myLocationError\}/)
})
check('the held fix actually reaches the fence editor', () => {
  // pendingMyPosition existed but was never passed down, so a fix captured in
  // the dialog was silently discarded.
  assert.match(geoPage, /setPendingMyPosition\(myPosition\)/)
  assert.match(geoPage, /initialMyPosition=\{pendingMyPosition\}/)
  // ...and it is cleared so a later edit never inherits a stale position.
  assert.match(geoPage, /setPendingMyPosition\(null\)/)
})
check('the fence editor shows progress and a retry with the real reason', () => {
  assert.match(editor, /requestGpsPosition\(\)/)
  assert.match(editor, /gpsErrorMessage\(err\)/)
  assert.match(editor, /const \[locating, setLocating\] = useState\(false\)/)
  assert.match(editor, /'Finding you…' : 'Try again'/)
  assert.ok(!/Could not get a GPS fix\./.test(editor))
})
check('a held fix reaches the editor through the state machine, not an undefined helper', () => {
  // The page passes initialMyPosition; the editor used to read it through a
  // `toCentre` that is NOT in scope (it lives inside geofenceService), so the
  // first held fix would have thrown a ReferenceError and blanked the page.
  assert.ok(!/const centre = toCentre\(/.test(editor), 'toCentre is not importable here')
  assert.match(editor, /const held = initialMyPosition/)
  assert.match(editor, /fenceGeometryReducer\(geometry, \{ type: 'set-my-position', center: \{ lat, lng \} \}\)/)
  // A junk fix is refused, never coerced into a 0,0 centre.
  assert.match(editor, /if \(!Number\.isFinite\(lat\) \|\| !Number\.isFinite\(lng\)\) return geometry/)
})
check('the coverage tester uses the same acquisition path', () => {
  assert.match(tester, /requestGpsPosition\(\)/)
  assert.match(tester, /gpsErrorMessage\(err\)/)
  // The local copy of the error mapper is gone: one message per reason.
  const local = tester.indexOf('function gpsErrorMessage')
  assert.equal(local, -1, 'the tester must import the shared mapper, not define its own')
})

// ===========================================================================
console.log(failed === 0 ? '\nAll checks passed' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
