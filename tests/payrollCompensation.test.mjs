import assert from 'node:assert/strict'
import fs from 'node:fs'

const migration = fs.readFileSync(new URL('../schema_phase63_payroll_master_compensation.sql', import.meta.url), 'utf8')

// Single shared arithmetic engine (pure helper)
assert.match(migration, /create or replace function public\._salary_breakdown\(/)
for (const token of [
  `(v_config ->> 'pension_employee_rate')::numeric, 0.08`,
  `(v_config ->> 'consolidated_relief_min')::numeric, 200000`,
  `(v_config ->> 'mid_month_ratio')::numeric, 0.5`,
  `'tax_paye', v_tax`,
  `'deductions_total', round(v_tax + v_pension + v_other + coalesce(p_deductions, 0)`,
]) {
  assert.ok(migration.includes(token), `engine token: ${token}`)
}

// Core RPCs
for (const fn of ['upsert_employee_compensation', 'preview_employee_compensation', 'get_employee_compensation']) {
  assert.match(migration, new RegExp(`create or replace function public\\.${fn}\\(`), `${fn} exists`)
}
assert.match(migration, /v_role not in \('super_admin', 'admin', 'hr_manager'\)/)
assert.match(migration, /EMPLOYEE_COMPENSATION_UPDATED/)
assert.match(migration, /'reason', p_reason/)
assert.match(migration, /length\(btrim\(p_reason\)\) < 5/)
assert.match(migration, /A reason is required \(at least 5 characters\)/)

// preview / get must never write
for (const stmt of ['insert into public.audit_logs', 'insert into public.employee_salary_packages', 'insert into public.employee_salary_snapshots']) {
  // the shared engine + upsert path may contain those statements, so scope
  // this check to the preview/get function bodies.
  const previewBody = migration.split('public.preview_employee_compensation(')[1]?.slice(0, 3000)
  assert.ok(previewBody && !previewBody.includes(stmt), `preview avoids ${stmt}`)
  const getBody = migration.split('public.get_employee_compensation(')[1]?.slice(0, 2500)
  assert.ok(getBody && !getBody.includes(stmt), `get avoids ${stmt}`)
}

// compute_payroll honours component packages (no more hardcoded allowances = 0)
assert.ok(!/v_allowances\s*:=\s*0/.test(migration), 'no hardcoded allowances=0 in compute_payroll')
assert.match(migration, /coalesce\(sum\(amount\), 0\) into v_allowances/)
assert.match(migration, /snapshot ->> 'component_type' = 'allowance'/)
assert.match(migration, /v_break := public\._salary_breakdown/)

// list_payroll_master exposes derived columns + has_compensation flag
assert.match(migration, /create or replace function public\.list_payroll_master\(\)/)
assert.match(migration, /has_compensation boolean/)
assert.match(migration, /coalesce\(sn\.basic_monthly, e\.salary, e\.basic_salary, 0\) as salary/)
assert.match(migration, /'CURRENT'/)
assert.match(migration, /snapshot ->> 'component_type' = 'allowance'/)

// Additive — no tables dropped, no payroll records scrubbed wholesale.
// The only DELETE is the period row rewrite inside compute_payroll
// (recalculate = delete rows for this period, then re-insert).
assert.doesNotMatch(migration, /drop table/)
assert.doesNotMatch(migration, /drop column/)
assert.doesNotMatch(migration, /delete from public\.payroll where payroll_period = v_period\.period_label;s*$/)
assert.match(migration, /\n  delete from public\.payroll where payroll_period = v_period\.period_label;\n/)

console.log('payrollCompensation.test.mjs passed')