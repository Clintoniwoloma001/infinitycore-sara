-- ============================================================
-- PHASE 10: USER APPROVAL WORKFLOW + WORKFORCE OPERATIONS
--
-- ALL ADDITIVE. Run after all prior schema files (schema.sql through
-- schema_phase9_integrated_operations.sql).
-- Safe to re-run: every statement uses IF NOT EXISTS / OR REPLACE /
-- DROP IF EXISTS. No existing data is destroyed.
-- ============================================================

-- ============================================================
-- 1. PROFILES — add status + department columns
-- ============================================================

-- Account approval status. New signups default to 'pending'.
-- The handle_new_user() trigger (phase 5) already sets role='customer';
-- this adds the approval lifecycle on top of it.
alter table public.profiles
  add column if not exists status text default 'pending'
  check (status in ('pending', 'active', 'suspended', 'rejected'));

alter table public.profiles
  add column if not exists department text;

alter table public.profiles
  add column if not exists phone text;

alter table public.profiles
  add column if not exists approved_by uuid references auth.users(id) on delete set null;

alter table public.profiles
  add column if not exists approved_at timestamptz;

alter table public.profiles
  add column if not exists rejected_reason text;

-- Update the signup trigger to also set status='pending'
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, role, status)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''), 'customer', 'pending')
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- 2. USER ACCESS PROFILES — per-user module access grants
--    Allows admins to grant/revoke individual module access beyond
--    the role-based defaults. Stored as a JSONB array of module keys.
-- ============================================================
create table if not exists public.user_access_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  modules jsonb not null default '[]'::jsonb,
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id)
);

alter table public.user_access_profiles enable row level security;

drop policy if exists "user_access_self_read" on public.user_access_profiles;
create policy "user_access_self_read" on public.user_access_profiles
  for select using (
    user_id = auth.uid()
    or public.current_role() in ('super_admin', 'admin', 'hr_manager')
  );

drop policy if exists "user_access_manage" on public.user_access_profiles;
create policy "user_access_manage" on public.user_access_profiles
  for all using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager')
  )
  with check (
    public.current_role() in ('super_admin', 'admin', 'hr_manager')
  );

-- ============================================================
-- 3. USER APPROVAL AUDIT TRAIL — structured account decision log
-- ============================================================
create table if not exists public.user_approval_audit (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null check (action in (
    'USER_APPROVED', 'USER_REJECTED', 'USER_SUSPENDED',
    'USER_ACTIVATED', 'USER_DEACTIVATED', 'USER_ROLE_CHANGED',
    'USER_DEPARTMENT_CHANGED', 'USER_ACCESS_CHANGED'
  )),
  previous_status text,
  new_status text,
  previous_role text,
  new_role text,
  department text,
  approver_id uuid references auth.users(id) on delete set null,
  approver_name text,
  reason text,
  created_at timestamptz default now()
);

create index if not exists idx_user_approval_audit_user on public.user_approval_audit(user_id);
create index if not exists idx_user_approval_audit_action on public.user_approval_audit(action);

alter table public.user_approval_audit enable row level security;

drop policy if exists "user_approval_audit_read" on public.user_approval_audit;
create policy "user_approval_audit_read" on public.user_approval_audit
  for select using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager')
  );

drop policy if exists "user_approval_audit_insert" on public.user_approval_audit;
create policy "user_approval_audit_insert" on public.user_approval_audit
  for insert with check (auth.role() = 'authenticated');

-- ============================================================
-- 4. TASKS — add workforce management columns
-- ============================================================
alter table public.tasks
  add column if not exists assignment_type text default 'individual'
  check (assignment_type in ('individual', 'team', 'department', 'branch', 'area'));

alter table public.tasks
  add column if not exists department text;

alter table public.tasks
  add column if not exists branch text;

alter table public.tasks
  add column if not exists area text;

alter table public.tasks
  add column if not exists start_date date;

alter table public.tasks
  add column if not exists supervisor_id uuid references auth.users(id) on delete set null;

