-- ============================================================
-- Phase — HR job postings: archive + delete + stop applications
-- Run in Supabase SQL Editor after 20260921000008. Idempotent/additive.
-- ============================================================

-- 1. Extend the status CHECK to admit 'archived'
--    ('draft' | 'published' | 'closed' | 'archived'). The public apply
--    gate (public_apply_for_job) and job listing already require
--    status = 'published', so archived and closed both stop the
--    collection of applications with no backend changes.
alter table public.hr_jobs
  drop constraint if exists hr_jobs_status_check;

alter table public.hr_jobs
  add constraint hr_jobs_status_check
  check (status in ('draft', 'published', 'closed', 'archived'));

-- 2. Track when a posting was archived
alter table public.hr_jobs
  add column if not exists archived_at timestamptz;

-- 3. RLS delete policy (none existed before — HR could read/insert/update
--    but never delete). Gated to HR management roles, mirroring the
--    update/insert gates. Deleting a job sets candidates' job_id null
--    (their records survive) and cascades screening config + job questions.
drop policy if exists hr_jobs_delete on public.hr_jobs;
create policy hr_jobs_delete on public.hr_jobs
  for delete using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager')
  );