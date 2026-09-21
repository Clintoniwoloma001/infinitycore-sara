-- Leave balance entitlement override support
-- Run in Supabase SQL Editor after existing leave migrations.
-- Idempotent and additive; preserves existing leave records and approved leave requests.

-- 1. Add override tracking columns to leave_balances
alter table public.leave_balances
  add column if not exists default_entitlement numeric(8, 2),
  add column if not exists manual_override numeric(8, 2),
  add column if not exists effective_entitlement numeric(8, 2),
  add column if not exists pending_days numeric(8, 2) not null default 0,
  add column if not exists override_reason text,
  add column if not exists override_updated_by uuid references public.profiles(id) on delete set null,
  add column if not exists override_updated_at timestamptz;

-- 2. Backfill: default = current entitled_days, effective = entitled_days (unless HR later overrides)
update public.leave_balances
   set default_entitlement = coalesce(default_entitlement, entitled_days),
       effective_entitlement = coalesce(effective_entitlement, entitled_days),
       pending_days = coalesce(pending_days, 0)
 where default_entitlement is null or effective_entitlement is null or pending_days is null;

-- 3. Helper: classify an employee's designation into the Annual Leave category
--    used by the Infinity Bank policy (MD/CEO=20, MD/HEAD=15, others=10).
create or replace function public.get_annual_leave_category(p_designation text)
returns text
language sql immutable
set search_path = public
as $$
  select case
    when upper(trim(coalesce(p_designation, ''))) in ('MD/CEO', 'MD / CEO', 'MD/ CEO', 'MD /CEO') then 'md'
    when upper(trim(coalesce(p_designation, ''))) in ('MD', 'M.D', 'M.D.', 'MANAGING DIRECTOR') then 'management_staff'
    when upper(trim(coalesce(p_designation, ''))) like '%HEAD%' then 'management_staff'
    else 'normal_staff'
  end;
$$;

-- 4. Helper: annual leave default days for a designation
create or replace function public.get_annual_leave_default_days(p_designation text)
returns numeric
language sql immutable
set search_path = public
as $$
  select case public.get_annual_leave_category(p_designation)
    when 'md' then 20
    when 'management_staff' then 15
    else 10
  end::numeric;
$$;

-- 5. Centralized employee leave entitlement.
--    Returns { default_entitlement, manual_override, effective_entitlement }
--    for a given employee + leave type. For annual leave the default is driven
--    by the employee's designation. Other leave types fall back to leave_rules
--    or the legacy hard-coded defaults.
create or replace function public.get_employee_leave_entitlement(
  p_employee_id uuid,
  p_leave_type text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_designation text;
  v_default numeric;
  v_override numeric;
  v_effective numeric;
  v_balance record;
  v_rule record;
begin
  select e.user_id, coalesce(nullif(trim(d.title), ''), nullif(trim(e."position"), ''), nullif(trim(p.role), ''))
    into v_user_id, v_designation
    from public.employees e
    left join public.designations d on d.id = e.designation_id
    left join public.profiles p on p.id = e.user_id
   where e.user_id = p_employee_id;

  -- Determine default entitlement
  if p_leave_type = 'annual' then
    v_default := public.get_annual_leave_default_days(v_designation);
  else
    select entitled_days into v_rule
      from public.leave_rules
     where leave_type = p_leave_type
       and employee_category = public.get_annual_leave_category(v_designation)
       and is_active = true
     limit 1;
    if v_rule is null then
      select entitled_days into v_rule
        from public.leave_rules
       where leave_type = p_leave_type
         and employee_category is null
         and is_active = true
       limit 1;
    end if;
    v_default := coalesce(v_rule.entitled_days, 0);
  end if;

  -- Check for manual override in leave_balances (employee_id here is auth.users.id)
  select * into v_balance
    from public.leave_balances
   where employee_id = p_employee_id
     and leave_type = p_leave_type
     and year = extract(year from now())::int
   limit 1;

  v_override := v_balance.manual_override;
  v_effective := coalesce(v_override, v_default);

  return jsonb_build_object(
    'employee_id', p_employee_id,
    'leave_type', p_leave_type,
    'designation', v_designation,
    'default_entitlement', v_default,
    'manual_override', v_override,
    'effective_entitlement', v_effective,
    'used_days', coalesce(v_balance.used_days, 0),
    'pending_days', coalesce(v_balance.pending_days, 0)
  );
end;
$$;

grant execute on function public.get_employee_leave_entitlement(uuid, text) to authenticated;
grant execute on function public.get_annual_leave_category(text) to authenticated;
grant execute on function public.get_annual_leave_default_days(text) to authenticated;

-- 6. Backfill all current-year balance rows with default/effective using the new engine.
--    This is safe to re-run: it never overwrites a non-null manual_override.
update public.leave_balances b
   set default_entitlement = case
       when b.leave_type = 'annual' then public.get_annual_leave_default_days(coalesce(nullif(trim(d.title), ''), nullif(trim(e."position"), '')))
       else coalesce(b.default_entitlement, b.entitled_days, 0)
     end,
       effective_entitlement = case
       when b.manual_override is not null then b.manual_override
       when b.leave_type = 'annual' then public.get_annual_leave_default_days(coalesce(nullif(trim(d.title), ''), nullif(trim(e."position"), '')))
       else coalesce(b.entitled_days, b.default_entitlement, 0)
     end
  from public.employees e
  left join public.designations d on d.id = e.designation_id
 where e.user_id = b.employee_id
   and b.year = extract(year from now())::int;

-- 7. Keep the legacy entitled_days column synchronised with effective_entitlement
--    so older consumers that read entitled_days still see the correct value.
update public.leave_balances
   set entitled_days = effective_entitlement
 where effective_entitlement is not null
   and (entitled_days is null or entitled_days <> effective_entitlement);

-- 8. Optional audit helper for leave entitlement changes.
create or replace function public.audit_leave_entitlement_change(
  p_balance_id uuid,
  p_old jsonb,
  p_new jsonb,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'LEAVE_ENTITLEMENT_CHANGED',
    'LeaveBalance',
    p_balance_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    jsonb_build_object('old', p_old, 'new', p_new, 'reason', p_reason)::text,
    'info'
  );
end;
$$;

grant execute on function public.audit_leave_entitlement_change(uuid, jsonb, jsonb, text) to authenticated;
