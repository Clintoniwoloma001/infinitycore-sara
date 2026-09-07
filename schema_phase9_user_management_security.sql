-- ============================================================
-- PHASE 9: USER MANAGEMENT SECURITY + MANUAL EMPLOYEE CREATION
--
-- Adds user approval workflow, super_admin protection, manual
-- employee creation support, and enforces permissions server-side.
--
-- ALL ADDITIVE. Safe to re-run. Non-destructive.
-- ============================================================

-- ============================================================
-- 1. PROFILES — add approval/status/assignment columns
-- ============================================================
alter table public.profiles add column if not exists status text default 'pending' check (status in ('pending', 'active', 'inactive', 'rejected'));
alter table public.profiles add column if not exists approved boolean default false;
alter table public.profiles add column if not exists approved_by uuid references auth.users(id) on delete set null;
alter table public.profiles add column if not exists approved_at timestamptz;
alter table public.profiles add column if not exists department text;
alter table public.profiles add column if not exists branch text;
alter table public.profiles add column if not exists phone text;
alter table public.profiles add column if not exists employee_id uuid references public.employees(id) on delete set null;
alter table public.profiles add column if not exists rejection_reason text;
alter table public.profiles add column if not exists user_type text default 'customer' check (user_type in ('customer', 'staff', 'contractor', 'intern'));

-- Index for filtering by status
create index if not exists idx_profiles_status on public.profiles(status);
create index if not exists idx_profiles_department on public.profiles(department);
create index if not exists idx_profiles_branch on public.profiles(branch);

-- ============================================================
-- 2. UPDATE SIGNUP TRIGGER — new users start as pending + customer
-- ============================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, role, status, approved, user_type)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    'customer',
    'pending',
    false,
    'customer'
  )
  on conflict (id) do nothing;
  return new;
end; $$;

-- ============================================================
-- 3. SUPER_ADMIN PROTECTION TRIGGER
--    Prevents non-super_admin from modifying super_admin profiles
--    (role, status, department, branch, etc.)
-- ============================================================
create or replace function public.protect_super_admin_profile()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  actor_role text := public.current_role();
begin
  -- Only applies when modifying an EXISTING super_admin's profile
  if old.role = 'super_admin' and actor_role <> 'super_admin' then
    -- Allow the super_admin themselves to update their own non-role fields
    if auth.uid() = old.id and new.role = old.role and new.status = old.status then
      return new;
    end if;
    raise exception 'Super Admin accounts are protected. Only another Super Admin can modify them.';
  end if;
  return new;
end; $$;

drop trigger if exists trg_protect_super_admin on public.profiles;
create trigger trg_protect_super_admin
  before update on public.profiles
  for each row execute function public.protect_super_admin_profile();

-- ============================================================
-- 4. RLS POLICIES FOR PROFILES
--    HR/admin can read all profiles. HR/admin can update non-super_admin
--    profiles. Users can always read/update their own profile.
-- ============================================================

-- Read: own profile OR HR/admin roles
drop policy if exists "profiles_read_all" on public.profiles;
create policy "profiles_read_all" on public.profiles
  for select using (
    auth.uid() = id
    or public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
  );

-- Update: own profile (non-role fields) OR HR/admin for non-super_admin
drop policy if exists "profiles_update_hr" on public.profiles;
create policy "profiles_update_hr" on public.profiles
  for update using (
    auth.uid() = id
    or (
      public.current_role() in ('super_admin', 'admin', 'hr_manager')
      and (old.role <> 'super_admin' or public.current_role() = 'super_admin')
    )
  )
  with check (
    auth.uid() = id
    or (
      public.current_role() in ('super_admin', 'admin', 'hr_manager')
      and (old.role <> 'super_admin' or public.current_role() = 'super_admin')
    )
  );

-- ============================================================
-- 5. EMPLOYEES — add source tracking column
-- ============================================================
alter table public.employees add column if not exists source text default 'onboarding' check (source in ('onboarding', 'manual'));
alter table public.employees add column if not exists created_by uuid references auth.users(id) on delete set null;
alter table public.employees add column if not exists preferred_name text;
alter table public.employees add column if not exists gender text;
alter table public.employees add column if not exists area text;
alter table public.employees add column if not exists probation_end_date date;
alter table public.employees add column if not exists reporting_manager_id uuid references auth.users(id) on delete set null;
alter table public.employees add column if not exists work_location text;
alter table public.employees add column if not exists basic_salary numeric(12, 2);
alter table public.employees add column if not exists account_name text;
alter table public.employees add column if not exists nhf_id text;

