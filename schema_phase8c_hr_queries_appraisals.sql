-- ============================================================
-- PHASE 8c: HR QUERIES + EMPLOYEE APPRAISALS
--
-- Adds two new tables for the connected HR workflow:
--   1. hr_queries — HR can issue queries against employees
--   2. employee_appraisals — Performance/appraisal records
--
-- ALL ADDITIVE. Safe to re-run. Non-destructive.
-- ============================================================

-- ============================================================
-- 1. HR QUERIES
-- ============================================================
create table if not exists public.hr_queries (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references public.employees(id) on delete cascade,
  employee_name text,
  query_title text not null,
  query_type text default 'general',
  description text,
  work_period text,
  status text default 'DRAFT' check (status in ('DRAFT', 'ISSUED', 'AWAITING_RESPONSE', 'RESPONDED', 'RESOLVED', 'CLOSED')),
  response text,
  response_date timestamptz,
  hr_comments text,
  issued_by uuid references auth.users(id) on delete set null,
  issued_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.hr_queries enable row level security;

drop policy if exists "hr_queries_hr_all" on public.hr_queries;

create policy "hr_queries_hr_all"
  on public.hr_queries
  for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

create index if not exists idx_hr_queries_employee on public.hr_queries(employee_id);
create index if not exists idx_hr_queries_status on public.hr_queries(status);

-- ============================================================
-- 2. EMPLOYEE APPRAISALS
-- ============================================================
create table if not exists public.employee_appraisals (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references public.employees(id) on delete cascade,
  employee_name text,
  appraisal_type text default 'quarterly',
  work_period text,
  quarter text,
  appraisal_year int,
  appraisal_date date,
  reviewer text,
  strengths text,
  areas_for_improvement text,
  objectives text,
  overall_rating text check (overall_rating in ('excellent', 'good', 'satisfactory', 'needs_improvement', 'unsatisfactory')),
  comments text,
  status text default 'draft' check (status in ('draft', 'in_review', 'completed', 'acknowledged')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.employee_appraisals enable row level security;

drop policy if exists "appraisals_hr_all" on public.employee_appraisals;

create policy "appraisals_hr_all"
  on public.employee_appraisals
  for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

create index if not exists idx_appraisals_employee on public.employee_appraisals(employee_id);
create index if not exists idx_appraisals_status on public.employee_appraisals(status);
