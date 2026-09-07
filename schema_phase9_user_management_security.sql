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
-- NOTE: In PostgreSQL RLS, the USING clause sees OLD row values (which
-- rows can be targeted), but the WITH CHECK clause only sees NEW row
-- values (which resulting rows are allowed). Referencing OLD in WITH
-- CHECK causes error 42P01 "missing FROM-clause entry for table old".
-- We use NEW.role in WITH CHECK to prevent elevation to super_admin.
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
      and (new.role <> 'super_admin' or public.current_role() = 'super_admin')
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

  -- Auto-create/link employee record for staff roles
  if p_role in ('staff', 'hr_manager', 'hr_officer', 'branch_manager', 'area_manager',
                'head_of_business', 'operations_manager', 'loan_officer',
                'relationship_manager', 'customer_service', 'admin') then
    declare
      v_emp_id uuid;
      v_emp_code text;
    begin
      -- Check if employee already exists (by user_id or email)
      select id into v_emp_id from public.employees
        where user_id = p_user_id
           or (v_target.email is not null and lower(email) = lower(v_target.email))
        limit 1;

      if v_emp_id is null then
        -- Generate employee code
        v_emp_code := public.generate_employee_code();

        insert into public.employees (
          user_id, full_name, email, department, "position", branch,
          employment_status, employee_code, source, created_by, hire_date, updated_at
        ) values (
          p_user_id, coalesce(v_target.full_name, v_target.email, 'Unknown'),
          v_target.email, p_department, null, p_branch,
          'active', v_emp_code, 'manual', auth.uid(), now()::date, now()
        )
        returning id into v_emp_id;

        insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
        values (
          'EMPLOYEE_AUTO_CREATED',
          'Employee',
          v_emp_id::text,
          coalesce(v_actor_name, auth.uid()::text),
          format('Employee auto-created for approved user %s (role: %s)', coalesce(v_target.email, p_user_id::text), p_role),
          'info'
        );
      else
        -- Link existing employee to user_id if not already linked
        update public.employees set user_id = p_user_id, updated_at = now()
          where id = v_emp_id and user_id is null;
      end if;

      -- Link profile to employee
      update public.profiles set employee_id = v_emp_id where id = p_user_id and employee_id is null;
    end;
  end if;

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
-- 13. SARA AUDIT LOG TABLE
--     Records every SARA-assisted action with user, command,
--     timestamp, affected records, action, and result.
-- ============================================================
create table if not exists public.sara_audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  user_name text,
  command text,
  intent text,
  action text,
  affected_records jsonb,
  result jsonb,
  confirmed boolean default false,
  executed_at timestamptz default now(),
  created_at timestamptz default now()
);

alter table public.sara_audit_logs enable row level security;

drop policy if exists "sara_audit_select" on public.sara_audit_logs;
create policy "sara_audit_select" on public.sara_audit_logs
  for select using (
    auth.uid() = user_id
    or public.current_role() in ('super_admin', 'admin', 'hr_manager')
  );

drop policy if exists "sara_audit_insert" on public.sara_audit_logs;
create policy "sara_audit_insert" on public.sara_audit_logs
  for insert with check (auth.uid() = user_id);

create index if not exists idx_sara_audit_user on public.sara_audit_logs(user_id);
create index if not exists idx_sara_audit_created on public.sara_audit_logs(created_at);

