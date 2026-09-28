-- ============================================================================
-- Work Management & KPI Engine Overhaul - step 4:
--   progress_reports / progress_report_steps / task_attachments + RLS
-- ============================================================================
-- Iterative progress reporting: an employee may submit as many reports as they
-- like per task. Only APPROVED step values are ever written back to
-- work_task_steps, so a rejected report can never inflate a score.
--
-- Idempotent + additive.
begin;

create table if not exists public.progress_reports (
  id                 uuid primary key default gen_random_uuid(),
  task_id            uuid not null references public.work_tasks(id) on delete cascade,
  submitted_by       uuid not null default auth.uid(),
  -- Snapshot of the task rate at submission time. The PENDING rate the user
  -- claimed, kept for the "approved vs pending" indicator in My Work.
  pending_percentage numeric not null default 0
                       check (pending_percentage >= 0 and pending_percentage <= 100),
  summary_comment    text,
  status             text not null default 'pending_review'
                       check (status in ('pending_review','approved','rejected','changes_requested')),
  reviewer_id        uuid references auth.users(id) on delete set null,
  reviewer_comment   text,
  reviewed_at        timestamptz,
  created_at         timestamptz not null default now()
);

create index if not exists idx_progress_reports_task
  on public.progress_reports(task_id, created_at desc);
create index if not exists idx_progress_reports_reviewer_queue
  on public.progress_reports(created_at)
  where status = 'pending_review';

-- Per-step snapshot of what the employee claimed. approval_status is PENDING
-- until a reviewer rules on that individual step.
create table if not exists public.progress_report_steps (
  id                 uuid primary key default gen_random_uuid(),
  progress_report_id uuid not null references public.progress_reports(id) on delete cascade,
  task_step_id       uuid not null references public.work_task_steps(id) on delete cascade,
  reported_value     numeric,
  reported_boolean   boolean,
  approval_status    text not null default 'pending'
                       check (approval_status in ('approved','rejected','pending')),
  rejection_reason   text,
  -- A rejected step MUST carry a reason; the UI and the RPC both enforce it.
  constraint progress_report_steps_reject_reason check (
    approval_status <> 'rejected' or (rejection_reason is not null and btrim(rejection_reason) <> '')
  )
);

create unique index if not exists uq_progress_report_steps_step
  on public.progress_report_steps(progress_report_id, task_step_id);
create index if not exists idx_progress_report_steps_step
  on public.progress_report_steps(task_step_id);

