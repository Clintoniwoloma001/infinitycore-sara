-- ============================================================
-- PHASE 14 — HR DOCUMENT FIXES + STAFF IDENTITY NORMALIZATION
--   • Staff ID card columns (expiry / issued by / status)
--   • Employee Number normalized to official IMFB/<n> format
--     (replaces page-13 IB-EMP-#####; idempotently converts legacy)
--   • update_employee_hr_fields allowlist extended (employee_number,
--     staff_id, staff_id_expiry…) so HR can save ID card settings
--   • profiles read-all RLS for HR (fixes User Management showing 0)
--   • attendance_devices ensured (fixes Attendance Terminal table error)
--     + one default terminal device seeded only when table is empty.
-- Idempotent + additive — safe to re-run against current DB.
-- ============================================================

-- ============================================================
-- 1. STAFF ID CARD COLUMNS
-- ============================================================
alter table public.employees add column if not exists staff_id_expiry date;
alter table public.employees add column if not exists staff_id_issued_by text;
alter table public.employees add column if not exists staff_id_status text default 'active';

-- ============================================================
-- 2. EMPLOYEE NUMBER → OFFICIAL IMFB/<n> FORMAT
-- ============================================================

-- Convert legacy IB-EMP-##### numbers to IMFB/<n>.
-- New numbers are sequenced AFTER any existing IMFB/ numbers so the
-- unique index is never violated. Only untouched legacy rows are moved.
with legacy as (
  select id, employee_number
  from public.employees
  where employee_number is not null
    and employee_number like 'IB-EMP-%'
    and id not in (
      select id from public.employees
      where staff_id ~ '^IMFB/' or employee_code ~ '^IMFB/'
    )
),
numbered as (
  select
    l.id,
    l.employee_number,
    'IMFB/' || (base.max_seq + row_number() over (order by l.employee_number))::text as new_number
  from legacy l
  cross join (
    select coalesce(max(e2.ord), 0) as max_seq
    from (
      select regexp_replace(employee_number, '^IMFB/', '')::int as ord
      from public.employees
      where employee_number ~ '^IMFB/\d+$'
    ) e2
  ) base
)
update public.employees e
set
  employee_number = n.new_number,
  staff_id = n.new_number,
  employee_code = case when e.employee_code = n.employee_number then n.new_number else coalesce(e.employee_code, n.new_number) end,
  updated_at = now()
from numbered n
where e.id = n.id;

-- RPC: generate_employee_number — assigns IMFB/<n> (official format).
create or replace function public.generate_employee_number(p_employee_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_emp public.employees;
  v_actor_role text := public.current_role();
  v_next int;
  v_code text;
  v_actor_name text;
begin
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    select * into v_emp from public.employees where id = p_employee_id;
    if v_emp.id is null or v_emp.user_id is distinct from auth.uid() then
      raise exception 'Not authorized to assign staff ID';
    end if;
  end if;

  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then
    raise exception 'Employee not found';
  end if;

  -- Idempotent — return existing assignment
  if v_emp.employee_number is not null then
    return jsonb_build_object(
      'ok', true,
      'exists', true,
      'employee_number', v_emp.employee_number,
      'staff_id', coalesce(v_emp.staff_id, v_emp.employee_number)
    );
  end if;

  select count(*) into v_next from public.employees where employee_number is not null;

  loop
    v_code := 'IMFB/' || (v_next + 1)::text;
    exit when not exists (
      select 1 from public.employees
      where employee_number = v_code or staff_id = v_code or employee_code = v_code
    );
    v_next := v_next + 1;
  end loop;

  update public.employees set
    employee_number = v_code,
    staff_id = v_code,
    employee_code = coalesce(employee_code, v_code),
    staff_id_issued_at = now(),
    updated_at = now()
  where id = p_employee_id;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'STAFF_ID_ASSIGNED',
    'Employee',
    p_employee_id::text,
    coalesce(v_actor_name, v_actor_role, auth.uid()::text),
    format('Assigned employee number %s', v_code),
    'info'
  );

  return jsonb_build_object(
    'ok', true,
    'exists', false,
    'employee_number', v_code,
    'staff_id', v_code
  );
end; $$;

grant execute on function public.generate_employee_number(uuid) to authenticated;

-- ============================================================
-- 3. update_employee_hr_fields — extended allowlist
--    Adds: employee_number, staff_id, staff_id_expiry,
--          staff_id_issued_by, staff_id_status + missing personal
--    fields already saved by the frontend.
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
    'job_title', 'employment_status', 'employment_type', 'hire_date',
    'confirmation_date', 'probation_end_date',
    'salary', 'basic_salary', 'allowances', 'branch',
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
-- 4. PROFILES — HR read-all (fixes "All Users (0)" in user mgmt)
-- ============================================================
drop policy if exists "profiles_read_all" on public.profiles;
create policy "profiles_read_all" on public.profiles
  for select
  using (
    auth.uid() = id
    or public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
  );

-- ============================================================
-- 5. ATTENDANCE DEVICES — ensure table + RLS + indexes
--    (consolidated from phase 11 so a single migration run fixes
--    the "table 'public.attendance_devices' not found" terminal error)
-- ============================================================
create table if not exists public.attendance_devices (
  id uuid primary key default gen_random_uuid(),
  device_name text not null,
  device_type text not null default 'fingerprint'
    check (device_type in ('fingerprint', 'face', 'biometric', 'attendance_terminal', 'kiosk')),
  manufacturer text,
  model text,
  serial_number text,
  branch_id text,
  location_id uuid,
  api_endpoint text,
  integration_type text default 'api'
    check (integration_type in ('api', 'webhook', 'local_agent', 'manual_import')),
  status text default 'active'
    check (status in ('active', 'inactive', 'suspended', 'offline')),
  last_seen_at timestamptz,
  device_token text,
  active boolean default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_device_status on public.attendance_devices(status);
create index if not exists idx_device_branch on public.attendance_devices(branch_id);

alter table public.attendance_devices enable row level security;

drop policy if exists "device_read" on public.attendance_devices;
create policy "device_read" on public.attendance_devices
  for select using (auth.role() = 'authenticated' and public.current_role() not in ('customer'));

drop policy if exists "device_manage" on public.attendance_devices;
create policy "device_manage" on public.attendance_devices
  for all using (public.current_role() in ('super_admin', 'admin', 'hr_manager'))
  with check (public.current_role() in ('super_admin', 'admin', 'hr_manager'));

-- Seed a default terminal device ONLY when none exists (never overwrites
-- real terminals registered by HR).
insert into public.attendance_devices (device_name, device_type, status, branch_id, active)
select 'HEAD OFFICE - TERMINAL 01', 'attendance_terminal', 'active', 'Head Office', true
where not exists (select 1 from public.attendance_devices);

-- ============================================================
-- 6. GRANTS (safe, idempotent)
-- ============================================================
grant usage on schema public to authenticated, anon;
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant execute on functions to authenticated;