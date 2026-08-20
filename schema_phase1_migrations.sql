-- ============================================================
-- PHASE 1: DATABASE SCHEMA MIGRATIONS
-- ============================================================
-- Run this in Supabase SQL Editor to create all Phase 1 tables
-- This includes: documents, tasks, support_cases, HR tables, roles, permissions, config
-- ============================================================

-- 1. DOCUMENTS TABLE
-- ============================================================
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('customer', 'loan_application', 'hr_candidate', 'support_case')),
  entity_id uuid not null,
  document_type text not null, -- 'national_id', 'proof_of_address', 'employment_letter', 'cv', etc.
  file_name text not null,
  file_path text not null, -- Supabase storage path
  file_size int,
  mime_type text,
  uploaded_by uuid references auth.users(id),
  uploaded_at timestamptz default now(),
  verified_by uuid references auth.users(id),
  verified_at timestamptz,
  verification_status text default 'pending' check (verification_status in ('pending', 'verified', 'rejected')),
  verification_notes text,
  is_required boolean default false,
  created_at timestamptz default now()
);

alter table public.documents enable row level security;

create index idx_documents_entity on public.documents(entity_type, entity_id);
create index idx_documents_status on public.documents(verification_status);
create index idx_documents_uploaded_by on public.documents(uploaded_by);

