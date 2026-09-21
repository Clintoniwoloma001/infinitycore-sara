import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { locationLabel, recordCoords } from '../src/utils/attendanceLocation.js'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const migration = read('supabase/migrations/20260921000000_attendance_web_gps_and_device_binding.sql')
const service = read('src/services/attendanceService.js')
const engine = read('src/services/attendanceEngineService.js')
const selfPage = read('src/pages/Attendance.jsx')
const management = read('src/pages/AttendanceManagement.jsx')
const util = read('src/utils/attendanceLocation.js')

// --- BUG 1: web clock-in must persist GPS on BOTH the record AND the event ---
// The record write carries the coordinates…
for (const token of [
  'clock_in_lat, clock_in_lng, clock_in_accuracy, clock_in_distance',
  'p_lat, p_lng, p_accuracy, v_distance,',
  'clock_out_lat = p_lat,',
  'clock_out_lng = p_lng,',
]) {
  assert.ok(migration.includes(token), `canonical helper is missing the record GPS write: ${token}`)
}
// …and the event ledger row that the UI actually reads carries lat/lng + name.
for (const token of [
  'insert into public.attendance_events',
  'latitude, longitude,',
]) {
  assert.ok(migration.includes(token), `canonical helper is missing the event ledger write: ${token}`)
}
assert.match(migration, /'actual_location_name', v_location ->> 'actual_location_name',/, 'event metadata is missing actual_location_name')
// The web wrapper delegates to the canonical contract (never a legacy body).
assert.match(migration, /v_result := public\.attendance_clock_in_for_employee\(v_employee_id, p_lat, p_lng, p_accuracy, 'web', null, 'GPS', 'WEB'\)/)
assert.match(migration, /return public\.attendance_clock_out_for_employee\(v_employee_id, p_attendance_id, p_lat, p_lng, p_accuracy, 'web', null, 'GPS', 'WEB'\)/)

// --- BUG 2: web clock-in REQUIRES the device fingerprint (server-enforced) ---
assert.match(migration, /create or replace function public\.clock_in_secure\(\n  p_lat float,\n  p_lng float,\n  p_accuracy float default null,\n  p_device_fingerprint text default null\n\)/)
assert.match(migration, /attendance_device_binding_check\(p_device_fingerprint, v_employee_id, 'CLOCK_IN'\)/)
assert.match(migration, /drop function if exists public\.clock_in_secure\(float, float, float\)/, 'guarded web clock-in must drop the un-fingerprinted overload')
assert.match(migration, /drop function if exists public\.clock_out_secure\(uuid, float, float, float\)/, 'guarded web clock-out must drop the un-fingerprinted overload')

// Same-employee reuse allowed; binding only persisted after a successful record.
assert.match(migration, /\(v_bind ->> 'reason'\) is distinct from 'same_employee'/)
assert.ok(migration.includes('perform public.attendance_device_bind(p_device_fingerprint, v_employee_id, null);'), 'clock-in does not bind the device after success')

// Different employee -> rejected, with the exact HR-facing copy.
assert.ok(migration.includes('DEVICE_BINDING:This device is already registered to another employee. Contact HR/Admin to reassign it.'))
assert.match(migration, /attendance_device_binding_check\(p_device_fingerprint, v_employee_id, 'CLOCK_OUT'\)/, 'web clock-out must run the binding policy too')
assert.ok(migration.includes('ATTENDANCE_DEVICE_BINDING_BLOCKED'), 'web blocks are not written to the audit trail')

// Server-side helpers stay locked so a forged request cannot bypass the gate.
assert.match(migration, /revoke all on function public\.attendance_clock_in_for_employee\(uuid, float, float, float, text, uuid, text, text\) from public, anon, authenticated/)
assert.match(migration, /revoke all on function public\.clock_out_secure_internal\(uuid, float, float, float\) from public, anon, authenticated/)
assert.match(migration, /grant execute on function public\.clock_in_secure\(float, float, float, text\) to authenticated/)

// --- Frontend: every web clock-in carries the persisted browser fingerprint ---
assert.match(service, /import \{ getDeviceFingerprint \} from '\.\.\/utils\/deviceFingerprint'/)
assert.match(service, /const deviceFingerprint = await getDeviceFingerprint\(\)\.catch\(\(\) => ''\)/)
assert.match(service, /p_device_fingerprint: deviceFingerprint \|\| null/)
assert.match(service, /if \(msg\.startsWith\('DEVICE_BINDING:'\)\) return msg\.replace\('DEVICE_BINDING:', ''\)/)
assert.match(engine, /import \{ getDeviceFingerprint \} from '\.\.\/utils\/deviceFingerprint'/)
assert.match(engine, /p_device_fingerprint: deviceFingerprint \|\| null/)

// --- Display: a captured location is never hidden by a missing event row ---
assert.match(selfPage, /locationLabel\(r\) \|\| '—'/, 'self attendance does not fall back to record GPS')
assert.ok(management.includes('return locationLabel(record)'), 'admin locationName does not fall back to record GPS')
assert.ok(util.includes('record?.actual_location_name'), 'util does not read the record-level location name')
assert.ok(util.includes('clock_in_lat'), 'util does not read record-level coordinates')

// --- Unit: fallback precedence (event name -> record name -> coordinates) ---
const withEvent = {
  clock_in_event: { metadata: { actual_location_name: 'Head Office' } },
}
assert.equal(locationLabel(withEvent), 'Head Office')

const withInOutDiffer = {
  clock_in_event: { metadata: { actual_location_name: 'Head Office' } },
  clock_out_event: { metadata: { actual_location_name: 'Victoria Island' } },
}
assert.equal(locationLabel(withInOutDiffer), 'In: Head Office / Out: Victoria Island')

const recordNameOnly = { actual_location_name: 'Ikeja Branch' }
assert.equal(locationLabel(recordNameOnly), 'Ikeja Branch')

const coordsOnly = { clock_in_lat: 6.5244, clock_in_lng: 3.3792 }
assert.equal(locationLabel(coordsOnly), '6.5244, 3.3792')
assert.equal(recordCoords(coordsOnly), '6.5244, 3.3792')

assert.equal(locationLabel({}), null)
assert.equal(recordCoords({ clock_in_lat: null, clock_out_lng: 1.2 }), null)

console.log('attendanceWebGpsBinding: all assertions passed')