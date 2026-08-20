-- ============================================================
-- PHASE 2: PLATFORM NAVIGATION / HR OPERATIONS MIGRATIONS
-- ============================================================
-- Run after schema.sql and schema_phase1_migrations.sql.
-- Adds operational tables used by the expanded InfinityCore modules.
-- ============================================================

-- Allow the expanded role model in profiles.role.
alter table public.profiles
  drop constraint if exists profiles_role_check;

alter table public.profiles
  add constraint profiles_role_check
  check (role in (
    'super_admin',
    'admin',
    'branch_manager',
    'operations_manager',
    'loan_officer',
    'relationship_manager',
    'customer_service',
    'hr_manager',
    'hr_officer',
    'staff',
    'customer'
  ));

-- Make the designated owner account a super admin.
update public.profiles
set role = 'super_admin'
where lower(email) = 'tamunosikiiwolomaclinton@gmail.com';

-- Current role helper should preserve all expanded role values.
create or replace function public.current_role()
returns text language sql stable as $$
  select coalesce((select role from public.profiles where id = auth.uid()), 'staff');
$$;

-- Branch directory.
create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  branch_name text not null,
  branch_code text unique,
  manager_name text,
  manager_id uuid references auth.users(id) on delete set null,
  location text,
  status text default 'active' check (status in ('active', 'inactive', 'closed')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.branches enable row level security;

create index if not exists idx_branches_status on public.branches(status);
create index if not exists idx_branches_code on public.branches(branch_code);

-- Link employees to branches without breaking existing rows.
alter table public.employees
  add column if not exists branch text,
  add column if not exists branch_id uuid references public.branches(id) on delete set null;

-- Payroll records.
create table if not exists public.payroll (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references public.employees(id) on delete set null,
  employee_name text,
  salary numeric(12, 2) default 0,
  allowances numeric(12, 2) default 0,
  deductions numeric(12, 2) default 0,
  net_pay numeric(12, 2) generated always as (coalesce(salary, 0) + coalesce(allowances, 0) - coalesce(deductions, 0)) stored,
  payroll_period text,
  period_start date,
  period_end date,
  status text default 'draft' check (status in ('draft', 'pending', 'approved', 'processed', 'paid', 'cancelled')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.payroll enable row level security;

create index if not exists idx_payroll_employee on public.payroll(employee_id);
create index if not exists idx_payroll_status on public.payroll(status);
create index if not exists idx_payroll_period on public.payroll(payroll_period);

-- Offer letters.
create table if not exists public.offer_letters (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references public.hr_candidates(id) on delete set null,
  candidate_name text,
  position text,
  salary numeric(12, 2) default 0,
  employment_type text check (employment_type in ('full_time', 'part_time', 'contract', 'intern')),
  status text default 'draft' check (status in ('draft', 'issued', 'accepted', 'declined', 'withdrawn')),
  issue_date date,
  approval_status text default 'pending' check (approval_status in ('pending', 'approved', 'rejected')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.offer_letters enable row level security;

create index if not exists idx_offer_letters_candidate on public.offer_letters(candidate_id);
create index if not exists idx_offer_letters_status on public.offer_letters(status);
create index if not exists idx_offer_letters_approval on public.offer_letters(approval_status);

-- Add permissions for the expanded modules.
alter table public.permissions
  drop constraint if exists permissions_category_check;

alter table public.permissions
  add constraint permissions_category_check
  check (category in ('customers', 'loans', 'documents', 'hr', 'admin', 'support', 'branches', 'reports'));

insert into public.permissions (permission_key, description, category)
values
  ('hr.payroll.read', 'Read payroll records', 'hr'),
  ('hr.offer_letters.read', 'Read offer letters', 'hr'),
  ('branches.read', 'Read branch records', 'branches'),
  ('reports.read', 'Read operational reports', 'reports')
on conflict (permission_key) do nothing;

do $$
declare
  permission_key text;
begin
  foreach permission_key in array array['hr.payroll.read', 'hr.offer_letters.read', 'branches.read', 'reports.read']
  loop
    perform public.assign_permission_to_role('super_admin', permission_key);
    perform public.assign_permission_to_role('admin', permission_key);
  end loop;

  perform public.assign_permission_to_role('hr_manager', 'hr.payroll.read');
  perform public.assign_permission_to_role('hr_manager', 'hr.offer_letters.read');
  perform public.assign_permission_to_role('hr_manager', 'branches.read');
  perform public.assign_permission_to_role('hr_manager', 'reports.read');
  perform public.assign_permission_to_role('hr_officer', 'hr.offer_letters.read');
  perform public.assign_permission_to_role('branch_manager', 'branches.read');
  perform public.assign_permission_to_role('branch_manager', 'reports.read');
end $$;

alter table public.documents
  drop constraint if exists documents_entity_type_check;

alter table public.documents
  add constraint documents_entity_type_check
  check (entity_type in ('customer', 'loan_application', 'hr_candidate', 'support_case', 'employee', 'offer_letter'));

-- RLS for expanded roles.
drop policy if exists "branches_read_authorized" on public.branches;
create policy "branches_read_authorized" on public.branches
  for select using (public.current_role() in ('super_admin', 'admin', 'branch_manager', 'operations_manager', 'hr_manager'));

drop policy if exists "branches_manage_admin" on public.branches;
create policy "branches_manage_admin" on public.branches
  for all using (public.current_role() in ('super_admin', 'admin'))
  with check (public.current_role() in ('super_admin', 'admin'));

drop policy if exists "payroll_read_hr_admin" on public.payroll;
create policy "payroll_read_hr_admin" on public.payroll
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager'));

drop policy if exists "payroll_manage_admin_hr_manager" on public.payroll;
create policy "payroll_manage_admin_hr_manager" on public.payroll
  for all using (public.current_role() in ('super_admin', 'admin', 'hr_manager'))
  with check (public.current_role() in ('super_admin', 'admin', 'hr_manager'));

drop policy if exists "offer_letters_read_hr_admin" on public.offer_letters;
create policy "offer_letters_read_hr_admin" on public.offer_letters
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

drop policy if exists "offer_letters_manage_hr_admin" on public.offer_letters;
create policy "offer_letters_manage_hr_admin" on public.offer_letters
  for all using (public.current_role() in ('super_admin', 'admin', 'hr_manager'))
  with check (public.current_role() in ('super_admin', 'admin', 'hr_manager'));

-- Existing Phase 1 policies often mention admin but not super_admin.
-- Add companion policies for super_admin without removing existing policies.
drop policy if exists "profiles_super_admin_all" on public.profiles;
create policy "profiles_super_admin_all" on public.profiles
  for all using (public.current_role() = 'super_admin')
  with check (public.current_role() = 'super_admin');

drop policy if exists "audit_super_admin_read" on public.audit_logs;
create policy "audit_super_admin_read" on public.audit_logs
  for select using (public.current_role() = 'super_admin');

drop policy if exists "roles_super_admin_read" on public.roles;
create policy "roles_super_admin_read" on public.roles
  for select using (public.current_role() = 'super_admin');

drop policy if exists "permissions_super_admin_read" on public.permissions;
create policy "permissions_super_admin_read" on public.permissions
  for select using (public.current_role() = 'super_admin');

drop policy if exists "role_permissions_super_admin_read" on public.role_permissions;
create policy "role_permissions_super_admin_read" on public.role_permissions
  for select using (public.current_role() = 'super_admin');
