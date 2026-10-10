-- ============================================================================
-- hr_interviews INSERT — Super Admin (and the head roles) can schedule
-- ============================================================================
-- WHY THIS FIX
--   Scheduling an interview from the Interviews page raised
--     `new row violates row-level security policy for table "hr_interviews"`
--   for a Super Admin. `hrService.scheduleInterview()` (src/services/hrService.js)
--   performs a direct INSERT, and the only INSERT policy on the table allowed
--     public.current_role() in ('admin', 'head_of_human_resources', 'hr_officer')
--   i.e. `super_admin` was missing. `super_admin` is in the SELECT and UPDATE
--   policies, so the row was created-then-rejected semantics were impossible:
--   nothing could ever be written by the platform's highest role.
--
-- WHAT THIS DOES
--   Re-issues ONE policy — `hr_interviews_insert` — with the same shape plus
--   the roles that can already read and update the table. ADDITIVE: no data,
--   no column, no grant change; SELECT/UPDATE policies are untouched.
--
-- IDEMPOTENT / SAFE TO RE-RUN. wrap in a single transaction.
-- ============================================================================
begin;

drop policy if exists "hr_interviews_insert" on public.hr_interviews;

create policy "hr_interviews_insert" on public.hr_interviews
  for insert with check (
    public.current_role() in (
      'super_admin', 'admin', 'head_of_human_resources', 'hr_officer',
      'head_of_business', 'head_of_operations'
    )
  );

-- Belt and braces: the guarded SECURITY DEFINER RPC used by the Recruitment
-- pipeline (and now by the Interviews page as an RLS-violation fallback)
-- inserts the same row under its own role gate. It is re-granted here in case
-- a host applied the pipeline schema without the execute grant.
do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'hr_schedule_recruitment_interview'
  ) then
    execute 'grant execute on function public.hr_schedule_recruitment_interview(uuid, jsonb) to authenticated';
  end if;
end $$;

commit;
