-- ============================================================
-- PHASE 37: STRICT EMPLOYEE TERMINATION / FIRING AUTHORIZATION
--
-- Enforcement target (NON-NEGOTIABLE):
--   ONLY the InfinityCore RBAC roles `super_admin` and `hr_manager`
--   may terminate/fire an employee. The inspection below shows the
--   pre-existing permissions that had to be closed:
--
--     * `update_employee_hr_fields` allowed `admin` and `hr_officer`
--       to set employment_status = 'terminated'
--     * the `employees_update` RLS policy allowed `admin` to update
--       the employees row directly (including to 'terminated')
--
-- This migration:
--   1. Adds termination / archive columns to employees.
--   2. Adds immutable, history-preserving tables:
--        - employee_employment_history      (every status transition)
--        - employee_termination_records     (canonical termination record)
--   3. Adds ONE canonical authorization function:
--        public.can_terminate_employee()
--      (true ONLY when current_role() = super_admin OR hr_manager)
--   4. Adds `terminate_employee` SECURITY DEFINER RPC.
--      Actor identity/role are derived from the auth session ONLY.
--      The LLM/browser can NEVER supply actor_user_id/actor_role/
--      authorization flags. Function body is atomic (single txn).
--   5. Adds `archive_employee` SECURITY DEFINER RPC (same restricted
--      roles) — archive is a sensitive lifecycle action and inherits
--      the SAME authorization rule.
--   6. Closes every other termination write path:
--        - a BEFORE UPDATE guard trigger rejects any size change of the
--          termination/archive fields by non-super_admin/hr_manager
--          (covers direct RLS writes AND RPCs),
--        - update_employee_hr_fields is patched so only the authorized
--          roles can set employment_status = 'terminated',
--        - a BEFORE DELETE guard trigger makes physical employee
--          deletion impossible for authenticated roles (service_role
--          only), so termination is NEVER a delete and history always
--          survives.
--
-- Idempotent and additive — safe to re-run in Supabase SQL Editor.
-- ============================================================

-- ============================================================
-- 1. EMPLOYEES — termination / archive columns (additive)
-- ============================================================
alter table public.employees
  add column if not exists terminated_at timestamptz,
  add column if not exists termination_effective_date date,
  add column if not exists termination_reason text,
  add column if not exists termination_hr_notes text,
  add column if not exists rehire_eligible boolean default true,
  add column if not exists previous_employment_status text,
  add column if not exists is_archived boolean default false,
  add column if not exists archived_at timestamptz,
  add column if not exists archive_reason text,
  add column if not exists archive_actor uuid references auth.users(id) on delete set null;

create index if not exists idx_employees_terminated_at on public.employees(terminated_at);
create index if not exists idx_employees_is_archived on public.employees(is_archived);
create index if not exists idx_employees_employment_status on public.employees(employment_status);

-- ============================================================
-- 2. CANONICAL AUTHORIZATION FUNCTIONS
--    canTerminateEmployee(userId) == current_role() in
--                   ('super_admin', 'hr_manager')
-- ============================================================
create or replace function public.can_terminate_employee()
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_role() in ('super_admin', 'hr_manager');
$$;

-- Archive is a sensitive employee-lifecycle action, so it inherits the
-- SAME restricted authorization as termination.
create or replace function public.can_archive_employee()
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_role() in ('super_admin', 'hr_manager');
$$;

grant execute on function public.can_terminate_employee() to authenticated;
grant execute on function public.can_archive_employee() to authenticated;

-- ============================================================
-- 3. HISTORY-PRESERVING TABLES
--
-- Physical delete is blocked (see guard trigger), so every row here is
-- permanent. `on delete restrict` adds a second belt-and-braces guard
-- against any service-side delete of an employee with lifecycle history.
-- ============================================================
create table if not exists public.employee_employment_history (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  previous_status text,
  new_status text not null,
  changed_by uuid references auth.users(id) on delete set null,
  actor_role text,
  reason text,
  source text default 'ui',
  created_at timestamptz default now()
);

