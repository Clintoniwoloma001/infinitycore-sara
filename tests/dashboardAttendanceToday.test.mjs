import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const migration = read('schema_phase55_dashboard_attendance_today.sql')
const attendanceService = read('src/services/attendanceService.js')
const dashboardService = read('src/domains/dashboard/dashboardService.js')

assert.match(migration, /get_dashboard_attendance_today/)
assert.match(migration, /ar\.attendance_date = v_today/)
assert.match(migration, /clock_timestamp\(\) at time zone public\.att_app_timezone\(\)/)
assert.match(migration, /v_role = 'branch_manager'/)
assert.match(migration, /v_role = 'area_manager'/)
assert.match(migration, /'MD', 'MD\/CEO'/)
assert.match(attendanceService, /getDashboardToday/)
assert.match(dashboardService, /attendanceService\.getDashboardToday\(filters\)/)

console.log('dashboard attendance today contract checks passed.')
