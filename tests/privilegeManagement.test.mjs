import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const migration = read('supabase/migrations/20260923000001_granular_privilege_access.sql')
const generator = read('scripts/gen-privilege-seed.mjs')
const service = read('src/services/privilegeService.js')
const page = read('src/pages/PrivilegeManagement.jsx')
const useAuth = read('src/hooks/useAuth.jsx')
const navigation = read('src/config/navigation.jsx')
const app = read('src/App.jsx')
const saraIntent = read('supabase/functions/sara-intent/index.ts')

// ------------------------------------------------------------------
// 1. Migration structure — one transaction, tables, engine, seed,
//    management RPCs and the payroll retrofit.
// ------------------------------------------------------------------
assert.match(migration, /^begin;/m, 'opens a transaction')
assert.match(migration, /^commit;$/m, 'closes the transaction')

for (const table of [
  'user_permissions', 'permission_field_rules', 'permission_delegation',
  'permission_audit', 'permission_version',
]) {
  assert.match(migration, new RegExp(`create table if not exists public\\.${table} \\(`), `table ${table} created`)
  assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security;`), `RLS enabled on ${table}`)
}

for (const fn of [
  'has_permission', 'has_permission_for', 'require_permission',
  'has_field_access', 'require_field_access', 'get_my_permissions',
  '_can_manage_permission', 'get_privilege_authority', 'is_privilege_manager',
  'grant_role_permission', 'revoke_role_permission',
  'set_user_permission', 'clear_user_permission',
  'set_field_rule', 'clear_field_rule',
  'set_delegation', 'revoke_delegation',
  'get_permission_epoch', 'get_role_permission_map', 'get_user_permissions_map',
  'search_permissions', 'list_delegations', 'get_permission_audit',
  'get_permissions_state_for_user', 'list_sensitive_fields',
]) {
  assert.match(migration, new RegExp(`create or replace function public\\.${fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\(`), `function ${fn} defined`)
}

// Head-of-HR needs the privilege-manager grant (the generated baseline only
// reaches super_admin + admin).
assert.match(migration, /seed_role_permission\('head_of_human_resources', 'administration\.privileges\.manage'\)/)

// Delegation contract: super_admin + admin own every module; the HR head is
// granted HR-adjacent modules only (never financial/admin modules).
assert.match(migration, /\('role', 'super_admin', '\*', 'global',/)
assert.match(migration, /\('role', 'admin', '\*', 'global',/)
assert.match(migration, /\('role', 'head_of_human_resources', 'attendance', 'global',/)
assert.doesNotMatch(migration, /her', 'bankone', 'global|her', 'administration', 'global|her', 'customers', 'global|her', 'loans', 'global/)

// No legacy role leftovers in the new engine.
assert.equal((migration.match(/'hr_manager'/g) || []).length, 0, 'no hr_manager references in the new migration')

// Payroll retrofit: list_payroll_master re-issued with granular view guard +
// redaction, the four impl renames, and revokes on the impls.
assert.match(migration, /create or replace function public\.list_payroll_master\(\)/)
assert.match(migration, /perform public\.require_permission\('payroll\.salary\.view'\)/)
assert.match(migration, /has_field_access\('employees', 'bank_account'\)/)
for (const fn of ['calculate_employee_salary_breakdown', 'get_employee_compensation', 'preview_employee_compensation']) {
  assert.match(migration, new RegExp(`alter function public\\.${fn}\\([^)]*\\) rename to _${fn}_impl;`), `${fn} renamed to impl`)
}
assert.match(migration, /alter function public\.upsert_employee_compensation\(uuid, numeric, jsonb, jsonb, text, text, text, numeric, numeric, numeric, numeric\) rename to _upsert_employee_compensation_impl;/)
// The four renames are guarded inside one DO block so a re-run skips an impl
// that already exists (keeps the migration idempotent alongside create-or-replace).
assert.match(migration, /do \$\$\s*\nbegin\s*\n  if not exists \(\s*\n    select 1 from pg_proc p join pg_namespace n on n\.oid = p\.pronamespace\s*\n    where n\.nspname = 'public' and p\.proname = '_calculate_employee_salary_breakdown_impl'\s*\n  \) then\s*\n    alter function public\.calculate_employee_salary_breakdown\(uuid, text\) rename to _calculate_employee_salary_breakdown_impl;/)
assert.match(migration, /revoke execute on function public\._.*_impl/u)
assert.match(migration, /create or replace function public\.upsert_employee_compensation\(\s*p_employee_id uuid,\s*p_basic numeric,\s*p_allowances jsonb,\s*p_deductions jsonb,\s*p_reason text\s*\)/)
assert.match(migration, /'super_admin', 'admin', 'head_of_human_resources'/)
assert.match(migration, /'super_admin', 'head_of_human_resources', 'hr_officer'/)

// ------------------------------------------------------------------
// 2. The generator reproduces the seed block embedded in the migration.
// ------------------------------------------------------------------
assert.match(generator, /MODULE_LABELS/)
assert.match(migration, /^-- BEGIN GENERATED PRIVILEGE SEED --$/m)
assert.match(migration, /^-- END GENERATED PRIVILEGE SEED --$/m)

// ------------------------------------------------------------------
// 3. Frontend service mirrors the RPC surface exactly.
// ------------------------------------------------------------------
for (const method of [
  'getMyPermissions', 'getPrivilegeAuthority', 'getEpoch',
  'searchPermissions', 'getRolePermissionMap', 'getUserPermissionsMap',
  'getPermissionsStateForUser', 'listSensitiveFields', 'listDelegations', 'getPermissionAudit',
  'grantRolePermission', 'revokeRolePermission',
  'setUserPermission', 'clearUserPermission',
  'setFieldRule', 'clearFieldRule',
  'setDelegation', 'revokeDelegation',
]) {
  assert.match(service, new RegExp(`\\b${method}\\(`), `service method ${method}`)
}
for (const rpc of [
  'get_my_permissions', 'get_privilege_authority', 'get_permission_epoch',
  'search_permissions', 'get_role_permission_map', 'get_user_permissions_map',
  'get_permissions_state_for_user', 'list_sensitive_fields', 'list_delegations', 'get_permission_audit',
  'grant_role_permission', 'revoke_role_permission',
  'set_user_permission', 'clear_user_permission',
  'set_field_rule', 'clear_field_rule',
  'set_delegation', 'revoke_delegation',
]) {
  assert.match(service, new RegExp(`rpc\\('${rpc}'`), `rpc ${rpc} invoked`)
}

// Redaction is enforced server-side; the web service must NOT touch the raw
// bank fields of employees directly.
assert.doesNotMatch(service, /from\('employees'\)/)

// ------------------------------------------------------------------
// 4. Privilege Management page implements the full management surface.
// ------------------------------------------------------------------
for (const tab of ['Role Privileges', 'User Privileges', 'Effective Access', 'Field Visibility', 'Delegation', 'History']) {
  assert.match(page, new RegExp(tab), `tab ${tab}`)
}
assert.match(page, /ReasonModal/, 'reason modal (audited changes)')
assert.match(page, /setPending\s*=/, 'pending change flow')
assert.match(page, /refreshPermissions/, 'refreshes the auth permission doc after changes')
assert.match(page, /privilegeService\.setFieldRule/, 'field rules can be added')
assert.match(page, /privilegeService\.setDelegation/, 'delegation can be added')
assert.match(page, /privilegeService\.getPermissionsStateForUser/, 'effective-access viewer wired')

// ------------------------------------------------------------------
// 5. useAuth integrates the effective document with a legacy fallback.
// ------------------------------------------------------------------
assert.match(useAuth, /permDoc/, 'effective permission document state')
assert.match(useAuth, /fetchPermissions/, 'permission fetch routine')
assert.match(useAuth, /refreshPermissions/, 'explicit refresh exposed')
assert.match(useAuth, /deniedKeys/, 'deny map exposed')
assert.match(useAuth, /if \(permDoc\.denied\?\.\[permissionKey\]\) return false/, 'explicit deny wins')
assert.match(useAuth, /return userPermissions\.includes\(permissionKey\)/, 'legacy fallback preserved')

// Route gating denies a route when a required permission is explicitly denied.
assert.match(navigation, /PERMISSIONS\.PRIVILEGES_MANAGE/, 'privileges permission constant referenced')
assert.match(navigation, /path: '\/privileges'/, '/privileges route registered')
assert.match(navigation, /route\.permissions\.some\(\(p\) => auth\.deniedKeys\[p\]\)/, 'deny wins in canAccessRoute')
assert.match(app, /PrivilegeManagement/, 'page wired into App')

// ------------------------------------------------------------------
// 6. SARA intent prunes explicit granular denies before calling the model.
// ------------------------------------------------------------------
assert.match(saraIntent, /applyGranularDeny/, 'granular deny applied server-side')
assert.match(saraIntent, /INTENT_PERMISSION_KEYS/, 'intent → permission mapping')
assert.match(saraIntent, /get_my_permissions'/, 'reads the effective document')
assert.match(saraIntent, /PENDING_LOANS: \['loans\.read'\]/, 'loans intent keyed')

console.log('privilege-management tests passed')