create table if not exists public.employee_termination_records (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  employee_name text,
  employee_code text,
  staff_id text,
  department text,
  position text,
  branch text,
  hire_date date,
  previous_employment_status text,
  new_employment_status text default 'terminated',
  termination_effective_date date not null,
  termination_reason text not null,
  hr_notes text,
  rehire_eligible boolean default true,
  actor_user_id uuid not null references auth.users(id) on delete set null,
  actor_role text not null,
  actor_name text,
  source text default 'ui',
  created_at timestamptz default now()
);

alter table public.employee_employment_history enable row level security;
alter table public.employee_termination_records enable row level security;

-- HR/Admin/ops can read history; an employee can read their own.
drop policy if exists "employee_history_read" on public.employee_employment_history;
create policy "employee_history_read"
  on public.employee_employment_history
  for select using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
    or employee_id in (select id from public.employees where user_id = auth.uid())
  );

drop policy if exists "termination_records_read" on public.employee_termination_records;
create policy "termination_records_read"
  on public.employee_termination_records
  for select using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
    or employee_id in (select id from public.employees where user_id = auth.uid())
  );

-- No INSERT/UPDATE/DELETE policies: writes happen ONLY inside the
-- SECURITY DEFINER RPCs below, which re-verify the actor role.

-- ============================================================
-- 4. terminate_employee RPC  (SUPER_ADMIN / HR_MANAGER ONLY)
--
-- Security hierarchy enforced inside this one atomic function:
--   authenticated session (auth.uid)
--     -> InfinityCore profile (public.current_role)
--       -> role is exactly 'super_admin' OR 'hr_manager'
--         -> employee update + history + audit
--
-- NO actor parameters are accepted. The actor is ALWAYS derived from
-- the session. The LLM / browser / API can never claim authorization.
-- ============================================================
create or replace function public.terminate_employee(
  p_employee_id uuid,
  p_effective_date date default current_date,
  p_reason text default '',
  p_hr_notes text default null,
  p_rehire_eligible boolean default true,
  p_source text default 'ui'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_emp record;
begin
  if v_actor_id is null then
    raise exception 'Not authenticated';
  end if;

  if v_actor_role not in ('super_admin', 'hr_manager') then
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'employee_termination_denied', 'Employee', p_employee_id::text,
      coalesce((select full_name from public.profiles where id = v_actor_id), 'user'),
      format('Termination attempt blocked: role %s is not authorized to terminate employees.', v_actor_role),
      'high'
    );
    raise exception 'Your role is not authorized to terminate employees.';
  end if;

  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then
    raise exception 'Employee not found.';
  end if;
  if v_emp.employment_status = 'terminated' then
    raise exception 'Employee is already terminated.';
  end if;
  if p_effective_date is null then
    raise exception 'A termination effective date is required.';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'A termination reason is required.';
  end if;
  if p_effective_date < coalesce(v_emp.hire_date, p_effective_date) then
    raise exception 'Termination effective date cannot precede the hire date.';
  end if;

  select full_name into v_actor_name from public.profiles where id = v_actor_id;

  -- Preserve the previous employment status for audit + history.
  insert into public.employee_employment_history (
    employee_id, previous_status, new_status, changed_by, actor_role, reason, source
  ) values (
    v_emp.id, v_emp.employment_status, 'terminated', v_actor_id, v_actor_role, p_reason,
    coalesce(nullif(p_source, ''), 'ui')
  );

  update public.employees set
    employment_status = 'terminated',
    previous_employment_status = v_emp.employment_status,
    terminated_at = now(),
    termination_effective_date = p_effective_date,
    termination_reason = p_reason,
    termination_hr_notes = p_hr_notes,
    rehire_eligible = coalesce(p_rehire_eligible, true),
    updated_at = now()
  where id = v_emp.id;

  insert into public.employee_termination_records (
    employee_id, employee_name, employee_code, staff_id, department, position,
    branch, hire_date, previous_employment_status, new_employment_status,
    termination_effective_date, termination_reason, hr_notes, rehire_eligible,
    actor_user_id, actor_role, actor_name, source
  ) values (
    v_emp.id, v_emp.full_name, coalesce(v_emp.employee_code, v_emp.employee_number),
    v_emp.staff_id, v_emp.department, v_emp.position, v_emp.branch, v_emp.hire_date,
    v_emp.employment_status, 'terminated', p_effective_date, p_reason, p_hr_notes,
    coalesce(p_rehire_eligible, true), v_actor_id, v_actor_role, v_actor_name,
    coalesce(nullif(p_source, ''), 'ui')
  );

  -- Immutable audit record. Actor selection is handled here, never by
  -- the caller, so the actor role is always trustworthy.
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'employee_terminated', 'Employee', v_emp.id::text, v_actor_name,
    jsonb_build_object(
      'actor_user_id', v_actor_id,
      'actor_role', v_actor_role,
      'actor_name', v_actor_name,
      'employee_id', v_emp.id,
      'employee_name', v_emp.full_name,
      'previous_employment_status', v_emp.employment_status,
      'new_employment_status', 'terminated',
      'termination_effective_date', p_effective_date,
      'termination_reason', p_reason,
      'hr_notes', p_hr_notes,
      'rehire_eligible', coalesce(p_rehire_eligible, true),
      'source', coalesce(nullif(p_source, ''), 'ui')
    )::text,
    'high'
  );

  return jsonb_build_object(
    'ok', true,
    'employee_id', v_emp.id,
    'employee_name', v_emp.full_name,
    'previous_employment_status', v_emp.employment_status,
    'new_employment_status', 'terminated',
    'termination_effective_date', p_effective_date,
    'actor_role', v_actor_role
  );
