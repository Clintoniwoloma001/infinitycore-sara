-- ============================================================================
-- Leave approval chain builder + idempotent approval actions.
-- ============================================================================
-- Run in Supabase SQL Editor AFTER 20260930000001. Idempotent and additive.
--
-- Why this file exists: 20260930000001 made routing correct and made the chain
-- a stored snapshot, but nothing YET BUILT that snapshot and nothing acted on
-- it. process_leave_decision still re-resolved the chain live on every call,
-- which is exactly the bug the snapshot exists to fix.
--
-- Everything here is server-side and role-gated, so the web app and the Flutter
-- app call the SAME functions and neither re-implements routing.
--
--   build_leave_approval_chain(p_request_id)   snapshot the chain ONCE
--   get_leave_approval_timeline(p_request_id)  read the stored chain
--   act_on_leave_stage(...)                    approve/reject/return/modify
--   repair_leave_approval_stage(...)           HR fixes a broken mapping
--
-- Guarantees:
--   * The chain is built once and LOCKED. Re-running the builder is a no-op, so
--     a later branch-manager change cannot rewrite who handled a request.
--   * Row locks (for update) plus a current-stage check make a double-click or
--     a retried request exactly-once: the retry sees a non-current stage.
--   * Rejection and return REQUIRE a reason (also enforced by a CHECK).
--   * Self-approval is refused.
--   * The leave balance is deducted EXACTLY ONCE, on final approval, guarded by
--     the request status transition itself.
--   * Original dates stay immutable; approver edits are stored separately with
--     actor, timestamp, stage and reason.
begin;

