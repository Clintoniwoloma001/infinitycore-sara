-- ============================================================
-- Phase — HR Organisation module UX updates
-- Run in Supabase SQL Editor after 20260921000010.
-- Idempotent/additive (begin / commit).
--
-- Adds write policies and SECURITY DEFINER RPCs so the HR Organisation
-- page can manage supervisor mappings, resolve hierarchy/data-quality
-- exceptions, and maintain the department master interactively.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. HELPER: management-role check reused by all write RPCs
-- ------------------------------------------------------------
create or replace function public._org_can_manage()
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.current_role() in ('super_admin', 'admin', 'head_of_human_resources')
$$;

-- ------------------------------------------------------------
-- 2. RLS WRITE POLICIES for the org tables
--    Reads remain wide open (phase26_read_all). Writes are limited
--    to the same HR management trio used elsewhere.
-- ------------------------------------------------------------

-- employee_supervisors
alter table public.employee_supervisors enable row level security;
drop policy if exists "employee_supervisors_write" on public.employee_supervisors;
create policy "employee_supervisors_write"
  on public.employee_supervisors
  for all
  to authenticated
  using (public._org_can_manage())
  with check (public._org_can_manage());

-- hierarchy_exceptions
alter table public.hierarchy_exceptions enable row level security;
drop policy if exists "hierarchy_exceptions_write" on public.hierarchy_exceptions;
create policy "hierarchy_exceptions_write"
  on public.hierarchy_exceptions
  for all
  to authenticated
  using (public._org_can_manage())
  with check (public._org_can_manage());

-- data_quality_exceptions
alter table public.data_quality_exceptions enable row level security;
drop policy if exists "data_quality_exceptions_write" on public.data_quality_exceptions;
create policy "data_quality_exceptions_write"
  on public.data_quality_exceptions
  for all
  to authenticated
  using (public._org_can_manage())
  with check (public._org_can_manage());

-- departments
alter table public.departments enable row level security;
drop policy if exists "departments_write" on public.departments;
create policy "departments_write"
  on public.departments
  for all
  to authenticated
  using (public._org_can_manage())
  with check (public._org_can_manage());

-- ------------------------------------------------------------
-- 3. RPCs — SUPERVISOR MAPPINGS
-- ------------------------------------------------------------

