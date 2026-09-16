-- ============================================================
-- Phase 23: ID Card Config Sync (additive, idempotent)
--
-- Fixes a critical sync bug: HR edits to an employee's staff ID
-- card (issued by / issue date / status / expiry) in the Employee
-- section were not reflected in the employee's own "My Staff ID
-- Card" view or shared card values across the platform.
--
-- Root causes fixed here (server side):
--   1. update_employee_hr_fields allowlist lacked `staff_id_issued_at`,
--      so Issue Date edits were silently rejected server-side.
--   (Frontend side — EmployeeProfile/Profile — now also sends and
--   reads all four card fields; see code changes.)
--
-- ALL ADDITIVE. Idempotent (OR REPLACE).
-- ============================================================

-- ------------------------------------------------------------
-- 1. update_employee_hr_fields — allow staff_id_issued_at
--    (keeps the full Phase 18 allowlist incl. branch_id)
-- ------------------------------------------------------------
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
    'job_title', 'employment_status', 'employment_type', 'hire_date',
    'confirmation_date', 'probation_end_date',
    'salary', 'basic_salary', 'allowances', 'branch', 'branch_id',
    'branch_manager_name', 'area_manager_name',
    'bank_name', 'account_number', 'account_name', 'bank_sort_code',
    'bvn', 'nin', 'pension_id', 'tax_id', 'nhf_id',
    'employee_code', 'employee_number', 'staff_id',
    'staff_id_expiry', 'staff_id_issued_by', 'staff_id_status',
    'staff_id_issued_at',
    'manager_id', 'reporting_manager_id',
    'work_location', 'area',
    'date_of_birth', 'sex', 'gender', 'state_of_origin', 'lga', 'town', 'town_city',
    'residential_address', 'religion', 'denomination', 'nationality',
    'marital_status', 'spouse_name', 'spouse_occupation', 'spouse_age',
    'spouse_business_address', 'spouse_email', 'spouse_phone',
    'living_with_spouse', 'number_of_children', 'children_age_range',
    'next_of_kin_name', 'next_of_kin_relationship', 'next_of_kin_phone', 'next_of_kin_address',
    'beneficiary_name', 'beneficiary_relationship', 'beneficiary_phone', 'beneficiary_address',
    'emergency_contact_name', 'emergency_contact_phone',
    'preferred_name', 'hmo', 'signature_url'
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
-- DONE.
-- ============================================================