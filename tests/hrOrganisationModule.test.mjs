import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const migration = read('supabase/migrations/20260921000013_hr_organisation_module_updates.sql')
const correction = read('supabase/migrations/20260921000014_data_quality_branch_correction.sql')
const areaMulti = read('supabase/migrations/20260921000017_area_manager_multi_branch.sql')
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

// Exception resolution: Resolve opens a supervisor picker modal; Dismiss is direct.
assert.match(page, /setResolveModal\(x\)/)
assert.match(page, /function ResolveExceptionModal/)
assert.match(page, /resolveHierarchyException\(exceptionId, 'resolved', supervisorId\)/)
assert.match(page, /resolveHierarchyException\(x\.id, 'dismissed'\)/)
// No-employee import artifacts are hidden from the active exceptions UI.
assert.match(page, /exceptions\.filter\(\(x\) => !!x\.employee_id\)/)

// Data quality clickable rows + modal
assert.match(page, /onClick=\{\(\) => setQualityModal\(d\)\}/)
assert.match(page, /function QualityIssueModal/)
assert.match(page, /Mark Resolved/)
assert.match(page, /Keep as it is/)

// Structure: expandable departments, edit, add, assign
assert.match(page, /Add Department/)
assert.match(page, /function DepartmentDetail/)
assert.match(page, /function DepartmentModal/)
assert.match(page, /Assign another employee/)
assert.match(page, /assignEmployeeDepartment/)

// Supervisor mapping: inline title editing, Edit button, and row-edit modal.
assert.match(page, /function SupervisorModal/)
assert.match(page, /onEdit=\{\(mapping\) => setSupervisorModal\(\{ mapping \}\)/)
assert.match(page, /Pencil className="w-3\.5 h-3\.5"/)

// Area ↔ Branch Kanban board.
assert.match(page, /function AreaBranchKanban/)
assert.match(page, /Area ↔ Branch Assignment/)
assert.match(page, /onDragStart=\{\(e\) => \{ e\.dataTransfer\.setData\('text\/branch-id', branchId\)/)
assert.match(page, /isHeadOffice/)

// --- 6. Branch-correction workflow (20260921000014) ---
assert.ok(correction.includes('create or replace function public.correct_data_quality_exception'),
  'correction migration is missing correct_data_quality_exception')
assert.ok(correction.includes('add column if not exists resolution jsonb'),
  'correction migration is missing resolution column')
assert.match(correction, /p_action/) // supports correct_single | split
assert.match(correction, /then\s+return jsonb_build_object\('ok', false, 'error', 'a corrected location name is required'\)/s,
  'correct_single must require a new name')
assert.match(correction, /'each staff assignment needs an employee and a target location'/,
  'split must require employee + target')
assert.match(correction, /'staff assignment is required for split'/,
  'split is not allowed without staff assignments')
assert.match(correction, /update public\.employee_onboarding_submissions\s+set payload = jsonb_set\(coalesce\(payload, '{}'::jsonb\), '\{branch\}'/s,
  'submissions must be corrected via the payload jsonb (no branch column)')
assert.match(correction, /else\s+return jsonb_build_object\('ok', false, 'error', 'action must be correct_single or split'\)/s)
assert.match(correction, /grant execute on function public\.correct_data_quality_exception/s)

// Service wrapper for the correction RPC
assert.ok(service.includes('async correctDataQualityException'), 'service is missing correctDataQualityException')
assert.ok(service.includes("orgRpcOk('correct_data_quality_exception'"), 'service wrapper does not call the RPC via orgRpcOk')

// Area branch assignment RPC and service wrapper.
assert.ok(areaMulti.includes('create or replace function public.set_area_branches'), 'migration is missing set_area_branches')
assert.ok(service.includes('async setAreaBranches'), 'service is missing setAreaBranches')
assert.ok(service.includes("orgRpcOk('set_area_branches'"), 'setAreaBranches does not use orgRpcOk')

// Write RPCs must surface { ok: false, error: ... } as thrown errors.
assert.match(service, /function checkOk\(data, name\)/)
assert.match(service, /'ok' in data && data\.ok === false/)
assert.match(service, /async function orgRpcOk/)

// Modal correction UI (Keep as it is / Correct / split with staff assignment)
assert.match(page, /startCorrect/)
assert.match(page, /Correct as a single entry/)
assert.match(page, /Split into entries/)
assert.match(page, /Assign all/)
assert.match(page, /Split & Save/)
assert.match(page, /Correct & Save/)
assert.match(page, /onCorrect\('correct_single'/)
assert.match(page, /onCorrect\('split'/)
assert.match(page, /staffAssignments/)

console.log('hr-organisation module assertions passed.')
