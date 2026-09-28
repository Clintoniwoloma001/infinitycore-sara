-- ============================================================================
-- Leave approval: persistent chain snapshot, correct branch/area routing,
-- date modification, and idempotent approval actions.
-- ============================================================================
-- EXTENDS the existing leave module (leave_requests, leave_approvals,
-- resolve_leave_approver, process_leave_decision, the workflow builder in
-- hr_platform_settings). Nothing here replaces it.
--
-- The three problems this fixes, all confirmed against the live data:
--   1. resolve_leave_approver had NO head_of_business and NO MD/CEO case, so
--      HEAD OFFICE and MD/CEO requests had no valid chain.
--   2. The chain was RESOLVED LIVE on every read. If a branch manager was
--      reassigned next month, an old request would rewrite its own history.
--      This adds a stored snapshot taken once, at submission.
--   3. An unresolvable approver returned NULL and the request silently stalled
--      with no HR-visible reason. It now records WHY and flags the request.
--
-- Idempotent + additive. Existing leave data is never destroyed.
begin;

-- ---------------------------------------------------------------------------
-- 1. The approval chain is STORED, not re-resolved on every read.
-- ---------------------------------------------------------------------------
create table if not exists public.leave_approval_stages (
  id                  uuid primary key default gen_random_uuid(),
  leave_request_id    uuid not null references public.leave_requests(id) on delete cascade,
  stage_key           text not null,
  stage_order         integer not null,
  stage_label         text not null,
  -- Who was resolved AT SUBMISSION TIME. These are snapshots: they are allowed
  -- to become stale, because they describe who actually handled the request.
  approver_user_id      uuid,
  approver_employee_id  uuid,
  approver_name_snapshot text,
  approver_role_snapshot text,
  -- The branch/area the approver was scoped to WHEN THE REQUEST WAS MADE.
  -- Kept so a later branch restructure cannot widen or narrow who may act.
  approver_branch_id   uuid,
  approver_area_id     uuid,
  status               text not null default 'pending'
    check (status in ('pending','current','approved','rejected','returned','skipped','unassigned')),
  assigned_at          timestamptz not null default now(),
  sla_hours            integer,
  sla_due_at           timestamptz,
  acted_at             timestamptz,
  decision             text check (decision in ('approved','rejected','returned') or decision is null),
  comment              text,
  rejection_reason     text,
  -- Date modification recorded at THIS stage (§6).
  modified_start_date  date,
  modified_end_date    date,
  modified_days        numeric,
  modified_by          uuid,
  modified_at          timestamptz,
  modification_comment text,
  created_at           timestamptz not null default now()
);

-- The table may pre-date this migration (an earlier partial apply), so every
-- column the builder relies on is asserted additively rather than assumed.
alter table public.leave_approval_stages
  add column if not exists unresolved_issue text,
  add column if not exists approver_employee_id uuid,
  add column if not exists approver_name_snapshot text,
  add column if not exists approver_role_snapshot text,
  add column if not exists approver_branch_id uuid,
  add column if not exists approver_area_id uuid,
  add column if not exists sla_hours integer,
  add column if not exists sla_due_at timestamptz,
  add column if not exists acted_at timestamptz,
  add column if not exists decision text,
  add column if not exists comment text,
  add column if not exists rejection_reason text,
  add column if not exists modified_start_date date,
  add column if not exists modified_end_date date,
  add column if not exists modified_days numeric,
  add column if not exists modified_by uuid,
  add column if not exists modified_at timestamptz,
  add column if not exists modification_comment text;

-- One stage per position in a chain; re-running the builder is idempotent.
create unique index if not exists uq_leave_approval_stages_order
  on public.leave_approval_stages(leave_request_id, stage_order);
create index if not exists idx_leave_approval_stages_request
  on public.leave_approval_stages(leave_request_id, stage_order);
-- The approver's action queue: "who must I act on?"
create index if not exists idx_leave_approval_stages_approver
  on public.leave_approval_stages(approver_user_id)
  where status = 'current';
-- The HR exception queue: unroutable stages awaiting configuration.
create index if not exists idx_leave_approval_stages_unassigned
  on public.leave_approval_stages(leave_request_id) where status = 'unassigned';