end; $$;

grant execute on function public.terminate_employee(uuid, date, text, text, boolean, text) to authenticated;

-- ============================================================
-- 5. archive_employee RPC  (SUPER_ADMIN / HR_MANAGER ONLY)
--
-- Archive hides/inactivates the employee while preserving full
-- history. Share the SAME restricted authorization as termination.
-- p_restore = true brings an archived employee back.
-- ============================================================
create or replace function public.archive_employee(
  p_employee_id uuid,
  p_reason text default '',
  p_restore boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_emp record;
begin
  if v_actor_id is null then
    raise exception 'Not authenticated';
  end if;

  if v_actor_role not in ('super_admin', 'hr_manager') then
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'employee_archive_denied', 'Employee', p_employee_id::text,
      coalesce((select full_name from public.profiles where id = v_actor_id), 'user'),
      format('Archive attempt blocked: role %s is not authorized to archive employees.', v_actor_role),
      'high'
    );
    raise exception 'Your role is not authorized to archive employees.';
  end if;

  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then
    raise exception 'Employee not found.';
  end if;

  select full_name into v_actor_name from public.profiles where id = v_actor_id;

  if p_restore then
    if not coalesce(v_emp.is_archived, false) then
      raise exception 'Employee is not archived.';
    end if;
    update public.employees set
      is_archived = false,
      archived_at = null,
      archive_reason = null,
      archive_actor = null,
      updated_at = now()
    where id = v_emp.id;
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'employee_restored_from_archive', 'Employee', v_emp.id::text, v_actor_name,
      jsonb_build_object('actor_user_id', v_actor_id, 'actor_role', v_actor_role,
                         'employee_name', v_emp.full_name)::text,
      'info'
    );
    return jsonb_build_object('ok', true, 'employee_id', v_emp.id, 'employee_name', v_emp.full_name, 'restored', true);
  end if;

  update public.employees set
    is_archived = true,
    archived_at = now(),
    archive_reason = p_reason,
    archive_actor = v_actor_id,
    updated_at = now()
  where id = v_emp.id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'employee_archived', 'Employee', v_emp.id::text, v_actor_name,
    jsonb_build_object('actor_user_id', v_actor_id, 'actor_role', v_actor_role,
                       'employee_name', v_emp.full_name, 'archive_reason', p_reason)::text,
    'warning'
  );

  return jsonb_build_object('ok', true, 'employee_id', v_emp.id, 'employee_name', v_emp.full_name, 'archived', true, 'actor_role', v_actor_role);
