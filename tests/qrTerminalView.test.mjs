import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const migration = read('supabase/migrations/20260920000001_attendance_fix_qr_view_link_status.sql')
const service = read('src/services/attendanceService.js')
const management = read('src/pages/AttendanceManagement.jsx')

// --- Status model: 'revoked' is an explicit state; suspended keeps its token ---
assert.match(migration, /check \(status in \('active', 'inactive', 'suspended', 'offline', 'revoked'\)\)/)
assert.match(migration, /update public\.attendance_devices/, 're-labels legacy token-less rows')
assert.match(migration, /where device_type = 'attendance_terminal'\n   and status = 'suspended'\n   and device_token is null/)

// Revoke = permanent kill: token purged, status='revoked', view link purged.
for (const token of [
  `device_token = null,\n         status = 'revoked',\n         active = false,\n         token_generated_at = null,`,
  `delete from public.attendance_terminal_view_links where device_id = p_device_id;`,
  `'ATTENDANCE_TERMINAL_REVOKED'`,
]) {
  assert.ok(migration.includes(token), `revoke is missing ${token}`)
}

// Suspend preserves token + view link (reversible, no reprint).
const suspendBody = migration.split('public.suspend_attendance_terminal(p_device_id uuid)')[1]?.slice(0, 1200)
assert.ok(!suspendBody.includes('delete from public.attendance_terminal_view_links'), 'suspend must NOT purge the view link')
assert.match(suspendBody, /set status = 'suspended', active = false, updated_at = now\(\)/)
assert.match(suspendBody, /This terminal is revoked and cannot be suspended/)

// Resume only from suspended; delete only from revoked.
assert.match(migration, /Only suspended terminals can be resumed\./)
assert.match(migration, /Only revoked terminals can be deleted\. Revoke the terminal first\./)

// --- View-link persistence: raw token only in the locked-down store ---
for (const required of [
  `create table if not exists public.attendance_terminal_view_links`,
  `device_id  uuid primary key references public.attendance_devices(id) on delete cascade`,
  `token_hex  text not null`,
  `enable row level security`,
  `revoke all on public.attendance_terminal_view_links from anon, authenticated;`,
]) {
  assert.ok(migration.includes(required), `view-links table is missing ${required}`)
}
// Generation keeps hashing the URL string for the scan gates (unchanged model)…
assert.match(migration, /set device_token = encode\(\n           extensions\.digest\(convert_to\(v_raw, 'UTF8'\), 'sha256'\), 'hex'\n         \)/)
// …and mirrors the raw token into the view store (no RLS-visible column ever carries it).
assert.match(migration, /insert into public\.attendance_terminal_view_links \(device_id, token_hex, created_at, updated_at\)/)
assert.match(migration, /on conflict \(device_id\)\n  do update set token_hex = excluded\.token_hex, updated_at = clock_timestamp\(\)/)
assert.match(migration, /token_generated_at timestamptz/)

// The gated RPC is the ONLY read path and is hr-role-only.
assert.match(migration, /create or replace function public\.get_attendance_terminal_qr_link\(p_device_id uuid\)/)
assert.match(migration, /public\.current_role\(\) not in \('super_admin', 'admin', 'hr_manager'\)/)
assert.match(migration, /'token', v_view\.token_hex/)

// Raw tokens are never granted to anon/authenticated anywhere.
assert.match(migration, /revoke all on function public\.get_attendance_terminal_qr_link\(uuid\) from public;/)
assert.match(migration, /grant execute on function public\.get_attendance_terminal_qr_link\(uuid\) to authenticated;/)

// --- Public scan gates answer suspended vs revoked distinctly ---
for (const fn of ['validate_attendance_terminal_employee', 'validate_attendance_terminal_location', 'clock_attendance_terminal']) {
  assert.ok(migration.includes(`create or replace function public.${fn}`), `${fn} recreated`)
}
const suspendedMsgCount = (migration.match(/This terminal is temporarily suspended\. Contact HR if you believe this is a mistake\./g) || []).length
assert.ok(suspendedMsgCount >= 3, `suspended message present in all gates (got ${suspendedMsgCount})`)
assert.match(migration, /This attendance terminal link is invalid or revoked\./)
// Enforcement stays server-side: the clock gate never reaches a write for non-active rows.
assert.match(migration, /No attendance record is ever created here\./)

// --- Frontend: View QR loads the CURRENT link from the server (no regenerate) ---
assert.match(service, /getTerminalQrLink\(deviceId\)/)
assert.match(service, /p_device_id: deviceId,/)
assert.match(service, /has_qr=false when the terminal has no live token/)
assert.ok(service.includes("'id, device_name, device_type, status, active, branch_id, last_seen_at, created_at, updated_at, token_generated_at'"), 'listTerminalDevices exposes token_generated_at')

// Modal resolves the link via the server RPC (persistent store wins), falls
// back to the main panel's LIVE in-session token when the store is empty for
// the SAME device, and never mints a new token on view.
assert.match(management, /const info = await attendanceService\.getTerminalQrLink\(device\.id\)/)
assert.match(management, /const storedLink = info\?\.has_qr && info\.token \? buildTerminalUrl\(info\.token\) : ''/)
assert.match(management, /const liveSessionLink = device\.id === selectedId && terminalLink \? terminalLink : ''/)
assert.match(management, /setQrLink\(storedLink \|\| liveSessionLink\)/)
const openQrViewBody = management.split('const openQrView = async')[1]?.split('const modalGenerate = async')[0] || ''
assert.ok(!openQrViewBody.includes('generateTerminalToken'), 'View QR must never mint a new token')
assert.ok(!management.includes('linksByDevice'), 'no more session-only link cache')
assert.ok(!management.includes('ensureQr'), 'no more silent regenerate-on-view path')
assert.match(management, /This terminal has no current QR link/)
// The previously-session-only cache is fully removed; generating still calls the same RPC.
assert.match(management, /attendanceService\.generateTerminalToken\(showQr \|\| null\)/)

console.log('qrTerminalView.test.mjs passed')