-- SLA scan for the escalation job.
create index if not exists idx_leave_approval_stages_sla
  on public.leave_approval_stages(sla_due_at)
  where status = 'current' and sla_due_at is not null;

-- ---------------------------------------------------------------------------
-- 1b. AUTHORITATIVE business-scope mapping for Head of Business.
--     area_id NULL  = the one bank-wide default.
--     area_id SET   = the Head of Business for that business unit (wins).
--     Until HR fills this in, leave routing reports an incomplete workflow
--     instead of picking an arbitrary person.
-- ---------------------------------------------------------------------------
create table if not exists public.leave_business_heads (
  id                  uuid primary key default gen_random_uuid(),
  area_id             uuid references public.areas(id) on delete cascade,
  approver_user_id    uuid not null references auth.users(id) on delete cascade,
  approver_employee_id uuid references public.employees(id) on delete set null,
  approver_name       text,
  is_active           boolean not null default true,
  notes               text,
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_by          uuid references auth.users(id) on delete set null,
  updated_at          timestamptz not null default now()
);

-- At most one active Head of Business per area...
create unique index if not exists uq_leave_business_heads_area
  on public.leave_business_heads(area_id)
  where is_active and area_id is not null;
-- ...and at most one bank-wide default.
create unique index if not exists uq_leave_business_heads_bank
  on public.leave_business_heads((true))
  where is_active and area_id is null;

-- ---------------------------------------------------------------------------
-- 2. leave_requests: keep the ORIGINAL period immutable, alongside the current
--    one. start_date/end_date/days remain the CURRENT (mutable) period so every
--    existing balance calculation keeps working untouched.
-- ---------------------------------------------------------------------------
alter table public.leave_requests
  add column if not exists original_start_date date,
  add column if not exists original_end_date   date,
  add column if not exists original_days        numeric,
  add column if not exists dates_modified       boolean not null default false,
  add column if not exists dates_modified_at    timestamptz,
  add column if not exists dates_modified_by    uuid,
  -- 'complete'  = every stage resolved an approver
  -- 'incomplete'= at least one stage could not be resolved (HR must act)
  add column if not exists workflow_config_status text not null default 'complete'
    check (workflow_config_status in ('complete','incomplete')),
  add column if not exists workflow_config_issue  text,
  add column if not exists chain_built_at    timestamptz,
  add column if not exists chain_locked       boolean not null default false,
  add column if not exists final_approved_by  uuid,
  add column if not exists final_approved_at  timestamptz;

create index if not exists idx_leave_requests_stage
  on public.leave_requests(current_approval_level, status);
create index if not exists idx_leave_requests_asat
  on public.leave_requests(start_date, end_date);

-- A rejected stage MUST carry a reason, permanently.
alter table public.leave_approval_stages
  drop constraint if exists leave_approval_stages_reject_reason;
alter table public.leave_approval_stages
  add constraint leave_approval_stages_reject_reason check (
    status <> 'rejected' or (rejection_reason is not null and btrim(rejection_reason) <> '')
  );

-- Safely backfill the immutable original period for any historical request that
-- pre-dates this migration. COALESCE-guarded, so it never overwrites a real
-- original period and is a no-op on a re-run.
update public.leave_requests
   set original_start_date = coalesce(original_start_date, start_date),
       original_end_date   = coalesce(original_end_date, end_date),
       original_days      = coalesce(original_days, days)
 where original_start_date is null
   and start_date is not null;

-- ---------------------------------------------------------------------------
-- 1c. RLS on the snapshot table. The table was created without any policy, so
--     while RLS was off every authenticated client could read and write every
--     approval chain directly, bypassing the RPCs. Reads are scoped to the
--     people involved; there is deliberately NO client write path - the chain
--     is only ever written by the SECURITY DEFINER builder below.
-- ---------------------------------------------------------------------------
alter table public.leave_approval_stages enable row level security;
alter table public.leave_business_heads  enable row level security;

drop policy if exists "leave_approval_stages read" on public.leave_approval_stages;
create policy "leave_approval_stages read" on public.leave_approval_stages
  for select to authenticated
  using (
    approver_user_id = auth.uid()
    or public.current_role() in ('super_admin','admin','head_of_human_resources','hr_officer')
    or exists (
      select 1 from public.leave_requests lr
       where lr.id = leave_approval_stages.leave_request_id
         and lr.created_by = auth.uid()
    )
  );

