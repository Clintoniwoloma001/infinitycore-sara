import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getDeviceFingerprint, sha256Hex } from '../src/utils/deviceFingerprint.js'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const migration = read('supabase/migrations/20260920000000_attendance_device_daily_binding.sql')
const terminal = read('src/pages/AttendanceTerminal.jsx')
const service = read('src/services/attendanceService.js')
const management = read('src/pages/AttendanceManagement.jsx')
const util = read('src/utils/deviceFingerprint.js')

// --- Migration: bindings table (one device -> one employee per app day) ---
for (const required of [
  'create table if not exists public.attendance_device_bindings',
  'device_fingerprint_hash text not null',
  'binding_date date not null',
  'primary key (device_fingerprint_hash, binding_date)',
  'employee_id uuid not null references public.employees(id) on delete cascade',
  'terminal_id uuid references public.attendance_devices(id) on delete cascade',
  'enable row level security',
  'revoke all on public.attendance_device_bindings from anon, authenticated',
]) {
  assert.ok(migration.includes(required), `migration is missing ${required}`)
}
// Day boundary matches the rest of the attendance engine (app timezone calendar day).
assert.match(migration, /clock_timestamp\(\) at time zone public\.att_app_timezone\(\)\)::date/)

// --- Migration: policy helpers (pure check + bind, both server-side) ---
for (const fn of ['attendance_device_binding_hash', 'attendance_device_binding_check', 'attendance_device_bind']) {
  assert.ok(migration.includes(`create or replace function public.${fn}`), `migration is missing ${fn}`)
}
// The stored value is a server-side hash of the client digest — never a raw fingerprint.
assert.match(migration, /extensions\.digest\(convert_to\(coalesce\(nullif\(p_fingerprint, ''\), ''\), 'UTF8'\), 'sha256'\)/)
// Check is read-only (never binds); bind() is the only writer and is upsert-guarded.
assert.match(migration, /on conflict \(device_fingerprint_hash, binding_date\)/)

// --- Migration: public gates reject the un-fingerprinted forms ---
assert.match(migration, /drop function if exists public\.validate_attendance_terminal_employee\(text, text\)/)
assert.match(migration, /drop function if exists public\.clock_attendance_terminal\(text, text, text, float, float, float\)/)
assert.ok(migration.includes('p_device_fingerprint text'), 'clock gate is missing the fingerprint parameter')
assert.match(migration, /grant execute on function public\.validate_attendance_terminal_employee\(text, text, text\) to anon, authenticated/)
assert.match(migration, /grant execute on function public\.clock_attendance_terminal\(text, text, text, float, float, float, text\) to anon, authenticated/)

// --- Migration: blocking semantics ---
// The exact HR-facing message surfaced to the employee.
assert.ok(migration.includes('This device has already been used to clock in a different employee today. Contact your supervisor or HR if this is an error.'))
// Empty fingerprint is rejected for both CLOCK_IN and CLOCK_OUT.
assert.match(migration, /coalesce\(p_fingerprint, ''\) = ''/)
assert.ok(migration.includes("p_event_type not in ('CLOCK_IN', 'CLOCK_OUT')"))
// Same employee re-scan is allowed (existing attendance_insert_rules guards the session).
assert.ok(migration.includes("v_binding.employee_id = p_employee_id"))
// Binding is only persisted after a successful clock-in record exists.
assert.match(migration, /v_result ->> 'attendance_id'\) is not null/)
// Every block is written to the existing audit trail.
assert.ok(migration.includes('ATTENDANCE_DEVICE_BINDING_BLOCKED'))
// CLOCK_OUT does not create a binding (bind_required only for CLOCK_IN).
assert.match(migration, /'bind_required', p_event_type = 'CLOCK_IN'/)

