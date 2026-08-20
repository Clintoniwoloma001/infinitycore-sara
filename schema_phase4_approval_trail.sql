-- ============================================================
-- Phase 4: Approval trail + cancellation-requires-reapproval
-- Run manually in Supabase SQL Editor, after phase3.
-- ============================================================

-- Distinguishes "this pass through the chain is a cancellation
-- request", so the same 4-stage chain can be reused for cancellations
-- without inventing a parallel workflow.
alter table public.leave_requests add column if not exists is_cancellation boolean default false;

-- One row per stage decision — this is what backs the "View approval
-- trail" UI (who decided, at which stage, when, with what comment/signature).
create table if not exists public.leave_approvals (
  id uuid primary key default gen_random_uuid(),
  leave_request_id uuid references public.leave_requests(id) on delete cascade,
  stage int not null,
  stage_role text not null,
  stage_label text not null,
  decision text not null check (decision in ('approved','rejected')),
  approver_id uuid references auth.users(id),
  approver_name text,
  comment text,
  signature text,
  is_cancellation boolean default false,
  created_at timestamptz default now()
);

create index if not exists idx_leave_approvals_request on public.leave_approvals(leave_request_id);

alter table public.leave_approvals enable row level security;

drop policy if exists "leave_approvals read" on public.leave_approvals;
create policy "leave_approvals read" on public.leave_approvals
  for select using (
    approver_id = auth.uid()
    or exists (select 1 from public.leave_requests lr where lr.id = leave_request_id and lr.created_by = auth.uid())
    or public.current_role() in ('admin','super_admin','branch_manager','area_manager','head_of_business','hr_manager','hr_officer')
  );

drop policy if exists "leave_approvals insert" on public.leave_approvals;
create policy "leave_approvals insert" on public.leave_approvals
  for insert with check (auth.role() = 'authenticated');

-- ============================================================
-- Also re-run the corrected leave_requests policies from the chat
-- message before this file, if you haven't already — they fix the
-- visibility bug (staff seeing other people's requests).
-- ============================================================