-- ============================================================
-- 14. RPC: sara_log_action
--      Called by the frontend after SARA executes an action.
--      Never used for authorization — only for audit trail.
-- ============================================================
create or replace function public.sara_log_action(
  p_command text,
  p_intent text,
  p_action text,
  p_affected_records jsonb default null,
  p_result jsonb default null,
  p_confirmed boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_user_name text;
begin
  select full_name into v_user_name from public.profiles where id = auth.uid();
  insert into public.sara_audit_logs (
    user_id, user_name, command, intent, action,
    affected_records, result, confirmed
  ) values (
    auth.uid(), coalesce(v_user_name, auth.uid()::text),
    p_command, p_intent, p_action,
    p_affected_records, p_result, p_confirmed
  );
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.sara_log_action(text, text, text, jsonb, jsonb, boolean) to authenticated;

-- ============================================================
-- 15. RPC: get_employee_completion
--      Returns completion percentage and missing required fields
--      for the authenticated user's employee record.
-- ============================================================
create or replace function public.get_employee_completion(p_employee_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_emp record;
  v_target_id uuid := p_employee_id;
  v_total int := 0;
  v_filled int := 0;
  v_missing text[] := '{}'::text[];
begin
  -- If no employee_id, use the authenticated user's
  if v_target_id is null then
    select id into v_target_id from public.employees where user_id = auth.uid() limit 1;
  end if;

  if v_target_id is null then
    return jsonb_build_object('ok', false, 'message', 'No employee record found');
  end if;

  select * into v_emp from public.employees where id = v_target_id;

  -- Required fields for a complete employee profile
  if v_emp.full_name is not null and trim(v_emp.full_name) <> '' then v_filled := v_filled + 1; else v_missing := array_append(v_missing, 'Full Name'); end if; v_total := v_total + 1;
  if v_emp.email is not null and trim(v_emp.email) <> '' then v_filled := v_filled + 1; else v_missing := array_append(v_missing, 'Email'); end if; v_total := v_total + 1;
  if v_emp.phone is not null and trim(v_emp.phone) <> '' then v_filled := v_filled + 1; else v_missing := array_append(v_missing, 'Phone'); end if; v_total := v_total + 1;
  if v_emp.department is not null and trim(v_emp.department) <> '' then v_filled := v_filled + 1; else v_missing := array_append(v_missing, 'Department'); end if; v_total := v_total + 1;
  if v_emp."position" is not null and trim(v_emp."position") <> '' then v_filled := v_filled + 1; else v_missing := array_append(v_missing, 'Position'); end if; v_total := v_total + 1;
  if v_emp.branch is not null and trim(v_emp.branch) <> '' then v_filled := v_filled + 1; else v_missing := array_append(v_missing, 'Branch'); end if; v_total := v_total + 1;
  if v_emp.employment_type is not null and trim(v_emp.employment_type) <> '' then v_filled := v_filled + 1; else v_missing := array_append(v_missing, 'Employment Type'); end if; v_total := v_total + 1;
  if v_emp.hire_date is not null then v_filled := v_filled + 1; else v_missing := array_append(v_missing, 'Date Employed'); end if; v_total := v_total + 1;
  if v_emp.emergency_contact_name is not null and trim(v_emp.emergency_contact_name) <> '' then v_filled := v_filled + 1; else v_missing := array_append(v_missing, 'Emergency Contact Name'); end if; v_total := v_total + 1;
  if v_emp.emergency_contact_phone is not null and trim(v_emp.emergency_contact_phone) <> '' then v_filled := v_filled + 1; else v_missing := array_append(v_missing, 'Emergency Contact Phone'); end if; v_total := v_total + 1;
  if v_emp.next_of_kin_name is not null and trim(v_emp.next_of_kin_name) <> '' then v_filled := v_filled + 1; else v_missing := array_append(v_missing, 'Next of Kin Name'); end if; v_total := v_total + 1;
  if v_emp.next_of_kin_phone is not null and trim(v_emp.next_of_kin_phone) <> '' then v_filled := v_filled + 1; else v_missing := array_append(v_missing, 'Next of Kin Phone'); end if; v_total := v_total + 1;
  if v_emp.bank_name is not null and trim(v_emp.bank_name) <> '' then v_filled := v_filled + 1; else v_missing := array_append(v_missing, 'Bank Name'); end if; v_total := v_total + 1;
  if v_emp.account_number is not null and trim(v_emp.account_number) <> '' then v_filled := v_filled + 1; else v_missing := array_append(v_missing, 'Account Number'); end if; v_total := v_total + 1;
  if v_emp.bvn is not null and trim(v_emp.bvn) <> '' then v_filled := v_filled + 1; else v_missing := array_append(v_missing, 'BVN'); end if; v_total := v_total + 1;

  return jsonb_build_object(
    'ok', true,
    'employee_id', v_target_id::text,
    'total_fields', v_total,
    'filled_fields', v_filled,
    'missing_fields', v_missing,
    'completion_pct', case when v_total = 0 then 0 else round((v_filled::numeric / v_total) * 100) end,
    'is_complete', v_filled = v_total
  );
end; $$;
grant execute on function public.get_employee_completion(uuid) to authenticated;

-- ============================================================
-- 16. RPC: request_employee_info_update
--      HR/super_admin requests an employee to update specific fields.
--      Creates a notification + audit record.
-- ============================================================
create or replace function public.request_employee_info_update(
  p_employee_id uuid,
  p_fields text[],
  p_message text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_emp record;
begin
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized to request employee updates';
  end if;

  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then
    raise exception 'Employee not found';
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  -- Notify the employee's linked user if they have one
  if v_emp.user_id is not null then
    insert into public.notifications (user_id, title, message, type, link)
    values (
      v_emp.user_id,
      'Employee Information Update Requested',
      coalesce(p_message, format('Please update the following: %s', array_to_string(p_fields, ', '))),
      'system',
      '/employees/' || p_employee_id::text
    );
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'EMPLOYEE_UPDATE_REQUESTED',
    'Employee',
    p_employee_id::text,
    coalesce(v_actor_name, auth.uid()::text),
    format('HR requested update for %s. Fields: %s. Message: %s',
           coalesce(v_emp.full_name, ''), array_to_string(p_fields, ', '), coalesce(p_message, 'N/A')),
    'warning'
  );

  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.request_employee_info_update(uuid, text[], text) to authenticated;

-- ============================================================
-- 17. RPC: sara_batch_approve_leave
--      SARA voice-approval execution path. Executes through the
--      same leave_approvals chain, never bypasses authorization.
--      Requires the authenticated user to have leave management rights.
-- ============================================================
create or replace function public.sara_batch_approve_leave(
  p_request_ids uuid[],
  p_comments text default 'Approved via SARA voice command'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_id uuid;
  v_count int := 0;
  v_results jsonb := '[]'::jsonb;
begin
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager', 'area_manager', 'head_of_business', 'branch_manager') then
    raise exception 'Not authorized to approve leave requests';
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  foreach v_id in array p_request_ids loop
    begin
      -- Update the leave request status
      update public.leave_requests
        set status = 'approved', reviewed_by = auth.uid(), reviewed_date = now(), approval_comments = p_comments
        where id = v_id and status = 'pending';

      if found then
        v_count := v_count + 1;
        v_results := v_results || jsonb_build_object('id', v_id::text, 'status', 'approved');

        -- Create approval trail entry
        insert into public.leave_approvals (request_id, stage, approver_id, approver_name, decision, comments)
        select v_id, 'final', auth.uid(), coalesce(v_actor_name, auth.uid()::text), 'approved', p_comments
        on conflict do nothing;

        -- Notify the employee
        insert into public.notifications (user_id, title, message, type, link)
        select created_by, 'Leave Approved',
               format('Your leave request has been approved via SARA by %s.', coalesce(v_actor_name, 'HR')),
               'workflow', '/leave-requests'
        from public.leave_requests where id = v_id;
      end if;
    exception when others then
      v_results := v_results || jsonb_build_object('id', v_id::text, 'status', 'error', 'error', SQLERRM);
    end;
  end loop;

  -- Audit
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'SARA_BATCH_APPROVE_LEAVE',
    'LeaveRequest',
    array_to_string(p_request_ids, ','),
    coalesce(v_actor_name, auth.uid()::text),
    format('SARA batch approved %s leave request(s)', v_count),
    'warning'
  );

  return jsonb_build_object('ok', true, 'approved_count', v_count, 'results', v_results);
end; $$;
grant execute on function public.sara_batch_approve_leave(uuid[], text) to authenticated;

-- ============================================================
-- DONE. All changes are additive and idempotent.
-- ============================================================