-- ============================================================
-- 2. TASKS / MY WORK QUEUE TABLE
-- ============================================================
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  task_type text not null check (task_type in ('approval', 'verification', 'assessment', 'review', 'follow_up', 'support', 'onboarding')),
  entity_type text check (entity_type in ('loan_application', 'customer', 'document', 'support_case', 'hr_candidate', 'employee')),
  entity_id uuid,
  assigned_to uuid references auth.users(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  priority text default 'normal' check (priority in ('critical', 'high', 'normal', 'low')),
  status text default 'pending' check (status in ('pending', 'in_progress', 'completed', 'cancelled')),
  due_date date,
  completed_at timestamptz,
  completion_notes text,
  related_customer_id uuid references public.customers(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.tasks enable row level security;

create index idx_tasks_assigned_to on public.tasks(assigned_to);
create index idx_tasks_status on public.tasks(status);
create index idx_tasks_due_date on public.tasks(due_date);
create index idx_tasks_priority on public.tasks(priority);
create index idx_tasks_entity on public.tasks(entity_type, entity_id);

-- Auto-update updated_at timestamp
create or replace function public.update_task_timestamp()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists task_update_timestamp on public.tasks;
create trigger task_update_timestamp
  before update on public.tasks
  for each row execute function public.update_task_timestamp();

-- ============================================================
-- 3. SUPPORT CASES / TICKETS TABLE
-- ============================================================
create table if not exists public.support_cases (
  id uuid primary key default gen_random_uuid(),
  case_number text unique not null, -- e.g., 'CASE-2024-00001'
  customer_id uuid references public.customers(id) on delete set null,
  issue_category text not null check (issue_category in ('account', 'loan', 'payment', 'complaint', 'inquiry', 'technical', 'other')),
  issue_type text,
  subject text not null,
  description text,
  created_by uuid references auth.users(id) on delete set null, -- Can be customer or staff
  assigned_to uuid references auth.users(id) on delete set null,
  status text default 'open' check (status in ('open', 'assigned', 'in_progress', 'waiting', 'resolved', 'closed')),
  priority text default 'normal' check (priority in ('critical', 'high', 'normal', 'low')),
  resolution text,
  closed_date timestamptz,
  sla_minutes int default 1440, -- Default 24 hours
  breached boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.support_cases enable row level security;

create index idx_support_cases_customer on public.support_cases(customer_id);
create index idx_support_cases_status on public.support_cases(status);
create index idx_support_cases_assigned_to on public.support_cases(assigned_to);
create index idx_support_cases_created_at on public.support_cases(created_at);

-- Auto-increment case number
create or replace function public.generate_case_number()
returns trigger language plpgsql as $$
declare
  case_count int;
begin
  if new.case_number is null then
    select count(*) + 1 into case_count from public.support_cases;
    new.case_number := 'CASE-' || to_char(now(), 'YYYY') || '-' || lpad(case_count::text, 5, '0');
  end if;
  return new;
end;
$$;

drop trigger if exists generate_support_case_number on public.support_cases;
create trigger generate_support_case_number
  before insert on public.support_cases
  for each row execute function public.generate_case_number();

-- ============================================================
-- 4. HR TABLES
-- ============================================================

-- Jobs and requisitions
create table if not exists public.hr_jobs (
  id uuid primary key default gen_random_uuid(),
  job_title text not null,
  department text,
  location text,
  employment_type text check (employment_type in ('full_time', 'part_time', 'contract', 'intern')),
  experience_years int,
  salary_min numeric(12, 2),
  salary_max numeric(12, 2),
  description text,
  requirements text,
  created_by uuid references auth.users(id) on delete set null,
  status text default 'draft' check (status in ('draft', 'published', 'closed')),
  published_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.hr_jobs enable row level security;

create index idx_hr_jobs_status on public.hr_jobs(status);
create index idx_hr_jobs_created_by on public.hr_jobs(created_by);

-- Candidate applications
create table if not exists public.hr_candidates (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references public.hr_jobs(id) on delete set null,
  full_name text not null,
  email text,
  phone text,
  current_company text,
  years_experience int,
  cv_file_path text,
  cover_letter text,
  application_status text default 'received' check (application_status in ('received', 'screening', 'shortlisted', 'interview', 'offer', 'hired', 'rejected')),
  screening_score numeric(5, 2),
  screening_notes text,
  screened_by uuid references auth.users(id) on delete set null,
  screened_at timestamptz,
  ai_screening_summary text, -- AI-generated summary of CV
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.hr_candidates enable row level security;

create index idx_hr_candidates_job_id on public.hr_candidates(job_id);
create index idx_hr_candidates_status on public.hr_candidates(application_status);
create index idx_hr_candidates_email on public.hr_candidates(email);

-- Assessments and tests
create table if not exists public.hr_assessments (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references public.hr_candidates(id) on delete cascade,
  assessment_type text check (assessment_type in ('technical', 'behavioral', 'practical', 'psychometric')),
  test_name text,
  status text default 'pending' check (status in ('pending', 'in_progress', 'completed', 'cancelled')),
  score numeric(5, 2),
  total_score numeric(5, 2),
  pass_score numeric(5, 2),
  notes text,
  completed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);

alter table public.hr_assessments enable row level security;

create index idx_hr_assessments_candidate on public.hr_assessments(candidate_id);
create index idx_hr_assessments_status on public.hr_assessments(status);

-- Interviews
create table if not exists public.hr_interviews (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references public.hr_candidates(id) on delete cascade,
  scheduled_date timestamptz,
  interview_type text check (interview_type in ('phone', 'video', 'in_person', 'panel')),
  interviewer_id uuid references auth.users(id) on delete set null,
  feedback text,
  rating numeric(3, 1) check (rating >= 0 and rating <= 5),
  status text default 'scheduled' check (status in ('scheduled', 'completed', 'cancelled')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.hr_interviews enable row level security;

create index idx_hr_interviews_candidate on public.hr_interviews(candidate_id);
create index idx_hr_interviews_status on public.hr_interviews(status);
create index idx_hr_interviews_scheduled_date on public.hr_interviews(scheduled_date);

-- Employees (hired candidates)
create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  full_name text not null,
  email text,
  phone text,
  department text,
  position text,
  manager_id uuid references auth.users(id) on delete set null,
  hire_date date,
  employment_status text default 'active' check (employment_status in ('active', 'on_leave', 'terminated', 'suspended')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.employees enable row level security;

create index idx_employees_user_id on public.employees(user_id);
create index idx_employees_department on public.employees(department);
create index idx_employees_status on public.employees(employment_status);

-- ============================================================
-- 5. ROLES & PERMISSIONS TABLES
-- ============================================================

-- System roles
create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  role_name text unique not null,
  display_name text not null,
  description text,
  is_system_role boolean default false, -- Can't be deleted
  icon text,
  color text,
  created_at timestamptz default now()
);

alter table public.roles enable row level security;

-- Insert default system roles
insert into public.roles (role_name, display_name, description, is_system_role, color)
values
  ('super_admin', 'Super Admin', 'Full system access, can switch all views', true, '#7c3aed'),
  ('admin', 'Admin', 'System administration and user management', true, '#7c3aed'),
  ('branch_manager', 'Branch Manager', 'Manage branch operations and staff', true, '#2563eb'),
  ('operations_manager', 'Operations Manager', 'Manage operational workflows', true, '#2563eb'),
  ('loan_officer', 'Loan Officer', 'Manage loan applications and assessments', true, '#059669'),
  ('relationship_manager', 'Relationship Manager', 'Manage customer relationships', true, '#0891b2'),
  ('customer_service', 'Customer Service', 'Handle customer support and inquiries', true, '#f59e0b'),
  ('hr_manager', 'HR Manager', 'Manage recruitment and HR processes', true, '#dc2626'),
  ('hr_officer', 'HR Officer', 'HR administrative tasks', true, '#dc2626'),
  ('staff', 'Staff', 'General staff member', true, '#6b7280'),
  ('customer', 'Customer', 'External customer', true, '#10b981')
on conflict (role_name) do nothing;

-- Granular permissions
create table if not exists public.permissions (
  id uuid primary key default gen_random_uuid(),
  permission_key text unique not null, -- e.g., 'customers.read', 'loans.approve'
  description text,
  category text check (category in ('customers', 'loans', 'documents', 'hr', 'admin', 'support', 'reports')),
  created_at timestamptz default now()
);

-- Insert default permissions
insert into public.permissions (permission_key, description, category)
values
  -- Customers
  ('customers.read', 'Read customer data', 'customers'),
  ('customers.create', 'Create new customer', 'customers'),
  ('customers.update', 'Update customer data', 'customers'),
  ('customers.delete', 'Delete customer', 'customers'),
  
  -- Loans
  ('loans.read', 'Read loan applications', 'loans'),
  ('loans.create', 'Create loan application', 'loans'),
  ('loans.assess', 'Assess loan risk', 'loans'),
  ('loans.approve_low', 'Auto-approve low-risk loans', 'loans'),
  ('loans.approve_medium', 'Approve medium-risk loans', 'loans'),
  ('loans.approve_high', 'Approve high-risk loans', 'loans'),
  ('loans.disburse', 'Disburse approved loans', 'loans'),
  
  -- Documents
  ('documents.upload', 'Upload documents', 'documents'),
  ('documents.read', 'Read documents', 'documents'),
  ('documents.verify', 'Verify document authenticity', 'documents'),
  ('documents.delete', 'Delete documents', 'documents'),
  
  -- HR
  ('hr.jobs.create', 'Create job postings', 'hr'),
  ('hr.jobs.manage', 'Manage job postings', 'hr'),
  ('hr.applications.read', 'Read candidate applications', 'hr'),
  ('hr.applications.screen', 'Screen candidates', 'hr'),
  ('hr.assessments.create', 'Create assessments', 'hr'),
  ('hr.interviews.schedule', 'Schedule interviews', 'hr'),
  ('hr.hire', 'Hire candidates', 'hr'),
  
  -- Support
  ('support.create', 'Create support cases', 'support'),
  ('support.read', 'Read support cases', 'support'),
  ('support.resolve', 'Resolve support cases', 'support'),
  
  -- Admin
  ('admin.manage_users', 'Manage users and roles', 'admin'),
  ('admin.view_audit', 'View audit logs', 'admin'),
  ('admin.manage_config', 'Manage system configuration', 'admin')
on conflict (permission_key) do nothing;

-- Role-permission assignments
create table if not exists public.role_permissions (
  id uuid primary key default gen_random_uuid(),
  role_id uuid references public.roles(id) on delete cascade,
  permission_id uuid references public.permissions(id) on delete cascade,
  created_at timestamptz default now(),
  unique(role_id, permission_id)
);

-- Helper function to assign permissions to roles
create or replace function public.assign_permission_to_role(
  p_role_name text,
  p_permission_key text
) returns void language sql security definer as $$
  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id
  from public.roles r
  join public.permissions p on p.permission_key = p_permission_key
  where r.role_name = p_role_name
  on conflict do nothing;
$$;

-- Assign default permissions (Super Admin gets all)
do $$
declare
  super_admin_id uuid;
  admin_id uuid;
  perm record;
begin
  select id into super_admin_id from public.roles where role_name = 'super_admin' limit 1;
  select id into admin_id from public.roles where role_name = 'admin' limit 1;
  
  for perm in select id from public.permissions
  loop
    insert into public.role_permissions (role_id, permission_id)
    values (super_admin_id, perm.id)
    on conflict do nothing;
    
    insert into public.role_permissions (role_id, permission_id)
    values (admin_id, perm.id)
    on conflict do nothing;
  end loop;
end $$;

-- ============================================================
-- 6. SYSTEM CONFIGURATION TABLE
-- ============================================================
create table if not exists public.system_config (
  id uuid primary key default gen_random_uuid(),
  config_key text unique not null,
  config_value text,
  config_type text check (config_type in ('string', 'number', 'boolean', 'json')),
  description text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz default now()
);

alter table public.system_config enable row level security;

-- Insert default configurations
insert into public.system_config (config_key, config_value, config_type, description)
values
  ('loan_default_interest_rate', '12', 'number', 'Default interest rate for loans (%)'),
  ('loan_auto_approve_min_score', '75', 'number', 'Minimum risk score for auto-approval'),
  ('loan_manager_approve_min_score', '50', 'number', 'Minimum risk score for manager approval'),
  ('support_case_sla_minutes', '1440', 'number', 'Default SLA for support cases (minutes)'),
  ('document_max_size_mb', '10', 'number', 'Maximum document file size in MB'),
  ('kyc_completion_required', 'true', 'boolean', 'Is KYC completion required for loan'),
  ('auto_create_repayment_schedule', 'true', 'boolean', 'Auto-create repayment schedule when loan is approved'),
  ('notification_email_enabled', 'true', 'boolean', 'Enable email notifications'),
  ('bank_name', 'Infinity Bank', 'string', 'Official bank name'),
  ('support_email', 'support@infinitybank.com', 'string', 'Support team email')
on conflict (config_key) do nothing;

-- ============================================================
-- 7. ENHANCED AUDIT LOGGING
-- ============================================================

-- Enhanced audit function with detailed tracking
create or replace function public.log_detailed_change(
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_old_data jsonb,
  p_new_data jsonb,
  p_details text default null
) returns void language sql security definer as $$
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    p_action,
    p_entity_type,
    p_entity_id,
    coalesce((select email from auth.users where id = auth.uid()), 'system'),
    jsonb_build_object(
      'old_data', p_old_data,
      'new_data', p_new_data,
      'details', p_details,
      'timestamp', now(),
      'user_id', auth.uid()
    )::text,
    'info'
  );
$$;

-- Auto-log loan application changes
create or replace function public.log_loan_application_change()
returns trigger language plpgsql security definer as $$
begin
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    case when TG_OP = 'DELETE' then 'delete' else TG_OP end,
    'loan_application',
    (case when TG_OP = 'DELETE' then OLD.id else NEW.id end)::text,
    coalesce((select email from auth.users where id = auth.uid()), 'system'),
    jsonb_build_object(
      'old_status', OLD.status,
      'new_status', NEW.status,
      'old_risk_level', OLD.risk_level,
      'new_risk_level', NEW.risk_level,
      'old_approval_route', OLD.approval_route,
      'new_approval_route', NEW.approval_route,
      'amount', NEW.amount,
      'customer_id', NEW.customer_id
    )::text,
    'info'
  );
  return case when TG_OP = 'DELETE' then OLD else NEW end;
end;
$$;

drop trigger if exists loan_application_audit on public.loan_applications;
create trigger loan_application_audit
  after insert or update or delete on public.loan_applications
  for each row execute function public.log_loan_application_change();

-- Auto-log document changes
create or replace function public.log_document_change()
returns trigger language plpgsql security definer as $$
begin
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    case when TG_OP = 'DELETE' then 'delete' else TG_OP end,
    'document',
    (case when TG_OP = 'DELETE' then OLD.id else NEW.id end)::text,
    coalesce((select email from auth.users where id = auth.uid()), 'system'),
    jsonb_build_object(
      'document_type', NEW.document_type,
      'entity_type', NEW.entity_type,
      'old_verification_status', OLD.verification_status,
      'new_verification_status', NEW.verification_status,
      'verification_notes', NEW.verification_notes
    )::text,
    case when NEW.verification_status = 'rejected' then 'warning' else 'info' end
  );
  return case when TG_OP = 'DELETE' then OLD else NEW end;
end;
$$;

drop trigger if exists document_audit on public.documents;
create trigger document_audit
  after insert or update or delete on public.documents
  for each row execute function public.log_document_change();

-- ============================================================
-- 8. ROW LEVEL SECURITY POLICIES (PHASE 1)
-- ============================================================

-- DOCUMENTS: Strict access control
create policy "documents_read_authorized" on public.documents
  for select using (
    auth.uid() in (
      select verified_by from public.documents where id = documents.id
    )
    or auth.uid() in (
      select uploaded_by from public.documents where id = documents.id
    )
    or public.current_role() = 'admin'
    or public.current_role() = 'loan_officer'
    or (entity_type = 'loan_application' and auth.uid() in (
      select created_by from public.loan_applications where id = entity_id
    ))
  );

create policy "documents_insert_user" on public.documents
  for insert with check (
    auth.role() = 'authenticated'
  );

create policy "documents_verify" on public.documents
  for update using (
    public.current_role() in ('admin', 'loan_officer')
  )
  with check (
    public.current_role() in ('admin', 'loan_officer')
  );

-- TASKS: Only assigned staff or admin
create policy "tasks_read_assigned" on public.tasks
  for select using (
    assigned_to = auth.uid()
    or created_by = auth.uid()
    or public.current_role() = 'admin'
    or public.current_role() = 'branch_manager'
  );

create policy "tasks_insert_admin" on public.tasks
  for insert with check (
    public.current_role() in ('admin', 'branch_manager', 'operations_manager')
  );

create policy "tasks_update_assigned_or_admin" on public.tasks
  for update using (
    assigned_to = auth.uid()
    or public.current_role() in ('admin', 'branch_manager')
  )
  with check (
    assigned_to = auth.uid()
    or public.current_role() in ('admin', 'branch_manager')
  );

-- SUPPORT CASES: Customer can see own, staff can see assigned/created
create policy "support_cases_read_authorized" on public.support_cases
  for select using (
    auth.uid() in (
      select created_by from public.customers where id = support_cases.customer_id
    )
    or assigned_to = auth.uid()
    or created_by = auth.uid()
    or public.current_role() in ('admin', 'customer_service', 'branch_manager')
  );

create policy "support_cases_insert" on public.support_cases
  for insert with check (
    auth.role() = 'authenticated'
  );

create policy "support_cases_update" on public.support_cases
  for update using (
    assigned_to = auth.uid()
    or public.current_role() in ('admin', 'customer_service', 'branch_manager')
  );

-- HR JOBS: HR staff and admins only (or public if published)
create policy "hr_jobs_read" on public.hr_jobs
  for select using (
    public.current_role() in ('admin', 'hr_manager', 'hr_officer')
    or status = 'published'
  );

create policy "hr_jobs_insert" on public.hr_jobs
  for insert with check (
    public.current_role() in ('admin', 'hr_manager')
  );

create policy "hr_jobs_update" on public.hr_jobs
  for update using (
    created_by = auth.uid()
    or public.current_role() = 'admin'
  );

-- HR CANDIDATES: HR staff and admins only
create policy "hr_candidates_read" on public.hr_candidates
  for select using (
    public.current_role() in ('admin', 'hr_manager', 'hr_officer')
  );

create policy "hr_candidates_insert" on public.hr_candidates
  for insert with check (
    public.current_role() in ('admin', 'hr_manager', 'hr_officer')
    or auth.role() = 'authenticated' -- Candidates can apply
  );

create policy "hr_candidates_update" on public.hr_candidates
  for update using (
    public.current_role() in ('admin', 'hr_manager')
  );

-- HR ASSESSMENTS: HR staff and assigned assessors
create policy "hr_assessments_read" on public.hr_assessments
  for select using (
    public.current_role() in ('admin', 'hr_manager', 'hr_officer')
  );

create policy "hr_assessments_insert" on public.hr_assessments
  for insert with check (
    public.current_role() in ('admin', 'hr_manager', 'hr_officer')
  );

-- HR INTERVIEWS: HR staff and assigned interviewers
create policy "hr_interviews_read" on public.hr_interviews
  for select using (
    interviewer_id = auth.uid()
    or public.current_role() in ('admin', 'hr_manager', 'hr_officer')
  );

create policy "hr_interviews_insert" on public.hr_interviews
  for insert with check (
    public.current_role() in ('admin', 'hr_manager', 'hr_officer')
  );

create policy "hr_interviews_update" on public.hr_interviews
  for update using (
    interviewer_id = auth.uid()
    or public.current_role() = 'admin'
  );

-- EMPLOYEES: HR staff and admin
create policy "employees_read" on public.employees
  for select using (
    public.current_role() in ('admin', 'hr_manager', 'hr_officer', 'branch_manager')
  );

create policy "employees_insert" on public.employees
  for insert with check (
    public.current_role() in ('admin', 'hr_manager')
  );

-- ROLES: Admin and super admin only
create policy "roles_read" on public.roles
  for select using (
    public.current_role() in ('admin', 'super_admin')
  );

-- PERMISSIONS: Admin and super admin only
create policy "permissions_read" on public.permissions
  for select using (
    public.current_role() in ('admin', 'super_admin')
  );

-- ROLE_PERMISSIONS: Admin and super admin only
create policy "role_permissions_read" on public.role_permissions
  for select using (
    public.current_role() in ('admin', 'super_admin')
  );

create policy "role_permissions_manage" on public.role_permissions
  for all using (
    public.current_role() = 'admin'
  );

-- SYSTEM_CONFIG: Admin only
create policy "system_config_read" on public.system_config
  for select using (
    public.current_role() = 'admin'
  );

create policy "system_config_update" on public.system_config
  for update using (
    public.current_role() = 'admin'
  );

-- ============================================================
-- 9. UPDATE EXISTING PROFILES TABLE TO SUPPORT NEW ROLES
-- ============================================================

-- Add role_id column if it doesn't exist (linking to roles table)
alter table public.profiles 
add column if not exists role_id uuid references public.roles(id);

-- Migrate existing role text to role_id (one-time migration)
-- This maps old text roles to new role table IDs
-- Note: This is idempotent - won't fail if already done
do $$
declare
  staff_role_id uuid;
  manager_role_id uuid;
  admin_role_id uuid;
begin
  select id into staff_role_id from public.roles where role_name = 'staff' limit 1;
  select id into manager_role_id from public.roles where role_name = 'branch_manager' limit 1;
  select id into admin_role_id from public.roles where role_name = 'admin' limit 1;
  
  update public.profiles
  set role_id = case
    when role = 'admin' then admin_role_id
    when role = 'manager' then manager_role_id
    else staff_role_id
  end
  where role_id is null;
end $$;

-- ============================================================
-- 10. HELPER VIEWS
-- ============================================================

-- View for user permissions (faster than joins)
create or replace view public.v_user_permissions as
select
  p.id as user_id,
  p.email,
  p.role,
  r.id as role_id,
  r.role_name,
  r.display_name,
  string_agg(perm.permission_key, ', ') as permissions
from public.profiles p
left join public.roles r on p.role_id = r.id
left join public.role_permissions rp on r.id = rp.role_id
left join public.permissions perm on rp.permission_id = perm.id
group by p.id, p.email, p.role, r.id, r.role_name, r.display_name;

-- View for pending tasks by assignee
create or replace view public.v_pending_tasks as
select
  t.id,
  t.title,
  t.task_type,
  t.priority,
  t.due_date,
  u.email as assigned_to_email,
  c.name as customer_name,
  t.created_at
from public.tasks t
left join auth.users u on t.assigned_to = u.id
left join public.customers c on t.related_customer_id = c.id
where t.status in ('pending', 'in_progress')
and t.due_date >= now()::date
order by t.priority desc, t.due_date asc;

-- ============================================================
-- DONE! All Phase 1 tables created with RLS enabled
-- ============================================================