end; $$;

grant execute on function public.archive_employee(uuid, text, boolean) to authenticated;

-- ============================================================
-- 6. HARD GUARD TRIGGER on employees
--
-- Any write that moves an employee towards termination/archive is
-- rejected unless the authenticated actor is super_admin or
-- hr_manager. This covers direct RLS updates, the HR-fields RPC, and
-- every other future write path — a SINGLE authoritative gate.
-- ============================================================
create or replace function public.employees_termination_guard()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
begin
  if (new.employment_status = 'terminated' and old.employment_status is distinct from 'terminated')
     or (new.terminated_at is distinct from old.terminated_at)
     or (new.termination_effective_date is distinct from old.termination_effective_date)
     or (new.termination_reason is distinct from old.termination_reason)
     or (new.termination_hr_notes is distinct from old.termination_hr_notes)
     or (new.previous_employment_status is distinct from old.previous_employment_status)
     or (new.rehire_eligible is distinct from old.rehire_eligible)
     or (new.is_archived is distinct from old.is_archived)
     or (new.archived_at is distinct from old.archived_at)
     or (new.archive_reason is distinct from old.archive_reason)
     or (new.archive_actor is distinct from old.archive_actor)
  then
    if v_actor_role not in ('super_admin', 'hr_manager') then
      raise exception 'Your role is not authorized to terminate employees.';
    end if;
  end if;
  return new;
end; $$;

drop trigger if exists employees_termination_guard on public.employees;
create trigger employees_termination_guard
  before update on public.employees
  for each row execute function public.employees_termination_guard();

-- ============================================================
-- 7. PHYSICAL DELETE GUARD
--
-- Termination / archive are soft lifecycle operations. Physical
-- deletion of an employee is blocked for every authenticated role.
-- Only internal service-role cleanup may ever remove a row (and any
-- employee with termination/history is additionally protected by the
-- `on delete restrict` foreign keys above).
-- ============================================================
create or replace function public.employees_hard_delete_guard()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Employee records cannot be physically deleted. Use terminate_employee or archive_employee instead.';
  end if;
  return old;
end; $$;

drop trigger if exists employees_hard_delete_guard on public.employees;
create trigger employees_hard_delete_guard
  before delete on public.employees
  for each row execute function public.employees_hard_delete_guard();

