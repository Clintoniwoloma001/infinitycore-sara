-- ============================================================
-- PHASE 18 — BRANCH HIERARCHY
--   - create_employee_manual: accept p_branch_id (FK to branches)
--   - update_employee_hr_fields allowlist: add branch_id
--   - helper RPC: resolve branch by name/code -> id (for UI + imports)
--   - backfill: populate branches + employees.branch_id from text
--     branch names so hierarchy lookups work on existing data.
--
-- ALL ADDITIVE. Idempotent (IF NOT EXISTS / OR REPLACE).
-- ============================================================

-- ------------------------------------------------------------
-- 1. update_employee_hr_fields — add branch_id to allowlist
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

-- ------------------------------------------------------------
-- 2. create_employee_manual — accept optional branch_id
-- ------------------------------------------------------------
create or replace function public.create_employee_manual(
  p_full_name text,
  p_email text default null,
  p_phone text default null,
  p_department text default null,
  p_position text default null,
  p_branch text default null,
  p_branch_id uuid default null,
  p_area text default null,
  p_employment_type text default null,
  p_employment_status text default 'active',
  p_hire_date date default null,
  p_employee_code text default null,
  p_basic_salary numeric default null,
  p_bank_name text default null,
  p_account_name text default null,
  p_account_number text default null,
  p_bank_sort_code text default null,
  p_bvn text default null,
  p_nin text default null,
  p_tax_id text default null,
  p_pension_id text default null,
  p_gender text default null,
  p_date_of_birth date default null,
  p_nationality text default null,
  p_marital_status text default null,
  p_state_of_origin text default null,
  p_lga text default null,
  p_residential_address text default null,
  p_emergency_contact_name text default null,
  p_emergency_contact_phone text default null,
  p_next_of_kin_name text default null,
  p_next_of_kin_phone text default null,
  p_next_of_kin_relationship text default null,
  p_reporting_manager_id uuid default null,
  p_work_location text default null,
  p_probation_end_date date default null,
  p_preferred_name text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_existing record;
  v_new_id uuid;
  v_branch_id uuid := p_branch_id;
  v_branch_name text := p_branch;
begin
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to create employees';
  end if;

  -- Resolve branch: prefer explicit id, else look up from name/code
  if v_branch_id is null and v_branch_name is not null then
    select id into v_branch_id from public.branches
    where branch_name = v_branch_name or branch_code = v_branch_name
    order by case when branch_name = v_branch_name then 0 else 1 end
    limit 1;
  elsif v_branch_id is not null and v_branch_name is null then
    select branch_name into v_branch_name from public.branches where id = v_branch_id;
  end if;

  -- Duplicate check: email or phone or employee_code
  if p_email is not null then
    select * into v_existing from public.employees where email = p_email limit 1;
    if v_existing.id is not null then
      return jsonb_build_object('ok', false, 'error', 'duplicate', 'existing_id', v_existing.id::text, 'message', 'An employee with this email already exists');
    end if;
  end if;

  if p_phone is not null then
    select * into v_existing from public.employees where phone = p_phone limit 1;
    if v_existing.id is not null then
      return jsonb_build_object('ok', false, 'error', 'duplicate', 'existing_id', v_existing.id::text, 'message', 'An employee with this phone number already exists');
    end if;
  end if;

  if p_employee_code is not null then
    select * into v_existing from public.employees where employee_code = p_employee_code limit 1;
    if v_existing.id is not null then
      return jsonb_build_object('ok', false, 'error', 'duplicate', 'existing_id', v_existing.id::text, 'message', 'An employee with this employee code already exists');
    end if;
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  insert into public.employees (
    full_name, email, phone, department, "position", branch, branch_id, area,
    employment_type, employment_status, hire_date, employee_code,
    basic_salary, bank_name, account_name, account_number, bank_sort_code,
    bvn, nin, tax_id, pension_id, gender, date_of_birth,
    nationality, marital_status, state_of_origin, lga, residential_address,
    emergency_contact_name, emergency_contact_phone,
    next_of_kin_name, next_of_kin_phone, next_of_kin_relationship,
    reporting_manager_id, work_location, probation_end_date,
    preferred_name, source, created_by, updated_at
  ) values (
    p_full_name, p_email, p_phone, p_department, p_position, v_branch_name, v_branch_id, p_area,
    p_employment_type, p_employment_status, p_hire_date, p_employee_code,
    p_basic_salary, p_bank_name, p_account_name, p_account_number, p_bank_sort_code,
    p_bvn, p_nin, p_tax_id, p_pension_id, p_gender, p_date_of_birth,
    p_nationality, p_marital_status, p_state_of_origin, p_lga, p_residential_address,
    p_emergency_contact_name, p_emergency_contact_phone,
    p_next_of_kin_name, p_next_of_kin_phone, p_next_of_kin_relationship,
    p_reporting_manager_id, p_work_location, p_probation_end_date,
    p_preferred_name, 'manual', auth.uid(), now()
  )
  returning id into v_new_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'EMPLOYEE_CREATED',
    'Employee',
    v_new_id::text,
    coalesce(v_actor_name, auth.uid()::text),
    format('Employee %s manually created by HR (source: manual)', p_full_name),
    'info'
  );

  return jsonb_build_object('ok', true, 'employee_id', v_new_id::text, 'branch_id', v_branch_id);
end; $$;
grant execute on function public.create_employee_manual(
  text, text, text, text, text, text, uuid, text, text, text, date, text, numeric,
  text, text, text, text, text, text, text, text, text, date, text, text, text,
  text, text, text, text, text, text, text, uuid, text, date, text
) to authenticated;

-- ------------------------------------------------------------
-- 3. Helper RPC: suggest_branch (HR/employees)
--    Fuzzy-match branch by name fragment or code.
-- ------------------------------------------------------------
create or replace function public.suggest_branches(p_query text, p_limit int default 10)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_results jsonb;
begin
  if p_query is null or length(trim(p_query)) = 0 then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'branch_name', b.branch_name, 'branch_code', b.branch_code,
      'manager_name', b.manager_name, 'location', b.location, 'status', b.status
    )), '[]'::jsonb) into v_results
    from public.branches b
    where b.status = 'active'
    order by b.branch_name
    limit greatest(p_limit, 1);
  else
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'branch_name', b.branch_name, 'branch_code', b.branch_code,
      'manager_name', b.manager_name, 'location', b.location, 'status', b.status
    )), '[]'::jsonb) into v_results
    from public.branches b
    where b.status = 'active'
      and (b.branch_name ilike '%' || p_query || '%' or b.branch_code ilike '%' || p_query || '%')
    order by b.branch_name
    limit greatest(p_limit, 1);
  end if;

  return jsonb_build_object('results', coalesce(v_results, '[]'::jsonb));
end;
$$;
grant execute on function public.suggest_branches(text, int) to authenticated;

-- ------------------------------------------------------------
-- 4. Backfill branches from existing employee text values so
--    hierarchy lookups (branch_id) work on legacy data.
--    Only creates branches for names that don't already match.
-- ------------------------------------------------------------
insert into public.branches (branch_name, status)
select distinct trim(e.branch), 'active'
from public.employees e
where e.branch is not null
  and length(trim(e.branch)) > 0
  and not exists (
    select 1 from public.branches b where b.branch_name = trim(e.branch)
  )
on conflict do nothing;

-- Backfill branch_id on employees whose branch text matches a known branch
update public.employees e
   set branch_id = b.id, updated_at = now()
  from public.branches b
 where e.branch_id is null
   and e.branch is not null
   and b.branch_name = e.branch;