create index if not exists idx_employees_source on public.employees(source);
create index if not exists idx_employees_created_by on public.employees(created_by);

-- ============================================================
-- 6. RPC: approve_user (HR/admin only)
--    Activates a pending user, assigns role/department/branch
-- ============================================================
create or replace function public.approve_user(
  p_user_id uuid,
  p_role text default 'staff',
  p_department text default null,
  p_branch text default null,
  p_user_type text default 'staff'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_target record;
begin
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to approve users';
  end if;

  select * into v_target from public.profiles where id = p_user_id;
  if v_target.id is null then
    raise exception 'User not found';
  end if;
  if v_target.role = 'super_admin' and v_actor_role <> 'super_admin' then
    raise exception 'Cannot modify Super Admin accounts';
  end if;

  -- Validate role assignment (reuse enforce_role_change_policy logic)
  if p_role = 'super_admin' and v_actor_role <> 'super_admin' then
    raise exception 'Only super_admin can assign the super_admin role';
  end if;
  if p_role in ('admin', 'area_manager', 'head_of_business') and v_actor_role not in ('super_admin', 'admin') then
    raise exception 'Not authorized to assign this role';
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  update public.profiles set
    role = p_role,
    status = 'active',
    approved = true,
    approved_by = auth.uid(),
    approved_at = now(),
    department = p_department,
    branch = p_branch,
    user_type = coalesce(p_user_type, 'staff')
  where id = p_user_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'USER_APPROVED',
    'User',
    p_user_id::text,
    coalesce(v_actor_name, auth.uid()::text),
    format('User %s approved with role %s, dept %s, branch %s', coalesce(v_target.email, p_user_id::text), p_role, coalesce(p_department, 'N/A'), coalesce(p_branch, 'N/A')),
    'warning'
  );

  -- Notify the approved user
  insert into public.notifications (user_id, title, message, type, link)
  values (
    p_user_id,
    'Account Approved',
    format('Your account has been approved. You now have access as %s.', p_role),
    'system',
    '/'
  );

  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.approve_user(uuid, text, text, text, text) to authenticated;

-- ============================================================
-- 7. RPC: reject_user (HR/admin only)
-- ============================================================
create or replace function public.reject_user(
  p_user_id uuid,
  p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_target record;
begin
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to reject users';
  end if;

  select * into v_target from public.profiles where id = p_user_id;
  if v_target.id is null then
    raise exception 'User not found';
  end if;
  if v_target.role = 'super_admin' then
    raise exception 'Cannot reject Super Admin accounts';
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  update public.profiles set
    status = 'rejected',
    approved = false,
    rejection_reason = p_reason
  where id = p_user_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'USER_REJECTED',
    'User',
    p_user_id::text,
    coalesce(v_actor_name, auth.uid()::text),
    format('User %s rejected. Reason: %s', coalesce(v_target.email, p_user_id::text), coalesce(p_reason, 'No reason given')),
    'warning'
  );

  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.reject_user(uuid, text) to authenticated;

-- ============================================================
-- 8. RPC: deactivate_user / reactivate_user (HR/admin only)
-- ============================================================
create or replace function public.deactivate_user(p_user_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_target record;
begin
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to deactivate users';
  end if;

  select * into v_target from public.profiles where id = p_user_id;
  if v_target.id is null then
    raise exception 'User not found';
  end if;
  if v_target.role = 'super_admin' then
    raise exception 'Cannot deactivate Super Admin accounts';
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  update public.profiles set status = 'inactive' where id = p_user_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'USER_DEACTIVATED',
    'User',
    p_user_id::text,
    coalesce(v_actor_name, auth.uid()::text),
    format('User %s deactivated', coalesce(v_target.email, p_user_id::text)),
    'warning'
  );

  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.deactivate_user(uuid) to authenticated;

create or replace function public.reactivate_user(p_user_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_target record;
begin
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to reactivate users';
  end if;

  select * into v_target from public.profiles where id = p_user_id;
  if v_target.id is null then
    raise exception 'User not found';
  end if;
  if v_target.role = 'super_admin' and v_actor_role <> 'super_admin' then
    raise exception 'Cannot modify Super Admin accounts';
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  update public.profiles set status = 'active', approved = true where id = p_user_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'USER_REACTIVATED',
    'User',
    p_user_id::text,
    coalesce(v_actor_name, auth.uid()::text),
    format('User %s reactivated', coalesce(v_target.email, p_user_id::text)),
    'info'
  );

  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.reactivate_user(uuid) to authenticated;

