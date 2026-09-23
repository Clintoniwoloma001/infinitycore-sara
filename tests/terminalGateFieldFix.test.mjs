import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const __dirname = fileURLToPath(new URL('..', import.meta.url))
const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const migration = read('supabase/migrations/20260923000002_terminal_gate_field_fix.sql')
const service = read('src/services/attendanceService.js')
const terminal = read('src/pages/AttendanceTerminal.jsx')

// ---------------------------------------------------------------------------
// ROOT CAUSE: attendance_terminal_for_token returns the PK as `device_id`
// (20260920000001), never `id`/`device_name`. The live gates that SELECT INTO
// v_terminal from it referenced the nonexistent fields and crashed every valid
// scan with `record "v_terminal" has no field "id"`.
// ---------------------------------------------------------------------------

// The helper contract is left intact — `device_id` is the canonical field.
assert.match(migration, /attendance_terminal_for_token\(\) itself is untouched\./)

// 1. validate_attendance_terminal_location: defensive not-found guard first…
assert.match(migration, /create or replace function public\.validate_attendance_terminal_location/)
assert.match(migration, /select \* into v_terminal from public\.attendance_terminal_for_token\(p_token\);\s*\n\s*if not found then/)
assert.match(migration, /'Terminal not found or inactive\. This attendance terminal link is invalid or revoked\.'/)

// …guards status/active after the not-found check …
assert.ok(
  migration.includes(`if v_terminal.status is distinct from 'active' or coalesce(v_terminal.active, false) = false then`),
  'location gate still rejects inactive terminals'
)

// …and feeds the geofence engine with the REAL field (device_id, never `id`).
assert.match(migration, /select \* into v_gf from public\._terminal_geofence\(v_terminal\.device_id\)/)

// The old crash line must be gone entirely from the live code (doc comments
// may still describe the bug, so only non-comment lines are checked).
const liveCode = migration.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('--')).join('\n')
assert.ok(!liveCode.includes('_terminal_geofence(v_terminal.id)'), 'no more v_terminal.id call in location gate')

// 2. validate_attendance_terminal_employee: same guard + the notify branch
//    resolves device_name via a lookup instead of a nonexistent field.
assert.match(migration, /create or replace function public\.validate_attendance_terminal_employee/)
assert.match(migration, /if not found then\s*\n\s*return jsonb_build_object\('valid', false, 'error', 'Terminal not found or inactive/)
assert.match(
  migration,
  /coalesce\(\(select d\.device_name from public\.attendance_devices d where d\.id = v_terminal\.device_id\), v_terminal\.device_id::text\)/,
  'device_name resolved from attendance_devices, never from v_terminal.device_name'
)
assert.ok(!liveCode.includes('v_terminal.device_name'), 'no more v_terminal.device_name in employee gate')
assert.ok(!liveCode.includes('v_terminal.id'), 'employee gate never referenced v_terminal.id')

// Permissions preserved on both public gates.
assert.match(migration, /grant execute on function public\.validate_attendance_terminal_employee\(text, text, text\) to anon, authenticated;/)
assert.match(migration, /grant execute on function public\.validate_attendance_terminal_location\(text, text, float, float, text\) to anon, authenticated;/)

// ---------------------------------------------------------------------------
// FRONTEND: the terminal page must not reinterpret a backend/server error as
// "Location is required". Location-denied is now a distinct classification.
// ---------------------------------------------------------------------------

// isLocationBlockedError only fires for genuine geolocation failures, not for
// server rejections or SQL crashes.
assert.match(service, /export function isLocationBlockedError\(message\)/)
assert.match(service, /location access is required\|does not support location detection/)
assert.ok(!service.includes(`record "v_terminal" has no field`), 'service no longer swallows the crash message')
assert.match(service, /e\.kind = 'server'/, 'RPC errors are tagged server')
assert.match(service, /e\.kind = \/bounds\|geofence\|within range\/i\.test\(data\.error \|\| ''\) \? 'rejected' : 'business'/, 'geofence rejections are tagged rejected')
assert.match(service, /'business'/, 'business rejections are tagged business')

// The terminal page branches on the tagged kind…
assert.match(terminal, /isLocationBlockedError/)
assert.match(terminal, /kind === 'server'/, 'verifyEmployee distinguishes server errors')
assert.match(terminal, /'Something went wrong\. Contact IT\.'/, 'server errors surface a generic message')
assert.ok(!terminal.includes("if (publicMode) {\n        const m = e?.message || ''\n        if (/bounds|geofence|within range/i.test(m)) {\n          setGeoStatus('rejected')"), 'old erreh classification removed')

// …keeps "Location is required" ONLY for genuine location-blocked states…
assert.match(terminal, /Location is required to clock in or out\./)
assert.ok(terminal.match(/Location is required to clock in or out\./g).length >= 1, 'denied state still renders')
// …and adds an explicit server-error state.
assert.match(terminal, /geoStatus === 'error' && <span className="text-rose-600">Something went wrong\. Contact IT\.<\/span>/)

// ---------------------------------------------------------------------------
// Cross-check: the fix migration is the FINAL re-issue of both gates (no newer
// migration redefines them, so this is what production runs), and every
// v_terminal.* access it contains lives on a field the token helper returns.
// ---------------------------------------------------------------------------
const migrationsDir = join(__dirname, 'supabase/migrations')
const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const fixFile = '20260923000002_terminal_gate_field_fix.sql'
const fixIndex = files.indexOf(fixFile)
assert.ok(fixIndex >= 0, 'fix migration exists')
for (const gateFn of ['validate_attendance_terminal_employee', 'validate_attendance_terminal_location']) {
  const later = files.slice(fixIndex + 1).filter((f) =>
    readFileSync(join(migrationsDir, f), 'utf8').includes(`create or replace function public.${gateFn}`)
  )
  assert.deepEqual(later, [], `${gateFn} must be last defined by the fix migration`)
}
const fieldsOnTerminal = ['device_id', 'status', 'active', 'has_token']
const refs = [...liveCode.matchAll(/v_terminal\.([A-Za-z_]+)/g)].map((r) => r[1])
for (const f of refs) {
  assert.ok(fieldsOnTerminal.includes(f), `fix migration uses v_terminal.${f}, not returned by attendance_terminal_for_token`)
}

console.log('terminalGateFieldFix.test.mjs passed')