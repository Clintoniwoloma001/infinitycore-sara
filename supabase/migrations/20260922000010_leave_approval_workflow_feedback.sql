-- Phase — Platform-wide Leave Approval Workflow + 30-min reminders + mandatory feedback.
-- Run in Supabase SQL Editor after 20260922000007. Idempotent/additive (begin/commit).
--
-- Adds a builder-owned `leave_approval_workflow` on hr_platform_settings (kept
-- SEPARATE from the legacy `leave_approval_chain` so nothing existing breaks),
-- the post-decision feedback store, SLA/reminder columns on leave_requests, and
-- a SECURITY DEFINER notifier scheduled every 30 minutes (pg_cron) that pushes
-- 'urgent' notifications to every approver with work waiting on them.
--
-- Resolution order for a request's chain:
--   1. request.approval_chain snapshot (stable once first resolved)
--   2. leave_approval_workflow (per-employee, resolved)  -- NEW, builder-owned
--   3. legacy leave_approval_chain template
begin;

-- --------------------------------------------------------------------------
-- 1. Storage: workflow template, per-request reminder/feedback columns
-- --------------------------------------------------------------------------
alter table public.hr_platform_settings
  add column if not exists leave_approval_workflow jsonb not null default '[]'::jsonb;

alter table public.leave_requests
  add column if not exists updated_at timestamptz default now(),
  add column if not exists current_approval_level integer,
  add column if not exists stage_entered_at timestamptz,
  add column if not exists last_reminded_at timestamptz,
  add column if not exists feedback_submitted boolean not null default false;

update public.leave_requests
   set updated_at = coalesce(updated_at, created_at),
       current_approval_level = coalesce(current_approval_level, approval_level, 1),
       stage_entered_at = coalesce(stage_entered_at, coalesce(updated_at, created_at))
 where status = 'pending';

-- --------------------------------------------------------------------------
-- 2. leave_feedback — mandatory post-decision feedback store
-- --------------------------------------------------------------------------
create table if not exists public.leave_feedback (
  id uuid primary key default gen_random_uuid(),
  leave_request_id uuid not null unique references public.leave_requests(id) on delete cascade,
  employee_id uuid not null references auth.users(id) on delete cascade,
  turnaround_rating smallint not null check (turnaround_rating between 1 and 5),
  ease_rating smallint not null check (ease_rating between 1 and 5),
  feedback_text text not null check (length(btrim(feedback_text)) >= 10),
  created_at timestamptz not null default now()
);

alter table public.leave_feedback enable row level security;
drop policy if exists "leave_feedback_select" on public.leave_feedback;
-- Requester sees their own; HR analytics sees everything. Writes only happen
-- through the SECURITY DEFINER submit_leave_feedback RPC.
create policy "leave_feedback_select"
  on public.leave_feedback
  for select
  to authenticated
  using (
    employee_id = auth.uid()
    or public._org_can_manage()
    or (select public.current_role()) in ('hr_officer', 'head_of_business')
  );

