import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const migration = read('supabase/migrations/20260921000007_roles_head_of_operations_and_new_roles.sql')
const core = read('supabase/functions/_shared/bankone-core.mjs')
const saraIntent = read('supabase/functions/sara-intent/index.ts')
const roles = read('src/constants/roles.js')

// ------------------------------------------------------------------
// 1. Migration: rename operations_manager -> head_of_operations and add
//    the five new bank head roles.
// ------------------------------------------------------------------
// The 13->18 role CHECK must be rebuilt: drop, rename live rows, re-add.
assert.match(migration, /alter table public\.profiles drop constraint if exists profiles_role_check/)
assert.match(migration, /update public\.profiles\s*\nset role = 'head_of_operations'\s*\nwhere role = 'operations_manager'/)
assert.match(migration, /check \(role in \(/)

// The 00007 migration was written when the role catalog still used hr_manager.
const legacyRoles = new Set([
  'super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager', 'area_manager',
  'head_of_business', 'staff', 'loan_officer', 'relationship_manager', 'customer_service',
  'head_of_operations', 'head_of_e_business', 'financial_controller', 'head_of_risk_compliance',
  'head_of_legal', 'head_of_audit', 'customer',
])
for (const r of legacyRoles) {
  assert.ok(migration.includes(`'${r}'`), `legacy role ${r} present in the 00007 CHECK`)
}

// The current frontend catalog reflects the 00010 rename to head_of_human_resources.
const currentRoles = new Set([
  'super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'branch_manager', 'area_manager',
  'head_of_business', 'staff', 'loan_officer', 'relationship_manager', 'customer_service',
  'head_of_operations', 'head_of_e_business', 'financial_controller', 'head_of_risk_compliance',
  'head_of_legal', 'head_of_audit', 'customer',
])

// roles table: rename keeps the id (role_permissions stay attached) and the
// five new roles are seeded with bank-appropriate descriptions.
assert.match(migration, /set role_name = 'head_of_operations'/)
assert.match(migration, /where role_name = 'operations_manager'/)
assert.match(migration, /\('HEAD OF OPERATIONS', 'head_of_operations'/)
assert.match(migration, /\('HEAD, E-BANKING', 'head_of_e_business'/)
assert.match(migration, /\('HEAD OF DIGITAL BANKING', 'head_of_e_business'/)
assert.match(migration, /\('FINANCIAL CONTROLLER', 'financial_controller'/)
assert.match(migration, /\('HEAD, RISK MANAGEMENT', 'head_of_risk_compliance'/)
assert.match(migration, /\('HEAD OF COMPLIANCE', 'head_of_risk_compliance'/)
assert.match(migration, /\('HEAD OF LEGAL', 'head_of_legal'/)
assert.match(migration, /\('HEAD OF AUDIT', 'head_of_audit'/)
assert.match(migration, /\('HEAD OF INTERNAL CONTROL', 'head_of_audit'/)
assert.match(migration, /on conflict \(designation_title\) do update set system_role = excluded\.system_role/)

// Every legacy policy/RPC that enumerated operations_manager is rewritten.
assert.match(migration, /create or replace function public\.can_manage_bankone\(\)/)
assert.match(migration, /create or replace function public\.can_manage_reconciliation\(\)/)
assert.match(migration, /create or replace function public\.can_author_announcement\(\)/)
assert.match(migration, /create or replace function public\.training_is_manager\(\)/)
assert.match(migration, /create or replace function public\.enforce_role_change_policy\(\)/)
assert.match(migration, /create trigger trg_enforce_role_change/)
assert.match(migration, /create or replace function public\.reset_annual_leave_balances\(target_year int\)/)
assert.match(migration, /create or replace function public\.get_man_hour_intelligence\(/)
assert.match(migration, /create or replace function public\.sync_auto_channel_members\(p_channel_id uuid\)/)
assert.match(migration, /create or replace function public\.reconcile_auto_channel_membership_for_employee\(p_employee_id uuid\)/)
assert.match(migration, /create or replace function public\.approve_user\(/)
assert.match(migration, /drop policy if exists "branches_read_authorized" on public\.branches/)
assert.match(migration, /create policy "bankone_batches write"/)
assert.match(migration, /create policy "recon_cases write"/)
assert.match(migration, /create policy "transport_allow write"/)

// finance owns BankOne: financial_controller enters the BankOne gates.
assert.match(migration, /'head_of_operations',\s+\s*'financial_controller'/s)

// ------------------------------------------------------------------
// 2. Edge functions never invent a second authorization system.
// ------------------------------------------------------------------
assert.doesNotMatch(core, /operations_manager/, 'bankone-core has no legacy role')
assert.match(core, /BANKONE_QUERY_ROLES = \['super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'head_of_operations', 'financial_controller'\]/)
assert.doesNotMatch(saraIntent, /operations_manager/, 'sara-intent has no legacy role')
assert.match(saraIntent, /LOAN_READ_ROLES = \['admin', 'super_admin', 'branch_manager', 'area_manager', 'head_of_business', 'head_of_operations', 'loan_officer', 'relationship_manager'\]/)
assert.match(saraIntent, /TERMINATION_ROLES = \['super_admin', 'head_of_human_resources'\]/, 'termination stays biometric')

// ------------------------------------------------------------------
// 3. Frontend role catalog matches the DB's 18 roles and grants the
//    attendance-terminal permission to the management roles.
// ------------------------------------------------------------------
for (const role of currentRoles) {
  assert.ok(roles.includes(`'${role}'`), `roles.js has ${role}`)
}
assert.match(roles, /attendance\.terminal/)
assert.match(roles, /\[ROLES\.ADMIN\]: \[[\s\S]*?\]/)
assert.match(roles, /'financial_controller'.*'reconciliation\.read'/s)

console.log('rolesHeadOperations.test.mjs passed')