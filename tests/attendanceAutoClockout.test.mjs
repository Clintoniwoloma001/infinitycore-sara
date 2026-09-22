import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const migration = read('supabase/migrations/20260922000009_attendance_auto_clockout_midnight.sql')
const page = read('src/pages/AttendanceManagement.jsx')

// --- 1. Visible flag so HR can tell a real card-out from a reconciliation ---
assert.match(migration, /add column if not exists auto_clock_out boolean not null default false/)
assert.match(migration, /create index if not exists idx_attendance_records_auto_clock_out/)

// --- 2. The RPC re-asserts the 17:00 ON-THE-SHIFT-DAY semantics ---
assert.match(migration, /attendance_auto_clockout_close_sessions\(/)
assert.match(migration, /coalesce\(max\(default_work_end_time\), time '17:00'\)/)
assert.match(migration, /v_clock_out := \(v_row\.attendance_date \+ v_work_end\) at time zone v_tz/)
assert.match(migration, /where r\.clock_out is null\s+and r\.attendance_date < v_local_today/s)
assert.match(migration, /auto_clock_out = true/)
assert.match(migration, /'scheduled_end', v_work_end::text/)

// --- 3. Role gate uses the post-rename HR role set ---
assert.match(migration, /not in \('super_admin', 'admin', 'head_of_human_resources', 'hr_manager', 'hr_officer'\)/)

// --- 4. The job is actually scheduled at five past midnight (guarded pg_cron) ---
assert.match(migration, /cron\.schedule\(/)
assert.match(migration, /'infinitycore-attendance-auto-clockout',/)
assert.match(migration, /'5 0 \* \* \*'/)
assert.match(migration, /extname = 'pg_cron'/)

// --- 5. Records table surfaces the Auto badge next to the clock-out time ---
assert.match(page, /r\.auto_clock_out &&/)
assert.match(page, /title="Closed automatically at the scheduled work-end time/)
assert.match(page, /Auto\s*<\/span>/)

console.log('midnight auto clock-out (17:00) assertions passed.')