-- ---------------------------------------------------------------------------
-- 1. The route template per employee, derived from the live organisation.
--    HEAD OFFICE : Department Head -> Head of Business -> Head of HR
--    BRANCH      : Branch Manager  -> Area Manager -> HoB -> Head of HR
--    MD/CEO      : Head of HR only
-- ---------------------------------------------------------------------------
create or replace function public.leave_route_for_employee(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_emp    public.employees;
  v_branch record;
  v_is_ho  boolean := false;
begin
  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then return null; end if;

  -- MD/CEO: straight to HR. No branch/area/department heads.
  if public.leave_employee_is_md(p_employee_id) then
    return jsonb_build_object(
      'route', 'md',
      'stages', jsonb_build_array(
        jsonb_build_object('stage_key','head_of_human_resources',
                           'label','Head of Human Resources','sla_hours',48)
      )
    );
  end if;

  if v_emp.branch_id is not null then
    select b.id, b.branch_name, b.branch_code into v_branch
      from public.branches b where b.id = v_emp.branch_id;
    v_is_ho := v_branch.id is not null and (
      upper(btrim(coalesce(v_branch.branch_code,''))) in ('HO','HQ')
      or upper(btrim(coalesce(v_branch.branch_name,''))) in ('HEAD OFFICE','HO','HQ')
    );
  end if;

  if v_is_ho then
    return jsonb_build_object(
      'route', 'head_office',
      'stages', jsonb_build_array(
        jsonb_build_object('stage_key','head_of_department',
                           'label','Head of Department','sla_hours',48),
        jsonb_build_object('stage_key','head_of_business',
                           'label','Head of Business','sla_hours',48),
        jsonb_build_object('stage_key','head_of_human_resources',
                           'label','Head of Human Resources','sla_hours',48)
      )
    );
  end if;

  return jsonb_build_object(
    'route', 'branch',
    'stages', jsonb_build_array(
      jsonb_build_object('stage_key','branch_manager',
                         'label','Branch Manager','sla_hours',24),
      jsonb_build_object('stage_key','area_manager',
                         'label','Area Manager','sla_hours',24),
      jsonb_build_object('stage_key','head_of_business',
                         'label','Head of Business','sla_hours',48),
      jsonb_build_object('stage_key','head_of_human_resources',
                         'label','Head of Human Resources','sla_hours',48)
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. THE CHAIN BUILDER. Snapshots every stage of the route ONCE, at
--    submission, and locks it. Idempotent: a second call returns the stored
--    chain rather than rebuilding it, so history can never be rewritten.
-- ---------------------------------------------------------------------------
create or replace function public.build_leave_approval_chain(
  p_request_id uuid,
  p_force      boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req      public.leave_requests;
  v_emp_id   uuid;
  v_route    jsonb;
  v_stage    jsonb;
  v_res      jsonb;
  v_order    int := 0;
  v_first    uuid;
  v_issues   text[] := '{}';
  v_built    jsonb := '[]'::jsonb;
begin
  -- Lock the request row for the whole build.
  select * into v_req from public.leave_requests where id = p_request_id for update;
  if v_req.id is null then
    raise exception 'Leave request not found';
  end if;

  -- Already built and locked: return the stored chain untouched.
  if v_req.chain_locked and not coalesce(p_force, false) then
    return public.get_leave_approval_timeline(p_request_id);
  end if;

  v_emp_id := coalesce(
    v_req.employee_id,
    public._leave_request_employee_id(v_req.created_by)
  );
  if v_emp_id is null then
    raise exception 'This request is not linked to an employee record. HR action required.';
  end if;

  v_route := public.leave_route_for_employee(v_emp_id);
  if v_route is null then
    raise exception 'The employee record could not be found';
  end if;

  -- Rebuild from scratch only when explicitly forced by HR.
  if coalesce(p_force, false) then
    delete from public.leave_approval_stages where leave_request_id = p_request_id;
  end if;

  for v_stage in select jsonb_array_elements(v_route -> 'stages') loop
    v_order := v_order + 1;
    v_res := public.resolve_leave_approver(v_emp_id, v_stage ->> 'stage_key');

    if coalesce((v_res ->> 'resolved')::boolean, false) then
      insert into public.leave_approval_stages
        (leave_request_id, stage_key, stage_order, stage_label,
         approver_user_id, approver_employee_id, approver_name_snapshot,
         approver_role_snapshot, approver_branch_id, approver_area_id,
         status, assigned_at, sla_hours, sla_due_at)
      values
        (p_request_id, v_stage ->> 'stage_key', v_order, v_stage ->> 'label',
         (v_res ->> 'approver_user_id')::uuid,
         (v_res ->> 'approver_employee_id')::uuid,
         v_res ->> 'approver_name',
         v_res ->> 'approver_role',
         (v_res ->> 'branch_id')::uuid,
         (v_res ->> 'area_id')::uuid,
         'pending', now(),
         coalesce(nullif(v_stage ->> 'sla_hours','')::int, 48),
         now() + make_interval(hours => coalesce(nullif(v_stage ->> 'sla_hours','')::int, 48)))
      on conflict (leave_request_id, stage_order) do update
        set approver_user_id       = excluded.approver_user_id,
            approver_employee_id   = excluded.approver_employee_id,
            approver_name_snapshot = excluded.approver_name_snapshot,
            approver_role_snapshot = excluded.approver_role_snapshot,
            approver_branch_id     = excluded.approver_branch_id,
            approver_area_id       = excluded.approver_area_id,
            unresolved_issue       = null;
    else
      -- No approver: still record the stage, with the reason, so HR can see and
      -- repair it. A stand-in approver is never substituted.
      insert into public.leave_approval_stages
        (leave_request_id, stage_key, stage_order, stage_label,
         status, assigned_at, sla_hours, unresolved_issue)
      values
        (p_request_id, v_stage ->> 'stage_key', v_order, v_stage ->> 'label',
         'unassigned', now(),
         coalesce(nullif(v_stage ->> 'sla_hours','')::int, 48),
         coalesce(v_res ->> 'issue', 'The approver could not be resolved. HR action required.'))
      on conflict (leave_request_id, stage_order) do update
        set unresolved_issue = excluded.unresolved_issue;
      v_issues := array_append(v_issues,
        (v_stage ->> 'label') || ': '
        || coalesce(v_res ->> 'issue', 'unresolved'));
    end if;

    v_built := v_built || jsonb_build_object(
      'stage_key', v_stage ->> 'stage_key',
      'label',     v_stage ->> 'label',
      'resolved',  coalesce((v_res ->> 'resolved')::boolean, false),
      'issue',     v_res ->> 'issue'
    );
  end loop;

  -- Activate the first stage ONLY when it actually resolved. If stage 1 is
  -- unassigned the chain STOPS there on purpose: advancing to stage 2 would
  -- silently bypass a whole approval level (a branch request could be approved
  -- without the Branch Manager ever seeing it). A blocked chain is visible to
  -- HR and repaired via repair_leave_approval_stage.
  if exists (
    select 1 from public.leave_approval_stages
     where leave_request_id = p_request_id and stage_order = 1 and status = 'pending'
  ) then
    select id into v_first
      from public.leave_approval_stages
     where leave_request_id = p_request_id and status = 'pending'
     order by stage_order
     limit 1;
    if v_first is not null then
      update public.leave_approval_stages
         set status = 'current',
             sla_due_at = now() + make_interval(hours => coalesce(sla_hours, 48))
       where id = v_first;
    end if;
  end if;

  update public.leave_requests
     set approval_level = 1,
         current_approval_level = 1,
         stage_entered_at = now(),
         last_reminded_at = now(),
         chain_built_at = now(),
         chain_locked = true,
         -- Original dates are captured ONCE and never overwritten afterwards.
         original_start_date = coalesce(original_start_date, start_date),
         original_end_date   = coalesce(original_end_date, end_date),
         original_days      = coalesce(original_days, days),
         workflow_config_status = case when cardinality(v_issues) = 0
                                       then 'complete' else 'incomplete' end,
         workflow_config_issue  = nullif(array_to_string(v_issues, ' | '), ''),
         updated_at = now()
   where id = p_request_id;

  return jsonb_build_object(
    'ok', true,
    'request_id', p_request_id,
    'route', v_route ->> 'route',
    'stages', v_built,
    'config_status', case when cardinality(v_issues) = 0
                          then 'complete' else 'incomplete' end,
    'issues', to_jsonb(v_issues)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The timeline reader. Returns the STORED snapshot (never re-resolves), so
--    a request rendered today shows the approvers captured when it was made.
--    Falls back to a fresh build for legacy rows created before this migration.
-- ---------------------------------------------------------------------------
create or replace function public.get_leave_approval_timeline(p_request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_req  public.leave_requests;
  v_rows jsonb;
begin
  select * into v_req from public.leave_requests where id = p_request_id;
  if v_req.id is null then
    raise exception 'Leave request not found';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id,
           'stage_key', s.stage_key,
           'label', s.stage_label,
           'order', s.stage_order,
           'status', s.status,
           'approver_user_id', s.approver_user_id,
           'approver_employee_id', s.approver_employee_id,
           'approver_name', s.approver_name_snapshot,
           'approver_role', s.approver_role_snapshot,
           'branch_id', s.approver_branch_id,
           'area_id', s.approver_area_id,
           'sla_hours', s.sla_hours,
           'sla_due_at', s.sla_due_at,
           'sla_breached', (s.status = 'current' and s.sla_due_at is not null
                            and s.sla_due_at < now()),
           'acted_at', s.acted_at,
           'decision', s.decision,
           'comment', s.comment,
           'rejection_reason', s.rejection_reason,
           'modified_start_date', s.modified_start_date,
           'modified_end_date', s.modified_end_date,
           'modified_days', s.modified_days,
           'modification_comment', s.modification_comment,
           'unresolved_issue', s.unresolved_issue
         ) order by s.stage_order), '[]'::jsonb)
    into v_rows
    from public.leave_approval_stages s
   where s.leave_request_id = p_request_id;

  return jsonb_build_object(
    'ok', true,
    'request_id', p_request_id,
    'status', v_req.status,
    'current_approval_level', coalesce(v_req.current_approval_level, v_req.approval_level, 1),
    'config_status', v_req.workflow_config_status,
    'config_issue', v_req.workflow_config_issue,
    'chain_locked', coalesce(v_req.chain_locked, false),
    'start_date', v_req.start_date,
    'end_date', v_req.end_date,
    'days', v_req.days,
    'original_start_date', v_req.original_start_date,
    'original_end_date', v_req.original_end_date,
    'original_days', v_req.original_days,
    'dates_modified', coalesce(v_req.dates_modified, false),
    'stages', v_rows
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. TRANSACTIONAL SUBMISSION. The request row and its chain snapshot are
--    written in ONE transaction: a request can never exist without its chain,
--    and a half-built chain can never be left behind.
-- ---------------------------------------------------------------------------
create or replace function public.submit_leave_request(
  p_employee_id uuid,
  p_leave_type  text,
  p_start       date,
  p_end         date,
  p_reason      text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor   uuid := auth.uid();
  v_emp     public.employees;
  v_req_id  uuid;
  v_days    numeric;
  v_branch  uuid;
  v_chain   jsonb;
  v_on_behalf boolean;
begin
  if v_actor is null then
    raise exception 'You must be signed in to submit a leave request.';
  end if;
  if p_start is null or p_end is null or p_end < p_start then
    raise exception 'The end date must not be before the start date.';
  end if;

  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then
    raise exception 'Employee record not found.';
  end if;

  -- Only the employee themselves or HR may file on their behalf.
  v_on_behalf := v_emp.user_id is distinct from v_actor;
  if v_on_behalf
     and public.current_role() not in ('super_admin','admin','head_of_human_resources','hr_officer')
  then
    raise exception 'You cannot submit a leave request for another employee.';
  end if;
  if v_emp.user_id is null and not v_on_behalf then
    raise exception 'This employee has no user account yet. HR action required.';
  end if;

  v_branch := v_emp.branch_id;
  v_days := public.leave_working_days(p_start, p_end, v_branch);
  if v_days <= 0 then
    raise exception 'The selected period contains no working days.';
  end if;

  -- created_by is the REQUEST OWNER, not the person who pressed submit. HR
  -- filing on someone's behalf must not make the requester look like the
  -- filer: the self-approval guard keys off created_by, and leave_balances is
  -- keyed by it, so attributing it to the HR user would both block the final
  -- approval and post the deduction to the wrong person.
  insert into public.leave_requests
    (employee_name, employee_id, leave_type, start_date, end_date, days,
     reason, status, approval_level, created_by, created_at,
     original_start_date, original_end_date, original_days)
  values
    (v_emp.full_name, v_emp.id, coalesce(p_leave_type,'annual'), p_start, p_end, v_days::int,
     p_reason, 'pending', 1,
     coalesce(v_emp.user_id, v_actor), now(),
     p_start, p_end, v_days)
  returning id into v_req_id;

  -- Build + lock the chain inside the same transaction.
  v_chain := public.build_leave_approval_chain(v_req_id);

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('LEAVE_REQUEST_SUBMITTED', 'LeaveRequest', v_req_id::text, v_actor::text,
          jsonb_build_object('leave_type', coalesce(p_leave_type,'annual'),
                             'start', p_start, 'end', p_end, 'days', v_days,
                             'on_behalf', v_on_behalf,
                             'route', v_chain ->> 'route',
                             'config_status', v_chain ->> 'config_status')::text,
          'info');

  return jsonb_build_object(
    'ok', true,
    'request_id', v_req_id,
    'days', v_days,
    'route', v_chain ->> 'route',
    'config_status', v_chain ->> 'config_status',
    'config_issue', v_chain ->> 'issues',
    'stages', v_chain ->> 'stages'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. THE ACTION RPC. One entry point for approve / reject / return, plus an
--    optional date modification recorded against the acting stage.
--
--    Exactly-once: the request and the current stage are both locked FOR UPDATE,
--    and the stage must still be 'current'. A duplicate click or a retried
--    request therefore fails the current-stage check instead of double-counting.
-- ---------------------------------------------------------------------------
create or replace function public.act_on_leave_stage(
  p_request_id         uuid,
  p_action             text,          -- approved | rejected | returned
  p_comment            text default null,
  p_rejection_reason   text default null,
  p_new_start          date default null,
  p_new_end            date default null,
  p_modification_note  text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor    uuid := auth.uid();
  v_role     text := public.current_role();
  v_req      public.leave_requests;
  v_stage    public.leave_approval_stages;
  v_next     public.leave_approval_stages;
  v_name     text;
  v_emp_id   uuid;
  v_days     numeric;
  v_final    boolean := false;
  v_branch   uuid;
begin
  if p_action not in ('approved','rejected','returned') then
    raise exception 'Action must be approved, rejected or returned';
  end if;
  if v_actor is null then
    raise exception 'You must be signed in to act on a leave request.';
  end if;
  -- A rejection or a return without a reason is never acceptable.
  -- NB: use a BARE '%' placeholder, not '%s'. In RAISE, '%s' on a text argument
  -- appends a plural "s" ("rejecteds"); '%' substitutes verbatim.
  if p_action in ('rejected','returned')
     and (p_rejection_reason is null or btrim(p_rejection_reason) = '') then
    raise exception 'A written reason is required for this % leave request.', p_action;
  end if;

  -- Lock the request, then the current stage: two concurrent clicks serialise.
  select * into v_req from public.leave_requests where id = p_request_id for update;
  if v_req.id is null then raise exception 'Leave request not found'; end if;
  if v_req.status <> 'pending' then
    raise exception 'This leave request has already been finalised (%).', v_req.status;
  end if;
  if v_req.created_by = v_actor then
    raise exception 'You cannot act on your own leave request.';
  end if;

  select * into v_stage
    from public.leave_approval_stages
   where leave_request_id = p_request_id and status = 'current'
   order by stage_order
   limit 1
   for update;
  if v_stage.id is null then
    raise exception 'There is no approval stage awaiting action on this request.';
  end if;

  -- Authorisation: the snapshotted approver, or an HR override role.
  if v_stage.approver_user_id is distinct from v_actor
     and v_role not in ('super_admin','admin','head_of_human_resources') then
    raise exception 'You are not the approver for the current stage of this request.';
  end if;

  select full_name into v_name from public.profiles where id = v_actor;
  v_emp_id := coalesce(v_req.employee_id, public._leave_request_employee_id(v_req.created_by));

  -- Optional date modification by THIS approver. The original period is never
  -- touched; the change is attributed to the actor, the stage and the moment.
  if p_new_start is not null or p_new_end is not null then
    if p_new_start is null or p_new_end is null or p_new_end < p_new_start then
      raise exception 'The modified end date must not be before the start date.';
    end if;
    if p_modification_note is null or btrim(p_modification_note) = '' then
      raise exception 'A reason is required when changing the leave dates.';
    end if;
    v_branch := (select branch_id from public.employees where id = v_emp_id);
    v_days := public.leave_working_days(p_new_start, p_new_end, v_branch);
    if v_days <= 0 then
      raise exception 'The modified period contains no working days.';
    end if;
    update public.leave_approval_stages
       set modified_start_date = p_new_start,
           modified_end_date   = p_new_end,
           modified_days       = v_days,
           modified_by         = v_actor,
           modified_at         = now(),
           modification_comment = p_modification_note
     where id = v_stage.id;
    update public.leave_requests
       set start_date = p_new_start,
           end_date   = p_new_end,
           days       = v_days::int,
           dates_modified = true,
           dates_modified_at = now(),
           dates_modified_by = v_actor,
           updated_at = now()
     where id = p_request_id;
  end if;

  update public.leave_approval_stages
     set status   = p_action::text,
         decision = p_action::text,
         acted_at = now(),
         comment  = p_comment,
         rejection_reason = case when p_action in ('rejected','returned')
                                 then btrim(p_rejection_reason) else null end
   where id = v_stage.id;

  if p_action = 'rejected' then
    -- Terminal: no further stages run and no balance moves.
    update public.leave_requests
       set status = 'rejected',
           approval_comments = p_comment,
           updated_at = now()
     where id = p_request_id;

  elsif p_action = 'returned' then
    -- Sent back to the requester. The chain is deliberately NOT rebuilt: the
    -- same approvers keep ownership until HR forces a rebuild.
    update public.leave_requests
       set status = 'returned',
           approval_comments = p_comment,
           updated_at = now()
     where id = p_request_id;

  else
    -- Approval. Is this the last stage that still has to sign off?
    select not exists (
             select 1 from public.leave_approval_stages s
              where s.leave_request_id = p_request_id
                and s.stage_order > v_stage.stage_order
                and s.status in ('pending','current')
           )
      into v_final;

    if v_final then
      update public.leave_requests
         set status = 'approved',
             approved_by_name = coalesce(v_name, 'Approver'),
             approved_date = now(),
             approval_comments = p_comment,
             final_approved_by = v_actor,
             final_approved_at = now(),
             updated_at = now()
       where id = p_request_id;

      -- EXACTLY ONCE: reachable only on the pending -> approved transition,
      -- which the status guard above and this branch's single execution allow.
      if v_req.leave_type <> 'unpaid' and coalesce(v_req.days,0) > 0 then
        update public.leave_balances
           set used_days = used_days + v_req.days, updated_at = now()
         where employee_id = v_req.created_by
           and year = extract(year from coalesce(v_req.start_date, now()))::int
           and leave_type = v_req.leave_type;
      end if;
    else
      -- Advance: the next pending stage becomes current and is notified.
      select * into v_next
        from public.leave_approval_stages
       where leave_request_id = p_request_id
         and stage_order > v_stage.stage_order
         and status = 'pending'
       order by stage_order
       limit 1;

      if v_next.id is not null then
        update public.leave_approval_stages
           set status = 'current',
               sla_due_at = now() + make_interval(hours => coalesce(sla_hours, 48))
         where id = v_next.id;
        update public.leave_requests
           set approval_level = v_next.stage_order,
               current_approval_level = v_next.stage_order,
               stage_entered_at = now(),
               last_reminded_at = now(),
               updated_at = now()
         where id = p_request_id;

        if v_next.approver_user_id is not null then
          insert into public.notifications (user_id, title, message, type, link)
          values (v_next.approver_user_id, 'Leave approval needed',
                  format('%s - awaiting your approval at the %s stage.',
                         v_req.employee_name, v_next.stage_label),
                  'urgent', '/leave-requests');
        end if;
      end if;
    end if;
  end if;

  -- Immutable decision trail.
  insert into public.leave_approvals
    (leave_request_id, stage, stage_role, stage_label, decision,
     approver_id, approver_name, comment, is_cancellation)
  values
    (p_request_id, v_stage.stage_order, v_stage.stage_key, v_stage.stage_label,
     case when p_action = 'returned' then 'rejected' else p_action end,
     v_actor, coalesce(v_name, v_actor::text),
     coalesce(p_comment, p_rejection_reason), coalesce(v_req.is_cancellation,false));

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('LEAVE_STAGE_' || upper(p_action), 'LeaveRequest', p_request_id::text, v_actor::text,
          jsonb_build_object('stage', v_stage.stage_order,
                             'stage_key', v_stage.stage_key,
                             'final', v_final,
                             'reason', p_rejection_reason,
                             'modified', (p_new_start is not null))::text,
          case when p_action = 'rejected' then 'warning' else 'info' end);

  if v_req.created_by is not null then
    insert into public.notifications (user_id, title, message, type, link)
    values (v_req.created_by, 'Leave request update',
            format('Your leave request was %s by %s at the %s stage.',
                   p_action, coalesce(v_name,'your approver'), v_stage.stage_label),
            'info', '/leave-requests');
  end if;

  return jsonb_build_object(
    'ok', true, 'request_id', p_request_id, 'action', p_action,
    'stage', v_stage.stage_order, 'final', v_final,
    'status', (select status from public.leave_requests where id = p_request_id)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. HR REPAIR. An unassigned stage is a configuration gap, not a dead end.
--    HR points it at a person, the request resumes, and the repair is audited.
-- ---------------------------------------------------------------------------
create or replace function public.repair_leave_approval_stage(
  p_stage_id        uuid,
  p_approver_user_id uuid,
  p_reason          text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role   text := public.current_role();
  v_stage  public.leave_approval_stages;
  v_emp_id uuid;
  v_name   text;
begin
  if v_role not in ('super_admin','admin','head_of_human_resources') then
    raise exception 'Only HR can repair an approval stage.';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required when repairing an approval stage.';
  end if;

  select * into v_stage
    from public.leave_approval_stages
   where id = p_stage_id for update;
  if v_stage.id is null then raise exception 'Approval stage not found'; end if;
  if v_stage.status not in ('unassigned','pending') then
    raise exception 'Only an unassigned or pending stage can be repaired.';
  end if;

  select id, full_name into v_emp_id, v_name
    from public.employees where user_id = p_approver_user_id;
  if v_emp_id is null then
    raise exception 'That approver is not linked to an employee record.';
  end if;

  update public.leave_approval_stages
     set approver_user_id = p_approver_user_id,
         approver_employee_id = v_emp_id,
         approver_name_snapshot = coalesce(v_name, 'Unknown'),
         status = 'pending',
         unresolved_issue = null,
         sla_due_at = now() + make_interval(hours => coalesce(sla_hours, 48))
   where id = p_stage_id;

  -- If this was the blocker and nothing is current yet, start the chain.
  if not exists (select 1 from public.leave_approval_stages
                  where leave_request_id = v_stage.leave_request_id
                    and status = 'current') then
    update public.leave_approval_stages
       set status = 'current',
           sla_due_at = now() + make_interval(hours => coalesce(sla_hours, 48))
     where id = (
       select id from public.leave_approval_stages
        where leave_request_id = v_stage.leave_request_id and status = 'pending'
        order by stage_order limit 1);
  end if;

  -- Recompute the config flag: still incomplete while any stage is unassigned.
  update public.leave_requests
     set workflow_config_status = case
           when exists (select 1 from public.leave_approval_stages
                         where leave_request_id = v_stage.leave_request_id
                           and status = 'unassigned')
           then 'incomplete' else 'complete' end,
         workflow_config_issue = (
           select string_agg(coalesce(unresolved_issue,'unresolved'), ' | ')
             from public.leave_approval_stages
            where leave_request_id = v_stage.leave_request_id
              and status = 'unassigned'),
         updated_at = now()
   where id = v_stage.leave_request_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('LEAVE_APPROVAL_STAGE_REPAIRED', 'LeaveRequest',
          v_stage.leave_request_id::text, auth.uid()::text,
          jsonb_build_object('stage_id', p_stage_id, 'stage_key', v_stage.stage_key,
                             'new_approver', p_approver_user_id,
                             'approver_name', v_name, 'reason', p_reason)::text,
          'warning');

  insert into public.notifications (user_id, title, message, type, link)
  values (p_approver_user_id, 'Leave approval needed',
          'A leave request has been assigned to you for approval.',
          'urgent', '/leave-requests');

  return jsonb_build_object('ok', true, 'stage_id', p_stage_id,
                            'approver_user_id', p_approver_user_id,
                            'approver_name', v_name);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Grants. Reads for the people involved; every write goes through the
--    SECURITY DEFINER functions above, which are role-gated and audited.
-- ---------------------------------------------------------------------------
grant execute on function public.leave_route_for_employee(uuid)           to authenticated;
grant execute on function public.build_leave_approval_chain(uuid, boolean) to authenticated;
grant execute on function public.get_leave_approval_timeline(uuid)         to authenticated;
grant execute on function public.submit_leave_request(uuid, text, date, date, text) to authenticated;
grant execute on function public.act_on_leave_stage(uuid, text, text, text, date, date, text) to authenticated;
grant execute on function public.repair_leave_approval_stage(uuid, uuid, text) to authenticated;
grant execute on function public.resolve_leave_approver(uuid, text)       to authenticated;
grant execute on function public.leave_head_of_business(uuid)             to authenticated;
grant execute on function public.leave_employee_is_md(uuid)               to authenticated;

-- The write RPCs must never be reachable anonymously.
revoke all on function public.repair_leave_approval_stage(uuid, uuid, text) from anon;
revoke all on function public.build_leave_approval_chain(uuid, boolean) from anon;
revoke all on function public.act_on_leave_stage(uuid, text, text, text, date, date, text) from anon;
revoke all on function public.submit_leave_request(uuid, text, date, date, text) from anon;

comment on function public.build_leave_approval_chain is
  'Snapshots and locks the approval chain for one request. Idempotent: a second call returns the stored chain instead of re-resolving, so organisational changes cannot rewrite historical approvers.';
comment on function public.act_on_leave_stage is
  'Approve / reject / return the CURRENT stage of a leave request, optionally modifying the dates. Locked and exactly-once: a duplicate or retried call fails the current-stage check.';
comment on function public.repair_leave_approval_stage is
  'HR assigns an approver to an unassigned stage so a stalled request can resume. Audited with a mandatory reason.';

commit;