-- ============================================================
-- 9. RPC: create_employee_manual (HR/admin only)
--    Creates an employee record with duplicate checking.
--    Does NOT create a user account — that's a separate step.
-- ============================================================
create or replace function public.create_employee_manual(
  p_full_name text,
  p_email text default null,
  p_phone text default null,
  p_department text default null,
  p_position text default null,
  p_branch text default null,
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
begin
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to create employees';
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
    full_name, email, phone, department, "position", branch, area,
    employment_type, employment_status, hire_date, employee_code,
    basic_salary, bank_name, account_name, account_number, bank_sort_code,
    bvn, nin, tax_id, pension_id, gender, date_of_birth,
    nationality, marital_status, state_of_origin, lga, residential_address,
    emergency_contact_name, emergency_contact_phone,
    next_of_kin_name, next_of_kin_phone, next_of_kin_relationship,
    reporting_manager_id, work_location, probation_end_date,
    preferred_name, source, created_by, updated_at
  ) values (
    p_full_name, p_email, p_phone, p_department, p_position, p_branch, p_area,
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

  return jsonb_build_object('ok', true, 'employee_id', v_new_id::text);
end; $$;
grant execute on function public.create_employee_manual to authenticated;

-- ============================================================
-- 10. RPC: generate_employee_code
--    Auto-generates a unique employee code following existing convention
-- ============================================================
create or replace function public.generate_employee_code()
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
  v_code text;
begin
  select count(*) + 1 into v_count from public.employees where employee_code is not null;
  v_code := 'EMP-' || lpad(v_count::text, 4, '0');

  -- Ensure uniqueness
  while exists (select 1 from public.employees where employee_code = v_code) loop
    v_count := v_count + 1;
    v_code := 'EMP-' || lpad(v_count::text, 4, '0');
  end loop;

  return v_code;
end; $$;
grant execute on function public.generate_employee_code to authenticated;

-- ============================================================
-- 11. FIX HR_JOBS RLS — super_admin was missing from insert/update policies
-- ============================================================
drop policy if exists "hr_jobs_insert" on public.hr_jobs;
create policy "hr_jobs_insert" on public.hr_jobs
  for insert with check (
    public.current_role() in ('super_admin', 'admin', 'hr_manager')
  );

drop policy if exists "hr_jobs_update" on public.hr_jobs;
create policy "hr_jobs_update" on public.hr_jobs
  for update using (
    created_by = auth.uid()
    or public.current_role() in ('super_admin', 'admin')
  )
  with check (
    public.current_role() in ('super_admin', 'admin', 'hr_manager')
  );

-- ============================================================
-- 12. AUTO-LINK ONBOARDING → EMPLOYEE
--    When onboarding submission is created, auto-create employee record
--    if one doesn't exist yet. This ensures approve_onboarding() can
--    activate the employee.
-- ============================================================
create or replace function public.auto_create_employee_from_submission()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_payload jsonb;
  v_employee_id uuid;
  v_link record;
begin
  -- Only act on new submissions
  if new.employee_id is not null then
    return new;
  end if;

  -- Get the link for position/department/branch info
  select * into v_link from public.employee_onboarding_links where id = new.link_id;

  -- Create a minimal employee record from submission data
  insert into public.employees (
    full_name, email, phone, "position", department, branch,
    employment_type, employment_status, source, candidate_id
  ) values (
    coalesce(new.candidate_name, 'Unknown'),
    new.email,
    new.phone,
    new."position",
    new.department,
    v_link.branch,
    new.employment_type,
    'onboarding',
    'onboarding',
    null
  )
  returning id into v_employee_id;

  -- Link the submission to the employee
  new.employee_id := v_employee_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'EMPLOYEE_LINKED_FROM_ONBOARDING',
    'Employee',
    v_employee_id::text,
    'system',
    format('Employee %s auto-created from onboarding submission', coalesce(new.candidate_name, '')),
    'info'
  );

  return new;
end; $$;

drop trigger if exists trg_auto_create_employee on public.employee_onboarding_submissions;
create trigger trg_auto_create_employee
  before insert on public.employee_onboarding_submissions
  for each row execute function public.auto_create_employee_from_submission();

-- ============================================================
-- DONE. All changes are additive and idempotent.
-- ============================================================