-- Upsert a supervisor line for an employee. Maintains the unique
-- (employee_id, supervisor_employee_id, level) constraint.
create or replace function public.upsert_employee_supervisor(
  p_employee_id uuid,
  p_supervisor_employee_id uuid,
  p_level int default 1,
  p_supervisor_title text default null,
  p_source text default 'hr_organisation'
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_title text;
begin
  if not public._org_can_manage() then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  if p_level not between 1 and 3 then
    return jsonb_build_object('ok', false, 'error', 'level must be 1, 2 or 3');
  end if;

  if p_employee_id = p_supervisor_employee_id then
    return jsonb_build_object('ok', false, 'error', 'employee cannot supervise themselves');
  end if;

  v_title := coalesce(p_supervisor_title, (select position from public.employees where id = p_supervisor_employee_id));

  insert into public.employee_supervisors (
    employee_id, supervisor_employee_id, level, supervisor_title, source, created_at
  ) values (
    p_employee_id, p_supervisor_employee_id, p_level, v_title, p_source, now()
  )
  on conflict (employee_id, supervisor_employee_id, level)
  do update set
    supervisor_title = excluded.supervisor_title,
    source = excluded.source;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('EMPLOYEE_SUPERVISOR_UPDATED', 'EmployeeSupervisor', p_employee_id::text, v_actor::text,
          format('Supervisor (id=%s, title=%s) mapped at level %s', p_supervisor_employee_id, coalesce(v_title, '?'), p_level), 'info');

  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.upsert_employee_supervisor(uuid, uuid, int, text, text) to authenticated;

-- Delete a supervisor mapping by id.
create or replace function public.delete_employee_supervisor(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_emp uuid;
  v_sup uuid;
  v_level int;
begin
  if not public._org_can_manage() then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  select employee_id, supervisor_employee_id, level
  into v_emp, v_sup, v_level
  from public.employee_supervisors where id = p_id;

  if v_emp is null then
    return jsonb_build_object('ok', false, 'error', 'supervisor mapping not found');
  end if;

  delete from public.employee_supervisors where id = p_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('EMPLOYEE_SUPERVISOR_DELETED', 'EmployeeSupervisor', v_emp::text, v_actor::text,
          format('Supervisor (id=%s) at level %s removed', v_sup, v_level), 'info');

  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.delete_employee_supervisor(uuid) to authenticated;

-- ------------------------------------------------------------
-- 4. RPCs — HIERARCHY / DATA QUALITY EXCEPTION RESOLUTION
-- ------------------------------------------------------------

create or replace function public.resolve_hierarchy_exception(
  p_exception_id uuid,
  p_resolution text default 'resolved', -- 'resolved' | 'dismissed'
  p_supervisor_employee_id uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_exc record;
begin
  if not public._org_can_manage() then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into v_exc from public.hierarchy_exceptions where id = p_exception_id;
  if v_exc is null then
    return jsonb_build_object('ok', false, 'error', 'exception not found');
  end if;

  if p_resolution not in ('resolved', 'dismissed') then
    return jsonb_build_object('ok', false, 'error', 'resolution must be resolved or dismissed');
  end if;

  update public.hierarchy_exceptions
  set status = p_resolution,
      resolution = jsonb_build_object('supervisor_employee_id', p_supervisor_employee_id, 'resolved_by', v_actor, 'resolved_at', now()),
      resolved_by = v_actor,
      resolved_at = now()
  where id = p_exception_id;

  -- If a supervisor was supplied, also materialise the mapping so the
  -- resolved exception actually fixes the hierarchy gap.
  if p_supervisor_employee_id is not null and v_exc.employee_id is not null then
    insert into public.employee_supervisors (
      employee_id, supervisor_employee_id, level, supervisor_title, source
    ) values (
      v_exc.employee_id,
      p_supervisor_employee_id,
      coalesce(v_exc.level, 1),
      (select position from public.employees where id = p_supervisor_employee_id),
      'hierarchy_exception_resolution'
    )
    on conflict (employee_id, supervisor_employee_id, level) do update set
      supervisor_title = excluded.supervisor_title,
      source = excluded.source;
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('HIERARCHY_EXCEPTION_RESOLVED', 'HierarchyException', p_exception_id::text, v_actor::text,
          format('Exception %s for employee %s (supervisor %s)', p_resolution, coalesce(v_exc.employee_id::text, '?'), coalesce(p_supervisor_employee_id::text, 'none')), 'info');

  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.resolve_hierarchy_exception(uuid, text, uuid) to authenticated;

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
  set status = p_resolution
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
-- 5. RPCs — DEPARTMENT MASTER
-- ------------------------------------------------------------

create or replace function public.upsert_department(
  p_code text,
  p_name text,
  p_sort_order int default 0,
  p_id uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_id uuid;
  v_code text := upper(trim(p_code));
  v_name text := trim(p_name);
begin
  if not public._org_can_manage() then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  if v_code = '' then
    return jsonb_build_object('ok', false, 'error', 'department code is required');
  end if;
  if v_name = '' then
    return jsonb_build_object('ok', false, 'error', 'department name is required');
  end if;

  if p_id is not null then
    update public.departments
    set code = v_code, name = v_name, sort_order = p_sort_order
    where id = p_id
    returning id into v_id;
  end if;

  if v_id is null then
    insert into public.departments (code, name, sort_order)
    values (v_code, v_name, p_sort_order)
    on conflict (code) do update set
      name = excluded.name,
      sort_order = excluded.sort_order
    returning id into v_id;
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('DEPARTMENT_UPSERTED', 'Department', v_id::text, v_actor::text,
          format('Department %s (%s) — sort %s', v_name, v_code, p_sort_order), 'info');

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;
grant execute on function public.upsert_department(text, text, int, uuid) to authenticated;

create or replace function public.delete_department(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_count int;
begin
  if not public._org_can_manage() then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  select count(*) into v_count from public.employees where department = (select name from public.departments where id = p_id);
  if v_count > 0 then
    return jsonb_build_object('ok', false, 'error', format('department has %s employee(s) — reassign them first', v_count));
  end if;

  delete from public.departments where id = p_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'department not found');
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('DEPARTMENT_DELETED', 'Department', p_id::text, v_actor::text, 'Department deleted', 'info');

  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.delete_department(uuid) to authenticated;

create or replace function public.assign_employee_department(
  p_employee_id uuid,
  p_department_name text,
  p_reason text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_old text;
  v_dept text := trim(p_department_name);
begin
  if not public._org_can_manage() then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  if v_dept = '' then
    return jsonb_build_object('ok', false, 'error', 'department name is required');
  end if;

  select department into v_old from public.employees where id = p_employee_id;
  if v_old is null then
    return jsonb_build_object('ok', false, 'error', 'employee not found');
  end if;

  update public.employees
  set department = v_dept, updated_at = now()
  where id = p_employee_id;

  update public.profiles
  set department = v_dept, updated_at = now()
  where employee_id = p_employee_id and department is distinct from v_dept;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('EMPLOYEE_DEPARTMENT_ASSIGNED', 'Employee', p_employee_id::text, v_actor::text,
          format('Department changed %s -> %s%s', coalesce(v_old, 'none'), v_dept, coalesce(', reason: ' || p_reason, '')), 'info');

  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.assign_employee_department(uuid, text, text) to authenticated;

commit;
