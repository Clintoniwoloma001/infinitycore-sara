/**
 * chairmanRoleDepartments.test.mjs
 *
 * Covers the three requests behind migration
 * 20260924000003_chairman_md_ceo_roles_department_hygiene.sql:
 *   1. Director appears in EVERY role list platform-wide.
 *   2. Chairman + MD/CEO exist as roles with the SAME access as Director.
 *   3. MD/CEO is a role, not a department — it is never offered in a
 *      department dropdown, and is never written back as a department.
 *
 * No live database: migration + source content assertions plus real unit tests
 * of the pure department-hygiene module.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  NON_DEPARTMENT_VALUES,
  isRoleLikeDepartment,
  filterDepartmentOptions,
  cleanDepartmentValue,
  normalizeDepartmentName,
} from '../src/constants/departments.js'

const read = (p) => readFileSync(p, 'utf8')
const migration = read('supabase/migrations/20260924000003_chairman_md_ceo_roles_department_hygiene.sql')
const directorMigration = read('supabase/migrations/20260924000001_director_executive_intelligence.sql')
const roles = read('src/constants/roles.js')
const generator = read('scripts/gen-privilege-seed.mjs')
const app = read('src/App.jsx')
const useAuth = read('src/hooks/useAuth.jsx')
const usersPage = read('src/pages/Users.jsx')
const provisioning = read('src/services/userProvisioningService.js')
const workMgmt = read('src/services/workManagementService.js')
const hrOrg = read('src/services/hrOrganisationService.js')
const dashService = read('src/domains/dashboard/dashboardService.js')
const trainingService = read('src/services/trainingService.js')
const attendanceMgmt = read('src/pages/AttendanceManagement.jsx')
const directorPage = read('src/pages/DirectorDashboard.jsx')
const inviteFn = read('supabase/functions/invite-employees/index.ts')
const createUserFn = read('supabase/functions/create-user/index.ts')

// ---------------------------------------------------------------
// 1 + 2. Role catalog: MD/CEO, Chairman and Director are one role family
// ---------------------------------------------------------------
for (const [constant, value] of [['MD_CEO', 'md_ceo'], ['CHAIRMAN', 'chairman'], ['DIRECTOR', 'director']]) {
  assert.match(roles, new RegExp(`${constant}: '${value}'`), `${constant} must exist in ROLES`)
  assert.match(roles, new RegExp(`\\[ROLES\\.${constant}\\]: \\{`), `${constant} must have ROLE_METADATA`)
  assert.match(roles, new RegExp(`\\[ROLES\\.${constant}\\]: \\[\\s*'dashboard',\\s*'attendance'`), `${constant} modules`)
  assert.match(roles, new RegExp(`\\[ROLES\\.${constant}\\]: \\[\\s*'director\\.executive\\.read',\\s*'hr\\.attendance\\.self'`), `${constant} permissions`)
  assert.match(roles, new RegExp(`\\[ROLES\\.${constant}\\]: \\d+,`), `${constant} hierarchy`)
  assert.match(migration, new RegExp(`\\('${value}',`), `${value} must be seeded into public.roles`)
  assert.match(migration, new RegExp(`seed_role_permission\\('${value}', 'director\\.executive\\.read'\\)`), `${value} executive read grant`)
  assert.match(migration, new RegExp(`seed_role_permission\\('${value}', 'attendance\\.clock_in'\\)`), `${value} self-service attendance baseline`)
  assert.match(migration, new RegExp(`'${value}'`), `${value} must be admitted by profiles_role_check`)
}

// Every role in ROLES must be assignable by super_admin (the list the review /
// approval dropdown renders) and must carry a UI label.
const roleKeys = [...roles.matchAll(/^\s{2}([A-Z][A-Z_0-9]+): '([a-z_]+)',$/gm)].map((m) => m[1])
assert.ok(roleKeys.length >= 20, 'role catalog should now expose 20+ platform roles')
for (const key of roleKeys) {
  assert.match(roles, new RegExp(`\\[ROLES\\.${key}\\]: \\{\\s*label:`), `${key} needs a UI label`)
}
assert.match(roles, /export const EXECUTIVE_VIEWER_ROLES = Object\.freeze\(\[ROLES\.MD_CEO, ROLES\.CHAIRMAN, ROLES\.DIRECTOR\]\)/)
assert.match(roles, /if \(actorRole === ROLES\.SUPER_ADMIN\) return Object\.values\(ROLES\)/)
assert.match(roles, /ROLES\.MD_CEO, ROLES\.CHAIRMAN, ROLES\.DIRECTOR, ROLES\.AREA_MANAGER/, 'area/HR managers must never see executive roles')
assert.match(generator, /const ALL_ROLES = Object\.keys\(ROLE_PERMISSIONS\)/, 'generator derives roles from the frontend matrix')

// Executive landing + edge-function parity
assert.match(app, /isExecutiveViewerRole\(actualRole\)\) return <DirectorDashboard \/>/)
assert.match(useAuth, /isExecutiveViewer: isExecutiveViewerRole\(actualRole\)/)
assert.match(useAuth, /isChairman: actualRole === ROLES\.CHAIRMAN/)
assert.match(useAuth, /isMdCeo: actualRole === ROLES\.MD_CEO/)
for (const fn of [inviteFn, createUserFn]) {
  assert.match(fn, /'head_of_business', 'md_ceo', 'chairman', 'director'/, 'edge functions must treat executive roles as senior')
}

// Role-change protection (server authority)
assert.match(migration, /create or replace function public\.enforce_role_change_policy\(\)/)
assert.match(migration, /senior_roles text\[\] := array\['md_ceo','chairman','director'\]/)
assert.match(migration, /if new\.role = any\(senior_roles\) and actor_role not in \('super_admin','admin'\) then/)
assert.match(migration, /create trigger trg_enforce_role_change before update on public\.profiles/)

// Regression guard: the senior/management role sets may only GROW. Extracting
// them from 20260924000001 vs 20260924000003 catches a silently dropped role
// (e.g. 'admin') that would let a branch manager promote somebody.
const mgmtRoles = (sql) => {
  const m = sql.match(/management_roles text\[\] := array\[([\s\S]*?)\]/)
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
}
const before = mgmtRoles(directorMigration)
const after = mgmtRoles(migration)
assert.ok(after.includes('admin'), "'admin' must stay super_admin/admin-only")
for (const role of before) {
  assert.ok(after.includes(role), `${role} was restricted in 20260924000001 and must stay restricted`)
}
for (const role of ['md_ceo', 'chairman', 'director']) {
  assert.ok(after.includes(role), `${role} must be a senior role`)
}

// The director RPC gate accepts the whole executive family; 20260924000001
// itself stays immutable history.
assert.match(migration, /public\.current_role\(\) not in \('md_ceo','chairman','director','super_admin'\)/)
assert.match(directorMigration, /public\.current_role\(\) not in \('director','super_admin'\)/)

// ---------------------------------------------------------------
// 3. Department hygiene (server side)
// ---------------------------------------------------------------
assert.match(migration, /^begin;$/m)
assert.match(migration, /^commit;$/m)
assert.match(migration, /create or replace function public\.is_role_like_department\(p_value text\)/)
assert.match(migration, /create or replace function public\.department_label\(p_value text\)/)
assert.match(migration, /when public\.is_role_like_department\(p_value\) then 'Unassigned'/)
assert.match(migration, /create or replace function public\.get_dashboard_filter_options\(/, 'dashboard option list must be re-issued')
assert.match(migration, /select distinct public\.department_label\(e\.department\) as name/)
assert.match(migration, /and not public\.is_role_like_department\(e\.department\)/)
assert.match(migration, /create or replace function public\.get_director_executive_snapshot\(/)
assert.match(migration, /create or replace function public\.get_director_employee_detail\(/)
assert.match(migration, /where x\.name <> 'Unassigned'/, 'executive titles must not be offered as a department option')
assert.match(migration, /update public\.departments set is_active = false where id = v_row\.id/)
assert.match(migration, /DEPARTMENT_TITLE_DEACTIVATED/)
// Nothing destructive, and no stored employee/profile data is rewritten.
assert.doesNotMatch(migration, /\bdelete from\b/i)
assert.doesNotMatch(migration, /update public\.employees/i)
assert.doesNotMatch(migration, /update public\.profiles/i)

// Every frontend department list runs through the shared filter.
assert.match(provisioning, /departments: filterDepartmentOptions\(clean\(\[/)
assert.match(workMgmt, /filterDepartmentOptions\(\[\.\.\.new Set\(\(data \|\| \[\]\)\.map\(\(d\) => d\.department\)\)\]\)/)
assert.match(hrOrg, /return filterDepartmentOptions\(data \|\| \[\]\)/)
assert.match(dashService, /departments: filterDepartmentOptions\(options\.departments \|\| \[\]\)/)
assert.match(trainingService, /departments: filterDepartmentOptions\(data\?\.departments \|\| \[\]\)/)
assert.match(attendanceMgmt, /return filterDepartmentOptions\(\[\.\.\.new Set\(employees\.map/)
assert.match(directorPage, /const departmentRollup=useMemo\(\(\)=>filterDepartmentOptions/)
assert.match(usersPage, /const selectedDepartment = cleanDepartmentValue\(assignment\.department\)/)
assert.match(usersPage, /p_department: cleanDepartmentValue\(assignment\.department\) \|\| null/)

// ---------------------------------------------------------------
// Behaviour of the pure module — this is what actually renders the dropdowns
// ---------------------------------------------------------------
assert.ok(NON_DEPARTMENT_VALUES.includes('MD/CEO'))
for (const title of ['MD/CEO', 'md/ceo', ' MD/CEO ', 'MD', 'M.D.', 'CEO', 'MANAGING DIRECTOR', 'Chairman', 'CHAIRMAN/CEO', 'DIRECTOR', 'Board of Directors']) {
  assert.equal(isRoleLikeDepartment(title), true, `${title} is a role, not a department`)
}
for (const dept of ['ADMINISTRATION', 'Human Resources', 'E-BUSINESS', 'FINANCIAL CONTROL', 'LOAN MONITORING & RECOVERY', 'Unassigned', '', null, undefined]) {
  assert.equal(isRoleLikeDepartment(dept), false, `${dept} is a real department`)
}

// Exactly the list captured in the department dropdown screenshot.
const screenshotDepartments = ['ADMINISTRATION', 'AUDIT & INVESTMENT', 'CREDIT & MARKETING', 'E-BUSINESS', 'FINANCIAL CONTROL', 'HUMAN RESOURCES', 'INFORMATION TECHNOLOGY', 'LEGAL', 'LOAN MONITORING & RECOVERY', 'MD/CEO', 'OPERATIONS', 'RECOVERY', 'RESEARCH & STRATEGY', 'RISK & COMPLIANCE']
assert.equal(screenshotDepartments.includes('MD/CEO'), true)
assert.deepEqual(
  filterDepartmentOptions(screenshotDepartments),
  screenshotDepartments.filter((d) => d !== 'MD/CEO')
)
assert.equal(filterDepartmentOptions(screenshotDepartments).includes('MD/CEO'), false, 'MD/CEO must not be selectable')

// RPC option shapes ({ id, name }) and blank handling.
assert.deepEqual(
  filterDepartmentOptions([{ id: 'MD/CEO', name: 'MD/CEO' }, { id: 'IT', name: 'INFORMATION TECHNOLOGY' }]).map((d) => d.name),
  ['INFORMATION TECHNOLOGY']
)
assert.deepEqual(filterDepartmentOptions(null), [])
assert.deepEqual(filterDepartmentOptions([null, '', 'LEGAL']), ['LEGAL'])

// Never silently rewrite a real department; always drop a title.
assert.equal(cleanDepartmentValue('  Human Resources '), 'Human Resources')
assert.equal(cleanDepartmentValue('MD/CEO'), '')
assert.equal(cleanDepartmentValue(''), '')
assert.equal(cleanDepartmentValue(null), '')
assert.equal(normalizeDepartmentName('  md /  ceo '), 'MD / CEO')

console.log('Chairman/MD-CEO roles + department hygiene assertions passed.')



