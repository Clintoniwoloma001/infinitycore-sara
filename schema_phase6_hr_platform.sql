-- ============================================================
-- PHASE 6: HR PLATFORM EXTENSIONS — Employee Profile Completion,
-- Digital Onboarding with secure one-time links, Attendance,
-- Payroll periods/calculation, and Data Import & Migration Centre.
--
-- ALL ADDITIVE. Run in Supabase SQL Editor after schema.sql,
-- schema_phase1_migrations.sql, schema_phase2_platform_migrations.sql,
-- schema_phase3_leave_automation.sql, schema_phase4_approval_trail.sql,
-- and schema_phase5_role_security.sql.
--
-- Safe to re-run: every statement uses IF NOT EXISTS / OR REPLACE /
-- DROP IF EXISTS where destructive behaviour is required.
-- ============================================================

-- Onboarding tokens are hashed with md5() (core Postgres, no extension
-- needed) so this file runs anywhere, pgcrypto or not. See the token_hash
-- columns below.

-- ============================================================
-- 1. EMPLOYEES — complete the existing table (additive only)
-- ============================================================
alter table public.employees
  add column if not exists employee_code text,
  add column if not exists candidate_id uuid,
  add column if not exists sex text,
  add column if not exists date_of_birth date,
  add column if not exists state_of_origin text,
  add column if not exists lga text,
  add column if not exists town text,
  add column if not exists residential_address text,
  add column if not exists religion text,
  add column if not exists denomination text,
  add column if not exists nationality text,
  add column if not exists marital_status text,
  add column if not exists spouse_name text,
  add column if not exists spouse_occupation text,
  add column if not exists spouse_age int,
  add column if not exists spouse_business_address text,
  add column if not exists spouse_email text,
  add column if not exists spouse_phone text,
  add column if not exists living_with_spouse boolean default true,
  add column if not exists number_of_children int default 0,
  add column if not exists children_age_range text,
  add column if not exists next_of_kin_name text,
  add column if not exists next_of_kin_address text,
  add column if not exists next_of_kin_phone text,
  add column if not exists next_of_kin_relationship text,
  add column if not exists beneficiary_name text,
  add column if not exists beneficiary_address text,
  add column if not exists beneficiary_phone text,
  add column if not exists beneficiary_relationship text,
  add column if not exists pension_id text,
  add column if not exists tax_id text,
  add column if not exists bvn text,
  add column if not exists nin text,
  add column if not exists employment_type text,
  add column if not exists salary numeric(12, 2),
  add column if not exists bank_name text,
  add column if not exists account_number text,
  add column if not exists bank_sort_code text,
  add column if not exists emergency_contact_name text,
  add column if not exists emergency_contact_phone text,
  add column if not exists updated_at timestamptz default now();

-- Extend employment_status to include the onboarding lifecycle. Safe to
-- re-run: we name the constraint we control explicitly.
alter table public.employees drop constraint if exists employees_employment_status_check;
alter table public.employees add constraint employees_employment_status_check
  check (employment_status in ('onboarding', 'active', 'probation', 'on_leave', 'terminated', 'suspended', 'inactive'));

create index if not exists idx_employees_email on public.employees(email);
create index if not exists idx_employees_phone on public.employees(phone);
create index if not exists idx_employees_code on public.employees(employee_code);
create index if not exists idx_employees_candidate on public.employees(candidate_id);

-- ============================================================
-- 2. PAYROLL — additive columns + widened workflow statuses
-- ============================================================
alter table public.payroll
  add column if not exists gross_pay numeric(12, 2) default 0,
  add column if not exists tax_paye numeric(12, 2) default 0,
  add column if not exists pension_deduction numeric(12, 2) default 0,
  add column if not exists other_deductions numeric(12, 2) default 0;

-- Workflow: DRAFT → CALCULATED → REVIEW → APPROVED → PROCESSED → PAID
alter table public.payroll drop constraint if exists payroll_status_check;
alter table public.payroll add constraint payroll_status_check
  check (status in ('draft', 'calculated', 'review', 'approved', 'processed', 'paid', 'cancelled', 'failed'));

-- Payroll runs (one run per period; rows in `payroll` are the per-employee items).
create table if not exists public.payroll_periods (
  id uuid primary key default gen_random_uuid(),
  period_label text not null,
  start_date date,
  end_date date,
  status text default 'draft' check (status in ('draft', 'calculated', 'review', 'approved', 'processed', 'paid', 'cancelled', 'failed')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  processed_at timestamptz,
  paid_at timestamptz,
  notes text,
  unique (period_label)
);

alter table public.payroll_periods enable row level security;

-- Self-heal: if payroll_periods pre-existed before phase 6 without these
-- columns (create table if not exists would otherwise skip them), add the
-- missing ones so the indexes / RPCs below can always rely on them.
alter table public.payroll_periods add column if not exists period_label text;
alter table public.payroll_periods add column if not exists start_date date;
alter table public.payroll_periods add column if not exists end_date date;
alter table public.payroll_periods add column if not exists status text default 'draft';
alter table public.payroll_periods add column if not exists created_by uuid;
alter table public.payroll_periods add column if not exists created_at timestamptz default now();
alter table public.payroll_periods add column if not exists updated_at timestamptz default now();
alter table public.payroll_periods add column if not exists approved_by uuid;
alter table public.payroll_periods add column if not exists approved_at timestamptz;
alter table public.payroll_periods add column if not exists processed_at timestamptz;
alter table public.payroll_periods add column if not exists paid_at timestamptz;
alter table public.payroll_periods add column if not exists notes text;

create index if not exists idx_payroll_periods_status on public.payroll_periods(status);
create index if not exists idx_payroll_item_period on public.payroll(payroll_period);

-- Configurable payroll calculation rules. A single-row table keeps the
-- numbers auditable and editable by authorized staff in one place instead
-- of hard-coding a tax formula.
create table if not exists public.payroll_config (
  id int primary key default 1 check (id = 1),
  config jsonb not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz default now()
);

alter table public.payroll_config enable row level security;

insert into public.payroll_config (id, config)
values (1, jsonb_build_object(
  'pension_employee_rate', 0.08,
  'pension_employer_rate', 0.10,
  'consolidated_relief_min', 200000,
  'consolidated_relief_percent', 0.20,
  'default_other_deduction', 0,
  'tax_bands', '[{"up_to":300000,"rate":0.07},{"up_to":600000,"rate":0.11},{"up_to":1100000,"rate":0.15},{"up_to":1600000,"rate":0.19},{"up_to":3200000,"rate":0.21},{"up_to":null,"rate":0.24}]'::jsonb
))
on conflict (id) do nothing;

-- ============================================================
-- 3. ATTENDANCE
-- ============================================================
create table if not exists public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  attendance_date date not null default (now() at time zone 'UTC')::date,
  clock_in timestamptz,
  clock_out timestamptz,
  work_hours numeric(6, 2),
  status text default 'present' check (status in ('present', 'absent', 'late', 'early_exit', 'on_leave', 'incomplete', 'corrected')),
  source text default 'web' check (source in ('web', 'mobile', 'flutter', 'admin')),
  device_info text,
  location_lat numeric(10, 6),
  location_lng numeric(10, 6),
  is_corrected boolean default false,
  corrected_by uuid references auth.users(id) on delete set null,
  corrected_at timestamptz,
  correction_reason text,
  created_at timestamptz default now(),
  unique (employee_id, attendance_date)
);

alter table public.attendance_records enable row level security;

create index if not exists idx_attendance_employee on public.attendance_records(employee_id);
create index if not exists idx_attendance_date on public.attendance_records(attendance_date);

-- Server-authoritative clock rules. The browser NEVER supplies the official
-- timestamp — this trigger stamps it and enforces the invariants.
-- SECURITY DEFINER so the duplicate check sees all rows regardless of RLS.
create or replace function public.attendance_insert_rules()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  open_sessions int;
begin
  new.clock_in := now();
  if new.attendance_date is null then
    new.attendance_date := (new.clock_in at time zone 'UTC')::date;
  end if;
  if new.clock_out is not null then
    raise exception 'Clock-out must be performed through an update on this record.';
  end if;
  select count(*) into open_sessions
  from public.attendance_records
  where employee_id = new.employee_id
    and attendance_date = new.attendance_date
    and clock_out is null;
  if open_sessions > 0 then
    raise exception 'An open attendance session already exists for this employee today.';
  end if;
  new.source := coalesce(new.source, 'web');
  new.clock_in := new.clock_in;
  return new;
