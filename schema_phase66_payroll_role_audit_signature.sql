-- ============================================================
-- PHASE 66 — PAYROLL ROLE-BASED EDITING + AUDIT TRAIL
-- (run in Supabase SQL Editor after Phase 64; idempotent/additive)
-- ============================================================
-- Goal: harden the Payroll Master edit path with role-based
-- permissions, a digital-signature requirement for HR Officers, a
-- dedicated queryable audit trail and DIRECT manual editing of the
-- payroll outcomes (gross / net / mid-month / month-end):
--
--   1. NEW table public.payroll_audit_logs — dedicated trail for
--      payroll data edits AND Excel structure overrides. RLS read-only
--      for payroll roles; every write flows through SECURITY DEFINER
--      RPCs (same pattern as payroll_imports).
--   2. NEW employees columns payroll_gross_override /
--      payroll_net_override / payroll_mid_override / payroll_end_override
--      (+ payroll_override_at / payroll_override_by) — a MANUAL layer on
--      top of the engine-derived figures. The Payroll Master editor sets
--      them; list_payroll_master and payroll_push_calc prefer them over
--      the derived values, so what HR sees and what is pushed matches.
--   3. upsert_employee_compensation is recreated (one write path) with:
--        * role allowlist = super_admin / hr_manager / hr_officer
--          (spec: ALL other roles are read-only),
--        * HR Officer MUST pass a base64 PNG signature (data:image/...),
--        * ip_address is captured when the browser can supply it,
--        * manual gross/net/mid/end overrides are persisted,
--        * a field-level diff is computed (basic / allowances /
--          component_deductions / derived net / gross/net/mid/end),
--        * an audit row is written to payroll_audit_logs + audit_logs
--          UNLESS the actor is super_admin (per spec, no audit needed).
--   4. list_payroll_master / get_employee_compensation are recreated to
--      surface the manual overrides (edit prefill + master columns).
--   5. payroll_push_calc is recreated so the BankOne push preview
--      honours the manual overrides (what HR edits flows to the push).
--   6. save_payroll_import is recreated to record the structure
--      override in payroll_audit_logs (previous columns → new columns,
--      added/removed columns) and to accept the caller's ip_address.
--      Same role policy: super_admin edits are not audited.
--   7. NEW public.list_payroll_audit(...) — read-only trail fetch for
--      the Payroll Master "Audit Trail" panel.
-- ============================================================

