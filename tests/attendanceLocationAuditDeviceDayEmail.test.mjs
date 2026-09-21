import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  locationStatusCode, locationStatusMeta, locationDistanceLabel,
  recordDistanceMeters, recordRadiusMeters, clockingLocationName,
} from '../src/utils/attendanceLocation.js'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const migration = read('supabase/migrations/20260921000008_attendance_device_day_binding_and_email_clockin.sql')
const service = read('src/services/attendanceService.js')
const management = read('src/pages/AttendanceManagement.jsx')
const modal = read('src/components/attendance/LocationAuditModal.jsx')
const terminal = read('src/pages/AttendanceTerminal.jsx')
const util = read('src/utils/attendanceLocation.js')

// ---------------------------------------------------------------------------
// PART A — device binding keyed by (fingerprint, calendar day), NOT terminal
// ---------------------------------------------------------------------------

// The terminal-scoped hard guarantee is removed entirely (drop statements are
// present; they must not be re-created in this migration).
assert.ok(migration.includes('drop index if exists public.uid_attendance_device_bindings_terminal_day'), 'terminal-day unique index was not dropped')
assert.ok(migration.includes('drop index if exists public.idx_attendance_device_bindings_terminal'), 'terminal index was not dropped')
assert.ok(!/create unique index if not exists uid_attendance_device_bindings_terminal_day/.test(migration), 'the terminal-day unique index must not be re-created')
// No gate may consult the terminal-day policy anymore.
assert.ok(!/attendance_terminal_day_binding_check\(/.test(migration), 'a gate still calls the terminal-day check')

// The old listing returned terminal_name; create-or-replace cannot change an
// OUT row type, so the function must be dropped first and the rename must be
// guarded (idempotent re-run / interrupted-batch recovery).
assert.ok(migration.includes('drop function if exists public.list_attendance_device_bindings(date);'), 'listing function is not dropped before its new row type')
assert.match(migration, /rename column terminal_id to last_terminal_id/, 'terminal_id was not renamed')
assert.ok(migration.includes('table_name = \'attendance_device_bindings\''), 'rename guard missing')
assert.ok(migration.includes('add column if not exists last_terminal_name text'), 'last_terminal_name was not added')
assert.ok(migration.includes("b.last_terminal_name is null"), 'terminal name backfill is missing')

// Bind keyed on (hash, date) — no terminal conflict branch, no terminal_taken.
assert.ok(!migration.includes("'terminal_taken'"), 'bind still has a terminal-taken branch')
assert.ok(!migration.includes('v_taker'), 'bind still checks terminal ownership')

// Audited scope is the calendar-day device scope everywhere.
assert.ok(migration.includes("'scope', 'device_day'"), 'device_day scope is missing')
assert.ok(!migration.includes("'terminal_device_day'"), 'legacy terminal scope still present')

// Required HR-facing copy is present verbatim (device, not terminal).
assert.ok(migration.includes("DEVICE_BINDING:This device is already bound to another employee for today."), 'canonical device-binding copy missing')

// The bound employee id must never leak in a public validate response.
assert.ok(migration.includes("'device_binding', v_bind - 'bound_to'"), 'public validate does not strip bound_to')
assert.ok(migration.includes("'attendance-terminal'"), 'blocked attempts are not audited')

// HR listing exposes the calendar-day view + informational terminal.
assert.ok(migration.includes('last_terminal_name'), 'list_attendance_device_bindings drops last_terminal_name')
assert.ok(migration.includes("'Active'::text"), 'binding status value is missing')
assert.ok(migration.includes('attendance_date'), 'attendance_date column is missing from the listing')

// ---------------------------------------------------------------------------
// PART B — work email clock-in (with an exactly-one match guard)
// ---------------------------------------------------------------------------

// resolve_attendance_terminal_employee matches email AND work_email.
assert.ok(migration.includes("lower(trim(coalesce(e.email, ''))) = v_lookup"), 'resolver does not match employees.email')
assert.ok(migration.includes("lower(trim(coalesce(e.work_email, ''))) = v_lookup"), 'resolver does not match employees.work_email')
assert.ok(migration.includes('v_matches <> 1'), 'resolver has no exactly-one ambiguity guard')

// lookup_employee_by_identifier ships the same email + guard + required copy.
assert.ok(/create or replace function public\.lookup_employee_by_identifier\(/.test(migration), 'kiosk lookup was not rewritten')
assert.ok(migration.includes("lower(trim(coalesce(e.work_email, ''))) = v_lookup"), 'kiosk lookup does not match work_email')
assert.ok(migration.includes('Employee not found. Check the Employee ID or work email and try again.'), 'standardized not-found copy missing')

// The kiosk ingest forwards the RESOLVED employee id so email works end-to-end.
assert.match(migration, /ingest_attendance_event_internal\(\n\s*p_device_id, p_external_user_id, p_event_type, p_event_time,\n\s*p_verification_method, p_metadata, v_employee_id\n\s*\)/, 'ingest does not forward the resolved employee id')

// The enums gate the ingest path too (device binding before any record).
assert.match(migration, /public\.ingest_attendance_event\(/ )

console.log('attendanceLocationAuditDeviceDayEmail: migration assertions passed')

// ---------------------------------------------------------------------------
// Frontend wiring
// ---------------------------------------------------------------------------
assert.match(terminal, /Enter your Employee ID or Work Email/, 'terminal prompt does not mention work email')
assert.match(terminal, /Employee not found\. Check the Employee ID or work email and try again\./, 'terminal fallback copy is not standardized')

assert.match(management, /locationStatusMeta/, 'admin records table does not use the canonical status meta')
assert.match(management, /locationDistanceLabel/, 'admin records table does not use the distance label')
assert.ok(management.includes('Last terminal used'), 'bindings table lacks the terminal provenance column')
assert.ok(management.includes('Attendance date'), 'bindings table lacks the calendar-day column')
assert.ok(management.includes('b.last_terminal_name || b.terminal_name'), 'bindings table does not read last_terminal_name')

assert.ok(!modal.includes('locationDifferenceLabel'), 'modal still contains the placeholder label helper')
assert.match(modal, /locationStatusMeta\(record\)/, 'modal does not use the canonical status meta')
assert.match(modal, /locationDistanceLabel\(record\)/, 'modal does not compute the distance')
assert.match(modal, /clockingLocationName\(record, 'clock_in'\)/, 'modal does not read the clock-in location')

assert.ok(service.includes('geofence_radius'), 'records embed does not carry branch geofence radius for fallback')
assert.ok(util.includes('geofence_radius'), 'util does not read the branch radius')
assert.match(util, /export const LOCATION_STATUS_META/, 'util lost the status meta table')

// ---------------------------------------------------------------------------
// Unit — canonical status/distance derivation (record verdict wins; legacy
// rows derive from stored GPS + branch radius; nothing faked from clock-in).
// ---------------------------------------------------------------------------
const branch = (over = {}) => ({
  id: 'UUID:1', branch_name: 'Head Office', latitude: 6.5244, longitude: 3.3792, geofence_radius: 150, ...over,
})

// Stored server verdict wins.
const inside = { clock_in_lat: 6.5244, clock_in_lng: 3.3792, clock_in_distance: 40, geofence_status: 'inside' }
assert.equal(locationStatusCode(inside), 'within')
assert.equal(locationStatusMeta(inside).label, 'Within Geofence')
assert.equal(locationDistanceLabel(inside), '40m')

// Outside stored verdict.
const outside = { clock_in_lat: 6.5244, clock_in_lng: 3.3792, clock_in_distance: 520, geofence_status: 'outside' }
assert.equal(locationStatusCode(outside), 'outside')
assert.equal(locationStatusMeta(outside).label, 'Outside Geofence')
assert.equal(locationDistanceLabel(outside), '520m')

// Legacy row (no status) derives from stored distance vs branch radius.
const legacy = { ...inside, geofence_status: null, branches: [branch()] }
assert.equal(locationStatusCode(legacy), 'within')
assert.equal(recordRadiusMeters(legacy), 150)

// Derivation against radius rejects an out-of-radius legacy row.
const legacyOut = { clock_in_lat: 6.5244, clock_in_lng: 3.3792, clock_in_distance: 300, branches: [branch()] }
assert.equal(locationStatusCode(legacyOut), 'outside')

// No GPS at all -> no_data (never a fake "within").
assert.equal(locationStatusCode({ branches: [branch()] }), 'no_data')
assert.equal(locationDistanceLabel({ branches: [branch()] }), null)
assert.equal(locationStatusMeta({}).label, 'No location data')

// Recompute only when the stored distance is missing.
const recompute = {
  clock_in_lat: 6.5244, clock_in_lng: 3.3792, clock_in_distance: null,
  employees: { branches: [branch({ geofence_radius: 100 })] },
}
const d = recordDistanceMeters(recompute)
assert.ok(Number.isFinite(d) && d < 5, `expected near-zero recomputed distance, got ${d}`)
assert.equal(recordRadiusMeters(recompute), 100)
assert.equal(locationStatusCode(recompute), 'within')

// Clock-out side naming prefers its own event, then its own coords.
const outCoords = { clock_out_lat: 6.5244, clock_out_lng: 3.3792, clock_in_lat: null, clock_in_lng: null }
assert.equal(clockingLocationName(outCoords, 'clock_out'), '6.5244, 3.3792')
assert.equal(clockingLocationName(outCoords, 'clock_in'), null)
assert.equal(clockingLocationName({ clock_out_event: { metadata: { actual_location_name: 'Ikeja' } } }, 'clock_out'), 'Ikeja')
assert.equal(clockingLocationName({}, 'clock_in'), null)

console.log('attendanceLocationAuditDeviceDayEmail: all assertions passed')