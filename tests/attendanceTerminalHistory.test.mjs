import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const migration = read('supabase/migrations/20260921000001_attendance_terminal_day_binding_qr_history.sql')
const service = read('src/services/attendanceService.js')
const management = read('src/pages/AttendanceManagement.jsx')
const indexHtml = read('index.html')

// ---------------------------------------------------------------------------
// 1. One employee per attendance DEVICE per app day (the "one device scanned by
//    three employees" critical fix). Independent of browser fingerprint.
// ---------------------------------------------------------------------------
assert.match(migration, /uid_attendance_device_bindings_terminal_day\s*\n\s+on public\.attendance_device_bindings \(terminal_id, binding_date\)\s*\n\s+where terminal_id is not null/)
assert.match(migration, /create or replace function public\.attendance_terminal_day_binding_check\(/)
for (const required of [
  `'DEVICE_BINDING:This attendance terminal has already been clocked-in by a different employee today. Contact your supervisor or HR if this is an error.'`,
  `'reason', 'terminal_taken'`,
  `'reason', 'unbound'`,
  `'reason', 'same_employee'`,
]) {
  assert.ok(migration.includes(required), `terminal-day check missing ${required}`)
}
// The fingerprint loader must never overwrite a different employee's terminal hold.
assert.match(migration, /return jsonb_build_object\('ok', false, 'reason', 'terminal_taken', 'hash', v_hash, 'date', v_today\)/)

// Both public gates enforce it BEFORE any attendance record is created, and
// return a device_binding_blocked flag the scan page surfaces verbatim.
assert.match(migration, /v_tbind := public\.attendance_terminal_day_binding_check\(/)
assert.match(migration, /'device_binding_blocked', true/)
assert.ok(migration.includes("attempted_employee"), 'gate audits the blocked attempt')

// ---------------------------------------------------------------------------
// 2. Durable QR token history — row-per-token, masked, never hard-deleted.
// ---------------------------------------------------------------------------
for (const required of [
  `create table if not exists public.attendance_terminal_token_history`,
  `device_id uuid not null references public.attendance_devices(id) on delete cascade`,
  `token_hash text not null`,
  `token_preview text not null`,
  `status in ('active', 'revoked', 'expired', 'deleted')`,
  `expires_at timestamptz`,
  `created_by uuid references auth.users(id) on delete set null`,
  `revoked_by uuid references auth.users(id) on delete set null`,
  `idx_attendance_terminal_token_history_device_created\n  on public.attendance_terminal_token_history (device_id, created_at desc)`,
  `enable row level security;`,
  `revoke all on public.attendance_terminal_token_history from anon, authenticated;`,
]) {
  assert.ok(migration.includes(required), `history table is missing ${required}`)
}

// Generation archives the superseded token then mints a new active one.
assert.match(migration, /update public\.attendance_terminal_token_history\s*\n\s+set status = 'revoked',\s*\n\s+revoked_at = v_now,\s*\n\s+revoked_by = v_who\s*\n\s+where device_id = v_device\.id\s*\n\s+and status = 'active'/)
assert.match(migration, /insert into public\.attendance_terminal_token_history \(/)
assert.match(migration, /left\(v_raw, 8\) \|\| '…'/)

// Revoke flips the active token row to 'revoked' (never destroys it).
assert.match(migration, /update public\.attendance_terminal_token_history\s*\n\s+set status = 'revoked',\s*\n\s+revoked_at = v_now,\s*\n\s+revoked_by = v_who\s*\n\s+where device_id = p_device_id\s*\n\s+and status = 'active'/)

// Delete = SOFT delete, only from revoked, history fully preserved.
assert.match(migration, /'deleted'\)\)/)
assert.match(migration, /Only revoked terminals can be deleted\. Revoke the terminal first\./)
assert.match(migration, /set status = 'deleted', active = false, updated_at = now\(\)/)
assert.ok(migration.includes("'soft_delete', true, 'history_preserved', true"), 'delete writes soft-delete audit')

// The list RPC shows only masked previews + names, is role-gated, filterable
// by status, and orders newest-first.
assert.match(migration, /create or replace function public\.list_attendance_terminal_qr_history\(/)
assert.match(migration, /public\.current_role\(\) not in \('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager'\)/)
assert.match(migration, /Invalid status filter\. Use active, revoked, expired or deleted\./)
assert.match(migration, /order by h\.created_at desc/)
assert.match(migration, /coalesce\(pc\.full_name, h\.created_by::text\)/)
assert.match(migration, /grant execute on function public\.list_attendance_terminal_qr_history\(uuid, text\) to authenticated;/)

// ---------------------------------------------------------------------------
// 3. Frontend — history service + UI.
// ---------------------------------------------------------------------------
assert.match(service, /listTerminalQrHistory\(deviceId, status = null\)/)
assert.match(service, /p_device_id: deviceId \|\| null,/)
assert.match(service, /p_status: status \|\| null,/)

assert.match(management, /History \}/)
assert.match(management, /QR History/)
assert.match(management, /openQrHistory/)
assert.match(management, /attendanceService\.listTerminalQrHistory\(device\.id\)/)
assert.ok(management.includes("[[ 'all', 'All'], ['active', 'Active'], ['revoked', 'Revoked'], ['deleted', 'Deleted']]") || management.includes("[['all', 'All'], ['active', 'Active'], ['revoked', 'Revoked'], ['deleted', 'Deleted']]"), 'history filter chips present')

// Deleted is a status value, so the badge + actions handle it; revoke/delete
// confirm copy no longer claims tokens/rows are destroyed.
assert.match(management, /if \(s === 'deleted'\) return \{ label: 'Deleted \(history kept\)'/)
assert.match(management, /it is never destroyed/)
assert.match(management, /soft delete\) so the audit trail is never destroyed/)

// View-QR, revocation and the scan path from the prior fix are untouched.
assert.match(management, /attendanceService\.getTerminalQrLink\(device\.id\)/)
assert.match(management, /token_preview \|\| '—'/)

// ---------------------------------------------------------------------------
// 4. Browser title + frontend rename.
// ---------------------------------------------------------------------------
assert.match(indexHtml, /<title>Infinity Microfinance Bank Operations<\/title>/)
assert.match(indexHtml, /content="Infinity Microfinance Bank Operations Platform"/)
for (const f of [
  'src/components/EmployeeRecordPrint.jsx',
  'src/components/training/TrainingCertificate.jsx',
  'src/pages/CustomerDashboard.jsx',
  'src/pages/CertificateVerification.jsx',
  'src/pages/careers/CareersShell.jsx',
  'src/pages/careers/Careers.jsx',
  'src/pages/careers/OfferAcceptance.jsx',
  'src/services/leaveApprovalsService.js',
  'src/index.css',
]) {
  assert.ok(!read(f).includes('Infinity Bank'), `${f} still references 'Infinity Bank'`)
  assert.ok(read(f).includes('Infinity Microfinance Bank'), `${f} missing 'Infinity Microfinance Bank'`)
}

console.log('attendanceTerminalHistory.test.mjs passed')