alter table public.tasks
  add column if not exists completion_pct int default 0 check (completion_pct >= 0 and completion_pct <= 100);

alter table public.tasks
  add column if not exists kpi_id uuid;

alter table public.tasks
  add column if not exists target_id uuid;

alter table public.tasks
  add column if not exists instructions text;

-- Widen task_type to include workforce task types
alter table public.tasks drop constraint if exists tasks_task_type_check;
alter table public.tasks add constraint tasks_task_type_check
  check (task_type in ('approval', 'verification', 'assessment', 'review', 'follow_up', 'support', 'onboarding', 'work_task', 'project', 'assignment', 'report'));

-- Widen status to include 'submitted' for report workflow
alter table public.tasks drop constraint if exists tasks_status_check;
alter table public.tasks add constraint tasks_status_check
  check (status in ('pending', 'in_progress', 'completed', 'cancelled', 'submitted'));

-- Widen tasks insert RLS to include HR managers and area managers
drop policy if exists "tasks_insert_admin" on public.tasks;
create policy "tasks_insert_admin" on public.tasks
  for insert with check (
    public.current_role() in ('admin', 'super_admin', 'branch_manager', 'operations_manager', 'hr_manager', 'hr_officer', 'area_manager')
  );

-- Widen tasks update RLS
drop policy if exists "tasks_update_assigned_or_admin" on public.tasks;
create policy "tasks_update_assigned_or_admin" on public.tasks
  for update using (
    assigned_to = auth.uid()
    or created_by = auth.uid()
    or public.current_role() in ('admin', 'super_admin', 'branch_manager', 'operations_manager', 'hr_manager', 'area_manager')
  )
  with check (
    assigned_to = auth.uid()
    or public.current_role() in ('admin', 'super_admin', 'branch_manager', 'operations_manager', 'hr_manager', 'area_manager')
  );

-- Widen tasks read RLS to include HR managers and area managers
drop policy if exists "tasks_read_assigned" on public.tasks;
create policy "tasks_read_assigned" on public.tasks
  for select using (
    assigned_to = auth.uid()
    or created_by = auth.uid()
    or public.current_role() in ('admin', 'super_admin', 'branch_manager', 'operations_manager', 'hr_manager', 'hr_officer', 'area_manager')
  );

-- ============================================================
-- 5. TASK PROGRESS REPORTS — employee progress submissions
--    Never overwritten — each submission is a new row (history).
-- ============================================================
create table if not exists public.task_progress_reports (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  submitted_by uuid references auth.users(id) on delete set null,
  progress_pct int default 0 check (progress_pct >= 0 and progress_pct <= 100),
  completed_quantity numeric default 0,
  narrative text,
  attachment_path text,
  attachment_name text,
  status text default 'pending' check (status in ('pending', 'accepted', 'correction_requested', 'rejected')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_comment text,
  created_at timestamptz default now()
);

create index if not exists idx_task_reports_task on public.task_progress_reports(task_id);
create index if not exists idx_task_reports_status on public.task_progress_reports(status);

alter table public.task_progress_reports enable row level security;

drop policy if exists "task_reports_read" on public.task_progress_reports;
create policy "task_reports_read" on public.task_progress_reports
  for select using (
    submitted_by = auth.uid()
    or exists (select 1 from public.tasks t where t.id = task_id and (t.assigned_to = auth.uid() or t.created_by = auth.uid()))
    or public.current_role() in ('super_admin', 'admin', 'branch_manager', 'operations_manager', 'hr_manager', 'hr_officer', 'area_manager')
  );

drop policy if exists "task_reports_insert" on public.task_progress_reports;
create policy "task_reports_insert" on public.task_progress_reports
  for insert with check (auth.role() = 'authenticated');

drop policy if exists "task_reports_update" on public.task_progress_reports;
create policy "task_reports_update" on public.task_progress_reports
  for update using (
    public.current_role() in ('super_admin', 'admin', 'branch_manager', 'operations_manager', 'hr_manager', 'hr_officer', 'area_manager')
  );

-- ============================================================
-- 6. KPI DEFINITIONS — metrics defined by HR/management
-- ============================================================
create table if not exists public.kpi_definitions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  measurement_type text default 'quantity' check (measurement_type in ('quantity', 'monetary', 'percentage', 'rating')),
  target_value numeric not null default 100,
  unit text,
  period text check (period in ('monthly', 'quarterly', 'annual', 'custom')),
  period_label text,
  start_date date,
  end_date date,
  is_shared boolean default false,
  is_active boolean default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.kpi_definitions enable row level security;

drop policy if exists "kpi_defs_read" on public.kpi_definitions;
create policy "kpi_defs_read" on public.kpi_definitions
  for select using (auth.role() = 'authenticated');

drop policy if exists "kpi_defs_manage" on public.kpi_definitions;
create policy "kpi_defs_manage" on public.kpi_definitions
  for all using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager', 'area_manager')
  )
  with check (
    public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager', 'area_manager')
  );

