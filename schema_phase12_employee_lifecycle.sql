-- ============================================================
-- Phase 12: Employee Lifecycle — field-protected updates
--
-- Adds missing employee columns and two RPCs:
--   1. update_employee_hr_fields  — HR-only field protection
--   2. update_profile_personal    — self-service personal info
--
-- Idempotent: safe to re-run.
-- ============================================================

-- 1. Add missing employee columns (HR-controlled fields)
alter table public.employees
  add column if not exists allowances numeric(12,2) default 0,
  add column if not exists hmo text,
  add column if not exists branch_manager_name text,
  add column if not exists area_manager_name text;

-- ============================================================
-- 2. RPC: update_employee_hr_fields (HR/Admin only)
--
-- Restricts which fields can be updated to a safe allowlist of
-- HR-controlled employment fields. Rejects attempts to update
-- non-listed fields. Runs as SECURITY DEFINER so RLS alone
-- is not the only gate.
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
-- 3. RPC: update_profile_personal (Authenticated users)
--
-- Allows any authenticated user to update their OWN profile
-- row with a strict allowlist of personal contact fields.
-- Cannot change: employee_id, department, salary, role, status,
-- guarantor, HMO, allowances, branch, or any employment field.
-- ============================================================
create or replace function public.update_profile_personal(
  p_fields jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_patch jsonb := '{}'::jsonb;
  v_allowed text[] := array[
    'full_name', 'email', 'phone',
    'residential_address', 'town', 'lga', 'state_of_origin',
    'emergency_contact_name', 'emergency_contact_phone',
    'date_of_birth', 'sex', 'religion', 'denomination',
    'nationality', 'marital_status',
    'spouse_name', 'spouse_occupation', 'spouse_phone', 'spouse_email'
  ];
  k text;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  for k in select jsonb_object_keys(p_fields)
  loop
    if k = any(v_allowed) then
      v_patch := v_patch || jsonb_build_object(k, p_fields -> k);
    end if;
  end loop;

  if v_patch = '{}'::jsonb then
    raise exception 'No valid fields provided.';
  end if;

  -- Also update the profiles table if full_name or email changed
  if v_patch ? 'full_name' or v_patch ? 'email' then
    update public.profiles set
      full_name = coalesce(v_patch ->> 'full_name', full_name),
      email = coalesce(v_patch ->> 'email', email)
    where id = v_user_id;
  end if;

  -- Update the employees table if user has an employee record
  update public.employees set
    full_name = coalesce(v_patch ->> 'full_name', full_name),
    email = coalesce(v_patch ->> 'email', email),
    phone = coalesce(v_patch ->> 'phone', phone),
    residential_address = coalesce(v_patch ->> 'residential_address', residential_address),
    town = coalesce(v_patch ->> 'town', town),
    lga = coalesce(v_patch ->> 'lga', lga),
    state_of_origin = coalesce(v_patch ->> 'state_of_origin', state_of_origin),
    emergency_contact_name = coalesce(v_patch ->> 'emergency_contact_name', emergency_contact_name),
    emergency_contact_phone = coalesce(v_patch ->> 'emergency_contact_phone', emergency_contact_phone),
    date_of_birth = coalesce(nullif(v_patch ->> 'date_of_birth', '')::date, date_of_birth),
    sex = coalesce(v_patch ->> 'sex', sex),
    religion = coalesce(v_patch ->> 'religion', religion),
    denomination = coalesce(v_patch ->> 'denomination', denomination),
    nationality = coalesce(v_patch ->> 'nationality', nationality),
    marital_status = coalesce(v_patch ->> 'marital_status', marital_status),
    spouse_name = coalesce(v_patch ->> 'spouse_name', spouse_name),
    spouse_occupation = coalesce(v_patch ->> 'spouse_occupation', spouse_occupation),
    spouse_phone = coalesce(v_patch ->> 'spouse_phone', spouse_phone),
    spouse_email = coalesce(v_patch ->> 'spouse_email', spouse_email),
    updated_at = now()
  where user_id = v_user_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('PROFILE_PERSONAL_UPDATED', 'Profile', v_user_id::text,
          coalesce((select full_name from public.profiles where id = v_user_id), 'user'),
          format('Personal profile fields updated: %s',
                 (select string_agg(key, ', ') from jsonb_object_keys(v_patch) key)), 'info');

  return jsonb_build_object('ok', true, 'fields_updated', v_patch);
end; $$;

grant execute on function public.update_profile_personal(jsonb) to authenticated;
