-- Phase 63 — Payroll Master compensation editing
--
-- The Payroll & BankOne → Payroll Master tab previously rendered
-- employees.salary / employees.allowances directly, which are EMPTY for
-- most staff — the real compensation lives in the Phase 41 Salary Structure
-- architecture (payroll_salary_components → employee_salary_packages →
-- employee_salary_snapshots, computed by calculate_employee_salary_breakdown
-- using payroll_config). The master therefore showed ₦0.00 for everyone.
--
-- This phase makes the single source of truth explicit and keeps ONE payroll
-- calculation engine:
--   1. A pure arithmetic helper  public._salary_breakdown(...)
--      implements pension + consolidated relief + PAYE bands + mid/end split
--      from payroll_config. calculate_employee_salary_breakdown, the new
--      preview RPC and (indirectly, via snapshot) the master list all call it.
--   2. calculate_employee_salary_breakdown is rewritten to persist the same
--      breakdown in the CURRENT snapshot (same engine, same shape).
--   3. NEW public.upsert_employee_compensation(...) — super_admin/admin/
--      hr_manager only, REQUIRES a reason, updates employees.salary (basic)
--      + employee_salary_packages, resyncs employees.allowances, recomputes
--      the CURRENT snapshot and writes an EMPLOYEE_COMPENSATION_UPDATED row
--      to audit_logs (before + after + reason). Transactional.
--   4. NEW public.preview_employee_compensation(...) — same engine, NO writes,
--      so the Payroll Master editor can show derived totals while typing.
--   5. NEW public.get_employee_compensation(...) — single-call compensation
--      bundle for the Payroll Master editor and the Employee 360 Payroll tab.
--   6. list_payroll_master is rewritten to surface the derived breakdown from
--      the CURRENT snapshot (with live package fallback) + a
--      has_compensation flag instead of the empty salary columns.
--   7. compute_payroll no longer hardcodes allowances = 0 — it reads the
--      active allowance/deduction packages so Payroll runs and the BankOne
--      push preview reflect edited compensation.
--
-- Idempotent/additive. Run in the Supabase SQL Editor after Phase 62.

-- ============================================================
-- 1. Single arithmetic engine: _salary_breakdown
--    (pure config-driven calculation — no RLS, shared by all callers)
-- ============================================================
create or replace function public._salary_breakdown(
  p_basic numeric,
  p_allowances numeric,
  p_allowances_taxable numeric,
  p_deductions numeric
) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  v_config jsonb;
  v_pension_rate numeric;
  v_relief_min numeric;
  v_relief_pct numeric;
  v_other numeric;
  v_bands jsonb;
  v_mid_ratio numeric := 0.5;
  v_gross numeric;
  v_pension numeric;
  v_annual numeric;
  v_relief numeric;
  v_taxable numeric;
  v_tax_annual numeric := 0;
  v_prev numeric;
  v_upper numeric;
  v_tax numeric;
  v_net numeric;
  v_mid numeric;
  v_end numeric;
  v_band jsonb;
  v_band_count int;
  v_i int;