drop policy if exists "leave_business_heads read" on public.leave_business_heads;
create policy "leave_business_heads read" on public.leave_business_heads
  for select to authenticated using (true);

-- Writes go through SECURITY DEFINER RPCs only (audited + role gated).
drop policy if exists "leave_business_heads hr write" on public.leave_business_heads;
create policy "leave_business_heads hr write" on public.leave_business_heads
  for all to authenticated
  using (public.current_role() in ('super_admin','admin','head_of_human_resources'))
  with check (public.current_role() in ('super_admin','admin','head_of_human_resources'));

revoke all on public.leave_business_heads from anon;
grant select, insert, update, delete on public.leave_business_heads to authenticated;
grant select on public.leave_approval_stages to authenticated;
revoke insert, update, delete on public.leave_approval_stages from anon, authenticated;

commit;

-- ============================================================================
-- 3. THE ROUTING ENGINE (shared by web and Flutter - both call these)
-- ============================================================================
-- Employee -> Branch -> Branch Manager -> Area -> Area Manager
--          -> Head of Business -> Head of HR
-- HEAD OFFICE -> Department Head -> Head of Business -> Head of HR
-- MD/CEO      -> Head of HR
--
-- Every approver is derived from the ORGANISATION TABLES by id. Nothing is
-- hardcoded, and no fallback ever picks an arbitrary person: an unresolvable
-- stage returns an explicit reason so the request is flagged for HR rather
-- than being misrouted.
begin;

-- Is this employee MD/CEO? Resolved from the STABLE designation->role mapping
-- (employees.designation_id -> designations.title -> designation_role_mappings)
-- rather than free-text matching on position, so a rename cannot silently
-- change routing. The profile role is the secondary signal.
create or replace function public.leave_employee_is_md(
  p_employee_id uuid
) returns boolean
language sql
stable
as $$
  select coalesce((
    select exists (
      select 1
        from public.employees e
        join public.designations d on d.id = e.designation_id
        join public.designation_role_mappings drm
          on upper(btrim(drm.designation_title)) = upper(btrim(d.title))
       where e.id = p_employee_id
         and drm.system_role in ('md_ceo', 'super_admin')
    )
    or exists (
      select 1
        from public.employees e
        join public.profiles p on p.id = e.user_id
       where e.id = p_employee_id and p.role = 'md_ceo'
    )
  ), false);
$$;

-- Head of Business for THIS employee's business unit, from the AUTHORITATIVE
-- mapping HR maintains in leave_business_heads. The area-specific row wins over
-- the single bank-wide default. There is deliberately NO "any active profile"
-- fallback: an unconfigured business unit is an HR configuration task, not a
-- licence to route a request to an arbitrary executive.
create or replace function public.leave_head_of_business(
  p_employee_id uuid
) returns jsonb
language plpgsql
stable
as $$
declare
  v_emp    public.employees;
  v_area   uuid;
  v_row    record;
begin
  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then return null; end if;

  select baa.area_id into v_area
    from public.branch_area_assignments baa
   where baa.branch_id = v_emp.branch_id and baa.is_current is true
   limit 1;

  -- 1) the Head of Business configured for this exact business unit
  if v_area is not null then
    select bh.approver_user_id, bh.approver_employee_id,
           coalesce(bh.approver_name, p.full_name) as nm
      into v_row
      from public.leave_business_heads bh
      left join public.profiles p on p.id = bh.approver_user_id
     where bh.area_id = v_area and bh.is_active;
    if found and v_row.approver_user_id is not null then
      return jsonb_build_object(
        'user_id', v_row.approver_user_id,
        'employee_id', v_row.approver_employee_id,
        'name', coalesce(v_row.nm, 'Unknown'),
        'scope', 'area', 'area_id', v_area
      );
    end if;
  end if;

  -- 2) the single bank-wide default
  select bh.approver_user_id, bh.approver_employee_id,
         coalesce(bh.approver_name, p.full_name) as nm
    into v_row
    from public.leave_business_heads bh
    left join public.profiles p on p.id = bh.approver_user_id
   where bh.area_id is null and bh.is_active;
  if found and v_row.approver_user_id is not null then
    return jsonb_build_object(
      'user_id', v_row.approver_user_id,
      'employee_id', v_row.approver_employee_id,
      'name', coalesce(v_row.nm, 'Unknown'),
      'scope', 'bank', 'area_id', v_area
    );
  end if;

  return null;
