import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const page = read('src/pages/AttendanceManagement.jsx')
const service = read('src/services/attendanceService.js')
const migration = read('supabase/migrations/20260921000021_attendance_summary_head_hr.sql')

// --- 1. Service listAll supports a bounded date range and all filter params ---
assert.match(service, /async listAll\(\{ startDate, endDate, branchId, department, employeeId, status \} = \{\}\)/)
assert.match(service, /if \(startDate\) q = q\.gte\('attendance_date', startDate\)/)
assert.match(service, /if \(endDate\) q = q\.lte\('attendance_date', endDate\)/)

// --- 2. Management page fetches a bounded window centered on the active date ---
assert.match(page, /const activeDate = filters\.date \|\| platformDateKey\(\)/)
assert.match(page, /start\.setDate\(start\.getDate\(\) - 6\)/)
assert.match(page, /attendanceService\.listAll\(\{\s*startDate,\s*endDate,/s)

// --- 3. Auto-clock-out reconciliation runs once on mount ---
assert.match(page, /attendanceService\.reconcileAutoClockouts\(\)\.catch/)

// --- 4. KPIs derive from the scoped employee list and active-date rows ---
assert.match(page, /const filteredEmployees = useMemo\(\(\) => \{/)
assert.match(page, /const activeDateRows = rows\.filter\(\(r\) => populationMatch\(r\) && String\(r\.attendance_date\) === activeDate\)/)
assert.match(page, /const totalEmps = filteredEmployees\.length \|\| summary\?\.total_employees \|\| 0/)
assert.match(page, /const present = activeDateRows\.filter\(\(r\) => r\.clock_in\)\.length/)
assert.match(page, /const absent = Math\.max\(0, totalEmps - present\)/)

// --- 5. 7-day trend ends on the active date and respects population scope ---
assert.match(page, /const active = new Date\(`\$\{activeDate\}T12:00:00`\)/)
assert.match(page, /d\.setDate\(d\.getDate\(\) - i\)/)
assert.match(page, /const dayRows = rows\.filter\(\(r\) => populationMatch\(r\) && String\(r\.attendance_date\) === ds\)/)

// --- 6. Head of Human Resources is authorized for the attendance summary ---
assert.match(migration, /create or replace function public\.get_attendance_management_summary\(\)/)
assert.match(migration, /'super_admin', 'admin', 'head_of_human_resources', 'hr_manager', 'hr_officer', 'head_of_business'/)

console.log('attendance management assertions passed.')