begin
  select config into v_config from public.payroll_config where id = 1;
  v_pension_rate := coalesce((v_config ->> 'pension_employee_rate')::numeric, 0.08);
  v_relief_min := coalesce((v_config ->> 'consolidated_relief_min')::numeric, 200000);
  v_relief_pct := coalesce((v_config ->> 'consolidated_relief_percent')::numeric, 0.20);
  v_other := coalesce((v_config ->> 'default_other_deduction')::numeric, 0);
  v_bands := coalesce(v_config -> 'tax_bands', '[{"up_to":null,"rate":0.0}]'::jsonb);
  v_mid_ratio := coalesce((v_config ->> 'mid_month_ratio')::numeric, 0.5);

  v_gross := round(p_basic + coalesce(p_allowances, 0), 2);
  v_pension := round(p_basic * v_pension_rate, 2);
  v_annual := (p_basic + coalesce(p_allowances_taxable, 0)) * 12;
  v_relief := greatest(v_relief_min, v_relief_pct * v_annual);
  v_taxable := greatest(0, v_annual - (v_pension * 12) - v_relief);

  v_tax_annual := 0;
  v_prev := 0;
  v_band_count := jsonb_array_length(v_bands);
  v_i := 0;
  while v_i < v_band_count loop
    v_band := v_bands -> v_i;
    if v_taxable <= v_prev then
      exit;
    end if;
    if (v_band ->> 'up_to') is null then
      v_upper := v_taxable;
    else
      v_upper := least(v_taxable, (v_band ->> 'up_to')::numeric);
    end if;
    v_tax_annual := v_tax_annual + greatest(0, (v_upper - v_prev) * coalesce((v_band ->> 'rate')::numeric, 0));
    if v_taxable <= v_upper then
      exit;
    end if;
    v_prev := v_upper;
    v_i := v_i + 1;
  end loop;
  v_tax := round(v_tax_annual / 12, 2);

  v_net := greatest(0, round(v_gross - v_tax - v_pension - v_other - coalesce(p_deductions, 0), 2));
  v_mid := round(v_net * v_mid_ratio, 2);
  v_end := round(v_net - v_mid, 2);

  return jsonb_build_object(
    'gross_annual', round(v_annual, 2),
    'basic_monthly', round(p_basic, 2),
    'allowances_total', round(coalesce(p_allowances, 0), 2),
    'gross_monthly', v_gross,
    'pension', v_pension,
    'tax_paye', v_tax,
    'other_deductions', v_other,
    'component_deductions', round(coalesce(p_deductions, 0), 2),
    'deductions_total', round(v_tax + v_pension + v_other + coalesce(p_deductions, 0), 2),
    'net_monthly', v_net,
    'mid_month', v_mid,
    'end_month', v_end
  );
end; $$;