-- --------------------------------------------------------------------------
-- 3. Workflow → chain translation (per employee)
-- --------------------------------------------------------------------------
-- The builder stores a list of levels:
--   { type:'role'|'user', role?, user_id?, label?, sla_hours?, auto_escalate? }
-- Role levels resolve like the legacy chain (specific line manager, branch /
-- area manager scope, or first active profile with that role). User levels become
-- a direct approver. SLA/auto-escalate ride along so the notifier can escalate.
create or replace function public.get_leave_workflow_chain_for_employee(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_workflow jsonb;
  v_level jsonb;
  v_type text;
  v_role text;
  v_res jsonb;
  v_stage jsonb;
  v_chain jsonb := '[]'::jsonb;
begin
  select leave_approval_workflow into v_workflow from public.hr_platform_settings where id = 1;
  if v_workflow is null or jsonb_typeof(v_workflow) <> 'array' or jsonb_array_length(v_workflow) = 0 then
    return null;
  end if;

  for v_level in select jsonb_array_elements(v_workflow) loop
    v_type := coalesce(v_level ->> 'type', 'role');
    if v_type = 'user' then
      v_stage := jsonb_build_object(
        'stage_key', 'user:' || (v_level ->> 'user_id'),
        'label', coalesce(v_level ->> 'label', 'Direct approver'),
        'approver_id', v_level ->> 'user_id',
        'sla_hours', coalesce(nullif(v_level ->> 'sla_hours', '')::int, 48),
        'auto_escalate', coalesce((v_level ->> 'auto_escalate')::boolean, false),
        'type', 'user'
      );
      v_chain := v_chain || v_stage;
    else
      v_role := v_level ->> 'role';
      if v_role is null or v_role = '' then continue; end if;
      v_res := public.resolve_leave_approver(p_employee_id, v_role);
      -- Legacy keyed stages are skipped when they cannot resolve for this
      -- employee (e.g. no line manager on file); generic roles are kept so the
      -- role match inside process_leave_decision still works via stages.
      if v_role in ('line_manager', 'branch_manager', 'area_manager', 'head_of_human_resources') then
        if v_res is null or v_res ->> 'approver_id' is null then continue; end if;
        v_stage := jsonb_build_object(
          'stage_key', v_role,
          'label', coalesce(v_level ->> 'label', v_role),
          'approver_id', v_res ->> 'approver_id',
          'approver_name', v_res ->> 'approver_name',
          'sla_hours', coalesce(nullif(v_level ->> 'sla_hours', '')::int, 48),
          'auto_escalate', coalesce((v_level ->> 'auto_escalate')::boolean, false),
          'type', 'role'
        );
        v_chain := v_chain || v_stage;
      else
        v_stage := jsonb_build_object(
          'stage_key', v_role,
          'label', coalesce(v_level ->> 'label', v_role),
          'approver_id', null,
          'sla_hours', coalesce(nullif(v_level ->> 'sla_hours', '')::int, 48),
          'auto_escalate', coalesce((v_level ->> 'auto_escalate')::boolean, false),
          'type', 'role'
        );
        v_chain := v_chain || v_stage;
      end if;
    end if;
  end loop;

  if jsonb_array_length(v_chain) = 0 then return null; end if;
  return v_chain;
end;
$$;

-- Current stored workflow template (for the Settings builder).
create or replace function public.get_leave_approval_workflow()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select leave_approval_workflow from public.hr_platform_settings where id = 1), '[]'::jsonb);
$$;

-- Persist + validate the workflow template (HR manage only).
create or replace function public.save_leave_approval_workflow(p_workflow jsonb, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_level jsonb;
  v_type text;
  v_role text;
  v_user_id text;
  v_sla text;
  v_count int := 0;
  v_actor_name text;
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to configure the leave approval workflow';
  end if;
  if p_workflow is null or jsonb_typeof(p_workflow) <> 'array' then
    raise exception 'Workflow must be a JSON array of levels.';
  end if;
  if jsonb_array_length(p_workflow) = 0 then
    raise exception 'Workflow must contain at least one level.';
  end if;
  if jsonb_array_length(p_workflow) > 10 then
    raise exception 'Workflow can contain at most 10 levels.';
  end if;
  if coalesce(btrim(coalesce(p_reason, '')), '') = '' or length(btrim(p_reason)) < 5 then
    raise exception 'A reason for the change is required (at least 5 characters).';
  end if;

  for v_level in select jsonb_array_elements(p_workflow) loop
    v_type := coalesce(v_level ->> 'type', 'role');
    if v_type not in ('role', 'user') then
      raise exception 'Each workflow level type must be "role" or "user".';
    end if;
    v_sla := v_level ->> 'sla_hours';
    if v_sla is not null and (nullif(v_sla, '')::int is null or nullif(v_sla, '')::int < 1) then
      raise exception 'SLA hours must be a positive whole number when provided.';
    end if;
    if v_type = 'role' then
      v_role := v_level ->> 'role';
      if v_role is null or v_role = '' then
        raise exception 'Role levels must specify a role.';
      end if;
      if not exists (select 1 from public.roles r where r.role_name = v_role) then
        raise exception 'Unknown role "%" in workspace level.', v_role;
      end if;
    else
      v_user_id := v_level ->> 'user_id';
      if v_user_id is null or (v_user_id::uuid is null) then
        raise exception 'User levels must specify a valid user_id.';
      end if;
      if not exists (select 1 from public.profiles p where p.id = v_user_id::uuid) then
        raise exception 'User level references an unknown profile.';
      end if;
    end if;
    v_count := v_count + 1;
  end loop;

  update public.hr_platform_settings
     set leave_approval_workflow = p_workflow
   where id = 1;

  select full_name into v_actor_name from public.profiles where id = auth.uid();
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'LEAVE_APPROVAL_WORKFLOW_SAVED', 'HrPlatformSettings', '1',
    coalesce(v_actor_name, auth.uid()::text),
    jsonb_build_object('levels', v_count, 'workflow', p_workflow, 'reason', p_reason)::text,
    'info'
  );

  return jsonb_build_object('ok', true, 'levels', v_count);