-- ============================================================
-- 7. KPI ASSIGNMENTS — assign KPIs to individuals/teams/departments
-- ============================================================
create table if not exists public.kpi_assignments (
  id uuid primary key default gen_random_uuid(),
  kpi_id uuid not null references public.kpi_definitions(id) on delete cascade,
  assignment_type text default 'individual' check (assignment_type in ('individual', 'team', 'department', 'branch', 'area')),
  user_id uuid references auth.users(id) on delete cascade,
  department text,
  branch text,
  area text,
  target_value numeric,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);

create index if not exists idx_kpi_assign_kpi on public.kpi_assignments(kpi_id);
create index if not exists idx_kpi_assign_user on public.kpi_assignments(user_id);

alter table public.kpi_assignments enable row level security;

drop policy if exists "kpi_assign_read" on public.kpi_assignments;
create policy "kpi_assign_read" on public.kpi_assignments
  for select using (
    user_id = auth.uid()
    or public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager', 'area_manager')
  );

drop policy if exists "kpi_assign_manage" on public.kpi_assignments;
create policy "kpi_assign_manage" on public.kpi_assignments
  for all using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager', 'area_manager')
  )
  with check (
    public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager', 'area_manager')
  );

-- ============================================================
-- 8. KPI SUBMISSIONS — employee progress reports against KPIs
--    Never overwritten — each submission is a new row (history).
-- ============================================================
create table if not exists public.kpi_submissions (
  id uuid primary key default gen_random_uuid(),
  kpi_id uuid not null references public.kpi_definitions(id) on delete cascade,
  assignment_id uuid references public.kpi_assignments(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  actual_value numeric default 0,
  progress_pct numeric default 0,
  narrative text,
  attachment_path text,
  attachment_name text,
  period_label text,
  status text default 'pending' check (status in ('pending', 'accepted', 'correction_requested', 'rejected')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_comment text,
  created_at timestamptz default now()
);

create index if not exists idx_kpi_subs_kpi on public.kpi_submissions(kpi_id);
create index if not exists idx_kpi_subs_user on public.kpi_submissions(user_id);
create index if not exists idx_kpi_subs_status on public.kpi_submissions(status);

alter table public.kpi_submissions enable row level security;

drop policy if exists "kpi_subs_read" on public.kpi_submissions;
create policy "kpi_subs_read" on public.kpi_submissions
  for select using (
    user_id = auth.uid()
    or public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager', 'area_manager')
  );

drop policy if exists "kpi_subs_insert" on public.kpi_submissions;
create policy "kpi_subs_insert" on public.kpi_submissions
  for insert with check (auth.role() = 'authenticated');

drop policy if exists "kpi_subs_update" on public.kpi_submissions;
create policy "kpi_subs_update" on public.kpi_submissions
  for update using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager', 'area_manager')
  );

-- ============================================================
-- 9. WORK PLANS — planned work items with timelines
-- ============================================================
create table if not exists public.work_plans (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  assignment_type text default 'individual' check (assignment_type in ('individual', 'team', 'department', 'branch', 'area')),
  user_id uuid references auth.users(id) on delete set null,
  department text,
  branch text,
  area text,
  start_date date,
  end_date date,
  status text default 'draft' check (status in ('draft', 'active', 'completed', 'cancelled')),
  progress_pct int default 0 check (progress_pct >= 0 and progress_pct <= 100),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.work_plans enable row level security;

drop policy if exists "work_plans_read" on public.work_plans;
create policy "work_plans_read" on public.work_plans
  for select using (
    user_id = auth.uid()
    or public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager', 'area_manager')
  );

drop policy if exists "work_plans_manage" on public.work_plans;
create policy "work_plans_manage" on public.work_plans
  for all using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager', 'area_manager')
  )
  with check (
    public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager', 'area_manager')
  );

-- ============================================================
-- 10. ATTENDANCE EXCEPTIONS — late arrival reasons
-- ============================================================
create table if not exists public.attendance_exceptions (
  id uuid primary key default gen_random_uuid(),
  attendance_id uuid references public.attendance_records(id) on delete cascade,
  employee_id uuid references public.employees(id) on delete cascade,
  exception_type text default 'late_arrival' check (exception_type in ('late_arrival', 'early_exit', 'missed_break', 'other')),
  reason text check (reason in ('traffic', 'transport_delay', 'health_emergency', 'official_assignment', 'family_emergency', 'weather', 'other')),
  custom_explanation text,
  expected_time text,
  actual_time text,
  status text default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_comment text,
  created_at timestamptz default now()
);

create index if not exists idx_attendance_exc_attendance on public.attendance_exceptions(attendance_id);
create index if not exists idx_attendance_exc_status on public.attendance_exceptions(status);

alter table public.attendance_exceptions enable row level security;

drop policy if exists "attendance_exc_read" on public.attendance_exceptions;
create policy "attendance_exc_read" on public.attendance_exceptions
  for select using (
    employee_id in (select id from public.employees where user_id = auth.uid())
    or public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager')
  );

drop policy if exists "attendance_exc_insert" on public.attendance_exceptions;
create policy "attendance_exc_insert" on public.attendance_exceptions
  for insert with check (
    employee_id in (select id from public.employees where user_id = auth.uid())
  );

drop policy if exists "attendance_exc_review" on public.attendance_exceptions;
create policy "attendance_exc_review" on public.attendance_exceptions
  for update using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager')
  );