-- ============================================================
-- 2. Rewrite company breakdown to persist through the SAME engine
-- ============================================================
create or replace function public.calculate_employee_salary_breakdown(p_employee_id uuid, p_period_label text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_emp public.employees;
  v_package record;
  v_basic numeric := 0;
  v_allowances numeric := 0;
  v_taxable_allow numeric := 0;
  v_deductions numeric := 0;
  v_comps jsonb := '[]'::jsonb;
  v_break jsonb;
  v_label text;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized';
  end if;
  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then raise exception 'Employee not found'; end if;

  v_basic := coalesce(v_emp.salary, 0);

  for v_package in
    select * from public.employee_salary_packages where employee_id = p_employee_id and active = true
  loop
    if v_package.snapshot ->> 'component_type' = 'allowance' then
      v_allowances := v_allowances + coalesce(v_package.amount, 0);
      if coalesce((v_package.snapshot ->> 'taxable')::bool, true) then
        v_taxable_allow := v_taxable_allow + coalesce(v_package.amount, 0);
      end if;
      v_comps := v_comps || jsonb_build_object(
        'name', v_package.snapshot ->> 'name', 'component_type', 'allowance',
        'amount', coalesce(v_package.amount, 0), 'payment_schedule', v_package.snapshot ->> 'payment_schedule');
    else
      v_deductions := v_deductions + coalesce(v_package.amount, 0);
      v_comps := v_comps || jsonb_build_object(
        'name', v_package.snapshot ->> 'name', 'component_type', 'deduction',
        'amount', coalesce(v_package.amount, 0), 'payment_schedule', v_package.snapshot ->> 'payment_schedule');
    end if;
  end loop;

  v_break := public._salary_breakdown(v_basic, v_allowances, v_taxable_allow, v_deductions);
  v_label := coalesce(nullif(p_period_label, ''), 'CURRENT');

  insert into public.employee_salary_snapshots
    (employee_id, period_label, gross_annual, gross_monthly, basic_monthly,
     allowances_total, deductions_total, tax_paye, pension, other_deductions,
     net_monthly, mid_month, end_month, components)
  values (p_employee_id, v_label,
          (v_break ->> 'gross_annual')::numeric, (v_break ->> 'gross_monthly')::numeric,
          (v_break ->> 'basic_monthly')::numeric, (v_break ->> 'allowances_total')::numeric,
          (v_break ->> 'deductions_total')::numeric, (v_break ->> 'tax_paye')::numeric,
          (v_break ->> 'pension')::numeric, (v_break ->> 'other_deductions')::numeric,
          (v_break ->> 'net_monthly')::numeric, (v_break ->> 'mid_month')::numeric,
          (v_break ->> 'end_month')::numeric, v_comps)
  on conflict (employee_id, period_label)
  do update set
    gross_annual = excluded.gross_annual, gross_monthly = excluded.gross_monthly,
    basic_monthly = excluded.basic_monthly, allowances_total = excluded.allowances_total,
    deductions_total = excluded.deductions_total, tax_paye = excluded.tax_paye,
    pension = excluded.pension, other_deductions = excluded.other_deductions,
    net_monthly = excluded.net_monthly, mid_month = excluded.mid_month,
    end_month = excluded.end_month, components = excluded.components,
    calc_timestamp = now();

  return jsonb_build_object(
    'ok', true, 'employee_id', p_employee_id, 'period_label', v_label,
    'breakdown', v_break || jsonb_build_object('components', v_comps)
  );
end; $$;
grant execute on function public.calculate_employee_salary_breakdown(uuid, text) to authenticated;

-- ============================================================
-- 3. upsert_employee_compensation — the ONLY compensation write path
--    (super_admin / admin / hr_manager). Reason mandatory. Audited.
-- ============================================================
create or replace function public.upsert_employee_compensation(
  p_employee_id uuid,
  p_basic numeric,
  p_allowances jsonb,
  p_deductions jsonb,
  p_reason text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_emp public.employees;
  v_entry jsonb;
  v_comp_id uuid;
  v_comp_name text;
  v_amount numeric;
  v_actor text;
  v_before_deductions numeric := 0;
  v_before_allowances numeric := 0;
  v_before_net numeric;
  v_result jsonb;
  v_component public.payroll_salary_components;
  v_uuid_re text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to edit employee compensation';
  end if;
  if coalesce(btrim(p_reason), '') = '' or length(btrim(p_reason)) < 5 then
    raise exception 'A reason is required (at least 5 characters)';
  end if;

  select coalesce(full_name, email, auth.uid()::text) into v_actor from public.profiles where id = auth.uid();
  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then raise exception 'Employee not found'; end if;

  -- capture the pre-edit state for the audit trail
  select coalesce(sum(amount), 0) into v_before_allowances
  from public.employee_salary_packages
  where employee_id = p_employee_id and active and snapshot ->> 'component_type' = 'allowance';
  select coalesce(sum(amount), 0) into v_before_deductions
  from public.employee_salary_packages
  where employee_id = p_employee_id and active and snapshot ->> 'component_type' = 'deduction';
  select net_monthly into v_before_net
  from public.employee_salary_snapshots
  where employee_id = p_employee_id and period_label = 'CURRENT'
  order by calc_timestamp desc limit 1;

  -- basic salary (monhtly)
  update public.employees set salary = coalesce(p_basic, 0) where id = p_employee_id;

  -- allowances: [{"component_id","name","category","amount"}]
  for v_entry in select * from jsonb_array_elements(coalesce(p_allowances, '[]'::jsonb)) loop
    v_comp_name := nullif(btrim(coalesce(v_entry ->> 'name', '')), '');
    v_amount := coalesce((v_entry ->> 'amount')::numeric, 0);
    v_comp_id := null;

    -- resolve existing component first (by id when it looks like a uuid, else by name)
    if coalesce(v_entry ->> 'component_id', '') ~ v_uuid_re then
      select * into v_component from public.payroll_salary_components
        where id = (v_entry ->> 'component_id')::uuid limit 1;
      if v_component.id is not null then
        v_comp_id := v_component.id;
        v_comp_name := coalesce(v_comp_name, v_component.name);
      end if;
    end if;
    if v_comp_id is null and v_comp_name is not null then
      select * into v_component from public.payroll_salary_components
        where name = v_comp_name and component_type = 'allowance' limit 1;
      if v_component.id is not null then
        v_comp_id := v_component.id;
      end if;
    end if;
    if v_comp_id is null then
      if v_comp_name is null then
        continue;
      end if;
      insert into public.payroll_salary_components
        (name, component_type, basis, rate, taxable, recurring, payment_schedule, category, active, created_by)
      values (v_comp_name, 'allowance', 'fixed', null, true, true, 'both',
              coalesce(nullif(v_entry ->> 'category', ''), 'other'), true, auth.uid())
      returning * into v_component;
      v_comp_id := v_component.id;
    end if;

    if v_amount <= 0 then
      update public.employee_salary_packages set active = false
      where employee_id = p_employee_id and component_id = v_comp_id;
    else
      insert into public.employee_salary_packages
        (employee_id, component_id, amount, rate, snapshot, active, created_by)
      values (p_employee_id, v_comp_id, round(v_amount, 2), 0, to_jsonb(v_component), true, auth.uid())
      on conflict (employee_id, component_id)
      do update set amount = excluded.amount, rate = excluded.rate,
                    snapshot = excluded.snapshot, active = true, effective_date = current_date;
    end if;
  end loop;

  -- deductions: [{"component_id","name","amount"}]
  for v_entry in select * from jsonb_array_elements(coalesce(p_deductions, '[]'::jsonb)) loop
    v_comp_name := nullif(btrim(coalesce(v_entry ->> 'name', '')), '');
    v_amount := coalesce((v_entry ->> 'amount')::numeric, 0);
    v_comp_id := null;

    if coalesce(v_entry ->> 'component_id', '') ~ v_uuid_re then
      select * into v_component from public.payroll_salary_components
        where id = (v_entry ->> 'component_id')::uuid limit 1;
      if v_component.id is not null then
        v_comp_id := v_component.id;
        v_comp_name := coalesce(v_comp_name, v_component.name);
      end if;
    end if;
    if v_comp_id is null and v_comp_name is not null then
      select * into v_component from public.payroll_salary_components
        where name = v_comp_name and component_type = 'deduction' limit 1;
      if v_component.id is not null then
        v_comp_id := v_component.id;
      end if;
    end if;
    if v_comp_id is null then
      if v_comp_name is null then
        continue;
      end if;
      insert into public.payroll_salary_components
        (name, component_type, basis, rate, taxable, recurring, payment_schedule, category, active, created_by)
      values (v_comp_name, 'deduction', 'fixed', null, false, true, 'both', 'other', true, auth.uid())
      returning * into v_component;
      v_comp_id := v_component.id;
    end if;

    if v_amount <= 0 then
      update public.employee_salary_packages set active = false
      where employee_id = p_employee_id and component_id = v_comp_id;
    else
      insert into public.employee_salary_packages
        (employee_id, component_id, amount, rate, snapshot, active, created_by)
      values (p_employee_id, v_comp_id, round(v_amount, 2), 0, to_jsonb(v_component), true, auth.uid())
      on conflict (employee_id, component_id)
      do update set amount = excluded.amount, rate = excluded.rate,
                    snapshot = excluded.snapshot, active = true, effective_date = current_date;
    end if;
  end loop;

  -- keep the legacy employees.allowances aggregate in sync (Phase 12 column)
  update public.employees e set allowances = coalesce(x.total, 0)
  from (
    select coalesce(sum(amount), 0) as total
    from public.employee_salary_packages
    where employee_id = p_employee_id and active and snapshot ->> 'component_type' = 'allowance'
  ) x
  where e.id = p_employee_id;

  -- recompute the CURRENT snapshot through the shared engine
  v_result := public.calculate_employee_salary_breakdown(p_employee_id, 'CURRENT');

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'EMPLOYEE_COMPENSATION_UPDATED', 'Employee', p_employee_id::text, v_actor,
    jsonb_build_object(
      'reason', p_reason,
      'before', jsonb_build_object(
        'basic_monthly', coalesce(v_emp.salary, 0),
        'allowances', v_before_allowances,
        'component_deductions', v_before_deductions,
        'net_monthly', coalesce(v_before_net, 0)
      ),
      'after', v_result -> 'breakdown'
    )::text,
    'info'
  );

  return v_result;
end; $$;
grant execute on function public.upsert_employee_compensation(uuid, numeric, jsonb, jsonb, text) to authenticated;

-- ============================================================
-- 4. preview_employee_compensation — same engine, NO writes
-- ============================================================
create or replace function public.preview_employee_compensation(
  p_employee_id uuid,
  p_basic numeric,
  p_allowances jsonb,
  p_deductions jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_entry jsonb;
  v_comp_id uuid;
  v_amount numeric;
  v_allow numeric := 0;
  v_taxable numeric := 0;
  v_ded numeric := 0;
  v_allowable bool;
  v_component public.payroll_salary_components;
  v_uuid_re text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized';
  end if;

  for v_entry in select * from jsonb_array_elements(coalesce(p_allowances, '[]'::jsonb)) loop
    v_amount := coalesce((v_entry ->> 'amount')::numeric, 0);
    v_comp_id := null;
    v_allowable := true;

    if coalesce(v_entry ->> 'component_id', '') ~ v_uuid_re then
      select taxable into v_allowable from public.payroll_salary_components
        where id = (v_entry ->> 'component_id')::uuid;
      if v_allowable is not null then
        v_comp_id := (v_entry ->> 'component_id')::uuid;
      end if;
    end if;
    if v_allowable is null then
      v_allowable := true;
    end if;
    if v_comp_id is null then
      select v_component.taxable into v_allowable from public.payroll_salary_components v_component
        where v_component.name = v_entry ->> 'name' and v_component.component_type = 'allowance' limit 1;
      v_allowable := coalesce(v_allowable, true);
    end if;
    if v_allowable then v_taxable := v_taxable + v_amount; end if;
    v_allow := v_allow + v_amount;
  end loop;

  for v_entry in select * from jsonb_array_elements(coalesce(p_deductions, '[]'::jsonb)) loop
    v_ded := v_ded + coalesce((v_entry ->> 'amount')::numeric, 0);
  end loop;

  return jsonb_build_object(
    'ok', true, 'employee_id', p_employee_id,
    'breakdown', public._salary_breakdown(
      coalesce(p_basic, 0), v_allow, v_taxable, v_ded
    )
  );
end; $$;
grant execute on function public.preview_employee_compensation(uuid, numeric, jsonb, jsonb) to authenticated;

-- ============================================================
-- 5. get_employee_compensation — single-call compensation bundle
-- ============================================================
create or replace function public.get_employee_compensation(p_employee_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_emp public.employees;
  v_packages jsonb;
  v_snapshot jsonb;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized';
  end if;
  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then raise exception 'Employee not found'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'component_id', p.component_id,
    'name', p.snapshot ->> 'name',
    'component_type', p.snapshot ->> 'component_type',
    'category', p.snapshot ->> 'category',
    'taxable', coalesce((p.snapshot ->> 'taxable')::bool, true),
    'payment_schedule', p.snapshot ->> 'payment_schedule',
    'amount', coalesce(p.amount, 0), 'active', p.active
  ) order by p.snapshot ->> 'name'), '[]'::jsonb)
  into v_packages
  from public.employee_salary_packages p
  where p.employee_id = p_employee_id;

  select jsonb_build_object(
    'gross_annual', s.gross_annual, 'gross_monthly', s.gross_monthly,
    'basic_monthly', s.basic_monthly, 'allowances_total', s.allowances_total,
    'deductions_total', s.deductions_total, 'tax_paye', s.tax_paye,
    'pension', s.pension, 'other_deductions', s.other_deductions,
    'net_monthly', s.net_monthly, 'mid_month', s.mid_month,
    'end_month', s.end_month, 'components', s.components, 'calc_timestamp', s.calc_timestamp
  ) into v_snapshot
  from public.employee_salary_snapshots s
  where s.employee_id = p_employee_id and s.period_label = 'CURRENT'
  order by s.calc_timestamp desc limit 1;

  return jsonb_build_object(
    'employee_id', v_emp.id, 'employee_name', v_emp.full_name,
    'employee_code', coalesce(v_emp.employee_code, v_emp.employee_number, v_emp.staff_id),
    'department', v_emp.department, 'position', v_emp.position,
    'basic_monthly', coalesce(v_emp.salary, v_emp.basic_salary, 0),
    'packages', v_packages, 'snapshot', coalesce(v_snapshot, jsonb_build_object()),
    'has_compensation', (
      coalesce(v_emp.salary, v_emp.basic_salary, 0) > 0
      or coalesce((select count(*) from public.employee_salary_packages where employee_id = p_employee_id and active), 0) > 0
    )
  );