-- -- -- core audit trail table -- -- --
create table if not exists public.payroll_audit_logs (
  id uuid primary key default gen_random_uuid(),
  action text not null default 'EMPLOYEE_COMPENSATION_EDITED',
  edited_by uuid,
  edited_by_role text,
  edited_by_name text,
  employee_id uuid references public.employees(id) on delete set null,
  previous_values jsonb default '{}'::jsonb,
  new_values jsonb default '{}'::jsonb,
  field_diff jsonb default '{}'::jsonb,
  signature_data_url text,
  ip_address text,
  reason text,
  details jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_payroll_audit_created on public.payroll_audit_logs(created_at desc);
create index if not exists idx_payroll_audit_employee on public.payroll_audit_logs(employee_id, created_at desc);

alter table public.payroll_audit_logs enable row level security;

drop policy if exists payroll_audit_logs_select on public.payroll_audit_logs;
create policy payroll_audit_logs_select on public.payroll_audit_logs
  for select to authenticated
  using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

grant select on public.payroll_audit_logs to authenticated;


-- ============================================================
-- 2. employees manual payroll-outcome override columns
--    (a manual layer ON TOP of the derived engine figures)
-- ============================================================
alter table public.employees
  add column if not exists payroll_gross_override numeric(12, 2),
  add column if not exists payroll_net_override numeric(12, 2),
  add column if not exists payroll_mid_override numeric(12, 2),
  add column if not exists payroll_end_override numeric(12, 2),
  add column if not exists payroll_override_at timestamptz,
  add column if not exists payroll_override_by uuid;


-- ============================================================
-- 7. list_payroll_audit — read-only trail fetch
-- ============================================================
create or replace function public.list_payroll_audit(
  p_employee_id uuid default null,
  p_limit integer default 100
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_limit integer;
  v_rows jsonb;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized to view the payroll audit trail';
  end if;
  v_limit := least(greatest(coalesce(p_limit, 100), 1), 500);

  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_rows
  from (
    select jsonb_build_object(
      'id', a.id,
      'action', a.action,
      'edited_by', a.edited_by,
      'edited_by_role', a.edited_by_role,
      'edited_by_name', a.edited_by_name,
      'employee_id', a.employee_id,
      'employee_name', e.full_name,
      'employee_code', coalesce(e.employee_code, e.employee_number, e.staff_id),
      'previous_values', a.previous_values,
      'new_values', a.new_values,
      'field_diff', a.field_diff,
      'signature_data_url', a.signature_data_url,
      'ip_address', a.ip_address,
      'reason', a.reason,
      'details', a.details,
      'created_at', a.created_at
    ) as x
    from public.payroll_audit_logs a
    left join public.employees e on e.id = a.employee_id
    where p_employee_id is null or a.employee_id = p_employee_id
    order by a.created_at desc
    limit v_limit
  ) t;

  return v_rows;
end; $$;

grant execute on function public.list_payroll_audit(uuid, integer) to authenticated;


-- ============================================================
-- 3. upsert_employee_compensation — role-based write path
--    with HR Officer signature, manual outcome overrides and
--    field-diff audit trail
-- ============================================================
-- DROP the Phase 63 signature (uuid,numeric,jsonb,jsonb,text) so the
-- new one (5 original args + signature + ip + 4 outcome overrides, all
-- defaulted) can take its place. Idempotent.
drop function if exists public.upsert_employee_compensation(uuid, numeric, jsonb, jsonb, text);

create or replace function public.upsert_employee_compensation(
  p_employee_id uuid,
  p_basic numeric,
  p_allowances jsonb,
  p_deductions jsonb,
  p_reason text,
  p_signature text default null,
  p_ip_address text default null,
  p_gross_override numeric default null,
  p_net_override numeric default null,
  p_mid_override numeric default null,
  p_end_override numeric default null
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
  v_before_net numeric := 0;
  v_before_gross numeric := 0;
  v_before_mid numeric := 0;
  v_before_end numeric := 0;
  v_has_override boolean;
  v_result jsonb;
  v_prev jsonb;
  v_now jsonb;
  v_diff jsonb := '{}'::jsonb;
  v_f text;
  v_sig text;
  v_component public.payroll_salary_components;
  v_uuid_re text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  -- Editable roles (all other roles are read-only by spec).
  if v_role not in ('super_admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized to edit employee payroll';
  end if;
  if coalesce(btrim(p_reason), '') = '' or length(btrim(p_reason)) < 5 then
    raise exception 'A reason is required (at least 5 characters)';
  end if;

  v_sig := nullif(btrim(coalesce(p_signature, '')), '');
  -- HR Officer edits are only persisted after a captured signature.
  if v_role = 'hr_officer' and (v_sig is null or left(v_sig, 11) <> 'data:image/') then
    raise exception 'An HR Officer signature is required to save payroll changes';
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
  select coalesce(net_monthly, 0), coalesce(gross_monthly, 0), coalesce(mid_month, 0), coalesce(end_month, 0)
  into v_before_net, v_before_gross, v_before_mid, v_before_end
  from public.employee_salary_snapshots
  where employee_id = p_employee_id and period_label = 'CURRENT'
  order by calc_timestamp desc limit 1;

  -- basic salary (monthly)
  update public.employees set salary = coalesce(p_basic, 0) where id = p_employee_id;

  -- allowances: [{"component_id","name","category","amount"}]
  for v_entry in select * from jsonb_array_elements(coalesce(p_allowances, '[]'::jsonb)) loop
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

  -- ---- manual payroll-outcome overrides (gross / net / mid / end) ----
  v_has_override := coalesce(p_gross_override, p_net_override, p_mid_override, p_end_override) is not null;
  update public.employees
  set payroll_gross_override = p_gross_override,
      payroll_net_override = p_net_override,
      payroll_mid_override = p_mid_override,
      payroll_end_override = p_end_override,
      payroll_override_at = case when v_has_override then now() else payroll_override_at end,
      payroll_override_by = case when v_has_override then auth.uid() else payroll_override_by end
  where id = p_employee_id;

  -- ---- field-level diff (source inputs + derived/override outcomes) ----
  v_prev := jsonb_build_object(
    'basic_monthly', coalesce(v_emp.salary, 0),
    'allowances', v_before_allowances,
    'component_deductions', v_before_deductions,
    'net_monthly', v_before_net,
    'gross_override', coalesce(v_emp.payroll_gross_override, v_before_gross),
    'net_override', coalesce(v_emp.payroll_net_override, v_before_net),
    'mid_override', coalesce(v_emp.payroll_mid_override, v_before_mid),
    'end_override', coalesce(v_emp.payroll_end_override, v_before_end)
  );
  v_now := jsonb_build_object(
    'basic_monthly', coalesce(p_basic, 0),
    'allowances', coalesce((v_result -> 'breakdown' ->> 'allowances_total')::numeric, 0),
    'component_deductions', coalesce((v_result -> 'breakdown' ->> 'component_deductions')::numeric, 0),
    'net_monthly', coalesce((v_result -> 'breakdown' ->> 'net_monthly')::numeric, 0),
    'gross_override', coalesce(p_gross_override, (v_result -> 'breakdown' ->> 'gross_monthly')::numeric),
    'net_override', coalesce(p_net_override, (v_result -> 'breakdown' ->> 'net_monthly')::numeric),
    'mid_override', coalesce(p_mid_override, (v_result -> 'breakdown' ->> 'mid_month')::numeric),
    'end_override', coalesce(p_end_override, (v_result -> 'breakdown' ->> 'end_month')::numeric)
  );
  foreach v_f in array array['basic_monthly', 'allowances', 'component_deductions', 'net_monthly',
                            'gross_override', 'net_override', 'mid_override', 'end_override'] loop
    if coalesce((v_prev ->> v_f)::numeric, 0) <> coalesce((v_now ->> v_f)::numeric, 0) then
      v_diff := v_diff || jsonb_build_object(
        v_f,
        jsonb_build_object(
          'from', coalesce((v_prev ->> v_f)::numeric, 0),
          'to', coalesce((v_now ->> v_f)::numeric, 0)
        )
      );
    end if;
  end loop;

  -- ---- audit (skipped entirely for super_admin per spec) ----
  if v_role <> 'super_admin' then
    insert into public.payroll_audit_logs
      (action, edited_by, edited_by_role, edited_by_name, employee_id,
       previous_values, new_values, field_diff, signature_data_url, ip_address, reason)
    values
      ('EMPLOYEE_COMPENSATION_EDITED', auth.uid(), v_role, v_actor, p_employee_id,
       v_prev, v_now, v_diff,
       case when v_role = 'hr_officer' then v_sig else null end,
       nullif(btrim(coalesce(p_ip_address, '')), ''), p_reason);

    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'EMPLOYEE_COMPENSATION_UPDATED', 'Employee', p_employee_id::text, v_actor,
      jsonb_build_object(
        'reason', p_reason,
        'edited_by_role', v_role,
        'signature_data_url', case when v_role = 'hr_officer' then v_sig else null end,
        'ip_address', nullif(btrim(coalesce(p_ip_address, '')), ''),
        'before', v_prev,
        'after', v_result -> 'breakdown',
        'diff', v_diff
      )::text,
      'info'
    );
  end if;

  return v_result;
end; $$;

grant execute on function public.upsert_employee_compensation(uuid, numeric, jsonb, jsonb, text, text, text, numeric, numeric, numeric, numeric) to authenticated;


-- ============================================================
-- 4a. list_payroll_master — surface the manual outcome overrides
--     (recreated: gross/net/mid/end prefer the manual override)
-- ============================================================
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
    coalesce(e.payroll_gross_override, sn.gross_monthly,
      coalesce(sn.basic_monthly, e.salary, e.basic_salary, 0) + coalesce(c.allowances, 0)) as gross,
    coalesce(sn.deductions_total,
      coalesce(sn.tax_paye, 0) + coalesce(sn.pension, 0) + coalesce(sn.other_deductions, 0) + coalesce(c.component_deductions, 0)) as deductions_total,
    coalesce(sn.tax_paye, 0) as tax_paye,
    coalesce(sn.pension, 0) as pension,
    coalesce(sn.other_deductions, 0) as other_deductions,
    coalesce(e.payroll_net_override, sn.net_monthly,
      greatest(0, coalesce(sn.gross_monthly, coalesce(e.salary, e.basic_salary, 0) + coalesce(c.allowances, 0))
        - coalesce(sn.tax_paye, 0) - coalesce(sn.pension, 0) - coalesce(sn.other_deductions, 0) - coalesce(c.component_deductions, 0))) as net,
    coalesce(e.payroll_mid_override, sn.mid_month,
      round(greatest(0, coalesce(e.payroll_net_override, sn.net_monthly,
        coalesce(sn.gross_monthly, coalesce(e.salary, e.basic_salary, 0) + coalesce(c.allowances, 0))
        - coalesce(sn.tax_paye, 0) - coalesce(sn.pension, 0) - coalesce(sn.other_deductions, 0) - coalesce(c.component_deductions, 0))) * v_ratio, 2)) as mid_month,
    coalesce(e.payroll_end_override, sn.end_month,
      greatest(0, coalesce(e.payroll_net_override, sn.net_monthly,
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
-- 4b. get_employee_compensation — include the manual overrides so
--     the Payroll Master editor can prefill them
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
    'payroll_gross_override', v_emp.payroll_gross_override,
    'payroll_net_override', v_emp.payroll_net_override,
    'payroll_mid_override', v_emp.payroll_mid_override,
    'payroll_end_override', v_emp.payroll_end_override,
    'payroll_override_at', v_emp.payroll_override_at,
    'has_compensation', (
      coalesce(v_emp.salary, v_emp.basic_salary, 0) > 0
      or coalesce((select count(*) from public.employee_salary_packages where employee_id = p_employee_id and active), 0) > 0
    )
  );
end; $$;
grant execute on function public.get_employee_compensation(uuid) to authenticated;


-- ============================================================
-- 5. payroll_push_calc — BankOne push preview honours the manual
--    outcome overrides (what HR edits in the master flows through)
-- ============================================================
create or replace function public.payroll_push_calc(p_period_label text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_ratio numeric := 0.5;
  v_period record;
  v_currency text := 'NGN';
  v_employees jsonb;
  v_count int := 0;
  v_total_gross numeric := 0;
  v_total_allow numeric := 0;
  v_total_ded numeric := 0;
  v_total_net numeric := 0;
  v_total_mid numeric := 0;
  v_total_end numeric := 0;
begin
  if public.current_role() not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized to calculate payroll push';
  end if;

  select coalesce(config->>'mid_month_ratio', '0.5')::numeric into v_ratio
  from public.payroll_config where id = 1;
  if v_ratio is null or v_ratio <= 0 or v_ratio >= 1 then v_ratio := 0.5; end if;

  select coalesce(currency_code, 'NGN') into v_currency from public.hr_platform_settings limit 1;
  v_currency := coalesce(v_currency, 'NGN');

  select * into v_period from public.payroll_periods where period_label = p_period_label;

  with rows as (
    select
      p.employee_id,
      p.employee_name,
      coalesce(p.salary, 0) as salary,
      coalesce(p.allowances, 0) as allowances,
      coalesce(p.deductions, 0) as deductions,
      coalesce(e.payroll_net_override, p.net_pay,
        coalesce(p.salary, 0) + coalesce(p.allowances, 0) - coalesce(p.deductions, 0)) as net_pay,
      coalesce(e.payroll_mid_override,
        round(coalesce(e.payroll_net_override, p.net_pay,
          coalesce(p.salary, 0) + coalesce(p.allowances, 0) - coalesce(p.deductions, 0)) * v_ratio, 2)) as mid_month,
      coalesce(e.payroll_end_override,
        greatest(0,
          coalesce(e.payroll_net_override, p.net_pay,
            coalesce(p.salary, 0) + coalesce(p.allowances, 0) - coalesce(p.deductions, 0))
          - round(coalesce(e.payroll_net_override, p.net_pay,
            coalesce(p.salary, 0) + coalesce(p.allowances, 0) - coalesce(p.deductions, 0)) * v_ratio, 2))) as month_end,
      e.payroll_net_override is not null as has_net_override
    from public.payroll p
    left join public.employees e on e.id = p.employee_id
    where p.payroll_period = p_period_label
      and p.status is distinct from 'cancelled'
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'employee_id', r.employee_id,
      'employee_name', r.employee_name,
      'salary', r.salary,
      'allowances', r.allowances,
      'deductions', r.deductions,
      'net_pay', r.net_pay,
      'mid_month', r.mid_month,
      'month_end', r.month_end,
      'manual_override', r.has_net_override
    )), '[]'::jsonb),
    count(*),
    coalesce(sum(r.salary), 0),
    coalesce(sum(r.allowances), 0),
    coalesce(sum(r.deductions), 0),
    coalesce(sum(r.net_pay), 0),
    coalesce(sum(r.mid_month), 0),
    coalesce(sum(r.month_end), 0)
  into v_employees, v_count, v_total_gross, v_total_allow, v_total_ded, v_total_net, v_total_mid, v_total_end
  from rows r;

  return jsonb_build_object(
    'period_label', p_period_label,
    'period_start', v_period.start_date,
    'period_end', v_period.end_date,
    'employee_count', v_count,
    'gross_total', v_total_gross,
    'allowances_total', v_total_allow,
    'deductions_total', v_total_ded,
    'net_total', v_total_net,
    'mid_month_total', v_total_mid,
    'month_end_total', v_total_end,
    'currency', v_currency,
    'mid_month_ratio', v_ratio,
    'employees', v_employees
  );
end; $$;

grant execute on function public.payroll_push_calc(text) to authenticated;


-- ============================================================
-- 6. save_payroll_import — structure override is now audited
--    (same write path as Phase 64, new p_ip_address + trail row)
-- ============================================================
drop function if exists public.save_payroll_import(text, text, text, text, text, jsonb, jsonb, boolean);

create or replace function public.save_payroll_import(
  p_filename text,
  p_source_format text,
  p_period_label text default null,
  p_currency text default 'NGN',
  p_match_key text default null,
  p_columns jsonb default '[]'::jsonb,
  p_rows jsonb default '[]'::jsonb,
  p_confirm_override boolean default false,
  p_ip_address text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_actor text;
  v_import_id uuid;
  v_active uuid;
  v_row jsonb;
  v_code text;
  v_affected integer := 0;
  v_override boolean := false;
  v_col_count integer;
  v_row_count integer;
  v_period text;
  v_prev_cols jsonb := null;
  v_prev_match text := null;
  v_added jsonb := '[]'::jsonb;
  v_removed jsonb := '[]'::jsonb;
  v_c jsonb;
  v_ckey text;
  v_diff jsonb;
  v_matched integer;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to import the payroll file';
  end if;
  if coalesce(btrim(p_filename), '') = '' then
    raise exception 'A file name is required';
  end if;
  if p_source_format not in ('xlsx', 'xls', 'csv') then
    raise exception 'Only .xlsx, .xls and .csv files are supported';
  end if;
  select count(*) into v_col_count from jsonb_array_elements(coalesce(p_columns, '[]'::jsonb));
  select count(*) into v_row_count from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb));
  if v_col_count = 0 then
    raise exception 'The file contains no recognizable column headers';
  end if;
  if v_row_count = 0 then
    raise exception 'The file contains no data rows';
  end if;

  -- an active import already exists → require explicit override
  select id into v_active from public.payroll_imports
  where is_active order by created_at desc limit 1;
  if v_active is not null and not coalesce(p_confirm_override, false) then
    return jsonb_build_object('ok', false, 'code', 'override_required');
  end if;
  if v_active is not null then
    select columns, match_key into v_prev_cols, v_prev_match from public.payroll_imports where id = v_active;
    update public.payroll_imports set is_active = false where is_active;
    update public.employees
    set payroll_import_id = null, payroll_import_snapshot = null, payroll_import_at = null
    where payroll_import_id = v_active;
    v_override := true;
  end if;

  select coalesce(full_name, email, auth.uid()::text) into v_actor from public.profiles where id = auth.uid();
  v_period := nullif(btrim(coalesce(p_period_label, '')), '');

  insert into public.payroll_imports
    (filename, source_format, period_label, currency, match_key, columns, rows,
     row_count, imported_by, imported_by_name, is_active)
  values
    (p_filename, p_source_format, v_period, coalesce(nullif(btrim(p_currency), ''), 'NGN'),
     nullif(nullif(btrim(coalesce(p_match_key, '')), ''), ''),
     p_columns, p_rows, v_row_count, auth.uid(), v_actor, true)
  returning id into v_import_id;

  -- link imported rows to employee profiles by staff identifier
  if nullif(btrim(coalesce(p_match_key, '')), '') is not null then
    for v_row in select * from jsonb_array_elements(p_rows) loop
      v_code := nullif(btrim(coalesce(v_row ->> p_match_key, '')), '');
      if v_code is null then
        continue;
      end if;
      update public.employees e
      set payroll_import_id = v_import_id,
          payroll_import_snapshot = v_row,
          payroll_import_at = now()
      where coalesce(e.employee_code, e.employee_number, e.staff_id) = v_code
        and coalesce(e.is_archived, false) = false;
    end loop;
  end if;

  select count(*) into v_matched from public.employees where payroll_import_id = v_import_id;

  update public.payroll_imports
  set matched_profiles = v_matched
  where id = v_import_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('PAYROLL_IMPORT_SAVED', 'payroll_import', v_import_id, v_actor,
    jsonb_build_object(
      'filename', p_filename,
      'source_format', p_source_format,
      'period_label', v_period,
      'currency', coalesce(nullif(btrim(p_currency), ''), 'NGN'),
      'match_key', nullif(btrim(coalesce(p_match_key, '')), ''),
      'columns', v_col_count,
      'rows', v_row_count,
      'matched_profiles', v_matched,
      'override_applied', v_override
    ), 'info');

  -- ---- structure-override audit trail row (skipped for super_admin) ----
  if v_role <> 'super_admin' then
    for v_c in select value from jsonb_array_elements(coalesce(v_prev_cols, '[]'::jsonb)) loop
      v_ckey := v_c ->> 'key';
      if not exists (
        select 1 from jsonb_array_elements(p_columns) where value ->> 'key' = v_ckey
      ) then
        v_removed := v_removed || to_jsonb(v_ckey);
      end if;
    end loop;
    for v_c in select value from jsonb_array_elements(p_columns) loop
      v_ckey := v_c ->> 'key';
      if not exists (
        select 1 from jsonb_array_elements(coalesce(v_prev_cols, '[]'::jsonb)) where value ->> 'key' = v_ckey
      ) then
        v_added := v_added || to_jsonb(v_ckey);
      end if;
    end loop;
    v_diff := jsonb_build_object('added_columns', v_added, 'removed_columns', v_removed, 'override_applied', v_override);

    insert into public.payroll_audit_logs
      (action, edited_by, edited_by_role, edited_by_name, employee_id,
       previous_values, new_values, field_diff, ip_address, reason, details)
    values
      ('PAYROLL_STRUCTURE_OVERRIDE', auth.uid(), v_role, v_actor, null,
       jsonb_build_object('columns', coalesce(v_prev_cols, '[]'::jsonb), 'match_key', v_prev_match),
       jsonb_build_object('columns', p_columns, 'match_key', nullif(btrim(coalesce(p_match_key, '')), '')),
       v_diff,
       nullif(btrim(coalesce(p_ip_address, '')), ''),
       format('Payroll Excel imported (%s) — %s columns, %s rows, %s matched', p_filename, v_col_count, v_row_count, v_matched),
       jsonb_build_object(
         'filename', p_filename,
         'source_format', p_source_format,
         'period_label', v_period,
         'currency', coalesce(nullif(btrim(p_currency), ''), 'NGN'),
         'rows', v_row_count,
         'matched_profiles', v_matched,
         'override_applied', v_override
       ));
  end if;

  return jsonb_build_object(
    'ok', true,
    'id', v_import_id,
    'filename', p_filename,
    'columns', v_col_count,
    'rows', v_row_count,
    'matched_profiles', v_matched,
    'override_applied', v_override
  );
end; $$;

grant execute on function public.save_payroll_import(text, text, text, text, text, jsonb, jsonb, boolean, text) to authenticated;

select 'schema_phase66_payroll_role_audit_signature.sql applied successfully' as result;