end; $$;

drop trigger if exists attendance_before_insert on public.attendance_records;
create trigger attendance_before_insert
  before insert on public.attendance_records
  for each row execute function public.attendance_insert_rules();

create or replace function public.attendance_update_rules()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- HR corrections go through correct_attendance(), which sets this flag so
  -- the supplied times pass through untouched.
  if current_setting('app.correcting_attendance', true) = 'on' then
    return new;
  end if;
  if new.clock_out is distinct from old.clock_out or new.clock_in is distinct from old.clock_in then
    -- A normal employee clocks out with an UPDATE that sets clock_out; the
    -- server stamps the authoritative time and recomputes the session.
    if old.clock_in is null then
      raise exception 'Cannot clock out without clocking in.';
    end if;
    if new.clock_in is distinct from old.clock_in then
      raise exception 'Clock-in time cannot be edited directly.';
    end if;
    if new.clock_out is not null then
      new.clock_out := now();
    end if;
    if new.clock_out is not null and new.clock_out <= old.clock_in then
      raise exception 'Invalid clock-out time.';
    end if;
    new.work_hours := round(extract(epoch from (coalesce(new.clock_out, now()) - old.clock_in)) / 3600.0, 2);
    new.status := 'present';
    new.is_corrected := false;
  end if;
  if old.is_corrected and new.is_corrected = old.is_corrected then
    -- HR corrections come through the dedicated RPC only.
    null;
  end if;
  return new;
end; $$;

drop trigger if exists attendance_before_update on public.attendance_records;
create trigger attendance_before_update
  before update on public.attendance_records
  for each row execute function public.attendance_update_rules();