-- ============================================================
-- 8. CLOSE THE update_employee_hr_fields BYPASS
--
-- The pre-existing RPC allowed admin / hr_officer to set
-- employment_status = 'terminated'. That write path is the very
-- bypass this migration exists to close. Only super_admin and
-- hr_manager may use that RPC to move an employee to 'terminated'.
-- ============================================================
create or replace function public.update_employee_hr_fields(
  p_employee_id uuid,
  p_fields jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_emp record;
  v_patch jsonb := '{}'::jsonb;
  v_allowed text[] := array[
    'full_name', 'email', 'phone', 'department', 'position',
    'employment_status', 'employment_type', 'hire_date',
    'salary', 'basic_salary', 'allowances', 'branch',
    'branch_manager_name', 'area_manager_name',
    'bank_name', 'account_number', 'account_name', 'bank_sort_code',
    'bvn', 'nin', 'pension_id', 'tax_id', 'nhf_id',
    'employee_code', 'manager_id', 'reporting_manager_id',
    'probation_end_date', 'work_location', 'area',
    'date_of_birth', 'sex', 'state_of_origin', 'lga', 'town',
    'residential_address', 'religion', 'denomination', 'nationality',
    'marital_status', 'spouse_name', 'spouse_occupation', 'spouse_age',
    'spouse_business_address', 'spouse_email', 'spouse_phone',
    'living_with_spouse', 'number_of_children', 'children_age_range',
    'next_of_kin_name', 'next_of_kin_relationship', 'next_of_kin_phone', 'next_of_kin_address',
    'beneficiary_name', 'beneficiary_relationship', 'beneficiary_phone', 'beneficiary_address',
    'emergency_contact_name', 'emergency_contact_phone',
    'preferred_name', 'gender', 'hmo'
  ];
  k text;
begin
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized to update employee fields';
  end if;

  -- STRICT TERMINATION GATE: setting the status to 'terminated' (the
  -- canonical firing transition) is reserved for super_admin/hr_manager.
  if p_fields ? 'employment_status'
     and p_fields ->> 'employment_status' = 'terminated'
     and v_actor_role not in ('super_admin', 'hr_manager') then
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'employee_termination_denied', 'Employee', p_employee_id::text,
      coalesce((select full_name from public.profiles where id = auth.uid()), 'user'),
      format('Termination attempt blocked via HR update path: role %s is not authorized to terminate employees.', v_actor_role),
      'high'
    );
    raise exception 'Your role is not authorized to terminate employees.';
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();
  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then
    raise exception 'Employee not found.';
  end if;

  -- Build safe patch from only allowed keys
  for k in select jsonb_object_keys(p_fields)
  loop
    if k = any(v_allowed) then
      v_patch := v_patch || jsonb_build_object(k, p_fields -> k);
    end if;
  end loop;

  -- Keep the printed staff identity in sync with the employee code so the
  -- ID card always shows the latest code (the card reads employee_number first).
  if v_patch ? 'employee_code' and nullif(v_patch ->> 'employee_code', '') is not null then
    v_patch := v_patch
      || jsonb_build_object('staff_id', v_patch ->> 'employee_code')
      || jsonb_build_object('employee_number', v_patch ->> 'employee_code');
  end if;

  if v_patch = '{}'::jsonb then
    raise exception 'No valid fields provided.';
  end if;

  -- Add updated_at
  v_patch := v_patch || jsonb_build_object('updated_at', now()::text);

  -- Execute the update (nullif converts empty strings to NULL so date/numeric
  -- columns never see an invalid cast like ''::date or ''::numeric, and each
  -- value is cast to the target column's type so text input works for
  -- timestamps/dates/numerics alike).
  execute format(
    'UPDATE public.employees SET %s WHERE id = $1 RETURNING id',
    (select string_agg(
       format('%I = nullif(($2->>''%s'')::text, '''')::%s', key, key,
         coalesce((select quote_ident(t.typname)
                    from pg_catalog.pg_attribute a
                    join pg_catalog.pg_type t on t.oid = a.atttypid
                    where a.attrelid = 'public.employees'::regclass
                      and a.attname = key and not a.attisdropped), 'text')),
       ', ')
     from jsonb_object_keys(v_patch) key)
  )
  using p_employee_id, v_patch;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('EMPLOYEE_HR_FIELDS_UPDATED', 'Employee', p_employee_id::text, v_actor_name,
          format('HR fields updated for %s: %s', v_emp.full_name,
                 (select string_agg(key, ', ') from jsonb_object_keys(v_patch) key)), 'info');

  return jsonb_build_object('ok', true, 'fields_updated', v_patch);
end; $$;

grant execute on function public.update_employee_hr_fields(uuid, jsonb) to authenticated;

-- ============================================================
-- 9. DEPLOY NOTES
--
-- Run this file in the Supabase SQL Editor (idempotent, safe to re-run).
-- After applying, the SARA edge function can be redeployed with:
--   supabase functions deploy sara-intent
-- No client-side secret is introduced anywhere in this migration.
-- ============================================================