end;
$$;

-- --------------------------------------------------------------------------
-- 4. Chain readers prefer the workflow (falling back to legacy template)
-- --------------------------------------------------------------------------
create or replace function public.get_leave_approval_chain_for_request(p_request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_row public.leave_requests;
  v_employee_id uuid;
  v_wf jsonb;
begin
  select * into v_row from public.leave_requests where id = p_request_id;
  if v_row.id is null then return '[]'::jsonb; end if;
  if v_row.approval_chain is not null then return v_row.approval_chain; end if;
  v_employee_id := public._leave_request_employee_id(v_row.created_by);
  v_wf := public.get_leave_workflow_chain_for_employee(v_employee_id);
  if v_wf is not null and jsonb_array_length(v_wf) > 0 then return v_wf; end if;
  return public.get_leave_approval_chain_for_employee(v_employee_id);
end;
$$;

-- --------------------------------------------------------------------------
-- 5. process_leave_decision — workflow-aware, keeps SLA/feedback columns in sync
-- --------------------------------------------------------------------------
create or replace function public.process_leave_decision(
  p_request_id uuid,
  p_decision text,
  p_comment text default null,
  p_signature text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_row record;
  v_employee_id uuid;
  v_chain jsonb;
  v_stage_idx int;
  v_stage jsonb;
  v_can_act boolean;
  v_balance_year int;
  v_cancelling boolean;
  v_final boolean;
  v_stage_key text;
  v_next_ids uuid[];
  v_next uuid;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'Decision must be approved or rejected';
  end if;

  select * into v_row from public.leave_requests where id = p_request_id;
  if v_row.id is null then raise exception 'Leave request not found'; end if;
  if v_row.status <> 'pending' then raise exception 'Leave request is not pending'; end if;
  if v_row.created_by = v_actor_id then raise exception 'You cannot approve your own leave request'; end if;

  v_employee_id := public._leave_request_employee_id(v_row.created_by);

  select full_name into v_actor_name from public.profiles where id = v_actor_id;
  v_cancelling := coalesce(v_row.is_cancellation, false);

  -- Resolve / cache the chain (workflow-aware).
  v_chain := coalesce(v_row.approval_chain, public.get_leave_workflow_chain_for_employee(v_employee_id));
  if v_chain is null then
    v_chain := public.get_leave_approval_chain_for_employee(v_employee_id);
  end if;
  if v_row.approval_chain is null then
    update public.leave_requests set approval_chain = v_chain where id = p_request_id;
  end if;

  if v_chain is null or jsonb_array_length(v_chain) = 0 then
    raise exception 'No approvers could be resolved for this employee';
  end if;

  v_stage_idx := coalesce(v_row.approval_level, v_row.current_approval_level, 1);
  if v_stage_idx < 1 or v_stage_idx > jsonb_array_length(v_chain) then
    raise exception 'Invalid approval stage';
  end if;
  v_stage := v_chain -> (v_stage_idx - 1);
  v_stage_key := v_stage ->> 'stage_key';
  v_final := v_stage_idx >= jsonb_array_length(v_chain);

  -- Authorize. Role stages match a scoped role OR the resolved direct approver;
  -- generic role levels also match the caller's role (except line_manager,
  -- which is always supervisor-scoped via approver_id).
  v_can_act := false;
  if v_actor_role in ('super_admin', 'admin', 'head_of_human_resources') then
    v_can_act := true;
  elsif v_stage_key = 'branch_manager' and v_actor_role = 'branch_manager' then
    v_can_act := exists (
      select 1 from public.branches b
      where b.manager_id = v_actor_id and b.id = (select branch_id from public.employees where id = v_employee_id)
    );
  elsif v_stage_key = 'area_manager' and v_actor_role = 'area_manager' then
    v_can_act := exists (
      select 1 from public.branch_area_assignments baa
      join public.areas a on a.id = baa.area_id
      where a.manager_employee_id = (select id from public.employees where user_id = v_actor_id)
        and baa.branch_id = (select branch_id from public.employees where id = v_employee_id)
        and baa.is_current = true
    );
  elsif v_actor_id = (v_stage ->> 'approver_id')::uuid then
    v_can_act := true;
  elsif v_stage_key = v_actor_role and v_stage_key <> 'line_manager' then
    v_can_act := true;
  end if;

  if not v_can_act then
    raise exception 'You are not authorized to act on this leave request at the current stage';
  end if;

  -- Record trail.
  insert into public.leave_approvals
    (leave_request_id, stage, stage_role, stage_label, decision,
     approver_id, approver_name, comment, signature, is_cancellation)
  values
    (p_request_id, v_stage_idx, v_stage_key, v_stage ->> 'label', p_decision,
     v_actor_id, coalesce(v_actor_name, v_actor_id::text), p_comment, p_signature, v_cancelling);

  v_balance_year := extract(year from coalesce(v_row.start_date, now()))::int;

  if p_decision = 'rejected' then
    update public.leave_requests
       set status = case when v_cancelling then 'approved' else 'rejected' end,
           is_cancellation = false,
           updated_at = now()
     where id = p_request_id;
  elsif v_final then
    if v_cancelling then
      update public.leave_requests
         set status = 'cancelled', is_cancellation = false,
             approved_by_name = coalesce(v_actor_name, 'HR'),
             approved_date = now(), approval_comments = p_comment,
             updated_at = now()
       where id = p_request_id;
      if v_row.leave_type <> 'unpaid' and coalesce(v_row.days, 0) > 0 then
        update public.leave_balances
           set used_days = greatest(0, used_days - v_row.days), updated_at = now()
         where employee_id = v_row.created_by
           and year = v_balance_year
           and leave_type = v_row.leave_type;
      end if;
    else
      update public.leave_requests
         set status = 'approved',
             approved_by_name = coalesce(v_actor_name, 'HR'),
             approved_date = now(), approval_comments = p_comment,
             updated_at = now()
       where id = p_request_id;
      if v_row.leave_type <> 'unpaid' and coalesce(v_row.days, 0) > 0 then
        update public.leave_balances
           set used_days = used_days + v_row.days, updated_at = now()
         where employee_id = v_row.created_by
           and year = v_balance_year
           and leave_type = v_row.leave_type;
      end if;
    end if;
  else
    update public.leave_requests
       set approval_level = v_stage_idx + 1,
           current_approval_level = v_stage_idx + 1,
           stage_entered_at = now(),
           last_reminded_at = now(),
           updated_at = now()
     where id = p_request_id;

    -- Punch the next approver immediately (the 30-min notifier keeps nudging).
    v_next_ids := public._leave_stage_approver_ids(v_row.created_by, v_chain -> v_stage_idx);
    foreach v_next in array coalesce(v_next_ids, '{}'::uuid[]) loop
      if v_next is null or v_next = v_row.created_by then continue; end if;
      insert into public.notifications (user_id, title, message, type, link)
      values (
        v_next,
        'Leave approval needed',
        format('%s — awaiting your approval at the %s stage.', v_row.employee_name, v_stage ->> 'label'),
        'urgent',
        '/leave-requests'
      );
    end loop;
  end if;

  insert into public.notifications (user_id, title, message, type, link)
  values (
    v_row.created_by,
    'Leave request update',
    format('Your leave request was %s by %s.', p_decision, coalesce(v_actor_name, 'HR')),
    'info',
    '/leave-requests'
  );

  return jsonb_build_object(
    'ok', true,
    'request_id', p_request_id,
    'decision', p_decision,
    'final', v_final,
    'cancellation', v_cancelling,
    'stage', v_stage_idx,
    'stage_label', v_stage ->> 'label'
  );
end;
$$;

-- --------------------------------------------------------------------------
-- 6. submit_leave_feedback — mandatory post-decision feedback
-- --------------------------------------------------------------------------
create or replace function public.submit_leave_feedback(
  p_request_id uuid,
  p_turnaround_rating smallint,
  p_ease_rating smallint,
  p_text text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.leave_requests;
  v_name text;
begin
  select * into v_row from public.leave_requests where id = p_request_id;
  if v_row.id is null then raise exception 'Leave request not found'; end if;
  if v_row.created_by <> v_uid then raise exception 'You can only give feedback on your own leave request'; end if;
  if v_row.status = 'pending' then raise exception 'Feedback can only be given once a decision has been made'; end if;
  if coalesce(v_row.feedback_submitted, false) then raise exception 'Feedback for this request was already submitted'; end if;
  if p_turnaround_rating is null or p_turnaround_rating not between 1 and 5 then
    raise exception 'Processing-time rating is required (1–5).';
  end if;
  if p_ease_rating is null or p_ease_rating not between 1 and 5 then
    raise exception 'Ease-of-process rating is required (1–5).';
  end if;
  if coalesce(btrim(coalesce(p_text, '')), '') = '' or length(btrim(p_text)) < 10 then
    raise exception 'Please share at least a sentence or two (10+ characters).';
  end if;

  insert into public.leave_feedback (leave_request_id, employee_id, turnaround_rating, ease_rating, feedback_text)
  values (p_request_id, v_uid, p_turnaround_rating, p_ease_rating, btrim(p_text));

  update public.leave_requests
     set feedback_submitted = true, updated_at = now()
   where id = p_request_id;

  select full_name into v_name from public.profiles where id = v_uid;
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'LEAVE_FEEDBACK_SUBMITTED', 'LeaveRequest', p_request_id::text,
    coalesce(v_name, v_uid::text),
    jsonb_build_object('turnaround_rating', p_turnaround_rating, 'ease_rating', p_ease_rating)::text,
    'info'
  );

  return jsonb_build_object('ok', true, 'request_id', p_request_id);
end;
$$;

-- --------------------------------------------------------------------------
-- 7. Notifier — resolves the actual approver(s) for a stage + 30-min reminders
-- --------------------------------------------------------------------------
create or replace function public._leave_stage_approver_ids(p_created_by uuid, p_stage jsonb)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_employee_id uuid := public._leave_request_employee_id(p_created_by);
  v_stage_key text := p_stage ->> 'stage_key';
  v_ids uuid[] := '{}'::uuid[];
  v_id uuid;
  v_res jsonb;
begin
  -- Direct approver (user levels + resolved legacy/role stages).
  if coalesce(p_stage ->> 'approver_id', '') <> '' then
    v_id := (p_stage ->> 'approver_id')::uuid;
    if v_id is not null then return array[v_id]; end if;
  end if;

  -- Role-scoped resolution — mirrors the authorization in process_leave_decision.
  case v_stage_key
    when 'line_manager' then
      v_res := public.resolve_leave_approver(v_employee_id, 'line_manager');
      if v_res is not null and v_res ->> 'approver_id' is not null then
        v_ids := array_append(v_ids, (v_res ->> 'approver_id')::uuid);
      end if;
    when 'branch_manager' then
      select b.manager_id into v_id
        from public.branches b
        join public.employees e on e.branch_id = b.id
       where e.id = v_employee_id
       limit 1;
      if v_id is not null then v_ids := array_append(v_ids, v_id); end if;
    when 'area_manager' then
      select am.user_id into v_id
        from public.branch_area_assignments baa
        join public.areas a on a.id = baa.area_id
        join public.employees e on e.branch_id = baa.branch_id
        join public.employees am on am.id = a.manager_employee_id
       where e.id = v_employee_id and baa.is_current = true
       limit 1;
      if v_id is not null then v_ids := array_append(v_ids, v_id); end if;
    when 'head_of_human_resources' then
      select coalesce(array_agg(id), '{}'::uuid[]) into v_ids
        from public.profiles where role = 'head_of_human_resources';
    else
      select coalesce(array_agg(id), '{}'::uuid[]) into v_ids
        from public.profiles where role = v_stage_key;
  end case;

  return coalesce(v_ids, '{}'::uuid[]);
end;
$$;

create or replace function public.notify_leave_approvers()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_sent int := 0;
  v_escalated int := 0;
  r record;
  v_employee_id uuid;
  v_chain jsonb;
  v_idx int;
  v_stage jsonb;
  v_stage_start timestamptz;
  v_sla int;
  v_candidates uuid[];
  v_cand uuid;
begin
  for r in
    select lr.id, lr.created_by, lr.employee_name, lr.leave_type,
           lr.start_date, lr.end_date, lr.approval_level, lr.current_approval_level,
           lr.stage_entered_at, lr.last_reminded_at, lr.approval_chain,
           lr.updated_at, lr.created_at, lr.approval_chain
      from public.leave_requests lr
     where lr.status = 'pending'
       and (lr.last_reminded_at is null or lr.last_reminded_at < v_now - interval '25 minutes')
      for update skip locked
  loop
    v_employee_id := public._leave_request_employee_id(r.created_by);
    v_chain := coalesce(r.approval_chain, public.get_leave_approval_chain_for_request(r.id));
    if v_chain is null or jsonb_array_length(v_chain) = 0 then
      continue; -- unresolved employee/stage — retry next cycle
    end if;

    v_idx := least(greatest(coalesce(r.current_approval_level, r.approval_level, 1), 1), jsonb_array_length(v_chain));
    v_stage := v_chain -> (v_idx - 1);
    v_stage_start := coalesce(r.stage_entered_at, r.updated_at, r.created_at);
    v_sla := coalesce(nullif(v_stage ->> 'sla_hours', '')::int, 48);

    -- 30-minute reminder to the current stage approver(s).
    v_candidates := public._leave_stage_approver_ids(r.created_by, v_stage);
    foreach v_cand in array coalesce(v_candidates, '{}'::uuid[]) loop
      if v_cand is null or v_cand = r.created_by then continue; end if;
      insert into public.notifications (user_id, title, message, type, link)
      values (
        v_cand,
        'Leave approval reminder',
        format('%s — %s leave (%s to %s) has been awaiting your approval at the %s stage for over an hour.',
               r.employee_name, r.leave_type, r.start_date, r.end_date, v_stage ->> 'label'),
        'urgent',
        '/leave-requests'
      );
      v_sent := v_sent + 1;
    end loop;

    -- SLA escalation: also wake the NEXT stage's approver when the current one
    -- has sat past its SLA. Chain is never mutated — the current approver keeps
    -- first claim; the backup can act per the authorization rules.
    if coalesce((v_stage ->> 'auto_escalate')::boolean, false)
       and v_now - v_stage_start > make_interval(hours => v_sla)
       and v_idx < jsonb_array_length(v_chain) then
      v_candidates := public._leave_stage_approver_ids(r.created_by, v_chain -> v_idx);
      foreach v_cand in array coalesce(v_candidates, '{}'::uuid[]) loop
        if v_cand is null or v_cand = r.created_by then continue; end if;
        insert into public.notifications (user_id, title, message, type, link)
        values (
          v_cand,
          'Leave approval escalated',
          format('%s — approval at the %s stage has exceeded its %s-hour SLA (%s to %s). Escalated to you as backup.',
                 r.employee_name, v_stage ->> 'label', v_sla, r.start_date, r.end_date),
          'urgent',
          '/leave-requests'
        );
        v_escalated := v_escalated + 1;
      end loop;
    end if;

    update public.leave_requests set last_reminded_at = v_now where id = r.id;
  end loop;

  return jsonb_build_object('ok', true, 'reminders_sent', v_sent, 'escalations_sent', v_escalated);
end;
$$;

-- --------------------------------------------------------------------------
-- 8. Grants + automatic schedule (30 minutes ÷, guarded by pg_cron presence)
-- --------------------------------------------------------------------------
grant execute on function public.get_leave_workflow_chain_for_employee(uuid) to authenticated;
grant execute on function public.get_leave_approval_workflow() to authenticated;
grant execute on function public.save_leave_approval_workflow(jsonb, text) to authenticated;
grant execute on function public.submit_leave_feedback(uuid, smallint, smallint, text) to authenticated;
grant execute on function public._leave_stage_approver_ids(uuid, jsonb) to authenticated;
grant execute on function public.notify_leave_approvers() to authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'infinitycore-leave-approver-reminders',
      '*/30 * * * *',
      $cmd$ select public.notify_leave_approvers(); $cmd$
    );
  end if;
exception
  when others then null;
end;
$$;

commit;