-- Evidence for a whole report (task_id kept for the "all evidence for this
-- task" view) and reviewer feedback, which uses the same table with
-- uploaded_by = the reviewer and a null progress_report_id.
create table if not exists public.task_attachments (
  id                 uuid primary key default gen_random_uuid(),
  task_id            uuid not null references public.work_tasks(id) on delete cascade,
  progress_report_id uuid references public.progress_reports(id) on delete cascade,
  file_url           text not null,
  file_name          text,
  file_type          text,
  -- 'evidence' = employee proof of work; 'reviewer_feedback' = returned to the
  -- employee with the review decision.
  kind               text not null default 'evidence'
                       check (kind in ('evidence','reviewer_feedback')),
  uploaded_by        uuid not null default auth.uid(),
  uploaded_at        timestamptz not null default now()
);

create index if not exists idx_task_attachments_task
  on public.task_attachments(task_id, uploaded_at desc);
create index if not exists idx_task_attachments_report
  on public.task_attachments(progress_report_id) where progress_report_id is not null;

commit;

-- ============================================================================
-- RLS
-- ============================================================================
-- INVARIANT: a user can always see exactly the steps of the tasks they can
-- see. Every policy is expressed as "exists a visible parent work_task", so
-- step visibility can never drift from task visibility. The only capability
-- added over the legacy work_tasks policy is the review role set, which is
-- REQUIRED - a reviewer must be able to see what they are judging.
begin;

-- The review role set, in one place so the four tables cannot drift apart.
create or replace function public.can_review_work_tasks()
returns boolean
language sql
stable
as $$
  select public.current_role() in (
    'super_admin','admin','head_of_human_resources','hr_officer',
    'head_of_operations','head_of_business','branch_manager','area_manager'
  );
$$;

alter table public.work_task_steps         enable row level security;
alter table public.progress_reports       enable row level security;
alter table public.progress_report_steps  enable row level security;
alter table public.task_attachments       enable row level security;

drop policy if exists work_task_steps_select on public.work_task_steps;
create policy work_task_steps_select on public.work_task_steps
  for select to authenticated
  using (exists (
    select 1 from public.work_tasks t
     where t.id = work_task_steps.task_id
       and (t.assigned_to_user_id = auth.uid()
            or t.assigned_by = auth.uid()
            or public.can_review_work_tasks())
  ));

-- Steps are written ONLY by the engine / the RPCs below, never by a client.
-- There is deliberately NO update/delete policy on this table, so a direct
-- supabase.from('work_task_steps').update(...) is refused by RLS and the
-- "no manual percentage" rule is enforced by the database, not by convention.
-- Only the creator of a task (or a reviewer) may add steps to it.
drop policy if exists work_task_steps_insert on public.work_task_steps;
create policy work_task_steps_insert on public.work_task_steps
  for insert to authenticated
  with check (exists (
    select 1 from public.work_tasks t
     where t.id = work_task_steps.task_id
       and (t.assigned_by = auth.uid() or public.can_review_work_tasks())
  ));

drop policy if exists progress_reports_select on public.progress_reports;
create policy progress_reports_select on public.progress_reports
  for select to authenticated
  using (exists (
    select 1 from public.work_tasks t
     where t.id = progress_reports.task_id
       and (t.assigned_to_user_id = auth.uid()
            or t.assigned_by = auth.uid()
            or public.can_review_work_tasks())
  ));

-- Reports are opened by the assignee and ruled on by a reviewer. Both need
-- INSERT; only the assignee may submit their own (task_id must be theirs).
drop policy if exists progress_reports_insert on public.progress_reports;
create policy progress_reports_insert on public.progress_reports
  for insert to authenticated
  with check (exists (
    select 1 from public.work_tasks t
     where t.id = progress_reports.task_id
       and t.assigned_to_user_id = auth.uid()
  ));

drop policy if exists progress_report_steps_select on public.progress_report_steps;
create policy progress_report_steps_select on public.progress_report_steps
  for select to authenticated
  using (exists (
    select 1 from public.progress_reports pr
      join public.work_tasks t on t.id = pr.task_id
     where pr.id = progress_report_steps.progress_report_id
       and (t.assigned_to_user_id = auth.uid()
            or t.assigned_by = auth.uid()
            or public.can_review_work_tasks())
  ));

drop policy if exists progress_report_steps_insert on public.progress_report_steps;
create policy progress_report_steps_insert on public.progress_report_steps
  for insert to authenticated
  with check (exists (
    select 1 from public.progress_reports pr
      join public.work_tasks t on t.id = pr.task_id
     where pr.id = progress_report_steps.progress_report_id
       and t.assigned_to_user_id = auth.uid()
  ));

drop policy if exists task_attachments_select on public.task_attachments;
create policy task_attachments_select on public.task_attachments
  for select to authenticated
  using (exists (
    select 1 from public.work_tasks t
     where t.id = task_attachments.task_id
       and (t.assigned_to_user_id = auth.uid()
            or t.assigned_by = auth.uid()
            or public.can_review_work_tasks())
  ));

-- Evidence is filed by the assignee or the reviewer (who may also return a
-- feedback file). Rows are immutable: a filed submission cannot be quietly
-- rewritten after the fact.
drop policy if exists task_attachments_insert on public.task_attachments;
create policy task_attachments_insert on public.task_attachments
  for insert to authenticated
  with check (uploaded_by = auth.uid() and exists (
    select 1 from public.work_tasks t
     where t.id = task_attachments.task_id
       and (t.assigned_to_user_id = auth.uid()
            or t.assigned_by = auth.uid()
            or public.can_review_work_tasks())
  ));

commit;

