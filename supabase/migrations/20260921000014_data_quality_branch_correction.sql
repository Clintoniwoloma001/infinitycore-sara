-- ============================================================
-- Phase — Data Quality Branch Correction (auto-resolve workflow)
-- Run in Supabase SQL Editor after 20260921000013.
-- Idempotent/additive (begin / commit).
--
-- Lets HR "Correct" a location-based data-quality exception:
--   * single-correct  — rename the location everywhere (branches,
--                       employees, profiles) and resolve the issue.
--   * split           — dissolve the combined location into several
--                       entries, reassign every linked staff member
--                       (individually or in bulk), then resolve.
-- "Keep as it is" remains resolve_data_quality_exception ('dismissed').
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Resolution tracking columns on data_quality_exceptions
-- ------------------------------------------------------------
alter table public.data_quality_exceptions
  add column if not exists resolution jsonb,
  add column if not exists resolved_by uuid,
  add column if not exists resolved_at timestamptz;

-- ------------------------------------------------------------
-- 2. Dismiss/reopen now also records who/when/why (same signature,
--    so existing callers keep working).
-- ------------------------------------------------------------
create or replace function public.resolve_data_quality_exception(
  p_exception_id uuid,
  p_resolution text default 'resolved' -- 'resolved' | 'dismissed'
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if not public._org_can_manage() then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  if p_resolution not in ('resolved', 'dismissed') then
    return jsonb_build_object('ok', false, 'error', 'resolution must be resolved or dismissed');
  end if;

  update public.data_quality_exceptions
  set status = p_resolution,
      resolution = jsonb_build_object(
        'resolution', p_resolution,
        'resolved_at', now(),
        'resolved_by', v_actor
      ),
      resolved_by = v_actor,
      resolved_at = now()
  where id = p_exception_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'exception not found');
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('DATA_QUALITY_EXCEPTION_RESOLVED', 'DataQualityException', p_exception_id::text, v_actor::text,
          format('Exception %s', p_resolution), 'info');

  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.resolve_data_quality_exception(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 3. Correct a branch-based data quality exception.
--    action           : 'correct_single' | 'split'
--    new_value        : corrected single location name (correct_single)
--    new_values       : array of split location names (split)
--    staff_assignments: jsonb array [{"employee_id": uuid, "branch_name": text}]
--                       ALL staff linked to the old value must be assigned.
-- ------------------------------------------------------------
create or replace function public.correct_data_quality_exception(
  p_exception_id uuid,
  p_action text,
  p_new_value text default null,
  p_new_values text[] default null,
  p_staff_assignments jsonb default null,
  p_reason text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_exc record;
  v_old text;
  v_new text;
  v_new_values text[];
  v_name text;
  v_branch_id uuid;
  v_new_branch_ids uuid[];
  v_val text;
  v_emp uuid;
  v_leftover int;
  v_assign jsonb;
begin
  if not public._org_can_manage() then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into v_exc from public.data_quality_exceptions where id = p_exception_id;
  if v_exc is null then
    return jsonb_build_object('ok', false, 'error', 'exception not found');
  end if;

  -- Only location (branch) corrections are supported for this workflow.
  if v_exc.entity_type <> 'branch' then
    return jsonb_build_object('ok', false, 'error', 'only branch-based issues can be corrected here');
  end if;

  if v_exc.status <> 'open' then
    return jsonb_build_object('ok', false, 'error', 'exception is not open');
  end if;

  v_old := v_exc.entity_ref;

  -- warm up the branch row so FK targets exist for every new name
  if p_action = 'split' then
    if p_new_values is null or array_length(p_new_values, 1) is null or array_length(p_new_values, 1) < 2 then
      return jsonb_build_object('ok', false, 'error', 'split requires at least two location names');
    end if;

    foreach v_name in array p_new_values loop
      if nullif(btrim(v_name), '') is null then
        return jsonb_build_object('ok', false, 'error', 'split location names cannot be blank');
      end if;
    end loop;

    -- distinct
    if (select count(distinct lower(btrim(x))) from unnest(p_new_values) as x) <> array_length(p_new_values, 1) then
      return jsonb_build_object('ok', false, 'error', 'split location names must be distinct');
    end if;

    v_new_values := array(select btrim(x) from unnest(p_new_values) as x);
    v_new_branch_ids := array[]::uuid[];

    foreach v_name in array v_new_values loop
      select id into v_branch_id from public.branches where branch_name = v_name limit 1;
      if v_branch_id is null then
        insert into public.branches (branch_name, branch_code, status)
        values (v_name,
                'BR-' || lpad((select count(*) + 1 from public.branches)::text, 2, '0'),
                'active')
        returning id into v_branch_id;
      end if;
      v_new_branch_ids := v_new_branch_ids || v_branch_id;
    end loop;

    -- validate staff assignments reference only allowed targets
    if p_staff_assignments is null or jsonb_typeof(p_staff_assignments) <> 'array' then
      return jsonb_build_object('ok', false, 'error', 'staff assignment is required for split');
    end if;

    for v_assign in select * from jsonb_array_elements(p_staff_assignments) loop
      v_emp := nullif(v_assign ->> 'employee_id', '')::uuid;
      v_val := nullif(btrim(coalesce(v_assign ->> 'branch_name', '')), '');
      if v_emp is null or v_val is null then
        return jsonb_build_object('ok', false, 'error', 'each staff assignment needs an employee and a target location');
      end if;
      if not exists (select 1 from unnest(v_new_values) nv(nm) where lower(nv.nm) = lower(v_val)) then
        return jsonb_build_object('ok', false, 'error', format('target "%s" is not one of the split locations', v_val));
      end if;
      if not exists (select 1 from public.employees where id = v_emp) then
        return jsonb_build_object('ok', false, 'error', format('employee %s not found', v_emp));
      end if;
    end loop;

    -- apply assignments
    for v_assign in select * from jsonb_array_elements(p_staff_assignments) loop
      v_emp := nullif(v_assign ->> 'employee_id', '')::uuid;
      v_val := btrim(coalesce(v_assign ->> 'branch_name', ''));
      select id into v_branch_id from public.branches where branch_name = v_val limit 1;
      update public.employees
      set branch = v_val, branch_id = v_branch_id, updated_at = now()
      where id = v_emp;
      update public.profiles
      set branch = v_val, updated_at = now()
      where employee_id = v_emp
         or user_id = (select e.user_id from public.employees e where e.id = v_emp);
    end loop;

    -- every staff member linked to the old location must have been moved
    select count(*) into v_leftover from public.employees where branch = v_old;
    if v_leftover > 0 then
      return jsonb_build_object('ok', false, 'error', format('%s employee(s) still linked to "%s" — assign them all before saving', v_leftover, v_old));
    end if;

    -- the combined location is dissolved (kept for history, no longer usable)
    update public.branches set status = 'inactive', updated_at = now() where branch_name = v_old;

    update public.data_quality_exceptions
    set status = 'resolved',
        resolution = jsonb_build_object(
          'action', 'split',
          'old_value', v_old,
          'new_values', (select jsonb_agg(nm order by nm) from unnest(v_new_values) as nv(nm)),
          'assigned_staff', jsonb_array_length(p_staff_assignments),
          'reason', p_reason,
          'resolved_at', now(),
          'resolved_by', v_actor
        ),
        resolved_by = v_actor,
        resolved_at = now()
    where id = p_exception_id;

    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values ('DATA_QUALITY_EXCEPTION_SPLIT', 'DataQualityException', p_exception_id::text, v_actor::text,
            format('%s -> %s (%s staff reassigned; %s)', v_old, array_to_string(v_new_values, ', '), jsonb_array_length(p_staff_assignments), coalesce(p_reason, 'split correction')), 'info');

    return jsonb_build_object('ok', true, 'branches', (select jsonb_agg(id::text) from unnest(v_new_branch_ids) id));

  elsif p_action = 'correct_single' then
    v_new := nullif(btrim(coalesce(p_new_value, '')), '');
    if v_new is null then
      return jsonb_build_object('ok', false, 'error', 'a corrected location name is required');
    end if;
    if lower(v_new) = lower(v_old) then
      return jsonb_build_object('ok', false, 'error', 'the corrected name must differ from the original');
    end if;

    -- rename every reference to the old location value
    update public.branches set branch_name = v_new, updated_at = now() where branch_name = v_old;
    update public.employees set branch = v_new, updated_at = now() where branch = v_old;
    update public.profiles set branch = v_new, updated_at = now() where branch = v_old;
    update public.employee_onboarding_links set branch = v_new where branch = v_old;
    -- submissions hold location inside the payload jsonb (no branch column)
    update public.employee_onboarding_submissions
    set payload = jsonb_set(coalesce(payload, '{}'::jsonb), '{branch}', to_jsonb(v_new))
    where payload is not null and (payload ->> 'branch') = v_old;

    update public.data_quality_exceptions
    set status = 'resolved',
        resolution = jsonb_build_object(
          'action', 'correct_single',
          'old_value', v_old,
          'new_value', v_new,
          'reason', p_reason,
          'resolved_at', now(),
          'resolved_by', v_actor
        ),
        resolved_by = v_actor,
        resolved_at = now()
    where id = p_exception_id;

    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values ('DATA_QUALITY_EXCEPTION_CORRECTED', 'DataQualityException', p_exception_id::text, v_actor::text,
            format('%s -> %s%s', v_old, v_new, coalesce(' (' || p_reason || ')', '')), 'info');

    return jsonb_build_object('ok', true);
  else
    return jsonb_build_object('ok', false, 'error', 'action must be correct_single or split');
  end if;

exception when others then
  return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;
grant execute on function public.correct_data_quality_exception(uuid, text, text, text[], jsonb, text) to authenticated;

commit;