end;
$$;

-- The single resolver. Returns the approver PLUS the reason when it cannot
-- resolve one, so the caller can flag the request instead of stalling it.
create or replace function public.resolve_leave_approver(
  p_employee_id uuid,
  p_stage_key   text
) returns jsonb
language plpgsql
stable
as $$
declare
  v_employee public.employees;
  v_branch   record;
  v_area     record;
  v_emp_id   uuid;
  v_user_id  uuid;
  v_name     text;
  v_hob      jsonb;
  v_role     text;
begin
  select * into v_employee from public.employees where id = p_employee_id;
  if v_employee.id is null then
    return jsonb_build_object('stage_key', p_stage_key, 'resolved', false,
      'issue', 'The employee record could not be found.');
  end if;

  -- MD/CEO never go through branch/area/department heads.
  if public.leave_employee_is_md(p_employee_id) and p_stage_key <> 'head_of_human_resources' then
    return jsonb_build_object('stage_key', p_stage_key, 'resolved', false,
      'issue', 'MD/CEO requests are routed directly to the Head of Human Resources.');
  end if;

  case p_stage_key
    when 'line_manager', 'head_of_department' then
      select lm.id, lm.user_id, lm.full_name into v_emp_id, v_user_id, v_name
        from public.employee_supervisors s
        join public.employees lm on lm.id = s.supervisor_employee_id
       where s.employee_id = p_employee_id and s.level = 1
       order by s.effective_from desc nulls last
       limit 1;
      if v_emp_id is null then
        return jsonb_build_object('stage_key', p_stage_key, 'resolved', false,
          'issue', 'No Department Head is mapped for this employee. HR action required.');
      end if;
      v_role := 'head_of_department';

    -- Routed from the employee's OWN branch record, never a search.
    when 'branch_manager' then
      if v_employee.branch_id is null then
        return jsonb_build_object('stage_key', p_stage_key, 'resolved', false,
          'issue', 'The employee has no branch assigned. HR action required.');
      end if;
      select b.id, b.manager_id, b.branch_name into v_branch
        from public.branches b where b.id = v_employee.branch_id;
      if v_branch.id is null then
        return jsonb_build_object('stage_key', p_stage_key, 'resolved', false,
          'issue', 'The employee''s branch record is missing or inactive. HR action required.');
      end if;
      if v_branch.manager_id is null then
        return jsonb_build_object('stage_key', p_stage_key, 'resolved', false,
          'issue', 'Branch Manager is not configured for ' || v_branch.branch_name || '. HR action required.',
          'branch_id', v_branch.id, 'branch_name', v_branch.branch_name);
      end if;
      -- branches.manager_id is a profiles id, per the HR Organisation model.
      -- Resolve the matching employee row too, so the snapshot stores BOTH
      -- identities for every approver (leave_balances is keyed by employee).
      select p.id, p.full_name, e.id into v_user_id, v_name, v_emp_id
        from public.profiles p
        left join public.employees e on e.user_id = p.id
       where p.id = v_branch.manager_id;
      if v_user_id is null then
        return jsonb_build_object('stage_key', p_stage_key, 'resolved', false,
          'issue', 'The configured Branch Manager for ' || v_branch.branch_name || ' has no user account. HR action required.',
          'branch_id', v_branch.id, 'branch_name', v_branch.branch_name);
      end if;
      if v_emp_id is null then
        return jsonb_build_object('stage_key', p_stage_key, 'resolved', false,
          'issue', 'The Branch Manager for ' || v_branch.branch_name || ' is not linked to an employee record. HR action required.',
          'branch_id', v_branch.id, 'branch_name', v_branch.branch_name);
      end if;
      v_role := 'branch_manager';

    -- Area of THIS branch, via the current branch_area assignment.
    when 'area_manager' then
      if v_employee.branch_id is null then
        return jsonb_build_object('stage_key', p_stage_key, 'resolved', false,
          'issue', 'The employee has no branch assigned. HR action required.');
      end if;
      select a.id, a.manager_employee_id, a.area_name into v_area
        from public.branch_area_assignments baa
        join public.areas a on a.id = baa.area_id
       where baa.branch_id = v_employee.branch_id and baa.is_current is true
       limit 1;
      if v_area.id is null then
        return jsonb_build_object('stage_key', p_stage_key, 'resolved', false,
          'issue', 'This branch is not assigned to an area. HR action required.');
      end if;
      if v_area.manager_employee_id is null then
        return jsonb_build_object('stage_key', p_stage_key, 'resolved', false,
          'issue', 'Area Manager is not configured for ' || v_area.area_name || '. HR action required.',
          'area_id', v_area.id, 'area_name', v_area.area_name);
      end if;
      select e.id, e.user_id, e.full_name into v_emp_id, v_user_id, v_name
        from public.employees e where e.id = v_area.manager_employee_id;
      if v_user_id is null then
        return jsonb_build_object('stage_key', p_stage_key, 'resolved', false,
          'issue', 'The configured Area Manager has no user account. HR action required.',
          'area_id', v_area.id, 'area_name', v_area.area_name);
      end if;
      v_role := 'area_manager';

    when 'head_of_business' then
      v_hob := public.leave_head_of_business(p_employee_id);
      if v_hob is null or v_hob ->> 'user_id' is null then
        return jsonb_build_object('stage_key', p_stage_key, 'resolved', false,
          'issue', 'Head of Business is not configured for this business unit. HR action required.');
      end if;
      v_user_id := (v_hob ->> 'user_id')::uuid;
      v_name := v_hob ->> 'name';
      v_role := 'head_of_business';

    when 'head_of_human_resources' then
      select p.id, p.full_name into v_user_id, v_name
        from public.profiles p
       where p.role = 'head_of_human_resources' and p.status = 'active'
       order by p.created_at limit 1;
      if v_user_id is null then
        return jsonb_build_object('stage_key', p_stage_key, 'resolved', false,
          'issue', 'No active Head of Human Resources is configured. HR action required.');
      end if;
      v_role := 'head_of_human_resources';

    else
      return jsonb_build_object('stage_key', p_stage_key, 'resolved', false,
        'issue', 'Unknown approval stage "' || coalesce(p_stage_key,'') || '".');
  end case;

  if v_user_id is null then
    return jsonb_build_object('stage_key', p_stage_key, 'resolved', false,
      'issue', 'The approver could not be resolved. HR action required.');
  end if;

  return jsonb_build_object(
    'stage_key', p_stage_key, 'resolved', true,
    'approver_user_id', v_user_id, 'approver_employee_id', v_emp_id,
    -- LEGACY ALIAS - DO NOT REMOVE. get_leave_approval_chain_for_employee,
    -- get_leave_workflow_chain_for_employee and _leave_stage_approver_ids all
    -- read ->>'approver_id'; the workflow builder `continue`s (dropping the
    -- stage entirely) when it is absent. approver_id IS approver_user_id.
    'approver_id', v_user_id,
    'approver_name', coalesce(v_name, 'Unknown'), 'approver_role', v_role,
    'branch_id', v_employee.branch_id,
    'area_id', (select a.id from public.branch_area_assignments baa
                  join public.areas a on a.id = baa.area_id
                 where baa.branch_id = v_employee.branch_id and baa.is_current is true limit 1)
  );
end;
$$;

comment on function public.resolve_leave_approver is
  'Resolves one approval stage from the HR Organisation tables. Returns resolved=false with an HR-facing issue when the organisation mapping is missing - never an arbitrary fallback. The payload is a superset of the pre-migration contract and must keep the approver_id alias.';

-- SECURITY DEFINER so routing is not blocked by the employees/branches RLS
-- policies of whichever approver happens to be reading the chain.
alter function public.resolve_leave_approver(uuid, text) security definer;
alter function public.resolve_leave_approver(uuid, text) set search_path = public;
alter function public.leave_head_of_business(uuid)  security definer;
alter function public.leave_head_of_business(uuid)  set search_path = public;
alter function public.leave_employee_is_md(uuid)    security definer;
alter function public.leave_employee_is_md(uuid)    set search_path = public;

commit;
