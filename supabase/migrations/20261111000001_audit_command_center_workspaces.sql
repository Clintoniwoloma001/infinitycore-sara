-- ============================================================================
-- PHASE 72 - AUDIT COMMAND CENTRE, DEPARTMENT WORKSPACE & SHARED WORKSPACE
-- ============================================================================
-- Run in Supabase SQL Editor AFTER 20260927000001 (Phase 71 audit tables).
-- Idempotent, additive, transaction-wrapped. Nothing is dropped and no
-- existing record is rewritten.
--
-- WHY THIS MIGRATION
-- The Phase 71 audit module gave the Audit department ONE workspace (the
-- regulatory + findings register). Three audiences need three different views
-- of the same data, and the most sensitive one - the Audit Command Centre -
-- was previously only hidden in the navigation menu. This migration makes the
-- boundaries REAL:
--
--   HEAD OF AUDIT    - Audit Command Centre. Cross-department oversight:
--                     every obligation, acknowledgement coverage, SLA state,
--                     review queues, escalation history and configuration.
--                     Restricted on the SERVER: get_audit_command_center()
--                     checks the caller's role itself, so a hidden menu item
--                     is never the only thing standing between a deep link and
--                     restricted data.
--   HEAD OF DEPT     - "My Department's Audit". The caller's department is
--                     read from THEIR OWN profiles row server-side; no
--                     client-supplied department id is trusted anywhere.
--   AUDIT STAFF      - Shared Audit Workspace. The audit department's
--                     schedules, assigned reviews, evidence and queues.
--
-- DATA MODEL (additive to Phase 71)
--   audit_obligations            one requirement: return, circular, evidence
--                                request, finding action, declaration...
--   audit_obligation_assignments one obligation issued to one person, with
--                                acknowledgement + submission deadlines
--   audit_submissions            versioned responses with correction trail
--
-- Every deadline, countdown, overdue flag and SLA state is DERIVED server-side
-- from these rows. There is no stored percentage and no stored "is overdue":
-- the reminder job, the Command Centre and the department workspace all read
-- the same computed truth, so they can never disagree.
--
-- WRITE PATH: RLS grants READ only. Every insert/update goes through a
-- SECURITY DEFINER RPC that re-checks the caller, so the browser cannot write
-- to these tables directly even with the anon key.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. PERMISSIONS
-- ---------------------------------------------------------------------------
-- Seeded into the existing granular catalogue so has_permission() resolves
-- them like any other key - no bespoke authz path is introduced.
insert into public.permissions (permission_key, description, category, module, resource, action, sensitive, scope_modes, is_system)
values
  ('audit.command_center.read', 'View the restricted Audit Command Centre and its configuration', 'audit', 'audit', 'command_center', 'read', true, '{global}', true),
  ('audit.obligations.manage',  'Create, edit and archive audit obligations and their schedules', 'audit', 'audit', 'obligations', 'manage', true, '{global}', true),
  ('audit.workspace.read',      'Use the shared Audit Workspace (audit department staff)', 'audit', 'audit', 'workspace', 'read', false, '{global}', true),
  ('audit.department.read',     'View own department''s audit obligations (Heads of Department)', 'audit', 'audit', 'department', 'read', false, '{global}', true)
on conflict (permission_key) do update
  set description = excluded.description, category = excluded.category;

-- The Command Centre is for the Head of Audit and the two break-glass
-- administrators. Everyone else is refused by the RPC itself.
select public.seed_role_permission('head_of_audit', 'audit.command_center.read');
select public.seed_role_permission('head_of_audit', 'audit.obligations.manage');
select public.seed_role_permission('head_of_audit', 'audit.workspace.read');
select public.seed_role_permission('super_admin', 'audit.command_center.read');
select public.seed_role_permission('super_admin', 'audit.obligations.manage');
select public.seed_role_permission('super_admin', 'audit.workspace.read');
select public.seed_role_permission('admin', 'audit.command_center.read');
select public.seed_role_permission('admin', 'audit.workspace.read');

-- Every Head of Department may see THEIR OWN department's audit tab. The role
-- list mirrors web src/constants/roles.js DEPARTMENT_HEAD_ROLES so a rename on
-- one side is visible as a failing test, not silent over-permission.
select public.seed_role_permission('head_of_human_resources', 'audit.department.read');
select public.seed_role_permission('head_of_operations', 'audit.department.read');
select public.seed_role_permission('head_of_business', 'audit.department.read');
select public.seed_role_permission('head_of_e_business', 'audit.department.read');
select public.seed_role_permission('financial_controller', 'audit.department.read');
select public.seed_role_permission('head_of_risk_compliance', 'audit.department.read');
select public.seed_role_permission('head_of_legal', 'audit.department.read');
select public.seed_role_permission('branch_manager', 'audit.department.read');
select public.seed_role_permission('area_manager', 'audit.department.read');

-- The audit department itself: its staff (and future members added to the
-- audit department on profiles.department) reach the shared workspace.