end; $$;
grant execute on function public.get_employee_compensation(uuid) to authenticated;

-- ============================================================
-- 6. list_payroll_master — derive real compensation instead of
--    the empty employees.salary / employees.allowances columns
-- ============================================================
-- The previous list_payroll_master had a smaller OUT row set; Postgres
-- refuses to change a function's return type via CREATE OR REPLACE
-- (42P13), so drop the old shape first. Idempotent for re-runs.
drop function if exists public.list_payroll_master();

create or replace function public.list_payroll_master()
returns table (
  employee_id uuid,
  employee_name text,
  employee_code text,
  department text,
  "position" text,
  branch text,
  bank_name text,
  account_name text,
  account_number text,
  bank_sort_code text,
  salary numeric,
  allowances numeric,
  gross numeric,
  deductions_total numeric,
  tax_paye numeric,
  pension numeric,
  other_deductions numeric,
  net numeric,
  mid_month numeric,
  end_month numeric,
  has_compensation boolean,
  employment_status text,
  effective_date date,
  bankone_employee_number text,
  payroll_eligible boolean
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_ratio numeric := 0.5;
begin
  if public.current_role() not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized to view the payroll master';
  end if;

  select coalesce((config ->> 'mid_month_ratio')::numeric, 0.5) into v_ratio
  from public.payroll_config where id = 1;

  return query
  with comp as (
    select
      p.employee_id,
      coalesce(sum(case when p.snapshot ->> 'component_type' = 'allowance' then p.amount else 0 end), 0) as allowances,
      coalesce(sum(case when p.snapshot ->> 'component_type' <> 'allowance' then p.amount else 0 end), 0) as component_deductions,
      bool_or(p.active) as has_packages
    from public.employee_salary_packages p
    where p.active
    group by p.employee_id
  ),
  snap as (
    select distinct on (s.employee_id)
      s.employee_id, s.basic_monthly, s.allowances_total, s.gross_monthly,
      s.deductions_total, s.tax_paye, s.pension, s.other_deductions,
      s.net_monthly, s.mid_month, s.end_month
    from public.employee_salary_snapshots s
    where s.period_label = 'CURRENT'
    order by s.employee_id, s.calc_timestamp desc
  )
  select
    e.id,
    e.full_name,
    coalesce(e.employee_code, e.employee_number, e.staff_id),
    e.department, e.position, e.branch,
    e.bank_name, e.account_name, e.account_number, e.bank_sort_code,
    coalesce(sn.basic_monthly, e.salary, e.basic_salary, 0) as salary,
    coalesce(sn.allowances_total, c.allowances, e.allowances, 0) as allowances,
    coalesce(sn.gross_monthly, coalesce(sn.basic_monthly, e.salary, e.basic_salary, 0) + coalesce(c.allowances, 0)) as gross,
    coalesce(sn.deductions_total,
      coalesce(sn.tax_paye, 0) + coalesce(sn.pension, 0) + coalesce(sn.other_deductions, 0) + coalesce(c.component_deductions, 0)) as deductions_total,
    coalesce(sn.tax_paye, 0) as tax_paye,
    coalesce(sn.pension, 0) as pension,
    coalesce(sn.other_deductions, 0) as other_deductions,
    coalesce(sn.net_monthly,
      greatest(0, coalesce(sn.gross_monthly, coalesce(e.salary, e.basic_salary, 0) + coalesce(c.allowances, 0))
        - coalesce(sn.tax_paye, 0) - coalesce(sn.pension, 0) - coalesce(sn.other_deductions, 0) - coalesce(c.component_deductions, 0))) as net,
    coalesce(sn.mid_month,
      round(greatest(0, coalesce(sn.net_monthly,
        coalesce(sn.gross_monthly, coalesce(e.salary, e.basic_salary, 0) + coalesce(c.allowances, 0))
        - coalesce(sn.tax_paye, 0) - coalesce(sn.pension, 0) - coalesce(sn.other_deductions, 0) - coalesce(c.component_deductions, 0))) * v_ratio, 2)) as mid_month,
    coalesce(sn.end_month,
      greatest(0, coalesce(sn.net_monthly,
        coalesce(sn.gross_monthly, coalesce(e.salary, e.basic_salary, 0) + coalesce(c.allowances, 0))
        - coalesce(sn.tax_paye, 0) - coalesce(sn.pension, 0) - coalesce(sn.other_deductions, 0) - coalesce(c.component_deductions, 0))
        - round(greatest(0, coalesce(sn.net_monthly,
          coalesce(sn.gross_monthly, coalesce(e.salary, e.basic_salary, 0) + coalesce(c.allowances, 0))
          - coalesce(sn.tax_paye, 0) - coalesce(sn.pension, 0) - coalesce(sn.other_deductions, 0) - coalesce(c.component_deductions, 0))) * v_ratio, 2))) as end_month,
    (coalesce(sn.basic_monthly, e.salary, e.basic_salary, 0) > 0
     or coalesce(c.has_packages, false)
     or coalesce(c.allowances, 0) > 0) as has_compensation,
    e.employment_status,
    e.hire_date,
    bi.bankone_employee_number,
    (e.employment_status = 'active' and e.account_number is not null and e.bank_name is not null)
  from public.employees e
  left join comp c on c.employee_id = e.id
  left join snap sn on sn.employee_id = e.id
  left join public.employee_bankone_identifiers bi on bi.employee_id = e.id
  where e.employment_status in ('active', 'probation', 'on_leave')
  order by e.full_name;
end; $$;

grant execute on function public.list_payroll_master() to authenticated;

-- ============================================================
-- 7. compute_payroll — honour component packages instead of
--    hardcoding allowances = 0
-- ============================================================
create or replace function public.compute_payroll(p_period_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  actor_role text := public.current_role();
  v_period record;
  v_emp record;
  v_salary numeric;
  v_allowances numeric;
  v_allowances_taxable numeric;
  v_component_deductions numeric;
  v_pension numeric;
  v_gross numeric;
  v_tax numeric;
  v_other numeric;
  v_net numeric;
  v_break jsonb;
  v_count int := 0;
begin
  if actor_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to compute payroll';
  end if;

  select * into v_period from public.payroll_periods where id = p_period_id;
  if v_period.id is null then
    raise exception 'Payroll period not found.';
  end if;
  if v_period.status not in ('draft', 'calculated') then
    raise exception 'Payroll can only be calculated for a draft or calculated period.';
  end if;

  -- Recalculate the whole period: rows for this period are rewritten.
  delete from public.payroll where payroll_period = v_period.period_label;

  for v_emp in
    select * from public.employees
    where employment_status in ('active', 'probation', 'on_leave')
    order by full_name
  loop
    v_salary := coalesce(v_emp.salary, 0);
    select coalesce(sum(amount), 0) into v_allowances
    from public.employee_salary_packages
    where employee_id = v_emp.id and active and snapshot ->> 'component_type' = 'allowance';
    select coalesce(sum(amount), 0) into v_allowances_taxable
    from public.employee_salary_packages
    where employee_id = v_emp.id and active
      and snapshot ->> 'component_type' = 'allowance'
      and coalesce((snapshot ->> 'taxable')::bool, true);
    select coalesce(sum(amount), 0) into v_component_deductions
    from public.employee_salary_packages
    where employee_id = v_emp.id and active and snapshot ->> 'component_type' = 'deduction';

    v_break := public._salary_breakdown(v_salary, v_allowances, v_allowances_taxable, v_component_deductions);
    v_gross := (v_break ->> 'gross_monthly')::numeric;
    v_tax := (v_break ->> 'tax_paye')::numeric;
    v_pension := (v_break ->> 'pension')::numeric;
    v_other := (v_break ->> 'other_deductions')::numeric;
    v_net := (v_break ->> 'net_monthly')::numeric;

    insert into public.payroll (employee_id, employee_name, salary, allowances, gross_pay, tax_paye, pension_deduction,
      other_deductions, deductions, payroll_period, period_start, period_end, status)
    values (v_emp.id, v_emp.full_name, v_salary, v_allowances, v_gross, v_tax,
      v_pension, v_other, (v_break ->> 'deductions_total')::numeric, v_period.period_label, v_period.start_date, v_period.end_date, 'calculated');
    v_count := v_count + 1;
  end loop;

  update public.payroll_periods set status = 'calculated', updated_at = now()
  where id = p_period_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('PAYROLL_CALCULATED', 'PayrollPeriod', p_period_id::text,
          coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
          format('Payroll calculated for %s — %s employee rows', v_period.period_label, v_count), 'info');

  return jsonb_build_object('ok', true, 'period', v_period.period_label, 'rows', v_count);
end; $$;

grant execute on function public.compute_payroll(uuid) to authenticated;

-- ============================================================
-- 8. Grants + sanity
-- ============================================================
grant execute on function public._salary_breakdown(numeric, numeric, numeric, numeric) to authenticated;
grant select, insert, update on public.employee_salary_packages to authenticated;
grant select on public.employee_salary_snapshots to authenticated;

select 'schema_phase63_payroll_master_compensation.sql applied successfully' as result;