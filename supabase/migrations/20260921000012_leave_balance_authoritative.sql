-- 20260921000012_leave_balance_authoritative.sql
-- Must be applied AFTER 20260921000011_leave_entitlement_override.sql.
-- Keeps public.leave_balances as the per-employee source of truth:
--   * DB sync/reset functions do NOT overwrite rows that have a manual_override.
--   * Rows without a manual_override continue to receive category defaults.
--   * Broadens RLS visibility/edit rights for workforce operations roles.
begin;

-- ------------------------------------------------------------------
-- sync_employee_leave_balances
-- ------------------------------------------------------------------
create or replace function public.sync_employee_leave_balances(
  p_user_id uuid,
  p_year int default extract(year from current_date)::int
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee_name text;
  v_annual_days numeric;
begin

  -- Get employee/profile name
  select coalesce(p.full_name, p.email)
  into v_employee_name
  from public.profiles p
  where p.id = p_user_id;

  -- Determine annual entitlement from employee category
  v_annual_days := public.get_annual_leave_entitlement(p_user_id);

  -- Annual leave: insert default, but preserve any HR-edited manual override.
  insert into public.leave_balances (
    employee_id, employee_name, year, leave_type, entitled_days, default_entitlement, effective_entitlement, used_days
  )
  values (
    p_user_id, v_employee_name, p_year, 'annual', v_annual_days, v_annual_days, v_annual_days, 0
  )
  on conflict (employee_id, year, leave_type)
  do update set
    employee_name = excluded.employee_name,
    entitled_days = case when leave_balances.manual_override is null then excluded.entitled_days else leave_balances.entitled_days end,
    default_entitlement = case when leave_balances.manual_override is null then excluded.default_entitlement else leave_balances.default_entitlement end,
    effective_entitlement = case when leave_balances.manual_override is null then excluded.effective_entitlement else leave_balances.effective_entitlement end,
    updated_at = now();

  -- Maternity leave
  insert into public.leave_balances (
    employee_id, employee_name, year, leave_type, entitled_days, default_entitlement, effective_entitlement, used_days
  )
  values (
    p_user_id, v_employee_name, p_year, 'maternity', 90, 90, 90, 0
  )
  on conflict (employee_id, year, leave_type)
  do update set
    employee_name = excluded.employee_name,
    entitled_days = case when leave_balances.manual_override is null then excluded.entitled_days else leave_balances.entitled_days end,
    default_entitlement = case when leave_balances.manual_override is null then excluded.default_entitlement else leave_balances.default_entitlement end,
    effective_entitlement = case when leave_balances.manual_override is null then excluded.effective_entitlement else leave_balances.effective_entitlement end,
    updated_at = now();

  -- Examination leave
  insert into public.leave_balances (
    employee_id, employee_name, year, leave_type, entitled_days, default_entitlement, effective_entitlement, used_days
  )
  values (
    p_user_id, v_employee_name, p_year, 'examination', 5, 5, 5, 0
  )
  on conflict (employee_id, year, leave_type)
  do update set
    employee_name = excluded.employee_name,
    entitled_days = case when leave_balances.manual_override is null then excluded.entitled_days else leave_balances.entitled_days end,
    default_entitlement = case when leave_balances.manual_override is null then excluded.default_entitlement else leave_balances.default_entitlement end,
    effective_entitlement = case when leave_balances.manual_override is null then excluded.effective_entitlement else leave_balances.effective_entitlement end,
    updated_at = now();

  -- Paternity leave
  insert into public.leave_balances (
    employee_id, employee_name, year, leave_type, entitled_days, default_entitlement, effective_entitlement, used_days
  )
  values (
    p_user_id, v_employee_name, p_year, 'paternity', 2, 2, 2, 0
  )
  on conflict (employee_id, year, leave_type)
  do update set
    employee_name = excluded.employee_name,
    entitled_days = case when leave_balances.manual_override is null then excluded.entitled_days else leave_balances.entitled_days end,
    default_entitlement = case when leave_balances.manual_override is null then excluded.default_entitlement else leave_balances.default_entitlement end,
    effective_entitlement = case when leave_balances.manual_override is null then excluded.effective_entitlement else leave_balances.effective_entitlement end,
    updated_at = now();

end; $$;

grant execute on function public.sync_employee_leave_balances(uuid, int)
to authenticated;

-- ------------------------------------------------------------------
-- RLS: broaden Leave Balances visibility / edit rights to the roles
-- that own workforce operations. Area manager was missing from read;
-- branch manager, area manager, head_of_business and head_of_operations
-- need write access for the Leave Balances management page.
-- ------------------------------------------------------------------
drop policy if exists "leave_balances read own or hr" on public.leave_balances;

create policy "leave_balances read own or hr"
on public.leave_balances
for select
using (
  employee_id = auth.uid()
  or public.current_role() in (
    'admin',
    'super_admin',
    'manager',
    'head_of_human_resources',
    'hr_officer',
    'branch_manager',
    'area_manager',
    'head_of_operations',
    'head_of_business',
    'head_of_e_business',
    'financial_controller',
    'head_of_risk_compliance',
    'head_of_legal',
    'head_of_audit'
  )
);

drop policy if exists "leave_balances write hr" on public.leave_balances;

create policy "leave_balances write hr"
on public.leave_balances
for all
using (
  public.current_role() in (
    'admin',
    'super_admin',
    'head_of_human_resources',
    'branch_manager',
    'area_manager',
    'head_of_business',
    'head_of_operations'
  )
)
with check (
  public.current_role() in (
    'admin',
    'super_admin',
    'head_of_human_resources',
    'branch_manager',
    'area_manager',
    'head_of_business',
    'head_of_operations'
  )
);

-- ------------------------------------------------------------------
-- reset_annual_leave_balances
-- ------------------------------------------------------------------
create or replace function public.reset_annual_leave_balances(target_year int)
returns void language plpgsql security definer set search_path = public as $$
declare
  p record;
  ent numeric;
begin
  for p in select id, coalesce(full_name, email) AS full_name, role FROM public.profiles loop
    -- Annual: category-dependent
    ent := case
      when p.role in ('md', 'super_admin') then 20
      when p.role in ('admin', 'head_of_human_resources', 'branch_manager', 'area_manager', 'head_of_business',
                      'head_of_operations', 'head_of_e_business', 'financial_controller',
                      'head_of_risk_compliance', 'head_of_legal', 'head_of_audit') then 15
      else 10
    end;
    insert into public.leave_balances (employee_id, employee_name, year, leave_type, entitled_days, default_entitlement, effective_entitlement, used_days)
    values (p.id, p.full_name, target_year, 'annual', ent, ent, ent, 0)
    on conflict (employee_id, year, leave_type) do update set
      employee_name = excluded.employee_name,
      entitled_days = case when leave_balances.manual_override is null then excluded.entitled_days else leave_balances.entitled_days end,
      default_entitlement = case when leave_balances.manual_override is null then excluded.default_entitlement else leave_balances.default_entitlement end,
      effective_entitlement = case when leave_balances.manual_override is null then excluded.effective_entitlement else leave_balances.effective_entitlement end,
      updated_at = now();

    -- Maternity
    insert into public.leave_balances (employee_id, employee_name, year, leave_type, entitled_days, default_entitlement, effective_entitlement, used_days)
    values (p.id, p.full_name, target_year, 'maternity', 90, 90, 90, 0)
    on conflict (employee_id, year, leave_type) do update set
      employee_name = excluded.employee_name,
      entitled_days = case when leave_balances.manual_override is null then excluded.entitled_days else leave_balances.entitled_days end,
      default_entitlement = case when leave_balances.manual_override is null then excluded.default_entitlement else leave_balances.default_entitlement end,
      effective_entitlement = case when leave_balances.manual_override is null then excluded.effective_entitlement else leave_balances.effective_entitlement end,
      updated_at = now();

    -- Examination
    insert into public.leave_balances (employee_id, employee_name, year, leave_type, entitled_days, default_entitlement, effective_entitlement, used_days)
    values (p.id, p.full_name, target_year, 'examination', 5, 5, 5, 0)
    on conflict (employee_id, year, leave_type) do update set
      employee_name = excluded.employee_name,
      entitled_days = case when leave_balances.manual_override is null then excluded.entitled_days else leave_balances.entitled_days end,
      default_entitlement = case when leave_balances.manual_override is null then excluded.default_entitlement else leave_balances.default_entitlement end,
      effective_entitlement = case when leave_balances.manual_override is null then excluded.effective_entitlement else leave_balances.effective_entitlement end,
      updated_at = now();

    -- Paternity
    insert into public.leave_balances (employee_id, employee_name, year, leave_type, entitled_days, default_entitlement, effective_entitlement, used_days)
    values (p.id, p.full_name, target_year, 'paternity', 2, 2, 2, 0)
    on conflict (employee_id, year, leave_type) do update set
      employee_name = excluded.employee_name,
      entitled_days = case when leave_balances.manual_override is null then excluded.entitled_days else leave_balances.entitled_days end,
      default_entitlement = case when leave_balances.manual_override is null then excluded.default_entitlement else leave_balances.default_entitlement end,
      effective_entitlement = case when leave_balances.manual_override is null then excluded.effective_entitlement else leave_balances.effective_entitlement end,
      updated_at = now();
  end loop;
end; $$;

commit;