-- ============================================================
-- 11. ATTENDANCE ISSUES — employee-reported issues
-- ============================================================
create table if not exists public.attendance_issues (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references public.employees(id) on delete cascade,
  issue_date date not null,
  issue_type text not null check (issue_type in ('forgot_clock_in', 'forgot_clock_out', 'incorrect_time', 'wrong_location', 'device_problem', 'other')),
  explanation text,
  attachment_path text,
  attachment_name text,
  status text default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_comment text,
  created_at timestamptz default now()
);

create index if not exists idx_attendance_issues_emp on public.attendance_issues(employee_id);
create index if not exists idx_attendance_issues_status on public.attendance_issues(status);

alter table public.attendance_issues enable row level security;

drop policy if exists "attendance_issues_read" on public.attendance_issues;
create policy "attendance_issues_read" on public.attendance_issues
  for select using (
    employee_id in (select id from public.employees where user_id = auth.uid())
    or public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager')
  );

drop policy if exists "attendance_issues_insert" on public.attendance_issues;
create policy "attendance_issues_insert" on public.attendance_issues
  for insert with check (
    employee_id in (select id from public.employees where user_id = auth.uid())
  );

drop policy if exists "attendance_issues_review" on public.attendance_issues;
create policy "attendance_issues_review" on public.attendance_issues
  for update using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager')
  );

