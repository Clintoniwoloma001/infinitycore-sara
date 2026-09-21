import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const migration = read('supabase/migrations/20260921000013_hr_organisation_module_updates.sql')
const page = read('src/pages/HROrganisation.jsx')
const service = read('src/services/hrOrganisationService.js')

// --- 1. RLS write policies for org tables ---
for (const tbl of ['employee_supervisors', 'hierarchy_exceptions', 'data_quality_exceptions', 'departments']) {
  assert.match(migration, new RegExp(`drop policy if exists "${tbl}_write"`), `missing drop for ${tbl}_write`)
  assert.match(migration, new RegExp(`create policy "${tbl}_write"`), `missing create for ${tbl}_write`)
  assert.match(migration, new RegExp(`on public\\.${tbl}\\s+for all`), `missing all policy on ${tbl}`)
}

// --- 2. Management helper used by write RPCs ---
assert.match(migration, /create or replace function public\._org_can_manage\(\)/)
assert.match(migration, /public\.current_role\(\) in \('super_admin', 'admin', 'head_of_human_resources'\)/)

// --- 3. Required RPCs exist ---
for (const fn of [
  'create or replace function public.upsert_employee_supervisor',
  'create or replace function public.delete_employee_supervisor',
  'create or replace function public.resolve_hierarchy_exception',
  'create or replace function public.resolve_data_quality_exception',
  'create or replace function public.upsert_department',
  'create or replace function public.delete_department',
  'create or replace function public.assign_employee_department',
]) {
  assert.ok(migration.includes(fn), `migration is missing ${fn}`)
}

// --- 4. Service wraps the new RPCs ---
for (const method of [
  'async upsertEmployeeSupervisor',
  'async deleteEmployeeSupervisor',
  'async resolveHierarchyException',
  'async resolveDataQualityException',
  'async upsertDepartment',
  'async deleteDepartment',
  'async assignEmployeeDepartment',
]) {
  assert.ok(service.includes(method), `service is missing ${method}`)
}

// --- 5. Frontend wiring ---
assert.match(page, /const \[supervisors, setSupervisors\] = useState\(\[\]\)/)
assert.match(page, /const \[expandedDepts, setExpandedDepts\] = useState/)
assert.match(page, /const \[deptModal, setDeptModal\] = useState/)
assert.match(page, /const \[qualityModal, setQualityModal\] = useState/)

// Hierarchy: Add Row button + blank-supervisor highlight
assert.match(page, /Add Row/)
assert.match(page, /!supervisorId \? 'bg-amber-50\/40'/)
assert.match(page, /Select a supervisor for this employee/)

// Supervisor dropdown is filtered by employee department + global executives
assert.match(page, /const supervisorCandidates = useMemo/)
assert.match(page, /globalSupervisorIds/)

// Exception resolution buttons
assert.match(page, /resolveHierarchyException\(x\.id, 'resolved'\)/)
assert.match(page, /resolveHierarchyException\(x\.id, 'dismissed'\)/)

// Data quality clickable rows + modal
assert.match(page, /onClick=\{\(\) => setQualityModal\(d\)\}/)
assert.match(page, /function QualityIssueModal/)
assert.match(page, /Mark Resolved/)

// Structure: expandable departments, edit, add, assign
assert.match(page, /Add Department/)
assert.match(page, /function DepartmentDetail/)
assert.match(page, /function DepartmentModal/)
assert.match(page, /Assign another employee/)
assert.match(page, /assignEmployeeDepartment/)

console.log('hr-organisation module assertions passed.')
