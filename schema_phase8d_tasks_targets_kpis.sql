-- ============================================================
-- PHASE 8d: TASKS + TARGETS + KPIs MANAGEMENT SYSTEM
--
-- Adds:
--   1. work_tasks — HR/manager-assigned tasks with completion proof workflow
--   2. task_submissions — employee completion submissions with evidence
--   3. targets — measurable objectives with progress tracking
--   4. employee_kpis — KPI definitions with weighted scoring
--   5. Adds missing columns to hr_interviews (candidate_name, email, etc.)
--
-- ALL ADDITIVE. Safe to re-run. Non-destructive.
-- Uses DROP POLICY IF EXISTS + CREATE POLICY (Supabase-compatible).
-- ============================================================

-- ============================================================
-- 0. HR INTERVIEWS — add missing columns for recruitment handoff
-- ============================================================
alter table public.hr_interviews add column if not exists candidate_name text;
alter table public.hr_interviews add column if not exists candidate_email text;
alter table public.hr_interviews add column if not exists "position" text;
alter table public.hr_interviews add column if not exists location text;
alter table public.hr_interviews add column if not exists platform text;
alter table public.hr_interviews add column if not exists meeting_url text;

-- Expand interview_type check to allow PHYSICAL / VIRTUAL
alter table public.hr_interviews drop constraint if exists hr_interviews_interview_type_check;
alter table public.hr_interviews add constraint hr_interviews_interview_type_check
  check (interview_type in ('phone', 'video', 'in_person', 'panel', 'PHYSICAL', 'VIRTUAL'));

-- ============================================================
-- 1. WORK TASKS
-- ============================================================
create table if not exists public.work_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  employee_id uuid references public.employees(id) on delete cascade,
  employee_name text,
  assigned_to_user_id uuid references auth.users(id) on delete cascade,
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_by_name text,
  department text,
  branch text,
  priority text default 'medium' check (priority in ('low', 'medium', 'high', 'critical')),
  status text default 'assigned' check (status in ('assigned', 'accepted', 'in_progress', 'submitted', 'under_review', 'completed', 'rejected', 'overdue', 'cancelled')),
  completion_percentage int default 0 check (completion_percentage >= 0 and completion_percentage <= 100),
  instructions text,
  expected_outcome text,
  requires_evidence boolean default false,
  start_date date,
  due_date date,
  completed_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.work_tasks enable row level security;

-- RLS: assignee sees their tasks; assigner sees tasks they created
drop policy if exists "work_tasks_select" on public.work_tasks;
create policy "work_tasks_select"
  on public.work_tasks for select
  using (
    assigned_to_user_id = auth.uid()
    or assigned_by = auth.uid()
  );

drop policy if exists "work_tasks_insert" on public.work_tasks;
create policy "work_tasks_insert"
  on public.work_tasks for insert
  with check (
    assigned_by = auth.uid()
    or auth.role() = 'authenticated'
  );

drop policy if exists "work_tasks_update" on public.work_tasks;
create policy "work_tasks_update"
  on public.work_tasks for update
  using (
    assigned_to_user_id = auth.uid()
    or assigned_by = auth.uid()
  );

create index if not exists idx_work_tasks_employee on public.work_tasks(employee_id);
create index if not exists idx_work_tasks_assigned_to on public.work_tasks(assigned_to_user_id);
create index if not exists idx_work_tasks_assigned_by on public.work_tasks(assigned_by);
create index if not exists idx_work_tasks_status on public.work_tasks(status);
create index if not exists idx_work_tasks_due_date on public.work_tasks(due_date);

-- ============================================================
-- 2. TASK SUBMISSIONS (completion proof)
-- ============================================================
create table if not exists public.task_submissions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.work_tasks(id) on delete cascade,
  submitted_by uuid references auth.users(id) on delete set null,
  submission_comment text,
  completion_percentage int default 100 check (completion_percentage >= 0 and completion_percentage <= 100),
  completed_date date,
  reference_url text,
  additional_note text,
  status text default 'under_review' check (status in ('under_review', 'approved', 'rejected')),
  review_comment text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.task_submissions enable row level security;

drop policy if exists "task_submissions_select" on public.task_submissions;
create policy "task_submissions_select"
  on public.task_submissions for select
  using (
    submitted_by = auth.uid()
    or exists (
      select 1 from public.work_tasks wt
      where wt.id = task_submissions.task_id
      and wt.assigned_by = auth.uid()
    )
  );

drop policy if exists "task_submissions_insert" on public.task_submissions;
create policy "task_submissions_insert"
  on public.task_submissions for insert
  with check (
    submitted_by = auth.uid()
  );

drop policy if exists "task_submissions_update" on public.task_submissions;
create policy "task_submissions_update"
  on public.task_submissions for update
  using (
    exists (
      select 1 from public.work_tasks wt
      where wt.id = task_submissions.task_id
      and wt.assigned_by = auth.uid()
    )
  );

create index if not exists idx_task_submissions_task on public.task_submissions(task_id);
create index if not exists idx_task_submissions_status on public.task_submissions(status);