-- ============================================================
-- 12. ATTENDANCE CONFIGURATION — configurable work schedule
-- ============================================================
create table if not exists public.attendance_config (
  id int primary key default 1 check (id = 1),
  expected_start_time text default '08:00',
  expected_end_time text default '17:00',
  grace_period_minutes int default 15,
  late_threshold_time text default '08:16',
  working_days text[] default array['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz default now()
);

alter table public.attendance_config enable row level security;

drop policy if exists "attendance_config_read" on public.attendance_config;
create policy "attendance_config_read" on public.attendance_config
  for select using (auth.role() = 'authenticated');

drop policy if exists "attendance_config_manage" on public.attendance_config;
create policy "attendance_config_manage" on public.attendance_config
  for update using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager')
  )
  with check (
    public.current_role() in ('super_admin', 'admin', 'hr_manager')
  );

-- Seed default config row
insert into public.attendance_config (id, expected_start_time, expected_end_time, grace_period_minutes, late_threshold_time)
values (1, '08:00', '17:00', 15, '08:16')
on conflict (id) do nothing;

-- ============================================================
-- 13. USER APPROVAL RPCs — server-side authorization
-- ============================================================

-- Approve a pending user: set status='active', assign role, department, access
create or replace function public.approve_user(
  p_user_id uuid,
  p_role text default 'customer',
  p_department text default null,
  p_modules jsonb default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  actor_role text := public.current_role();
  actor_name text;
  v_prev_status text;
  v_prev_role text;
  promoter_roles text[] := array['super_admin', 'admin', 'hr_manager', 'area_manager', 'branch_manager'];
begin
  if not (actor_role = any(promoter_roles)) then
    raise exception 'Not authorized to approve users';
  end if;

  -- Enforce role assignment hierarchy (same rules as enforce_role_change_policy)
  if p_role = 'super_admin' and actor_role <> 'super_admin' then
    raise exception 'Only super_admin can assign the super_admin role';
  end if;
  if p_role = 'admin' and actor_role not in ('super_admin', 'admin') then
    raise exception 'Only super_admin or admin can assign the admin role';
  end if;
  if p_role in ('area_manager', 'head_of_business') and actor_role not in ('super_admin', 'admin') then
    raise exception 'Only super_admin or admin can assign this role';
  end if;
  if actor_role = 'branch_manager' and p_role not in ('staff', 'loan_officer', 'relationship_manager', 'customer_service') then
    raise exception 'Branch Manager is not authorized to assign this role';
  end if;

  select status, role into v_prev_status, v_prev_role
  from public.profiles where id = p_user_id for update;

  if v_prev_status is null then
    raise exception 'User not found';
  end if;

  select coalesce(full_name, email) into actor_name
  from public.profiles where id = auth.uid();

  -- Update profile — role change goes through the trigger
  update public.profiles
  set status = 'active',
      role = p_role,
      department = p_department,
      approved_by = auth.uid(),
      approved_at = now(),
      rejected_reason = null
  where id = p_user_id;

  -- Upsert access profile
  if p_modules is not null then
    insert into public.user_access_profiles (user_id, modules, granted_by, granted_at, updated_at)
    values (p_user_id, p_modules, auth.uid(), now(), now())
    on conflict (user_id) do update
    set modules = excluded.modules,
        granted_by = auth.uid(),
        granted_at = now(),
        updated_at = now();
  end if;

  -- Audit trail
  insert into public.user_approval_audit (user_id, action, previous_status, new_status, previous_role, new_role, department, approver_id, approver_name)
  values (p_user_id, 'USER_APPROVED', v_prev_status, 'active', v_prev_role, p_role, p_department, auth.uid(), actor_name);

  if v_prev_role is distinct from p_role then
    insert into public.user_approval_audit (user_id, action, previous_role, new_role, approver_id, approver_name)
    values (p_user_id, 'USER_ROLE_CHANGED', v_prev_role, p_role, auth.uid(), actor_name);
  end if;

  if p_department is not null then
    insert into public.user_approval_audit (user_id, action, department, approver_id, approver_name)
    values (p_user_id, 'USER_DEPARTMENT_CHANGED', p_department, auth.uid(), actor_name);
  end if;

  if p_modules is not null then
    insert into public.user_approval_audit (user_id, action, approver_id, approver_name)
    values (p_user_id, 'USER_ACCESS_CHANGED', auth.uid(), actor_name);
  end if;

  -- Also log to audit_logs for the existing audit trail
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('USER_APPROVED', 'User', p_user_id::text, actor_name,
          format('User approved: role=%s, department=%s', p_role, coalesce(p_department, 'none')), 'critical');

  return jsonb_build_object('ok', true);
end; $$;

grant execute on function public.approve_user(uuid, text, text, jsonb) to authenticated;

-- Reject a pending user
create or replace function public.reject_user(
  p_user_id uuid,
  p_reason text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  actor_role text := public.current_role();
  actor_name text;
  v_prev_status text;
  promoter_roles text[] := array['super_admin', 'admin', 'hr_manager'];
begin
  if not (actor_role = any(promoter_roles)) then
    raise exception 'Not authorized to reject users';
  end if;

  select status into v_prev_status from public.profiles where id = p_user_id for update;
  if v_prev_status is null then
    raise exception 'User not found';
  end if;

  select coalesce(full_name, email) into actor_name from public.profiles where id = auth.uid();

  update public.profiles
  set status = 'rejected', rejected_reason = p_reason
  where id = p_user_id;

  insert into public.user_approval_audit (user_id, action, previous_status, new_status, approver_id, approver_name, reason)
  values (p_user_id, 'USER_REJECTED', v_prev_status, 'rejected', auth.uid(), actor_name, p_reason);

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('USER_REJECTED', 'User', p_user_id::text, actor_name,
          format('User rejected: %s', coalesce(p_reason, 'no reason given')), 'critical');

  return jsonb_build_object('ok', true);
end; $$;

grant execute on function public.reject_user(uuid, text) to authenticated;

-- Suspend a user
create or replace function public.suspend_user(
  p_user_id uuid,
  p_reason text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  actor_role text := public.current_role();
  actor_name text;
  v_prev_status text;
  promoter_roles text[] := array['super_admin', 'admin', 'hr_manager'];
begin
  if not (actor_role = any(promoter_roles)) then
    raise exception 'Not authorized to suspend users';
  end if;

  select status into v_prev_status from public.profiles where id = p_user_id for update;
  if v_prev_status is null then
    raise exception 'User not found';
  end if;

  select coalesce(full_name, email) into actor_name from public.profiles where id = auth.uid();

  update public.profiles set status = 'suspended', rejected_reason = p_reason
  where id = p_user_id;

  insert into public.user_approval_audit (user_id, action, previous_status, new_status, approver_id, approver_name, reason)
  values (p_user_id, 'USER_SUSPENDED', v_prev_status, 'suspended', auth.uid(), actor_name, p_reason);

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('USER_SUSPENDED', 'User', p_user_id::text, actor_name, coalesce(p_reason, 'no reason'), 'critical');

  return jsonb_build_object('ok', true);
end; $$;

grant execute on function public.suspend_user(uuid, text) to authenticated;

-- Activate a suspended/rejected user
create or replace function public.activate_user(
  p_user_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  actor_role text := public.current_role();
  actor_name text;
  v_prev_status text;
  promoter_roles text[] := array['super_admin', 'admin', 'hr_manager'];
begin
  if not (actor_role = any(promoter_roles)) then
    raise exception 'Not authorized to activate users';
  end if;

  select status into v_prev_status from public.profiles where id = p_user_id for update;
  if v_prev_status is null then
    raise exception 'User not found';
  end if;

  select coalesce(full_name, email) into actor_name from public.profiles where id = auth.uid();

  update public.profiles set status = 'active', rejected_reason = null
  where id = p_user_id;

  insert into public.user_approval_audit (user_id, action, previous_status, new_status, approver_id, approver_name)
  values (p_user_id, 'USER_ACTIVATED', v_prev_status, 'active', auth.uid(), actor_name);

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('USER_ACTIVATED', 'User', p_user_id::text, actor_name, 'User activated', 'info');

  return jsonb_build_object('ok', true);
end; $$;

grant execute on function public.activate_user(uuid) to authenticated;

-- Update user access modules
create or replace function public.update_user_access(
  p_user_id uuid,
  p_modules jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  actor_role text := public.current_role();
  actor_name text;
  promoter_roles text[] := array['super_admin', 'admin', 'hr_manager'];
begin
  if not (actor_role = any(promoter_roles)) then
    raise exception 'Not authorized to change user access';
  end if;

  select coalesce(full_name, email) into actor_name from public.profiles where id = auth.uid();

  insert into public.user_access_profiles (user_id, modules, granted_by, granted_at, updated_at)
  values (p_user_id, p_modules, auth.uid(), now(), now())
  on conflict (user_id) do update
  set modules = excluded.modules,
      granted_by = auth.uid(),
      granted_at = now(),
      updated_at = now();

  insert into public.user_approval_audit (user_id, action, approver_id, approver_name)
  values (p_user_id, 'USER_ACCESS_CHANGED', auth.uid(), actor_name);

  return jsonb_build_object('ok', true);
end; $$;

grant execute on function public.update_user_access(uuid, jsonb) to authenticated;

-- ============================================================
-- 14. PROFILES RLS — update policies to include super_admin
--    and allow status reads for HR managers
-- ============================================================
drop policy if exists "profiles read own or admin" on public.profiles;
create policy "profiles read own or admin" on public.profiles
  for select using (
    auth.uid() = id
    or public.current_role() in ('admin', 'super_admin', 'hr_manager')
  );

drop policy if exists "profiles update own or admin" on public.profiles;
create policy "profiles update own or admin" on public.profiles
  for update using (
    auth.uid() = id
    or public.current_role() in ('admin', 'super_admin', 'hr_manager')
  )
  with check (
    auth.uid() = id
    or public.current_role() in ('admin', 'super_admin', 'hr_manager')
  );

-- ============================================================
-- 15. NEW PERMISSIONS — work management
-- ============================================================
insert into public.permissions (permission_key, description, category)
values
  ('work.tasks.manage', 'Create and assign tasks to staff', 'hr'),
  ('work.kpis.manage', 'Create and assign KPIs', 'hr'),
  ('work.targets.manage', 'Create and assign targets', 'hr'),
  ('work.plans.manage', 'Create and manage work plans', 'hr'),
  ('work.reports.review', 'Review and approve work reports', 'hr'),
  ('work.team.performance', 'View team performance', 'hr'),
  ('attendance.config.manage', 'Configure attendance settings', 'admin')
on conflict (permission_key) do nothing;

-- Assign new permissions to management roles
do $$
declare
  r text;
begin
  foreach r in array array['super_admin', 'admin']
  loop
    perform public.assign_permission_to_role(r, 'work.tasks.manage');
    perform public.assign_permission_to_role(r, 'work.kpis.manage');
    perform public.assign_permission_to_role(r, 'work.targets.manage');
    perform public.assign_permission_to_role(r, 'work.plans.manage');
    perform public.assign_permission_to_role(r, 'work.reports.review');
    perform public.assign_permission_to_role(r, 'work.team.performance');
    perform public.assign_permission_to_role(r, 'attendance.config.manage');
  end loop;

  foreach r in array array['hr_manager', 'area_manager', 'branch_manager']
  loop
    perform public.assign_permission_to_role(r, 'work.tasks.manage');
    perform public.assign_permission_to_role(r, 'work.kpis.manage');
    perform public.assign_permission_to_role(r, 'work.targets.manage');
    perform public.assign_permission_to_role(r, 'work.plans.manage');
    perform public.assign_permission_to_role(r, 'work.reports.review');
    perform public.assign_permission_to_role(r, 'work.team.performance');
  end loop;

  foreach r in array array['hr_officer']
  loop
    perform public.assign_permission_to_role(r, 'work.tasks.manage');
    perform public.assign_permission_to_role(r, 'work.reports.review');
  end loop;
end $$;

-- ============================================================
-- DONE. All objects are additive. Re-running is safe.
-- ============================================================