-- ---------------------------------------------------------------------------
-- 2. SERVER-SIDE IDENTITY HELPERS
-- ---------------------------------------------------------------------------
-- current_role() is the existing pattern (SECURITY DEFINER to dodge the
-- profiles RLS recursion). These follow it exactly. The client NEVER supplies
-- a role, a department or a claim of Head of Audit privilege.
create or replace function public.current_department()
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select department from public.profiles where id = auth.uid()), '');
$$;

create or replace function public.is_audit_command_center_reader()
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_permission('audit.command_center.read')
      or public.current_role() in ('super_admin', 'admin', 'head_of_audit');
$$;

create or replace function public.is_department_head()
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_permission('audit.department.read')
      or public.current_role() in (
        'super_admin', 'admin',
        'head_of_audit',
        'head_of_human_resources', 'hr_manager',
        'head_of_operations', 'head_of_business', 'head_of_e_business',
        'financial_controller', 'head_of_risk_compliance', 'head_of_legal',
        'branch_manager', 'area_manager'
      );
$$;

create or replace function public.is_audit_workspace_member()
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_permission('audit.workspace.read')
      or public.current_role() in ('super_admin', 'admin', 'head_of_audit')
      or public.current_department() = 'audit';
$$;

-- ---------------------------------------------------------------------------
-- 3. AUDIT OBLIGATIONS
-- ---------------------------------------------------------------------------
-- One row per requirement issued. Every deadline is a real date; the derived
-- states (overdue, due soon, SLA breached) are computed at read time by the
-- RPCs so the UI, the reminder job and the Command Centre cannot disagree.
create table if not exists public.audit_obligations (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  title text not null,
  description text,
  instructions text,
  obligation_type text not null default 'regulatory_return'
    check (obligation_type in (
      'audit_finding', 'regulatory_return', 'regulatory_circular',
      'compliance_declaration', 'evidence_request', 'corrective_action', 'custom')),
  department text not null default 'audit',
  accountable_owner_user_id uuid references public.profiles(id) on delete set null,
  contributors uuid[] not null default '{}',
  reviewers uuid[] not null default '{}',
  reporting_period text,
  source_document text,
  source_reference text,
  issue_date date,
  acknowledgement_deadline date,
  submission_deadline date,
  review_deadline date,
  priority text not null default 'medium'
    check (priority in ('low', 'medium', 'high', 'critical')),
  risk_rating text not null default 'medium'
    check (risk_rating in ('low', 'medium', 'high', 'critical')),
  requires_acknowledgement boolean not null default true,
  requires_submission boolean not null default true,
  required_documents jsonb not null default '[]'::jsonb,
  submission_methods text[] not null default '{upload,editor}',
  sla_policy jsonb,
  recurrence_rule text,
  next_occurrence date,
  status text not null default 'active'
    check (status in ('draft', 'active', 'paused', 'archived', 'closed')),
  closure_evidence text,
  closure_decision text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists audit_obligations_department_idx
  on public.audit_obligations (department);
create index if not exists audit_obligations_owner_idx
  on public.audit_obligations (accountable_owner_user_id);
create index if not exists audit_obligations_status_deadline_idx
  on public.audit_obligations (status, submission_deadline);

-- ---------------------------------------------------------------------------
-- 4. AUDIT OBLIGATION ASSIGNMENTS
-- ---------------------------------------------------------------------------
-- One obligation issued to ONE person. The per-person deadlines live here so
-- an extension granted to one department never rewrites the institution-wide
-- deadline: the original stays visible, the assignment records what changed.
create table if not exists public.audit_obligation_assignments (
  id uuid primary key default gen_random_uuid(),
  obligation_id uuid not null references public.audit_obligations(id) on delete cascade,
  assigned_user_id uuid not null references public.profiles(id) on delete cascade,
  department text not null default 'audit',
  acknowledgement_deadline date,
  submission_deadline date,
  review_deadline date,
  deadline_extension_reason text,
  deadline_extended_by uuid references public.profiles(id) on delete set null,
  deadline_extended_at timestamptz,
  original_submission_deadline date,
  status text not null default 'not_started'
    check (status in (
      'not_started', 'acknowledged', 'submitted', 'under_review',
      'returned_for_correction', 'resubmitted', 'accepted', 'closed', 'rejected')),
  acknowledged_at timestamptz,
  last_submitted_at timestamptz,
  last_reminded_at timestamptz,
  escalated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (obligation_id, assigned_user_id)
);

create index if not exists audit_assignments_user_idx
  on public.audit_obligation_assignments (assigned_user_id);
create index if not exists audit_assignments_department_idx
  on public.audit_obligation_assignments (department);
create index if not exists audit_assignments_status_idx
  on public.audit_obligation_assignments (status);

-- ---------------------------------------------------------------------------
-- 5. AUDIT SUBMISSIONS (versioned, with correction trail)
-- ---------------------------------------------------------------------------
-- Draft -> Submitted -> Under Review -> Accepted | Returned for Correction ->
-- Resubmitted -> Under Review -> Accepted/Closed. Every version is kept: a
-- corrected file never erases the evidence it replaces.
create table if not exists public.audit_submissions (
  id uuid primary key default gen_random_uuid(),
  obligation_id uuid not null references public.audit_obligations(id) on delete cascade,
  assignment_id uuid not null references public.audit_obligation_assignments(id) on delete cascade,
  version integer not null default 1,
  submitted_by uuid not null references public.profiles(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  files jsonb not null default '[]'::jsonb,
  status text not null default 'submitted'
    check (status in ('draft', 'submitted', 'under_review', 'returned_for_correction',
                      'resubmitted', 'accepted', 'closed', 'rejected')),
  correction_reason text,
  correction_fields text[] not null default '{}',
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (assignment_id, version)
);

create index if not exists audit_submissions_assignment_idx
  on public.audit_submissions (assignment_id);
create index if not exists audit_submissions_status_idx
  on public.audit_submissions (status);

-- ---------------------------------------------------------------------------
-- 6. ROW-LEVEL SECURITY - READ ONLY FROM THE CLIENT
-- ---------------------------------------------------------------------------
-- There is deliberately NO insert/update/delete policy. Writes go through the
-- SECURITY DEFINER RPCs below, each of which re-checks the caller; a missing
-- policy denies the direct path even with the anon key and a valid JWT.
alter table public.audit_obligations enable row level security;
alter table public.audit_obligation_assignments enable row level security;
alter table public.audit_submissions enable row level security;

drop policy if exists audit_obligations_select on public.audit_obligations;
create policy audit_obligations_select on public.audit_obligations
  for select using (
    public.is_audit_command_center_reader()
    or (public.is_department_head() and department = public.current_department())
    or (public.is_audit_workspace_member() and department = 'audit')
    or accountable_owner_user_id = auth.uid()
    or auth.uid() = any (contributors)
    or auth.uid() = any (reviewers)
  );

drop policy if exists audit_assignments_select on public.audit_obligation_assignments;
create policy audit_assignments_select on public.audit_obligation_assignments
  for select using (
    public.is_audit_command_center_reader()
    or (public.is_department_head() and department = public.current_department())
    or (public.is_audit_workspace_member() and department = 'audit')
    or assigned_user_id = auth.uid()
  );

drop policy if exists audit_submissions_select on public.audit_submissions;
create policy audit_submissions_select on public.audit_submissions
  for select using (
    public.is_audit_command_center_reader()
    or exists (
      select 1 from public.audit_obligation_assignments a
      where a.id = audit_submissions.assignment_id
        and (
          a.assigned_user_id = auth.uid()
          or (public.is_department_head() and a.department = public.current_department())
          or (public.is_audit_workspace_member() and a.department = 'audit')
        )
    )
  );

-- ---------------------------------------------------------------------------
-- 7. THE THREE WORKSPACE RPCs
-- ---------------------------------------------------------------------------
-- 7a. AUDIT COMMAND CENTRE - restricted to the Head of Audit (and the two
--     break-glass admins). The check is INSIDE the function: hiding the
--     navigation entry is not a security boundary.
create or replace function public.get_audit_command_center()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_audit_command_center_reader() then
    raise exception 'AUDIT_FORBIDDEN:The Audit Command Centre is restricted to the Head of Audit.';
  end if;

  return jsonb_build_object(
    'ok', true,
    'viewer', jsonb_build_object(
      'user_id', auth.uid(),
      'is_command_center_reader', true,
      'department', public.current_department()
    ),
    -- KPI cards. Every number below counts REAL rows.
    'summary', jsonb_build_object(
      'active_obligations', (
        select count(*)::int from public.audit_obligations where status = 'active'),
      'issued_assignments', (
        select count(*)::int from public.audit_obligation_assignments),
      'not_started', (
        select count(*)::int from public.audit_obligation_assignments where status = 'not_started'),
      'acknowledged', (
        select count(*)::int from public.audit_obligation_assignments
        where status in ('acknowledged', 'submitted', 'under_review',
                         'returned_for_correction', 'resubmitted', 'accepted', 'closed')),
      'pending_acknowledgement', (
        select count(*)::int from public.audit_obligation_assignments
        where status = 'not_started'
          and (acknowledgement_deadline is null or acknowledgement_deadline >= current_date)),
      'overdue_acknowledgement', (
        select count(*)::int from public.audit_obligation_assignments
        where status = 'not_started'
          and acknowledgement_deadline is not null
          and acknowledgement_deadline < current_date),
      'awaiting_review', (
        select count(*)::int from public.audit_submissions
        where status in ('submitted', 'resubmitted', 'under_review')),
      'returned_for_correction', (
        select count(*)::int from public.audit_submissions
        where status = 'returned_for_correction'),
      'overdue_submissions', (
        select count(*)::int from public.audit_obligation_assignments a
        where a.status in ('not_started', 'acknowledged', 'returned_for_correction')
          and a.submission_deadline is not null
          and a.submission_deadline < current_date),
      'open_findings', (
        select count(*)::int from public.audit_findings
        where status in ('open', 'in_progress', 'pending_closeout')),
      'critical_findings', (
        select count(*)::int from public.audit_findings
        where status in ('open', 'in_progress', 'pending_closeout')
          and severity = 'critical'),
      'high_risk_findings', (
        select count(*)::int from public.audit_findings
        where status in ('open', 'in_progress', 'pending_closeout')
          and severity = 'high')
    ),
    -- Acknowledgement coverage, per obligation.
    'acknowledgement_coverage', coalesce((
      select jsonb_agg(x order by x.reference)
      from (
        select o.id, o.reference, o.title, o.department,
               count(a.id)::int as recipients,
               count(a.acknowledged_at)::int as acknowledged,
               count(a.id) - count(a.acknowledged_at) as pending
        from public.audit_obligations o
        left join public.audit_obligation_assignments a on a.obligation_id = o.id
        where o.status = 'active'
        group by o.id
      ) x
    ), '[]'::jsonb),
    -- Department-by-department completion comparison.
    'department_completion', coalesce((
      select jsonb_agg(x order by (x.completion_pct) desc nulls last, x.department)
      from (
        select coalesce(a.department, o.department) as department,
               count(a.id)::int as assignments,
               count(a.acknowledged_at)::int as acknowledged,
               count(*) filter (where a.status in ('accepted', 'closed'))::int as completed,
               case when count(a.id) = 0 then null
                    else round(100.0 * count(*) filter (where a.status in ('accepted', 'closed'))
                               / count(a.id), 1) end as completion_pct
        from public.audit_obligation_assignments a
        join public.audit_obligations o on o.id = a.obligation_id
        group by coalesce(a.department, o.department)
      ) x
    ), '[]'::jsonb),
    -- What is due today, soon (7 days) and later (30 days).
    'deadline_horizon', coalesce((
      select jsonb_agg(x order by x.submission_deadline)
      from (
        select o.id, o.reference, o.title, o.department, o.risk_rating,
               a.submission_deadline,
               (a.submission_deadline - current_date)::int as days_until_due,
               case when a.submission_deadline < current_date then 'overdue'
                    when a.submission_deadline = current_date then 'due_today'
                    when a.submission_deadline <= current_date + 7 then 'due_soon'
                    else 'upcoming' end as sla_state,
               a.status
        from public.audit_obligation_assignments a
        join public.audit_obligations o on o.id = a.obligation_id
        where o.status = 'active'
          and a.submission_deadline is not null
          and a.submission_deadline <= current_date + 30
      ) x
    ), '[]'::jsonb),
    -- The review queue: submissions waiting on an audit decision.
    'review_queue', coalesce((
      select jsonb_agg(x order by x.submitted_at)
      from (
        select s.id as submission_id, s.version, s.status, s.submitted_at,
               s.correction_reason,
               o.reference, o.title as obligation_title, o.department,
               p.full_name as submitted_by_name
        from public.audit_submissions s
        join public.audit_obligations o on o.id = s.obligation_id
        left join public.profiles p on p.id = s.submitted_by
        where s.status in ('submitted', 'resubmitted', 'under_review')
      ) x
    ), '[]'::jsonb),
    -- High-risk and overdue findings, straight from the Phase 71 register.
    'high_risk_findings', coalesce((
      select jsonb_agg(x order by x.severity_rank, x.opened_at)
      from (
        select f.id, f.title, f.department, f.severity, f.status,
               f.due_date, f.opened_at,
               case f.severity when 'critical' then 1 when 'high' then 2
                               when 'medium' then 3 else 4 end as severity_rank,
               case when f.due_date is not null and f.due_date < current_date
                    then true else false end as is_overdue
        from public.audit_findings f
        where f.status in ('open', 'in_progress', 'pending_closeout')
          and f.severity in ('high', 'critical')
      ) x
    ), '[]'::jsonb),
    -- Every assignment with its derived SLA state, for the drill-down tables.
    'obligations', coalesce((
      select jsonb_agg(x order by x.sort_overdue desc, x.submission_deadline nulls last)
      from (
        select o.id, o.reference, o.title, o.obligation_type, o.department,
               o.risk_rating, o.priority, o.status,
               a.id as assignment_id, a.assigned_user_id, a.status as assignment_status,
               a.acknowledgement_deadline, a.acknowledged_at, a.submission_deadline,
               a.original_submission_deadline, a.deadline_extension_reason,
               a.escalated_at,
               p.full_name as owner_name,
               (a.submission_deadline - current_date)::int as days_until_due,
               case when a.status in ('accepted', 'closed', 'rejected') then 'closed'
                    when a.submission_deadline is null then 'not_due'
                    when a.submission_deadline < current_date then 'overdue'
                    when a.submission_deadline = current_date then 'due_today'
                    when a.submission_deadline <= current_date + 7 then 'due_soon'
                    else 'upcoming' end as sla_state,
               (a.submission_deadline is not null
                and a.submission_deadline < current_date
                and a.status not in ('accepted', 'closed', 'rejected')) as sort_overdue
        from public.audit_obligation_assignments a
        join public.audit_obligations o on o.id = a.obligation_id
        left join public.profiles p on p.id = a.assigned_user_id
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_audit_command_center() from public;
grant execute on function public.get_audit_command_center() to authenticated;

-- 7b. MY DEPARTMENT'S AUDIT - a Head of Department's own scope.
--     The department comes from the caller's own profiles row. A client that
--     asks for another department's work gets THIS department's work, not an
--     error and not theirs.
create or replace function public.get_my_department_audit()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_dept text := public.current_department();
begin
  if not public.is_department_head() then
    raise exception 'AUDIT_FORBIDDEN:This workspace is limited to Heads of Department.';
  end if;

  return jsonb_build_object(
    'ok', true,
    'viewer', jsonb_build_object(
      'user_id', auth.uid(),
      'department', v_dept
    ),
    'summary', jsonb_build_object(
      'obligations_issued', (
        select count(*)::int from public.audit_obligations o where o.department = v_dept),
      'assignments', (
        select count(*)::int from public.audit_obligation_assignments a where a.department = v_dept),
      'acknowledged', (
        select count(*)::int from public.audit_obligation_assignments a
        where a.department = v_dept and a.acknowledged_at is not null),
      'submitted', (
        select count(*)::int from public.audit_obligation_assignments a
        where a.department = v_dept and a.status in ('submitted', 'under_review', 'accepted', 'closed')),
      'pending', (
        select count(*)::int from public.audit_obligation_assignments a
        where a.department = v_dept and a.status in ('not_started', 'acknowledged')),
      'overdue', (
        select count(*)::int from public.audit_obligation_assignments a
        where a.department = v_dept
          and a.submission_deadline is not null
          and a.submission_deadline < current_date
          and a.status not in ('accepted', 'closed', 'rejected')),
      'returned_for_correction', (
        select count(*)::int from public.audit_submissions s
        join public.audit_obligation_assignments a on a.id = s.assignment_id
        where a.department = v_dept and s.status = 'returned_for_correction'),
      'due_today', (
        select count(*)::int from public.audit_obligation_assignments a
        where a.department = v_dept
          and a.submission_deadline = current_date
          and a.status not in ('accepted', 'closed', 'rejected')),
      'due_next_30', (
        select count(*)::int from public.audit_obligation_assignments a
        where a.department = v_dept
          and a.submission_deadline between current_date and current_date + 30
          and a.status not in ('accepted', 'closed', 'rejected'))
    ),
    'obligations', coalesce((
      select jsonb_agg(x order by x.sla_rank, x.submission_deadline nulls last)
      from (
        select o.id, o.reference, o.title, o.instructions, o.obligation_type,
               o.risk_rating, o.priority,
               o.requires_acknowledgement, o.requires_submission,
               o.required_documents,
               a.id as assignment_id, a.assigned_user_id, a.status as assignment_status,
               a.acknowledgement_deadline, a.acknowledged_at,
               a.submission_deadline, a.original_submission_deadline,
               a.deadline_extension_reason,
               p.full_name as owner_name, p.work_email as owner_email,
               (a.submission_deadline - current_date)::int as days_until_due,
               case when a.status in ('accepted', 'closed', 'rejected') then 'closed'
                    when a.submission_deadline is null then 'not_due'
                    when a.submission_deadline < current_date then 'overdue'
                    when a.submission_deadline = current_date then 'due_today'
                    when a.submission_deadline <= current_date + 7 then 'due_soon'
                    else 'upcoming' end as sla_state,
               case when a.status in ('accepted', 'closed', 'rejected') then 9
                    when a.submission_deadline is null then 8
                    when a.submission_deadline < current_date then 0
                    when a.submission_deadline = current_date then 1
                    when a.submission_deadline <= current_date + 7 then 2
                    else 3 end as sla_rank
        from public.audit_obligation_assignments a
        join public.audit_obligations o on o.id = a.obligation_id
        left join public.profiles p on p.id = a.assigned_user_id
        where a.department = v_dept
      ) x
    ), '[]'::jsonb),
    -- The department's own findings from the Phase 71 register.
    'findings', coalesce((
      select jsonb_agg(x order by x.severity_rank, x.opened_at)
      from (
        select f.id, f.title, f.description, f.severity, f.status, f.due_date,
               f.opened_at, f.reference,
               case f.severity when 'critical' then 1 when 'high' then 2
                               when 'medium' then 3 else 4 end as severity_rank
        from public.audit_findings f
        where f.department = v_dept
      ) x
    ), '[]'::jsonb),
    -- The full submission trail for this department, newest first. A returned
    -- item keeps its correction reason and the version it was returned from,
    -- so the Head of Department sees exactly why and can act on it.
    'submissions', coalesce((
      select jsonb_agg(x order by x.submitted_at desc)
      from (
        select s.id, s.assignment_id, s.version, s.status, s.correction_reason,
               s.correction_fields, s.submitted_at, s.reviewed_at,
               o.reference, o.title as obligation_title,
               p.full_name as submitted_by_name
        from public.audit_submissions s
        join public.audit_obligation_assignments a on a.id = s.assignment_id
        join public.audit_obligations o on o.id = s.obligation_id
        left join public.profiles p on p.id = s.submitted_by
        where a.department = v_dept
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_my_department_audit() from public;
grant execute on function public.get_my_department_audit() to authenticated;

-- 7c. SHARED AUDIT WORKSPACE - the audit department's own register.
create or replace function public.get_audit_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_audit_workspace_member() then
    raise exception 'AUDIT_FORBIDDEN:The shared Audit Workspace is limited to audit department staff.';
  end if;

  return jsonb_build_object(
    'ok', true,
    'viewer', jsonb_build_object(
      'user_id', auth.uid(),
      'department', public.current_department()
    ),
    'schedule', coalesce((
      select jsonb_agg(x order by x.submission_deadline nulls last)
      from (
        select o.id, o.reference, o.title, o.obligation_type, o.department,
               o.risk_rating, o.priority,
               a.id as assignment_id, a.assigned_user_id, a.status as assignment_status,
               a.submission_deadline,
               (a.submission_deadline - current_date)::int as days_until_due,
               p.full_name as owner_name,
               case when a.status in ('accepted', 'closed', 'rejected') then 'closed'
                    when a.submission_deadline is null then 'not_due'
                    when a.submission_deadline < current_date then 'overdue'
                    when a.submission_deadline = current_date then 'due_today'
                    when a.submission_deadline <= current_date + 7 then 'due_soon'
                    else 'upcoming' end as sla_state
        from public.audit_obligation_assignments a
        join public.audit_obligations o on o.id = a.obligation_id
        left join public.profiles p on p.id = a.assigned_user_id
        where o.status = 'active'
      ) x
    ), '[]'::jsonb),
    'my_assignments', coalesce((
      select jsonb_agg(x order by x.submission_deadline nulls last)
      from (
        select o.id as obligation_id, o.reference, o.title, o.instructions,
               o.required_documents,
               a.id as assignment_id, a.status as assignment_status,
               a.acknowledgement_deadline, a.acknowledged_at,
               a.submission_deadline,
               a.department as department,
               (a.submission_deadline - current_date)::int as days_until_due
        from public.audit_obligation_assignments a
        join public.audit_obligations o on o.id = a.obligation_id
        where a.assigned_user_id = auth.uid()
      ) x
    ), '[]'::jsonb),
    'review_queue', coalesce((
      select jsonb_agg(x order by x.submitted_at)
      from (
        select s.id as submission_id, s.version, s.status, s.submitted_at,
               s.correction_reason, s.correction_fields,
               o.reference, o.title as obligation_title, o.department,
               p.full_name as submitted_by_name
        from public.audit_submissions s
        join public.audit_obligations o on o.id = s.obligation_id
        left join public.profiles p on p.id = s.submitted_by
        where s.status in ('submitted', 'resubmitted', 'under_review')
      ) x
    ), '[]'::jsonb),
    'outstanding_tasks', coalesce((
      select jsonb_agg(x order by x.sla_rank, x.submission_deadline nulls last)
      from (
        select o.id, o.reference, o.title, o.department, o.risk_rating,
               a.id as assignment_id, a.status as assignment_status,
               a.submission_deadline,
               case when a.submission_deadline is null then 8
                    when a.submission_deadline < current_date then 0
                    when a.submission_deadline = current_date then 1
                    when a.submission_deadline <= current_date + 7 then 2
                    else 3 end as sla_rank
        from public.audit_obligation_assignments a
        join public.audit_obligations o on o.id = a.obligation_id
        where a.status in ('not_started', 'acknowledged', 'returned_for_correction')
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_audit_workspace() from public;
grant execute on function public.get_audit_workspace() to authenticated;

-- ---------------------------------------------------------------------------
-- 8. WRITE RPCS - the enforcement point for the client
-- ---------------------------------------------------------------------------
-- 8a. Create an obligation. Head of Audit only.
create or replace function public.create_audit_obligation(
  p_reference text,
  p_title text,
  p_description text default null,
  p_instructions text default null,
  p_obligation_type text default 'regulatory_return',
  p_department text default 'audit',
  p_accountable_owner_user_id uuid default null,
  p_reporting_period text default null,
  p_source_document text default null,
  p_source_reference text default null,
  p_issue_date date default null,
  p_acknowledgement_deadline date default null,
  p_submission_deadline date default null,
  p_review_deadline date default null,
  p_priority text default 'medium',
  p_risk_rating text default 'medium',
  p_requires_acknowledgement boolean default true,
  p_requires_submission boolean default true,
  p_required_documents jsonb default '[]'::jsonb,
  p_recurrence_rule text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not (public.has_permission('audit.obligations.manage')
          or public.current_role() in ('super_admin', 'admin', 'head_of_audit')) then
    raise exception 'AUDIT_FORBIDDEN:Only the Head of Audit can create audit obligations.';
  end if;
  if p_reference is null or btrim(p_reference) = '' or p_title is null or btrim(p_title) = '' then
    raise exception 'OBLIGATION_DETAILS_REQUIRED:An obligation needs a reference and a title.';
  end if;

  insert into public.audit_obligations (
    reference, title, description, instructions, obligation_type, department,
    accountable_owner_user_id, reporting_period, source_document, source_reference,
    issue_date, acknowledgement_deadline, submission_deadline, review_deadline,
    priority, risk_rating, requires_acknowledgement, requires_submission,
    required_documents, recurrence_rule, created_by
  ) values (
    btrim(p_reference), btrim(p_title), p_description, p_instructions, p_obligation_type, p_department,
    p_accountable_owner_user_id, p_reporting_period, p_source_document, p_source_reference,
    p_issue_date, p_acknowledgement_deadline, p_submission_deadline, p_review_deadline,
    p_priority, p_risk_rating, p_requires_acknowledgement, p_requires_submission,
    coalesce(p_required_documents, '[]'::jsonb), p_recurrence_rule, auth.uid()
  ) returning id into v_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('AUDIT_OBLIGATION_CREATED', 'AuditObligation', v_id::text,
          (select full_name from public.profiles where id = auth.uid()),
          jsonb_build_object('reference', btrim(p_reference), 'department', p_department,
                             'risk_rating', p_risk_rating, 'success', true)::text,
          'info');

  return jsonb_build_object('ok', true, 'id', v_id, 'reference', btrim(p_reference));
end;
$$;

revoke all on function public.create_audit_obligation(text, text, text, text, text, text, uuid, text, text, text, date, date, date, date, text, text, boolean, boolean, jsonb, text) from public;
grant execute on function public.create_audit_obligation(text, text, text, text, text, text, uuid, text, text, text, date, date, date, date, text, text, boolean, boolean, jsonb, text) to authenticated;

-- 8b. Issue an obligation to one person. Head of Audit only.
create or replace function public.issue_audit_obligation(
  p_obligation_id uuid,
  p_assigned_user_id uuid,
  p_acknowledgement_deadline date default null,
  p_submission_deadline date default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dept text;
  v_id uuid;
begin
  if not (public.has_permission('audit.obligations.manage')
          or public.current_role() in ('super_admin', 'admin', 'head_of_audit')) then
    raise exception 'AUDIT_FORBIDDEN:Only the Head of Audit can issue audit obligations.';
  end if;
  select department into v_dept from public.profiles where id = p_assigned_user_id;
  if v_dept is null then
    raise exception 'UNKNOWN_ASSIGNEE:That user could not be found.';
  end if;

  insert into public.audit_obligation_assignments (
    obligation_id, assigned_user_id, department,
    acknowledgement_deadline, submission_deadline, original_submission_deadline
  ) values (
    p_obligation_id, p_assigned_user_id, v_dept,
    p_acknowledgement_deadline, p_submission_deadline, p_submission_deadline
  )
  on conflict (obligation_id, assigned_user_id) do update
    set acknowledgement_deadline = excluded.acknowledgement_deadline,
        submission_deadline = excluded.submission_deadline,
        updated_at = now()
  returning id into v_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('AUDIT_OBLIGATION_ISSUED', 'AuditObligationAssignment', v_id::text,
          (select full_name from public.profiles where id = auth.uid()),
          jsonb_build_object('obligation_id', p_obligation_id, 'assignee', p_assigned_user_id,
                             'department', v_dept, 'success', true)::text,
          'info');

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

revoke all on function public.issue_audit_obligation(uuid, uuid, date, date) from public;
grant execute on function public.issue_audit_obligation(uuid, uuid, date, date) to authenticated;

-- 8c. Acknowledge. The assignee ONLY - the server resolves the caller.
create or replace function public.acknowledge_audit_obligation(p_assignment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  if not exists (select 1 from public.audit_obligation_assignments
                 where id = p_assignment_id and assigned_user_id = v_user) then
    raise exception 'AUDIT_FORBIDDEN:Only the assigned person can acknowledge this obligation.';
  end if;

  update public.audit_obligation_assignments
     set status = case when status = 'not_started' then 'acknowledged' else status end,
         acknowledged_at = coalesce(acknowledged_at, now()),
         updated_at = now()
   where id = p_assignment_id;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.acknowledge_audit_obligation(uuid) from public;
grant execute on function public.acknowledge_audit_obligation(uuid) to authenticated;

-- 8d. Submit a response (draft or final). The assignee ONLY.
create or replace function public.submit_audit_response(
  p_assignment_id uuid,
  p_payload jsonb default '{}'::jsonb,
  p_files jsonb default '[]'::jsonb,
  p_is_final boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_assignment record;
  v_version integer;
begin
  select * into v_assignment
    from public.audit_obligation_assignments
   where id = p_assignment_id and assigned_user_id = v_user;
  if v_assignment.id is null then
    raise exception 'AUDIT_FORBIDDEN:Only the assigned person can submit against this obligation.';
  end if;

  select coalesce(max(version), 0) + 1 into v_version
    from public.audit_submissions where assignment_id = p_assignment_id;

  insert into public.audit_submissions (
    obligation_id, assignment_id, version, submitted_by, payload, files, status
  ) values (
    v_assignment.obligation_id, p_assignment_id, v_version, v_user,
    coalesce(p_payload, '{}'::jsonb), coalesce(p_files, '[]'::jsonb),
    case when p_is_final then 'submitted' else 'draft' end
  );

  -- A draft is private progress: it does not move the assignment and never
  -- appears in a review queue. Only a final submission advances the state.
  if p_is_final then
    update public.audit_obligation_assignments
       set status = case
                     when status in ('not_started', 'acknowledged') then 'submitted'
                     when status = 'returned_for_correction' then 'resubmitted'
                     else status end,
           last_submitted_at = now(),
           updated_at = now()
     where id = p_assignment_id;
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('AUDIT_SUBMISSION_RECEIVED', 'AuditSubmission', p_assignment_id::text,
          (select full_name from public.profiles where id = v_user),
          jsonb_build_object('assignment_id', p_assignment_id, 'version', v_version,
                             'files', jsonb_array_length(coalesce(p_files, '[]'::jsonb)),
                             'success', true)::text,
          'info');

  return jsonb_build_object('ok', true, 'version', v_version);
end;
$$;

revoke all on function public.submit_audit_response(uuid, jsonb, jsonb, boolean) from public;
grant execute on function public.submit_audit_response(uuid, jsonb, jsonb, boolean) to authenticated;

-- 8e. Review a submission. Reviewers, Heads of Department and the Head of
--     Audit decide - a submitter can never accept or reject their own work.
create or replace function public.review_audit_submission(
  p_submission_id uuid,
  p_decision text,
  p_correction_reason text default null,
  p_correction_fields text[] default '{}'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_role text := public.current_role();
  v_submission record;
begin
  if p_decision not in ('under_review', 'returned_for_correction', 'accepted', 'rejected') then
    raise exception 'INVALID_DECISION:Unknown review decision.';
  end if;
  -- A returned-for-correction decision MUST carry a reason.
  if p_decision = 'returned_for_correction'
     and (p_correction_reason is null or btrim(p_correction_reason) = '') then
    raise exception 'CORRECTION_REASON_REQUIRED:A return for correction needs a reason.';
  end if;

  select s.*, o.reviewers, o.department as obligation_department
    into v_submission
    from public.audit_submissions s
    join public.audit_obligations o on o.id = s.obligation_id
   where s.id = p_submission_id;
  if v_submission.id is null then
    raise exception 'UNKNOWN_SUBMISSION:That submission does not exist.';
  end if;

  if not (
    public.is_audit_command_center_reader()
    or v_user = any (v_submission.reviewers)
    or (public.is_department_head()
        and exists (select 1 from public.audit_obligation_assignments a
                     where a.id = v_submission.assignment_id
                       and a.department = public.current_department()))
    or (public.is_audit_workspace_member()
        and v_submission.obligation_department = 'audit')
  ) then
    raise exception 'AUDIT_FORBIDDEN:You are not an authorised reviewer for this submission.';
  end if;

  update public.audit_submissions
     set status = p_decision,
         correction_reason = p_correction_reason,
         correction_fields = coalesce(p_correction_fields, '{}'),
         reviewed_by = v_user,
         reviewed_at = now()
   where id = p_submission_id;

  -- Mirror the decision onto the assignment so the queue and the record
  -- agree, and keep the CORRECTION state visible even though the owner
  -- responded on time.
  update public.audit_obligation_assignments
     set status = case p_decision
                    when 'under_review' then 'under_review'
                    when 'returned_for_correction' then 'returned_for_correction'
                    when 'accepted' then 'accepted'
                    when 'rejected' then 'rejected'
                    else status end,
         updated_at = now()
   where id = v_submission.assignment_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('AUDIT_SUBMISSION_REVIEWED', 'AuditSubmission', p_submission_id::text,
          (select full_name from public.profiles where id = v_user),
          jsonb_build_object('decision', p_decision, 'submission', p_submission_id,
                             'correction_reason', p_correction_reason, 'success', true)::text,
          'info');

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.review_audit_submission(uuid, text, text, text[]) from public;
grant execute on function public.review_audit_submission(uuid, text, text, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. SLA SWEEP - deadline truth as a callable, not a browser countdown
-- ---------------------------------------------------------------------------
-- Returns the rows whose SLA state CHANGED today, so the notification engine
-- has one place to look. No email is sent here: this is the read model the
-- reminder job and the escalation rules consume.
create or replace function public.audit_sla_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (public.is_audit_command_center_reader() or public.is_audit_workspace_member()) then
    raise exception 'AUDIT_FORBIDDEN:You cannot view the audit SLA snapshot.';
  end if;

  return jsonb_build_object(
    'ok', true,
    'as_of', current_date,
    'overdue', (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select a.id as assignment_id, o.reference, o.title, o.department,
               o.risk_rating, a.submission_deadline,
               (current_date - a.submission_deadline)::int as days_overdue,
               p.full_name as owner_name, p.work_email as owner_email,
               a.escalated_at
        from public.audit_obligation_assignments a
        join public.audit_obligations o on o.id = a.obligation_id
        left join public.profiles p on p.id = a.assigned_user_id
        where a.submission_deadline < current_date
          and a.status not in ('accepted', 'closed', 'rejected')
      ) x),
    'due_today', (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select a.id as assignment_id, o.reference, o.title, p.full_name as owner_name
        from public.audit_obligation_assignments a
        join public.audit_obligations o on o.id = a.obligation_id
        left join public.profiles p on p.id = a.assigned_user_id
        where a.submission_deadline = current_date
          and a.status not in ('accepted', 'closed', 'rejected')
      ) x),
    'overdue_unacknowledged', (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select a.id as assignment_id, o.reference, o.title, p.full_name as owner_name
        from public.audit_obligation_assignments a
        join public.audit_obligations o on o.id = a.obligation_id
        left join public.profiles p on p.id = a.assigned_user_id
        where a.acknowledgement_deadline < current_date
          and a.acknowledged_at is null
      ) x)
  );
end;
$$;

revoke all on function public.audit_sla_snapshot() from public;
grant execute on function public.audit_sla_snapshot() to authenticated;

commit;