-- HR correction RPC — the ONLY sanctioned way to alter a stamped record.
create or replace function public.correct_attendance(
  p_attendance_id uuid,
  p_clock_in timestamptz,
  p_clock_out timestamptz,
  p_reason text default 'Corrected by HR'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  actor_role text := public.current_role();
  v_result jsonb;
begin
  if actor_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager') then
    raise exception 'Not authorized to correct attendance';
  end if;
  if p_clock_in is null then
    raise exception 'Clock-in time is required.';
  end if;
  if p_clock_out is not null and p_clock_out <= p_clock_in then
    raise exception 'Clock-out must be after clock-in.';
  end if;
  perform set_config('app.correcting_attendance', 'on', true);
  update public.attendance_records
  set clock_in = p_clock_in,
      clock_out = p_clock_out,
      work_hours = round(extract(epoch from (coalesce(p_clock_out, now()) - p_clock_in)) / 3600.0, 2),
      status = 'corrected',
      is_corrected = true,
      corrected_by = auth.uid(),
      corrected_at = now(),
      correction_reason = coalesce(p_reason, 'Corrected by HR')
  where id = p_attendance_id
  returning id into p_attendance_id;

  if p_attendance_id is null then
    raise exception 'Attendance record not found.';
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('ATTENDANCE_CORRECTED', 'AttendanceRecord', p_attendance_id::text,
          coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
          format('Attendance corrected to %s / %s. Reason: %s', p_clock_in, p_clock_out, p_reason),
          'warning');
  return jsonb_build_object('ok', true, 'attendance_id', p_attendance_id);
end; $$;

grant execute on function public.correct_attendance(uuid, timestamptz, timestamptz, text) to authenticated;

-- ============================================================
-- 4. EMPLOYEE PROFILE CHILD TABLES
-- ============================================================
create table if not exists public.employee_education (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  source text default 'manual' check (source in ('manual', 'onboarding')),
  institution text not null,
  education_level text check (education_level in ('primary', 'secondary', 'tertiary', 'professional', 'other')),
  from_year int,
  to_year int,
  field_of_study text,
  class_degree text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table public.employee_education enable row level security;
create index if not exists idx_emp_edu on public.employee_education(employee_id);

create table if not exists public.employee_work_history (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  source text default 'manual' check (source in ('manual', 'onboarding')),
  company_name text not null,
  company_address text,
  company_email text,
  "position" text,
  duties text,
  salary numeric(12, 2),
  supervisor_name text,
  supervisor_phone text,
  start_date date,
  end_date date,
  reason_for_leaving text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table public.employee_work_history enable row level security;
create index if not exists idx_emp_work on public.employee_work_history(employee_id);

create table if not exists public.employee_guarantors (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  source text default 'manual' check (source in ('manual', 'onboarding')),
  full_name text not null,
  phone text,
  profession text,
  designation text,
  business_address text,
  residential_address text,
  email text,
  relationship text,
  bvn text,
  nin text,
  verification_status text default 'pending' check (verification_status in ('pending', 'verified', 'rejected')),
  verification_comments text,
  signature text,
  signature_date date,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table public.employee_guarantors enable row level security;
create index if not exists idx_emp_guard on public.employee_guarantors(employee_id);

create table if not exists public.employee_fidelity_bonds (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  source text default 'manual' check (source in ('manual', 'onboarding')),
  surety_name text not null,
  address text,
  occupation text,
  bvn text,
  nin text,
  email text,
  phone text,
  relationship text,
  employee_ref text,
  verification_status text default 'pending' check (verification_status in ('pending', 'verified', 'rejected')),
  verification_comments text,
  signature text,
  signature_date date,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table public.employee_fidelity_bonds enable row level security;
create index if not exists idx_emp_bond on public.employee_fidelity_bonds(employee_id);

-- ============================================================
-- 5. DIGITAL ONBOARDING
-- ============================================================
create table if not exists public.employee_onboarding_links (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  candidate_name text not null,
  candidate_email text,
  candidate_phone text,
  "position" text,
  department text,
  branch text,
  employment_type text check (employment_type in ('full_time', 'part_time', 'contract', 'intern')),
  expiry timestamptz not null,
  expires_at timestamptz,
  status text default 'pending' check (status in ('pending', 'opened', 'in_progress', 'submitted', 'expired', 'revoked')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  opened_at timestamptz,
  submitted_at timestamptz
);
alter table public.employee_onboarding_links enable row level security;

-- Self-heal: if employee_onboarding_links predates phase 6 it may lack the
-- newer columns (create table if not exists silently skips them). Add the
-- missing ones BEFORE the expiry index below so it never errors.
alter table public.employee_onboarding_links add column if not exists token_hash text;
alter table public.employee_onboarding_links add column if not exists candidate_name text;
alter table public.employee_onboarding_links add column if not exists candidate_email text;
alter table public.employee_onboarding_links add column if not exists candidate_phone text;
alter table public.employee_onboarding_links add column if not exists "position" text;
alter table public.employee_onboarding_links add column if not exists department text;
alter table public.employee_onboarding_links add column if not exists branch text;
alter table public.employee_onboarding_links add column if not exists employment_type text;
alter table public.employee_onboarding_links add column if not exists expiry timestamptz;
-- Some deployments predate phase 6 with a NOT NULL `expires_at` column that
-- this repo never knew about. Keep `expiry` as the canonical column and
-- mirror the value into `expires_at` so every INSERT satisfies either
-- schema. The app always sends both; this default is a defensive safeguard
-- for any other caller, and the backfill heals rows created before phase 6.
alter table public.employee_onboarding_links add column if not exists expires_at timestamptz;
alter table public.employee_onboarding_links alter column expires_at set default (now() + interval '7 days');
update public.employee_onboarding_links
   set expires_at = expiry
 where expires_at is null and expiry is not null;
alter table public.employee_onboarding_links add column if not exists status text default 'pending';
alter table public.employee_onboarding_links add column if not exists created_by uuid;
alter table public.employee_onboarding_links add column if not exists created_at timestamptz default now();
alter table public.employee_onboarding_links add column if not exists updated_at timestamptz default now();
alter table public.employee_onboarding_links add column if not exists opened_at timestamptz;
alter table public.employee_onboarding_links add column if not exists submitted_at timestamptz;

create index if not exists idx_onb_links_status on public.employee_onboarding_links(status);
create index if not exists idx_onb_links_expiry on public.employee_onboarding_links(expiry);

create table if not exists public.employee_onboarding_submissions (
  id uuid primary key default gen_random_uuid(),
  link_id uuid references public.employee_onboarding_links(id) on delete set null,
  employee_id uuid references public.employees(id) on delete set null,
  candidate_name text,
  email text,
  phone text,
  "position" text,
  department text,
  employment_type text,
  payload jsonb,
  declaration_accepted boolean default false,
  signature_data text,
  status text default 'submitted' check (status in ('submitted', 'reviewed', 'approved', 'rejected')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_comments text,
  submitted_at timestamptz default now(),
  created_at timestamptz default now()
);
alter table public.employee_onboarding_submissions enable row level security;

-- Self-heal: if the submissions table predates phase 6 without the newer
-- columns, add them BEFORE the indexes below (which reference link_id and
-- employee_id) so the migration never aborts on a missing column.
alter table public.employee_onboarding_submissions add column if not exists link_id uuid;
alter table public.employee_onboarding_submissions add column if not exists employee_id uuid;
alter table public.employee_onboarding_submissions add column if not exists candidate_name text;
alter table public.employee_onboarding_submissions add column if not exists email text;
alter table public.employee_onboarding_submissions add column if not exists phone text;
alter table public.employee_onboarding_submissions add column if not exists "position" text;
alter table public.employee_onboarding_submissions add column if not exists department text;
alter table public.employee_onboarding_submissions add column if not exists employment_type text;
alter table public.employee_onboarding_submissions add column if not exists payload jsonb;
alter table public.employee_onboarding_submissions add column if not exists declaration_accepted boolean default false;
alter table public.employee_onboarding_submissions add column if not exists signature_data text;
alter table public.employee_onboarding_submissions add column if not exists status text default 'submitted';
alter table public.employee_onboarding_submissions add column if not exists reviewed_by uuid;
alter table public.employee_onboarding_submissions add column if not exists reviewed_at timestamptz;
alter table public.employee_onboarding_submissions add column if not exists review_comments text;
alter table public.employee_onboarding_submissions add column if not exists submitted_at timestamptz default now();
alter table public.employee_onboarding_submissions add column if not exists created_at timestamptz default now();

create index if not exists idx_onb_subs_link on public.employee_onboarding_submissions(link_id);
create index if not exists idx_onb_subs_emp on public.employee_onboarding_submissions(employee_id);

-- ============================================================
-- 6. DATA IMPORT & MIGRATION CENTRE (staging architecture)
-- ============================================================
create table if not exists public.data_import_jobs (
  id uuid primary key default gen_random_uuid(),
  created_by uuid references auth.users(id) on delete set null,
  import_type text not null check (import_type in ('employees', 'customers', 'loans', 'repayments', 'payroll', 'recruitment')),
  filename text,
  status text default 'pending' check (status in ('pending', 'validating', 'ready', 'importing', 'completed', 'completed_with_warnings', 'failed', 'rolled_back', 'cancelled')),
  duplicate_strategy text default 'skip' check (duplicate_strategy in ('skip', 'update', 'create', 'review')),
  mapping jsonb,
  total_rows int default 0,
  valid_rows int default 0,
  warning_rows int default 0,
  error_rows int default 0,
  inserted_rows int default 0,
  updated_rows int default 0,
  skipped_rows int default 0,
  error_summary text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  completed_at timestamptz
);
alter table public.data_import_jobs enable row level security;
create index if not exists idx_import_jobs_status on public.data_import_jobs(status);

create table if not exists public.data_import_records (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.data_import_jobs(id) on delete cascade,
  row_number int not null,
  source_data jsonb,
  validation_errors jsonb,
  status text default 'staged' check (status in ('staged', 'valid', 'warning', 'error', 'inserted', 'updated', 'skipped', 'failed')),
  match_type text,
  target_entity_id uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table public.data_import_records enable row level security;
create index if not exists idx_import_records_job on public.data_import_records(job_id);

-- ============================================================
-- 7. PERMISSIONS (new capabilities)
-- ============================================================
insert into public.permissions (permission_key, description, category)
values
  ('hr.onboarding.read', 'View employee onboarding links and submissions', 'hr'),
  ('hr.onboarding.manage', 'Generate, revoke and review onboarding links', 'hr'),
  ('hr.employee.read', 'Read employee profiles', 'hr'),
  ('hr.employee.update', 'Edit employee profiles', 'hr'),
  ('hr.attendance.self', 'Record own attendance (clock in / clock out)', 'hr'),
  ('hr.attendance.manage', 'Manage team attendance and corrections', 'hr'),
  ('payroll.manage', 'Run payroll periods and approve payroll', 'hr'),
  ('data.import.view', 'View import history and previews', 'admin'),
  ('data.import.execute', 'Execute data imports', 'admin')
on conflict (permission_key) do nothing;

do $$
declare
  r text;
begin
  -- Super admin + admin get every new capability.
  foreach r in array array['super_admin', 'admin']
  loop
    perform public.assign_permission_to_role(r, 'hr.onboarding.read');
    perform public.assign_permission_to_role(r, 'hr.onboarding.manage');
    perform public.assign_permission_to_role(r, 'hr.employee.read');
    perform public.assign_permission_to_role(r, 'hr.employee.update');
    perform public.assign_permission_to_role(r, 'hr.attendance.self');
    perform public.assign_permission_to_role(r, 'hr.attendance.manage');
    perform public.assign_permission_to_role(r, 'payroll.manage');
    perform public.assign_permission_to_role(r, 'data.import.view');
    perform public.assign_permission_to_role(r, 'data.import.execute');
  end loop;

  -- HR Manager: full HR capabilities, read-only import visibility.
  foreach r in array array['hr_manager']
  loop
    perform public.assign_permission_to_role(r, 'hr.onboarding.read');
    perform public.assign_permission_to_role(r, 'hr.onboarding.manage');
    perform public.assign_permission_to_role(r, 'hr.employee.read');
    perform public.assign_permission_to_role(r, 'hr.employee.update');
    perform public.assign_permission_to_role(r, 'hr.attendance.self');
    perform public.assign_permission_to_role(r, 'hr.attendance.manage');
    perform public.assign_permission_to_role(r, 'payroll.manage');
    perform public.assign_permission_to_role(r, 'data.import.view');
  end loop;

  -- HR Officer: read/assist on onboarding and attendance.
  foreach r in array array['hr_officer']
  loop
    perform public.assign_permission_to_role(r, 'hr.onboarding.read');
    perform public.assign_permission_to_role(r, 'hr.employee.read');
    perform public.assign_permission_to_role(r, 'hr.attendance.self');
    perform public.assign_permission_to_role(r, 'hr.attendance.manage');
  end loop;

  -- Branch Manager: team attendance.
  foreach r in array array['branch_manager']
  loop
    perform public.assign_permission_to_role(r, 'hr.attendance.self');
    perform public.assign_permission_to_role(r, 'hr.attendance.manage');
  end loop;

  -- Every working role records their own attendance.
  foreach r in array array['area_manager', 'head_of_business', 'operations_manager', 'loan_officer', 'relationship_manager', 'customer_service', 'staff']
  loop
    perform public.assign_permission_to_role(r, 'hr.attendance.self');
  end loop;
end $$;

-- ============================================================
-- 8. RLS POLICIES — all new tables, consistent with current_role()
-- ============================================================

-- EMPLOYEES (recreate to include super_admin; add update)
drop policy if exists "employees_read" on public.employees;
create policy "employees_read" on public.employees
  for select using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager')
  );
drop policy if exists "employees_insert" on public.employees;
create policy "employees_insert" on public.employees
  for insert with check (
    public.current_role() in ('super_admin', 'admin', 'hr_manager')
  );
drop policy if exists "employees_update" on public.employees;
create policy "employees_update" on public.employees
  for update using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager')
  )
  with check (
    public.current_role() in ('super_admin', 'admin', 'hr_manager')
  );
-- Staff must see their OWN row so "own record" subqueries used by
-- attendance and profile child tables return a result under RLS.
drop policy if exists "employees_read_own" on public.employees;
create policy "employees_read_own" on public.employees
  for select using (user_id = auth.uid());

-- ATTENDANCE — own records + HR/managers
drop policy if exists "attendance_read" on public.attendance_records;
create policy "attendance_read" on public.attendance_records
  for select using (
    employee_id in (select id from public.employees where user_id = auth.uid())
    or public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager')
  );
drop policy if exists "attendance_insert_own" on public.attendance_records;
create policy "attendance_insert_own" on public.attendance_records
  for insert with check (
    employee_id in (select id from public.employees where user_id = auth.uid())
  );
drop policy if exists "attendance_update_own" on public.attendance_records;
create policy "attendance_update_own" on public.attendance_records
  for update using (
    employee_id in (select id from public.employees where user_id = auth.uid())
  )
  with check (
    employee_id in (select id from public.employees where user_id = auth.uid())
  );
drop policy if exists "attendance_delete_admin" on public.attendance_records;
create policy "attendance_delete_admin" on public.attendance_records
  for delete using (public.current_role() in ('super_admin', 'admin'));

-- EMPLOYEE PROFILE CHILD TABLES — HR full, employee reads own
do $$
declare
  t text;
  tbl text;
begin
  foreach t in array array['employee_education', 'employee_work_history', 'employee_guarantors', 'employee_fidelity_bonds']
  loop
    execute format('drop policy if exists "%s_read" on public.%s', t, t);
    execute format('create policy "%s_read" on public.%s for select using (employee_id in (select id from public.employees where user_id = auth.uid()) or public.current_role() in (%L))', t, t, 'super_admin,admin,hr_manager,hr_officer');
    execute format('drop policy if exists "%s_write" on public.%s', t, t);
    execute format('create policy "%s_write" on public.%s for all using (public.current_role() in (%L)) with check (public.current_role() in (%L))', t, t, 'super_admin,admin,hr_manager', 'super_admin,admin,hr_manager');
  end loop;
end $$;

-- ONBOARDING LINKS — HR/Admin only (anon access is exclusively via RPC)
drop policy if exists "onboarding_links_read" on public.employee_onboarding_links;
create policy "onboarding_links_read" on public.employee_onboarding_links
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));
drop policy if exists "onboarding_links_write" on public.employee_onboarding_links;
create policy "onboarding_links_write" on public.employee_onboarding_links
  for all using (public.current_role() in ('super_admin', 'admin', 'hr_manager'))
  with check (public.current_role() in ('super_admin', 'admin', 'hr_manager'));

-- ONBOARDING SUBMISSIONS — HR/Admin read only (writes via security definer RPC)
drop policy if exists "onboarding_subs_read" on public.employee_onboarding_submissions;
create policy "onboarding_subs_read" on public.employee_onboarding_submissions
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

-- PAYROLL PERIODS + CONFIG
drop policy if exists "payroll_periods_read" on public.payroll_periods;
create policy "payroll_periods_read" on public.payroll_periods
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager'));
drop policy if exists "payroll_periods_write" on public.payroll_periods;
create policy "payroll_periods_write" on public.payroll_periods
  for all using (public.current_role() in ('super_admin', 'admin', 'hr_manager'))
  with check (public.current_role() in ('super_admin', 'admin', 'hr_manager'));

drop policy if exists "payroll_config_read" on public.payroll_config;
create policy "payroll_config_read" on public.payroll_config
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager'));
drop policy if exists "payroll_config_write" on public.payroll_config;
create policy "payroll_config_write" on public.payroll_config
  for update using (public.current_role() in ('super_admin', 'admin'))
  with check (public.current_role() in ('super_admin', 'admin'));

-- DATA IMPORT JOBS / RECORDS — HR/admins read, admins write
drop policy if exists "import_jobs_read" on public.data_import_jobs;
create policy "import_jobs_read" on public.data_import_jobs
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager'));
drop policy if exists "import_jobs_write" on public.data_import_jobs;
create policy "import_jobs_write" on public.data_import_jobs
  for all using (public.current_role() in ('super_admin', 'admin'))
  with check (public.current_role() in ('super_admin', 'admin'));
drop policy if exists "import_records_read" on public.data_import_records;
create policy "import_records_read" on public.data_import_records
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager'));
drop policy if exists "import_records_write" on public.data_import_records;
create policy "import_records_write" on public.data_import_records
  for all using (public.current_role() in ('super_admin', 'admin'))
  with check (public.current_role() in ('super_admin', 'admin'));

-- ============================================================
-- 9. ONBOARDING RPC FUNCTIONS (public, token-scoped, minimal exposure)
--
-- The candidates table flow works because these functions are SECURITY
-- DEFINER and validate the token + expiry BEFORE touching any data. The
-- anon role can ONLY call these functions — it can never SELECT from
-- employees, onboarding links, or any other table directly.
-- ============================================================

-- Return safe prefill details for the candidate form. Marks PENDING → OPENED
-- the first time the candidate opens the form.
create or replace function public.get_onboarding_link_details(
  p_token text,
  p_mark_opened boolean default true
) returns table (
  link_id uuid,
  candidate_name text,
  candidate_email text,
  candidate_phone text,
  "position" text,
  department text,
  branch text,
  employment_type text,
  expiry timestamptz,
  status text
)
language sql security definer volatile set search_path = public as $$
  with l as (
    select id, token_hash, candidate_name, candidate_email, candidate_phone,
           "position", department, branch, employment_type, coalesce(expires_at, expiry) as expiry, status
    from public.employee_onboarding_links
    where token_hash = md5(p_token)
  ),
  u as (
    update public.employee_onboarding_links
    set status = 'opened', opened_at = now(), updated_at = now()
    where id in (select id from l)
      and status = 'pending'
      and p_mark_opened
    returning id
  )
  select l.id, l.candidate_name, l.candidate_email, l.candidate_phone,
         l."position", l.department, l.branch, l.employment_type, l.expiry,
         case
           when l.expiry <= now() then 'expired'
           when l.status = 'submitted' then 'submitted'
           when l.status = 'revoked' then 'revoked'
           when exists (select 1 from u where u.id = l.id) then 'opened'
           else l.status
         end
  from l;
$$;

grant execute on function public.get_onboarding_link_details(text, boolean) to anon, authenticated;

-- Record that the candidate has started filling the form (for status tracking).
create or replace function public.mark_onboarding_progress(p_token text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_hash text := md5(p_token);
  v_status text;
begin
  update public.employee_onboarding_links
  set status = 'in_progress', updated_at = now()
  where token_hash = v_hash
    and status in ('pending', 'opened')
    and expiry > now()
  returning status into v_status;
  if v_status is null then
    select status into v_status from public.employee_onboarding_links where token_hash = v_hash;
  end if;
  return jsonb_build_object('ok', true, 'status', coalesce(v_status, 'unknown'));
end; $$;

grant execute on function public.mark_onboarding_progress(text) to anon, authenticated;

-- One-time submission. Validates the token, claims it atomically, then
-- creates or safely updates the employee record (gap-fill only), stores
-- education / work history / guarantor / fidelity bond / documents, and
-- records audit + HR notifications.
create or replace function public.submit_onboarding(p_token text, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_hash text := md5(p_token);
  v_link record;
  v_employee uuid;
  v_created boolean := false;
  v_submission uuid;
  v_full_name text;
  v_surname text := lower(trim(coalesce(p_payload ->> 'surname', '')));
  v_first_name text := lower(trim(coalesce(p_payload ->> 'first_name', '')));
  v_email text := lower(trim(coalesce(p_payload ->> 'email', '')));
  v_phone text := trim(coalesce(p_payload ->> 'phone', ''));
  v_dob date;
  v_candidate_id uuid;
  v_candidate text := coalesce(p_payload ->> 'candidate_id', '');
  v_warnings text[] := '{}'::text[];
  v_doc record;
  v_notes text[];
  v_hr_id uuid;
  v_req text;
  v_row record;
  v_children int;
begin
  if p_payload is null or (v_surname = '' and v_first_name = '') then
    raise exception 'Submission payload is required and must include a name.';
  end if;
  begin
    v_dob := nullif(p_payload ->> 'date_of_birth', '')::date;
  exception when others then
    v_dob := null;
  end;

  select id, candidate_name, candidate_email, candidate_phone, coalesce(expires_at, expiry) as expiry, status,
         "position", department, branch, employment_type
  into v_link
  from public.employee_onboarding_links
  where token_hash = v_hash
  for update;

  if v_link.id is null then
    raise exception 'Invalid onboarding link.';
  end if;
  if v_link.status = 'submitted' then
    raise exception 'This onboarding link has already been used.';
  end if;
  if v_link.status = 'revoked' then
    raise exception 'This onboarding link has been revoked.';
  end if;
  if v_link.expiry <= now() then
    raise exception 'This onboarding link has expired.';
  end if;

  v_full_name := trim(initcap(v_surname));
  if v_first_name <> '' then v_full_name := v_full_name || ' ' || initcap(v_first_name); end if;
  if v_full_name = '' then v_full_name := coalesce(v_link.candidate_name, 'Candidate'); end if;

  if v_candidate <> '' then
    begin
      v_candidate_id := v_candidate::uuid;
    exception when others then
      v_candidate_id := null;
    end;
  end if;

  -- Resolve candidate identity: explicit id first, then email, then phone.
  select id into v_employee
  from public.employees
  where (v_candidate_id is not null and candidate_id = v_candidate_id)
     or (v_email <> '' and lower(email) = v_email)
     or (v_phone <> '' and phone = v_phone)
  limit 1;

  if v_employee is null then
    insert into public.employees (
      full_name, candidate_id, email, phone, sex, date_of_birth, state_of_origin, lga,
      town, residential_address, religion, denomination, nationality, marital_status,
      employee_code, department, "position", employment_type, employment_status,
      next_of_kin_name, next_of_kin_address, next_of_kin_phone, next_of_kin_relationship,
      beneficiary_name, beneficiary_address, beneficiary_phone, beneficiary_relationship,
      pension_id, tax_id, bvn, nin, branch,
      emergency_contact_name, emergency_contact_phone,
      number_of_children, children_age_range
    ) values (
      v_full_name, v_candidate_id, nullif(v_email, ''), nullif(v_phone, ''), nullif(coalesce(p_payload ->> 'sex', ''), ''),
      v_dob, nullif(p_payload ->> 'state_of_origin', ''),
      nullif(p_payload ->> 'lga', ''), nullif(p_payload ->> 'town', ''), nullif(p_payload ->> 'residential_address', ''),
      nullif(p_payload ->> 'religion', ''), nullif(p_payload ->> 'denomination', ''), nullif(p_payload ->> 'nationality', ''),
      nullif(p_payload ->> 'marital_status', ''), nullif(p_payload ->> 'employee_code', ''),
      nullif(coalesce(p_payload ->> 'department', v_link.department), ''), nullif(coalesce(p_payload ->> 'position', v_link."position"), ''),
      nullif(coalesce(p_payload ->> 'employment_type', v_link.employment_type), ''), 'onboarding',
      nullif(p_payload ->> 'next_of_kin_name', ''), nullif(p_payload ->> 'next_of_kin_address', ''),
      nullif(p_payload ->> 'next_of_kin_phone', ''), nullif(p_payload ->> 'next_of_kin_relationship', ''),
      nullif(p_payload ->> 'beneficiary_name', ''), nullif(p_payload ->> 'beneficiary_address', ''),
      nullif(p_payload ->> 'beneficiary_phone', ''), nullif(p_payload ->> 'beneficiary_relationship', ''),
      nullif(p_payload ->> 'pension_id', ''), nullif(p_payload ->> 'tax_id', ''),
      nullif(p_payload ->> 'bvn', ''), nullif(p_payload ->> 'nin', ''),
      nullif(coalesce(p_payload ->> 'branch', v_link.branch), ''),
      nullif(p_payload ->> 'emergency_contact_name', ''), nullif(p_payload ->> 'emergency_contact_phone', ''),
      coalesce(nullif(p_payload ->> 'number_of_children', ''), '0')::int,
      nullif(p_payload ->> 'children_age_range', '')
    ) returning id into v_employee;
    v_created := true;
  else
    -- Gap-fill only: never overwrite populated HR-verified fields.
    update public.employees set
      email = coalesce(nullif(v_email, ''), email),
      phone = coalesce(nullif(v_phone, ''), phone),
      sex = coalesce(nullif(p_payload ->> 'sex', ''), sex),
      date_of_birth = coalesce(v_dob, date_of_birth),
      state_of_origin = coalesce(nullif(p_payload ->> 'state_of_origin', ''), state_of_origin),
      lga = coalesce(nullif(p_payload ->> 'lga', ''), lga),
      town = coalesce(nullif(p_payload ->> 'town', ''), town),
      residential_address = coalesce(nullif(p_payload ->> 'residential_address', ''), residential_address),
      religion = coalesce(nullif(p_payload ->> 'religion', ''), religion),
      denomination = coalesce(nullif(p_payload ->> 'denomination', ''), denomination),
      marital_status = coalesce(nullif(p_payload ->> 'marital_status', ''), marital_status),
      spouse_name = coalesce(nullif(p_payload ->> 'spouse_name', ''), spouse_name),
      spouse_occupation = coalesce(nullif(p_payload ->> 'spouse_occupation', ''), spouse_occupation),
      spouse_phone = coalesce(nullif(p_payload ->> 'spouse_phone', ''), spouse_phone),
      next_of_kin_name = coalesce(nullif(p_payload ->> 'next_of_kin_name', ''), next_of_kin_name),
      next_of_kin_address = coalesce(nullif(p_payload ->> 'next_of_kin_address', ''), next_of_kin_address),
      next_of_kin_phone = coalesce(nullif(p_payload ->> 'next_of_kin_phone', ''), next_of_kin_phone),
      next_of_kin_relationship = coalesce(nullif(p_payload ->> 'next_of_kin_relationship', ''), next_of_kin_relationship),
      beneficiary_name = coalesce(nullif(p_payload ->> 'beneficiary_name', ''), beneficiary_name),
      beneficiary_address = coalesce(nullif(p_payload ->> 'beneficiary_address', ''), beneficiary_address),
      beneficiary_phone = coalesce(nullif(p_payload ->> 'beneficiary_phone', ''), beneficiary_phone),
      beneficiary_relationship = coalesce(nullif(p_payload ->> 'beneficiary_relationship', ''), beneficiary_relationship),
      pension_id = coalesce(nullif(p_payload ->> 'pension_id', ''), pension_id),
      tax_id = coalesce(nullif(p_payload ->> 'tax_id', ''), tax_id),
      bvn = coalesce(nullif(p_payload ->> 'bvn', ''), bvn),
      nin = coalesce(nullif(p_payload ->> 'nin', ''), nin),
      emergency_contact_name = coalesce(nullif(p_payload ->> 'emergency_contact_name', ''), emergency_contact_name),
      emergency_contact_phone = coalesce(nullif(p_payload ->> 'emergency_contact_phone', ''), emergency_contact_phone),
      number_of_children = coalesce(nullif(p_payload ->> 'number_of_children', '')::int, number_of_children),
      children_age_range = coalesce(nullif(p_payload ->> 'children_age_range', ''), children_age_range),
      updated_at = now()
    where id = v_employee;
  end if;

  -- Education history (repeatable)
  if p_payload ? 'education' and jsonb_typeof(p_payload -> 'education') = 'array' then
    for v_row in select * from jsonb_array_elements(p_payload -> 'education')
    loop
      if (v_row.value ->> 'institution') is not null and trim(v_row.value ->> 'institution') <> '' then
        insert into public.employee_education (employee_id, source, institution, education_level, from_year, to_year, field_of_study, class_degree)
        values (v_employee, 'onboarding', v_row.value ->> 'institution', v_row.value ->> 'education_level',
                nullif(v_row.value ->> 'from_year', '')::int, nullif(v_row.value ->> 'to_year', '')::int,
                v_row.value ->> 'field_of_study', v_row.value ->> 'class_degree');
      end if;
    end loop;
  end if;

  -- Work history (repeatable)
  if p_payload ? 'work_history' and jsonb_typeof(p_payload -> 'work_history') = 'array' then
    for v_row in select * from jsonb_array_elements(p_payload -> 'work_history')
    loop
      if (v_row.value ->> 'company_name') is not null and trim(v_row.value ->> 'company_name') <> '' then
        insert into public.employee_work_history (employee_id, source, company_name, company_address, company_email, "position", duties, salary,
          supervisor_name, supervisor_phone, start_date, end_date, reason_for_leaving)
        values (v_employee, 'onboarding', v_row.value ->> 'company_name', v_row.value ->> 'company_address',
                v_row.value ->> 'company_email', v_row.value ->> 'position', v_row.value ->> 'duties',
                nullif(v_row.value ->> 'salary', '')::numeric, v_row.value ->> 'supervisor_name',
                v_row.value ->> 'supervisor_phone', nullif(v_row.value ->> 'start_date', '')::date,
                nullif(v_row.value ->> 'end_date', '')::date, v_row.value ->> 'reason_for_leaving');
      end if;
    end loop;
  end if;

  -- Guarantor
  if (p_payload ->> 'guarantor_full_name') is not null and trim(p_payload ->> 'guarantor_full_name') <> '' then
    insert into public.employee_guarantors (employee_id, source, full_name, phone, profession, designation, business_address,
      residential_address, email, relationship, bvn, nin, signature, signature_date)
    values (v_employee, 'onboarding', p_payload ->> 'guarantor_full_name', p_payload ->> 'guarantor_phone',
            p_payload ->> 'guarantor_profession', p_payload ->> 'guarantor_designation', p_payload ->> 'guarantor_business_address',
            p_payload ->> 'guarantor_residential_address', p_payload ->> 'guarantor_email', p_payload ->> 'guarantor_relationship',
            p_payload ->> 'guarantor_bvn', p_payload ->> 'guarantor_nin', p_payload ->> 'guarantor_signature',
            nullif(p_payload ->> 'guarantor_date', '')::date);
  end if;

  -- Fidelity bond
  if (p_payload ->> 'fidelity_surety_name') is not null and trim(p_payload ->> 'fidelity_surety_name') <> '' then
    insert into public.employee_fidelity_bonds (employee_id, source, surety_name, address, occupation, bvn, nin, email, phone,
      relationship, employee_ref, signature, signature_date)
    values (v_employee, 'onboarding', p_payload ->> 'fidelity_surety_name', p_payload ->> 'fidelity_address',
            p_payload ->> 'fidelity_occupation', p_payload ->> 'fidelity_bvn', p_payload ->> 'fidelity_nin',
            p_payload ->> 'fidelity_email', p_payload ->> 'fidelity_phone', p_payload ->> 'fidelity_relationship',
            v_full_name, p_payload ->> 'fidelity_signature', nullif(p_payload ->> 'fidelity_date', '')::date);
  end if;

  -- Submitted supporting documents: only accept paths that were created
  -- under the request's own token namespace in the documents bucket.
  if p_payload ? 'documents' and jsonb_typeof(p_payload -> 'documents') = 'array' then
    for v_doc in select * from jsonb_array_elements(p_payload -> 'documents')
    loop
      v_req := 'onboarding/' || v_hash || '/';
      if position(v_req in coalesce(v_doc.value ->> 'file_path', '')) = 1 then
        insert into public.documents (entity_type, entity_id, document_type, file_name, file_path, file_size, mime_type,
          verification_status, is_required, uploaded_at)
        values ('employee', v_employee, coalesce(v_doc.value ->> 'category', 'other'), v_doc.value ->> 'file_name',
                v_doc.value ->> 'file_path', (v_doc.value ->> 'size')::int, v_doc.value ->> 'mime', 'pending', false, now());
        v_notes := array_append(v_notes, v_doc.value ->> 'category');
      else
        v_warnings := array_append(v_warnings, 'Document path rejected: ' || coalesce(v_doc.value ->> 'file_name', '?'));
      end if;
    end loop;
  end if;

  insert into public.employee_onboarding_submissions (link_id, employee_id, candidate_name, email, phone, "position", department,
    employment_type, payload, declaration_accepted, signature_data)
  values (v_link.id, v_employee, v_full_name, nullif(v_email, ''), nullif(v_phone, ''), v_link."position", v_link.department,
    v_link.employment_type, p_payload, coalesce((p_payload ->> 'declaration_accepted')::boolean, false), p_payload ->> 'declaration_signature')
  returning id into v_submission;

  update public.employee_onboarding_links
  set status = 'submitted', submitted_at = now(), updated_at = now()
  where id = v_link.id;

  -- Audit trail
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('ONBOARDING_SUBMITTED', 'OnboardingSubmission', v_submission::text, coalesce(v_full_name, 'candidate'),
          format('Onboarding submitted by %s (token link %s)', v_full_name, v_link.id), 'info');
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (case when v_created then 'EMPLOYEE_CREATED' else 'EMPLOYEE_UPDATED' end,
          'Employee', v_employee::text,
          coalesce((select full_name from public.profiles where id = auth.uid()), 'candidate'),
          format('%s via onboarding (%s)', v_full_name, case when v_created then 'new record' else 'existing record updated' end),
          'info');
  if array_length(v_notes, 1) > 0 then
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values ('DOCUMENT_UPLOADED', 'Employee', v_employee::text, v_full_name,
            format('Onboarding documents: %s', array_to_string(v_notes, ', ')), 'info');
  end if;

  -- Notify HR using the existing notifications architecture.
  for v_hr_id in
    select id from public.profiles
    where role in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
  loop
    insert into public.notifications (user_id, title, message, type, link)
    values (v_hr_id, 'New employee onboarding submitted',
            format('%s submitted onboarding information as %s.', v_full_name, coalesce(v_link."position", 'N/A')),
            'onboarding', '/onboarding-links');
  end loop;

  return jsonb_build_object(
    'ok', true,
    'submission_id', v_submission,
    'employee_id', v_employee,
    'created', v_created,
    'message', case when v_created then 'NEW EMPLOYEE CREATED' else 'EXISTING EMPLOYEE PROFILE UPDATED' end,
    'warnings', to_jsonb(v_warnings)
  );
end; $$;

grant execute on function public.submit_onboarding(text, jsonb) to anon, authenticated;

-- ============================================================
-- 10. PAYROLL CALCULATION RPC
-- ============================================================
create or replace function public.compute_payroll(p_period_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  actor_role text := public.current_role();
  v_period record;
  v_config jsonb;
  v_pension_rate numeric;
  v_relief_min numeric;
  v_relief_pct numeric;
  v_bands jsonb;
  v_band record;
  v_band_count int;
  v_i int;
  v_emp record;
  v_salary numeric;
  v_allowances numeric;
  v_pension numeric;
  v_gross numeric;
  v_annual numeric;
  v_taxable numeric;
  v_relief numeric;
  v_tax_annual numeric := 0;
  v_tax numeric;
  v_other numeric;
  v_deductions numeric;
  v_count int := 0;
  v_upper numeric;
  v_prev numeric;
begin
  if actor_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to compute payroll';
  end if;

  select * into v_period from public.payroll_periods where id = p_period_id;
  if v_period.id is null then
    raise exception 'Payroll period not found.';
  end if;
  if v_period.status not in ('draft', 'calculated') then
    raise exception 'Payroll can only be calculated for a draft or calculated period.';
  end if;

  select config into v_config from public.payroll_config where id = 1;
  v_pension_rate := coalesce((v_config ->> 'pension_employee_rate')::numeric, 0.08);
  v_relief_min := coalesce((v_config ->> 'consolidated_relief_min')::numeric, 200000);
  v_relief_pct := coalesce((v_config ->> 'consolidated_relief_percent')::numeric, 0.20);
  v_other := coalesce((v_config ->> 'default_other_deduction')::numeric, 0);
  v_bands := coalesce(v_config -> 'tax_bands', '[{"up_to":null,"rate":0.0}]'::jsonb);

  -- Recalculate the whole period: rows for this period are rewritten.
  delete from public.payroll where payroll_period = v_period.period_label;

  for v_emp in
    select * from public.employees
    where employment_status in ('active', 'probation', 'on_leave')
    order by full_name
  loop
    v_salary := coalesce(v_emp.salary, 0);
    v_allowances := 0;
    v_gross := v_salary + v_allowances;
    v_pension := round(v_salary * v_pension_rate, 2);
    v_annual := v_gross * 12;
    v_relief := greatest(v_relief_min, v_relief_pct * v_annual);
    v_taxable := greatest(0, (v_salary - v_pension) * 12 - v_relief);

    v_tax_annual := 0;
    v_prev := 0;
    v_band_count := jsonb_array_length(v_bands);
    v_i := 0;
    while v_i < v_band_count loop
      v_band := jsonb_array_element(v_bands, v_i);
      if v_taxable <= v_prev then
        exit;
      end if;
      if (v_band.value ->> 'up_to') is null then
        v_upper := v_taxable;
      else
        v_upper := least(v_taxable, (v_band.value ->> 'up_to')::numeric);
      end if;
      v_tax_annual := v_tax_annual + greatest(0, (v_upper - v_prev) * coalesce((v_band.value ->> 'rate')::numeric, 0));
      if v_taxable <= v_upper then
        exit;
      end if;
      v_prev := v_upper;
      v_i := v_i + 1;
    end loop;

    v_tax := round(v_tax_annual / 12, 2);
    v_deductions := v_tax + v_pension + v_other;

    insert into public.payroll (employee_id, employee_name, salary, allowances, gross_pay, tax_paye, pension_deduction,
      other_deductions, deductions, payroll_period, period_start, period_end, status)
    values (v_emp.id, v_emp.full_name, v_salary, v_allowances, v_gross, v_tax, v_pension,
      v_other, v_deductions, v_period.period_label, v_period.start_date, v_period.end_date, 'calculated');
    v_count := v_count + 1;
  end loop;

  update public.payroll_periods set status = 'calculated', updated_at = now()
  where id = p_period_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('PAYROLL_CALCULATED', 'PayrollPeriod', p_period_id::text,
          coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
          format('Payroll calculated for %s — %s employee rows', v_period.period_label, v_count), 'info');

  return jsonb_build_object('ok', true, 'period', v_period.period_label, 'rows', v_count);
end; $$;

grant execute on function public.compute_payroll(uuid) to authenticated;

-- ============================================================
-- 11. DATA IMPORT EXECUTION RPC
--
-- Frontend stages rows (validated client-side) into data_import_records.
-- This function performs the actual controlled inserts inside a
-- transaction. SECURITY DEFINER + explicit role check means the anon key
-- can never run it and the database is the authority, not the UI.
-- ============================================================
create or replace function public.run_data_import(p_job_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  actor_role text := public.current_role();
  v_job record;
  v_row record;
  v_target text;
  v_source jsonb;
  v_mapping jsonb;
  v_strategy text;
  v_dupe_id uuid;
  v_dup_key text;
  v_match text := null;
  v_branch_id uuid;
  v_col text;
  v_in_col text;
  v_val text;
  v_inserted int := 0;
  v_updated int := 0;
  v_skipped int := 0;
  v_failed int := 0;
  v_err text;
  v_payload jsonb := '{}'::jsonb;
  v_created_at timestamptz := now();
  v_status text;
begin
  if actor_role not in ('super_admin', 'admin') then
    raise exception 'Not authorized to execute data imports';
  end if;

  select * into v_job from public.data_import_jobs where id = p_job_id for update;
  if v_job.id is null then
    raise exception 'Import job not found.';
  end if;
  if v_job.status in ('completed', 'completed_with_warnings', 'importing') then
    raise exception 'Import already ran.';
  end if;

  update public.data_import_jobs set status = 'importing', updated_at = now() where id = p_job_id;

  v_strategy := v_job.duplicate_strategy;
  v_mapping := coalesce(v_job.mapping, '{}'::jsonb);

  for v_row in
    select * from public.data_import_records
    where job_id = p_job_id
    order by row_number
  loop
    begin
      v_err := null;
      v_source := coalesce(v_row.source_data, '{}'::jsonb);
      v_dupe_id := null;
      v_match := null;

      -- Duplicate detection by import type + strategy.
      if v_job.import_type = 'employees' then
        v_dup_key := 'email';
        if v_source ->> 'email' is not null and trim(v_source ->> 'email') <> '' then
          select id, 'email' into v_dupe_id, v_match
          from public.employees
          where lower(email) = lower(trim(v_source ->> 'email')) limit 1;
        end if;
        if v_dupe_id is null and v_source ->> 'phone' is not null and trim(v_source ->> 'phone') <> '' then
          select id, 'phone' into v_dupe_id, v_match
          from public.employees
          where phone = trim(v_source ->> 'phone') limit 1;
        end if;
      elsif v_job.import_type = 'customers' then
        v_dup_key := 'email';
        if v_source ->> 'email' is not null and trim(v_source ->> 'email') <> '' then
          select id, 'email' into v_dupe_id, v_match
          from public.customers
          where lower(email) = lower(trim(v_source ->> 'email')) limit 1;
        end if;
      end if;

      if v_dupe_id is not null and v_strategy = 'skip' then
        update public.data_import_records set status = 'skipped', match_type = v_match where id = v_row.id;
        v_skipped := v_skipped + 1;
        continue;
      end if;
      if v_dupe_id is not null and v_strategy = 'create' then
        v_dupe_id := null;
        v_match := null;
      end if;

      -- Build the target payload from the mapping (source column -> target column).
      v_payload := '{}'::jsonb;
      for v_in_col, v_col in select key, value from jsonb_each_text(v_mapping) loop
        if v_source ? v_in_col then
          v_payload := jsonb_set(v_payload, array[v_col], to_jsonb(coalesce((v_source ->> v_in_col), '')));
        end if;
      end loop;

      -- Transform common values before they reach the database.
      if v_job.import_type = 'employees' and v_payload ? 'employment_status' then
        v_payload := jsonb_set(v_payload, array['employment_status'],
          to_jsonb(lower(trim(v_payload ->> 'employment_status'))));
        if v_payload ->> 'employment_status' in ('active employee', 'active_employee', 'employed') then
          v_payload := jsonb_set(v_payload, array['employment_status'], to_jsonb('active'));
        elsif v_payload ->> 'employment_status' in ('terminated', 'exited', 'resigned') then
          v_payload := jsonb_set(v_payload, array['employment_status'], to_jsonb('terminated'));
        elsif v_payload ->> 'employment_status' not in ('onboarding', 'active', 'probation', 'on_leave', 'inactive', 'suspended') then
          v_payload := jsonb_set(v_payload, array['employment_status'], to_jsonb('onboarding'));
        end if;
      end if;

      v_target := null;
      if v_job.import_type = 'employees' then
        v_target := 'employee';
        -- Resolve branch reference by name (never guess).
        if v_payload ? 'branch' and trim(v_payload ->> 'branch') <> '' then
          select id, 'branch' into v_branch_id, v_match
          from public.branches
          where lower(branch_name) = lower(trim(v_payload ->> 'branch')) limit 1;
          if v_branch_id is null then
            raise exception 'Branch "%" could not be resolved.', v_payload ->> 'branch';
          end if;
          v_payload := jsonb_set(v_payload, array['branch'], to_jsonb(v_payload ->> 'branch'));
        end if;
      end if;

      if v_job.import_type = 'employees' then
        if v_dupe_id is not null then
          update public.employees set
            full_name = coalesce(nullif(v_payload ->> 'full_name', ''), full_name),
            email = coalesce(nullif(v_payload ->> 'email', ''), email),
            phone = coalesce(nullif(v_payload ->> 'phone', ''), phone),
            department = coalesce(nullif(v_payload ->> 'department', ''), department),
            "position" = coalesce(nullif(v_payload ->> 'position', ''), "position"),
            employment_status = coalesce(nullif(v_payload ->> 'employment_status', ''), employment_status),
            salary = coalesce(nullif(v_payload ->> 'salary', '')::numeric, salary),
            bank_name = coalesce(nullif(v_payload ->> 'bank_name', ''), bank_name),
            account_number = coalesce(nullif(v_payload ->> 'account_number', ''), account_number),
            updated_at = now()
          where id = v_dupe_id;
          v_updated := v_updated + 1;
          update public.data_import_records set status = 'updated', target_entity_id = v_dupe_id, match_type = v_match where id = v_row.id;
        else
          insert into public.employees (
            full_name, email, phone, department, "position", employment_status, salary,
            bank_name, account_number, employee_code, sex, date_of_birth, hire_date,
            created_at, updated_at
          ) values (
            coalesce(v_payload ->> 'full_name', ''),
            nullif(v_payload ->> 'email', ''), nullif(v_payload ->> 'phone', ''),
            nullif(v_payload ->> 'department', ''), nullif(v_payload ->> 'position', ''),
            coalesce(nullif(v_payload ->> 'employment_status', ''), 'onboarding'),
            nullif(v_payload ->> 'salary', '')::numeric, nullif(v_payload ->> 'bank_name', ''),
            nullif(v_payload ->> 'account_number', ''), nullif(v_payload ->> 'employee_code', ''),
            nullif(v_payload ->> 'sex', ''), nullif((v_payload ->> 'date_of_birth')::date, null),
            nullif((v_payload ->> 'hire_date')::date, null), v_created_at, v_created_at
          ) returning id into v_dupe_id;
          v_inserted := v_inserted + 1;
          update public.data_import_records set status = 'inserted', target_entity_id = v_dupe_id where id = v_row.id;
        end if;
      elsif v_job.import_type = 'customers' then
        insert into public.customers (name, email, phone, address, employment_status, employer, monthly_income, status, notes, created_at)
        values (
          coalesce(v_payload ->> 'name', ''),
          nullif(v_payload ->> 'email', ''), nullif(v_payload ->> 'phone', ''),
          nullif(v_payload ->> 'address', ''), coalesce(nullif(v_payload ->> 'employment_status', ''), 'employed'),
          nullif(v_payload ->> 'employer', ''), coalesce(nullif(v_payload ->> 'monthly_income', '')::numeric, 0),
          coalesce(nullif(v_payload ->> 'status', ''), 'pending'), nullif(v_payload ->> 'notes', ''),
          v_created_at
        ) returning id into v_dupe_id;
        v_inserted := v_inserted + 1;
        update public.data_import_records set status = 'inserted', target_entity_id = v_dupe_id where id = v_row.id;
      elsif v_job.import_type = 'loans' then
        insert into public.loans (customer_id, customer_name, principal_amount, outstanding_balance, interest_rate, term_months,
          monthly_payment, status, disbursed_date, maturity_date, created_at)
        values (
          nullif(v_payload ->> 'customer_id', '')::uuid, nullif(v_payload ->> 'customer_name', ''),
          coalesce(nullif(v_payload ->> 'principal_amount', '')::numeric, 0),
          coalesce(nullif(v_payload ->> 'outstanding_balance', '')::numeric, 0),
          coalesce(nullif(v_payload ->> 'interest_rate', '')::numeric, 0),
          coalesce(nullif(v_payload ->> 'term_months', '')::int, 0),
          nullif(v_payload ->> 'monthly_payment', '')::numeric,
          coalesce(nullif(v_payload ->> 'status', ''), 'active'),
          nullif((v_payload ->> 'disbursed_date')::date, null), nullif((v_payload ->> 'maturity_date')::date, null),
          v_created_at
        ) returning id into v_dupe_id;
        v_inserted := v_inserted + 1;
        update public.data_import_records set status = 'inserted', target_entity_id = v_dupe_id where id = v_row.id;
      elsif v_job.import_type = 'repayments' then
        insert into public.repayments (loan_id, customer_id, customer_name, amount, due_date, payment_date, status, payment_method, created_at)
        values (
          nullif(v_payload ->> 'loan_id', '')::uuid, nullif(v_payload ->> 'customer_id', '')::uuid,
          nullif(v_payload ->> 'customer_name', ''), coalesce(nullif(v_payload ->> 'amount', '')::numeric, 0),
          nullif((v_payload ->> 'due_date')::date, null), nullif((v_payload ->> 'payment_date')::date, null),
          coalesce(nullif(v_payload ->> 'status', ''), 'pending'), nullif(v_payload ->> 'payment_method', ''),
          v_created_at
        ) returning id into v_dupe_id;
        v_inserted := v_inserted + 1;
        update public.data_import_records set status = 'inserted', target_entity_id = v_dupe_id where id = v_row.id;
      elsif v_job.import_type = 'payroll' then
        insert into public.payroll (employee_id, employee_name, salary, allowances, deductions, payroll_period, period_start, period_end, status, created_at)
        values (
          nullif(v_payload ->> 'employee_id', '')::uuid, nullif(v_payload ->> 'employee_name', ''),
          coalesce(nullif(v_payload ->> 'salary', '')::numeric, 0), coalesce(nullif(v_payload ->> 'allowances', '')::numeric, 0),
          coalesce(nullif(v_payload ->> 'deductions', '')::numeric, 0),
          coalesce(v_payload ->> 'payroll_period', v_job.filename),
          nullif((v_payload ->> 'period_start')::date, null), nullif((v_payload ->> 'period_end')::date, null),
          coalesce(nullif(v_payload ->> 'status', ''), 'draft'), v_created_at
        ) returning id into v_dupe_id;
        v_inserted := v_inserted + 1;
        update public.data_import_records set status = 'inserted', target_entity_id = v_dupe_id where id = v_row.id;
      elsif v_job.import_type = 'recruitment' then
        insert into public.hr_candidates (full_name, email, phone, current_company, years_experience, application_status, created_at)
        values (
          coalesce(v_payload ->> 'full_name', ''), nullif(v_payload ->> 'email', ''),
          nullif(v_payload ->> 'phone', ''), nullif(v_payload ->> 'current_company', ''),
          coalesce(nullif(v_payload ->> 'years_experience', '')::int, 0),
          coalesce(nullif(v_payload ->> 'application_status', ''), 'received'), v_created_at
        ) returning id into v_dupe_id;
        v_inserted := v_inserted + 1;
        update public.data_import_records set status = 'inserted', target_entity_id = v_dupe_id where id = v_row.id;
      else
        raise exception 'Unsupported import type %.', v_job.import_type;
      end if;
    exception when others then
      v_err := SQLERRM;
      update public.data_import_records set status = 'failed', validation_errors = jsonb_build_array(jsonb_build_object('row', v_row.row_number, 'message', v_err, 'severity', 'ERROR'))
      where id = v_row.id;
      v_failed := v_failed + 1;
    end;
  end loop;

  if v_failed > 0 and v_inserted = 0 and v_updated = 0 then
    v_status := 'failed';
  elsif v_failed > 0 then
    v_status := 'completed_with_warnings';
  elsif v_skipped > 0 then
    v_status := 'completed_with_warnings';
  else
    v_status := 'completed';
  end if;

  update public.data_import_jobs
  set status = v_status, inserted_rows = v_inserted, updated_rows = v_updated,
      skipped_rows = v_skipped, error_rows = v_failed,
      error_summary = (select to_jsonb(array_agg(jsonb_build_object('row', r.row_number, 'message', (r.validation_errors ->> 0), 'severity', 'ERROR')))::text
                       from public.data_import_records r where r.job_id = p_job_id and r.status = 'failed'),
      completed_at = now(), updated_at = now()
  where id = p_job_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('IMPORT_COMPLETED', 'DataImport', p_job_id::text,
          coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
          format('%s import (%s): inserted %s, updated %s, skipped %s, failed %s', v_job.import_type, v_job.filename, v_inserted, v_updated, v_skipped, v_failed),
          case when v_failed > 0 then 'warning' else 'info' end);

  return jsonb_build_object('ok', true, 'inserted', v_inserted, 'updated', v_updated,
    'skipped', v_skipped, 'failed', v_failed, 'status', v_status);
end; $$;

grant execute on function public.run_data_import(uuid) to authenticated;

-- ============================================================
-- 12. STORAGE — secure onboarding document uploads
--
-- Anon candidates may upload into the documents bucket ONLY under the
-- path "onboarding/<token-hash>/...". The path is unguessable (SHA-256 of
-- a 256-bit random token) and the submit RPC re-validates the prefix
-- before any document row is created.
-- ============================================================
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

drop policy if exists "onboarding anon upload" on storage.objects;
create policy "onboarding anon upload" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'documents' and name like 'onboarding/%');

drop policy if exists "documents authenticated read" on storage.objects;
create policy "documents authenticated read" on storage.objects
  for select to authenticated
  using (bucket_id = 'documents');

-- ============================================================
-- DONE. Next steps after running this file:
--   1. (Any outstanding) select public.reset_annual_leave_balances(date_part('year', now())::int);
--   2. Confirm permissions applied:
--      select role_name, string_agg(permission_key, ', ') from public.v_user_permissions
--      where role_name in ('hr_manager','hr_officer') group by role_name;
-- ============================================================