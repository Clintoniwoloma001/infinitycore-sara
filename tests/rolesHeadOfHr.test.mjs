import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const migration = read('supabase/migrations/20260921000010_roles_head_of_human_resources.sql')
const core = read('supabase/functions/_shared/bankone-core.mjs')
const saraIntent = read('supabase/functions/sara-intent/index.ts')
const sendAssessment = read('supabase/functions/send-assessment-email/index.ts')
const genQuestions = read('supabase/functions/generate-training-questions/index.ts')
const createUser = read('supabase/functions/create-user/index.ts')
const escalate = read('supabase/functions/escalate-leave-requests/index.ts')
const roles = read('src/constants/roles.js')

// ------------------------------------------------------------------
// 1. Migration renames hr_manager → head_of_human_resources and keeps
//    the roles row id (so role_permissions stay attached).
// ------------------------------------------------------------------
assert.match(migration, /update public\.roles\s*\nset role_name = 'head_of_human_resources',/)
assert.match(migration, /where role_name = 'hr_manager'/)
assert.match(migration, /update public\.profiles\s*\nset role = 'head_of_human_resources'\s*\nwhere role = 'hr_manager'/)
assert.match(migration, /alter table public\.profiles drop constraint if exists profiles_role_check/)
assert.match(migration, /check \(role in \(/)

// The live DB must end with the full 18-role catalog and NO hr_manager.
const allRoles = new Set([
  'super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'branch_manager', 'area_manager',
  'head_of_business', 'staff', 'loan_officer', 'relationship_manager', 'customer_service',
  'head_of_operations', 'head_of_e_business', 'financial_controller', 'head_of_risk_compliance',
  'head_of_legal', 'head_of_audit', 'customer',
])
for (const r of allRoles) {
  assert.ok(migration.includes(`'${r}'`), `role ${r} present in the CHECK`)
}
assert.equal((migration.match(/'hr_manager'/g) || []).length, 2, 'only the two migration WHERE clauses may reference the old role')

// Every legacy policy/RPC that enumerated hr_manager is re-issued.
assert.match(migration, /create or replace function public\.approve_user\(/)
assert.match(migration, /create or replace function public\.enforce_role_change_policy\(\)/)
assert.match(migration, /create or replace function public\.can_author_announcement\(\)/)
assert.match(migration, /create or replace function public\.training_is_manager\(\)/)
assert.match(migration, /create or replace function public\.reset_annual_leave_balances\(target_year int\)/)
assert.match(migration, /create or replace function public\.get_man_hour_intelligence\(/)
assert.match(migration, /create or replace function public\.sync_auto_channel_members\(p_channel_id uuid\)/)
assert.match(migration, /create or replace function public\.reconcile_auto_channel_membership_for_employee\(p_employee_id uuid\)/)
assert.match(migration, /drop policy if exists "hr_jobs_delete" on public\.hr_jobs/)
assert.match(migration, /create policy "?hr_jobs_delete"? on public\.hr_jobs/)

// The phase6 dynamic child-table policy loop is re-run so the new role
// reaches employee_education / employee_work_history / employee_fidelity_bonds.
assert.match(migration, /foreach t in array array\['employee_education', 'employee_work_history', 'employee_guarantors', 'employee_fidelity_bonds'\]/)
assert.match(migration, /'super_admin,admin,head_of_human_resources,hr_officer'/)

// ------------------------------------------------------------------
// 2. Edge functions never invent a second authorization system.
// ------------------------------------------------------------------
for (const [name, text] of [
  ['bankone-core', core],
  ['sara-intent', saraIntent],
  ['send-assessment-email', sendAssessment],
  ['generate-training-questions', genQuestions],
  ['create-user', createUser],
  ['escalate-leave-requests', escalate],
]) {
  assert.doesNotMatch(text, /'hr_manager'/, `${name} has no legacy role string`)
}
assert.match(core, /BANKONE_QUERY_ROLES = \['super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'head_of_operations', 'financial_controller'\]/)
assert.match(saraIntent, /TERMINATION_ROLES = \['super_admin', 'head_of_human_resources'\]/)
assert.match(sendAssessment, /HR_ROLES = \['super_admin', 'admin', 'head_of_human_resources', 'hr_officer'\]/)
assert.match(genQuestions, /ALLOWED_ROLES = \['super_admin', 'admin', 'branch_manager', 'head_of_human_resources', 'hr_officer'\]/)
assert.match(createUser, /\['super_admin', 'admin', 'head_of_human_resources'\]\.includes\(actorRole\)/)
assert.match(escalate, /hr: \['head_of_human_resources'\]/)

// ------------------------------------------------------------------
// 3. Frontend role catalog matches the DB's 18 roles and exposes the
//    new constant.
// ------------------------------------------------------------------
assert.match(roles, /HEAD_OF_HUMAN_RESOURCES: 'head_of_human_resources'/)
assert.doesNotMatch(roles, /HR_MANAGER/, 'roles.js has no HR_MANAGER constant')
assert.doesNotMatch(roles, /'hr_manager'/, 'roles.js has no hr_manager string')
for (const role of allRoles) {
  assert.ok(roles.includes(`'${role}'`), `roles.js has ${role}`)
}

console.log('rolesHeadOfHr.test.mjs passed')