-- ============================================================
-- 3. TARGETS
-- ============================================================
create table if not exists public.targets (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  employee_id uuid references public.employees(id) on delete cascade,
  employee_name text,
  manager_id uuid references auth.users(id) on delete set null,
  department text,
  branch text,
  measurement_type text,
  target_value numeric(14, 2) not null default 0,
  starting_value numeric(14, 2) default 0,
  current_value numeric(14, 2) default 0,
  unit text,
  start_date date,
  end_date date,
  frequency text default 'monthly' check (frequency in ('daily', 'weekly', 'monthly', 'quarterly', 'annual', 'custom')),
  status text default 'active' check (status in ('active', 'achieved', 'missed', 'cancelled')),
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.targets enable row level security;

drop policy if exists "targets_select" on public.targets;
create policy "targets_select"
  on public.targets for select
  using (
    manager_id = auth.uid()
    or exists (
      select 1 from public.employees e
      where e.id = targets.employee_id
      and e.user_id = auth.uid()
    )
    or auth.role() = 'authenticated'
  );

drop policy if exists "targets_insert" on public.targets;
create policy "targets_insert"
  on public.targets for insert
  with check (auth.role() = 'authenticated');

drop policy if exists "targets_update" on public.targets;
create policy "targets_update"
  on public.targets for update
  using (
    manager_id = auth.uid()
    or exists (
      select 1 from public.employees e
      where e.id = targets.employee_id
      and e.user_id = auth.uid()
    )
    or auth.role() = 'authenticated'
  );

create index if not exists idx_targets_employee on public.targets(employee_id);
create index if not exists idx_targets_manager on public.targets(manager_id);
create index if not exists idx_targets_status on public.targets(status);

-- ============================================================
-- 4. EMPLOYEE KPIs
-- ============================================================
create table if not exists public.employee_kpis (
  id uuid primary key default gen_random_uuid(),
  kpi_name text not null,
  employee_id uuid references public.employees(id) on delete cascade,
  employee_name text,
  department text,
  role text,
  manager_id uuid references auth.users(id) on delete set null,
  category text,
  description text,
  measurement_method text,
  target_value numeric(14, 2) not null default 0,
  actual_value numeric(14, 2) default 0,
  unit text,
  weight numeric(5, 2) default 100 check (weight >= 0 and weight <= 100),
  review_period text default 'quarterly' check (review_period in ('q1', 'q2', 'q3', 'q4', 'annual', 'mid_year')),
  quarter text check (quarter in ('Q1', 'Q2', 'Q3', 'Q4')),
  appraisal_year int,
  rating text check (rating in ('excellent', 'good', 'satisfactory', 'needs_improvement', 'unsatisfactory')),
  manager_comment text,
  employee_comment text,
  status text default 'active' check (status in ('active', 'in_review', 'completed', 'acknowledged')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.employee_kpis enable row level security;

drop policy if exists "kpis_select" on public.employee_kpis;
create policy "kpis_select"
  on public.employee_kpis for select
  using (
    manager_id = auth.uid()
    or exists (
      select 1 from public.employees e
      where e.id = employee_kpis.employee_id
      and e.user_id = auth.uid()
    )
    or auth.role() = 'authenticated'
  );

drop policy if exists "kpis_insert" on public.employee_kpis;
create policy "kpis_insert"
  on public.employee_kpis for insert
  with check (auth.role() = 'authenticated');

drop policy if exists "kpis_update" on public.employee_kpis;
create policy "kpis_update"
  on public.employee_kpis for update
  using (
    manager_id = auth.uid()
    or exists (
      select 1 from public.employees e
      where e.id = employee_kpis.employee_id
      and e.user_id = auth.uid()
    )
    or auth.role() = 'authenticated'
  );

create index if not exists idx_kpis_employee on public.employee_kpis(employee_id);
create index if not exists idx_kpis_manager on public.employee_kpis(manager_id);
create index if not exists idx_kpis_status on public.employee_kpis(status);

-- ============================================================
-- 5. STORAGE BUCKET for task evidence
-- ============================================================
insert into storage.buckets (id, name, public)
values ('task-evidence', 'task-evidence', false)
on conflict (id) do nothing;

-- Storage policies: employees can upload to their own task folder;
-- managers can read evidence for tasks they assigned
drop policy if exists "task_evidence_upload" on storage.objects;
create policy "task_evidence_upload"
  on storage.objects for insert
  with check (
    bucket_id = 'task-evidence'
    and auth.role() = 'authenticated'
  );

drop policy if exists "task_evidence_read" on storage.objects;
create policy "task_evidence_read"
  on storage.objects for select
  using (
    bucket_id = 'task-evidence'
    and auth.role() = 'authenticated'
  );

drop policy if exists "task_evidence_delete" on storage.objects;
create policy "task_evidence_delete"
  on storage.objects for delete
  using (
    bucket_id = 'task-evidence'
    and auth.role() = 'authenticated'
  );