// --- Migration: HR/super-admin override + listings (audited, role-gated) ---
for (const fn of ['list_attendance_device_bindings', 'list_attendance_device_binding_blocks', 'clear_attendance_device_binding']) {
  assert.ok(migration.includes(`create or replace function public.${fn}`), `migration is missing ${fn}`)
}
assert.ok(migration.includes('ATTENDANCE_DEVICE_BINDING_OVERRIDE'), 'override is not audited')
assert.ok(migration.includes("('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager')"), 'override role gate is missing')
for (const fn of [
  'grant execute on function public.list_attendance_device_bindings(date) to authenticated',
  'grant execute on function public.clear_attendance_device_binding(text, date, text) to authenticated',
]) {
  assert.ok(migration.includes(fn), `migration is missing grant: ${fn}`)
}
// Internal helpers are never callable by anon/authenticated.
assert.ok(migration.includes('attendance_device_binding_hash(text) from public'))
assert.ok(migration.includes('attendance_device_binding_check(text, uuid, text) from public'))

// --- Frontend: terminal sends the fingerprint and surfaces blocks ---
assert.ok(terminal.includes("import { getDeviceFingerprint } from '../utils/deviceFingerprint'"), 'terminal does not import the fingerprint util')
assert.match(terminal, /const fp = await getDeviceFingerprint\(\)\.catch\(\(\) => ''\)/)
assert.match(terminal, /validatePublicTerminalEmployee\(terminalToken, pin, deviceFingerprint\)/)
assert.match(terminal, /deviceFingerprint,/)
assert.ok(terminal.includes('lookup?.device_binding_blocked'), 'terminal does not stop on a blocked validation')
assert.match(terminal, /device_binding_error \|\| 'This device has already been used to clock in a different employee today\. Contact your supervisor or HR if this is an error\.'/)

// --- Frontend: service passes the fingerprint to the server RPCs ---
assert.match(service, /p_device_fingerprint: deviceFingerprint \|\| null/)
assert.ok(service.includes("async validatePublicTerminalEmployee(token, employeeIdentifier, deviceFingerprint)"), 'validate does not accept a fingerprint')
assert.ok(service.includes('deviceFingerprint })'), 'clockPublicTerminal does not forward the fingerprint')
// HR oversight methods.
assert.ok(service.includes("async listDeviceBindings(date)"), 'service is missing listDeviceBindings')
assert.ok(service.includes("async listDeviceBindingBlocks(date, limit = 20)"), 'service is missing listDeviceBindingBlocks')
assert.ok(service.includes("async clearDeviceBinding(fingerprintHash, date, reason)"), 'service is missing clearDeviceBinding')
assert.match(service, /rpc\('list_attendance_device_bindings'/)
assert.match(service, /rpc\('clear_attendance_device_binding'/)

// --- Frontend: Attendance Management oversight tab ---
assert.ok(management.includes("id: 'bindings', label: 'Device Binding'"), 'bindings tab is missing')
assert.ok(management.includes('function DeviceBindingsTab({ setNotice })'), 'DeviceBindingsTab is missing')
assert.match(management, /clearDeviceBinding\(binding\.device_fingerprint_hash, binding\.binding_date/)
assert.match(management, /listDeviceBindingBlocks\(d \|\| null, 20\)/)
assert.ok(management.includes("['super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'branch_manager']"), 'management role gate is missing')

// --- Frontend: fingerprint util semantics ---
assert.ok(util.includes('infinitycore_qr_device_id'), 'storage key is missing')
assert.ok(util.includes('cryptoObj.subtle.digest'), 'sha-256 via crypto.subtle is missing')
assert.ok(util.includes('storage.getItem(STORAGE_KEY)'), 'first-party identity is missing')

// Deterministic, opaque, stable across calls on the same device.
const a = await getDeviceFingerprint()
const b = await getDeviceFingerprint()
assert.ok(/^[0-9a-f]{64}$/.test(a), 'fingerprint is not a 64-char lowercase hex sha-256')
assert.equal(a, b, 'fingerprint is not stable within a session')

// sha256Hex is deterministic and produces the same digest via Node's crypto.subtle.
const h1 = await sha256Hex('InfinityCore QR Terminal')
const h2 = await sha256Hex('InfinityCore QR Terminal')
assert.equal(h1, h2, 'sha256Hex is not deterministic')
assert.ok(h1.length === 64, 'sha256Hex is not sha-256 length')

console.log('attendanceDeviceBinding: all assertions passed')