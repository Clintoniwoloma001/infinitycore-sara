-- ============================================================
-- Phase 32 — Platform QA hardening (idempotent, additive)
-- ============================================================
-- Fixes found during the full-platform QA/repair sweep:
--
--   1. `permissions` and `role_permissions` had permissive RLS
--      policies defined but RLS was never ENABLED, so the policies
--      were inert. Enable RLS so only super_admin can read them.
--   2. `targets` / `employee_kpis` select + write policies contained
--      `or auth.role() = 'authenticated'`, which let any signed-in
--      user read (and write) every employee's targets/KPIs. Scope
--      them to the owning employee, their manager, or HR/leadership.
--   3. `employee_supervisors` and `employee_account_invites` were
--      world-readable to every authenticated user. Scope reads to
--      HR/leadership (the only features that use them).
--   4. `employee_kpis.review_period` default ('quarterly') violated
--      its own CHECK constraint. Default corrected to a valid value.
--
-- Safe to re-run. No data is dropped.
-- ============================================================

-- 1) Reference tables: turn on the RLS that was already declared.
alter table if exists public.permissions enable row level security;
alter table if exists public.role_permissions enable row level security;

-- The read policies `permissions_super_admin_read` and
-- `role_permissions_super_admin_read` are created in phase 2 and take
-- effect once RLS is enabled above.

-- 2a) targets — owner, manager, or HR/leadership only.
drop policy if exists "targets_select" on public.targets;
create policy "targets_select"
  on public.targets for select
  to authenticated
  using (
    manager_id = auth.uid()
    or exists (
      select 1 from public.employees e
      where e.id = targets.employee_id
      and e.user_id = auth.uid()
    )
    or public.current_role() in (
      'super_admin', 'admin', 'hr_manager', 'hr_officer',
      'branch_manager', 'area_manager', 'head_of_business'
    )
  );

drop policy if exists "targets_insert" on public.targets;
create policy "targets_insert"
  on public.targets for insert
  to authenticated
  with check (
    public.current_role() in (
      'super_admin', 'admin', 'hr_manager', 'hr_officer',
      'branch_manager', 'area_manager', 'head_of_business'
    )
  );

drop policy if exists "targets_update" on public.targets;
create policy "targets_update"
  on public.targets for update
  to authenticated
  using (
    manager_id = auth.uid()
    or exists (
      select 1 from public.employees e
      where e.id = targets.employee_id
      and e.user_id = auth.uid()
    )
    or public.current_role() in (
      'super_admin', 'admin', 'hr_manager', 'hr_officer',
      'branch_manager', 'area_manager', 'head_of_business'
    )
  )
  with check (
    public.current_role() in (
      'super_admin', 'admin', 'hr_manager', 'hr_officer',
      'branch_manager', 'area_manager', 'head_of_business'
    )
  );

-- 2b) employee_kpis — same scoping.
drop policy if exists "kpis_select" on public.employee_kpis;
create policy "kpis_select"
  on public.employee_kpis for select
  to authenticated
  using (
    manager_id = auth.uid()
    or exists (
      select 1 from public.employees e
      where e.id = employee_kpis.employee_id
      and e.user_id = auth.uid()
    )
    or public.current_role() in (
      'super_admin', 'admin', 'hr_manager', 'hr_officer',
      'branch_manager', 'area_manager', 'head_of_business'
    )
  );

drop policy if exists "kpis_insert" on public.employee_kpis;
create policy "kpis_insert"
  on public.employee_kpis for insert
  to authenticated
  with check (
    public.current_role() in (
      'super_admin', 'admin', 'hr_manager', 'hr_officer',
      'branch_manager', 'area_manager', 'head_of_business'
    )
  );

drop policy if exists "kpis_update" on public.employee_kpis;
create policy "kpis_update"
  on public.employee_kpis for update
  to authenticated
  using (
    manager_id = auth.uid()
    or exists (
      select 1 from public.employees e
      where e.id = employee_kpis.employee_id
      and e.user_id = auth.uid()
    )
    or public.current_role() in (
      'super_admin', 'admin', 'hr_manager', 'hr_officer',
      'branch_manager', 'area_manager', 'head_of_business'
    )
  )
  with check (
    public.current_role() in (
      'super_admin', 'admin', 'hr_manager', 'hr_officer',
      'branch_manager', 'area_manager', 'head_of_business'
    )
  );

-- 3) Org/invite data — HR/leadership only.
drop policy if exists "phase26_read_all" on public.employee_supervisors;
create policy "phase26_read_all"
  on public.employee_supervisors for select
  to authenticated
  using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
  );

drop policy if exists "phase26_read_all" on public.employee_account_invites;
create policy "phase26_read_all"
  on public.employee_account_invites for select
  to authenticated
  using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
  );

-- 4) employee_kpis.review_period default violated its CHECK constraint.
alter table if exists public.employee_kpis
  alter column review_period set default 'q1';

-- 5) task_submissions.evidence_files was written by workTaskService on every
--    submission but the column did not exist, so submissions with evidence
--    failed with a PostgREST "column does not exist" error.
alter table if exists public.task_submissions
  add column if not exists evidence_files jsonb default '[]'::jsonb;
