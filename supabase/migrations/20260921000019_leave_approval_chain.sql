-- Phase 6 — Configurable leave approval chain.
-- Idempotent/additive.
-- Default chain: employee → line manager → branch manager → area manager → head of human resources.
-- Missing stages are skipped for that employee (e.g. no line manager means go straight to branch manager).

-- 1. Store the global approval-chain template on hr_platform_settings.
alter table public.hr_platform_settings
  add column if not exists leave_approval_chain jsonb default '["line_manager","branch_manager","area_manager","head_of_human_resources"]'::jsonb;

update public.hr_platform_settings
   set leave_approval_chain = coalesce(leave_approval_chain, '["line_manager","branch_manager","area_manager","head_of_human_resources"]'::jsonb)
 where id = 1;

-- 2. Helper: resolve the actual approver for one stage of the chain for a given employee.
create or replace function public.resolve_leave_approver(p_employee_id uuid, p_stage_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_employee public.employees;
  v_supervisor record;
  v_branch record;
  v_area record;
  v_hr record;
  v_name text;
  v_id uuid;
begin
  select * into v_employee from public.employees where id = p_employee_id;
  if v_employee.id is null then return null; end if;

  case p_stage_key
    when 'line_manager' then
      select lm.user_id, lm.full_name into v_id, v_name
        from public.employee_supervisors s
        join public.employees lm on lm.id = s.supervisor_employee_id
       where s.employee_id = p_employee_id and s.level = 1
       order by s.effective_from desc nulls last
       limit 1;

    when 'branch_manager' then
      select b.id, b.manager_id into v_branch.id, v_id
        from public.branches b
       where b.id = v_employee.branch_id
       limit 1;
      if v_id is not null then
        select full_name into v_name from public.profiles where id = v_id;
      end if;

    when 'area_manager' then
      select am.user_id, am.full_name into v_id, v_name
        from public.branch_area_assignments baa
        join public.areas a on a.id = baa.area_id
        join public.employees am on am.id = a.manager_employee_id
       where baa.branch_id = v_employee.branch_id
         and baa.is_current = true
       limit 1;

    when 'head_of_human_resources' then
      select id, full_name into v_id, v_name
        from public.profiles
       where role = 'head_of_human_resources' and status = 'active'
       order by created_at
       limit 1;

    else
      return null;
  end case;

  if v_id is null then return null; end if;
  return jsonb_build_object('stage_key', p_stage_key, 'approver_id', v_id, 'approver_name', coalesce(v_name, 'Unknown'));
end;
$$;

-- Helper: map a leave_request.created_by (auth user id) to the employee id.
create or replace function public._leave_request_employee_id(p_user_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.employees where user_id = p_user_id limit 1;
$$;

-- 3. Helper: return the resolved chain for an employee (missing stages omitted).
create or replace function public.get_leave_approval_chain_for_employee(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_template jsonb;
  v_stage text;
  v_resolved jsonb;
  v_chain jsonb := '[]'::jsonb;
  v_labels jsonb := '{"line_manager":"Line Manager","branch_manager":"Branch Manager","area_manager":"Area Manager","head_of_human_resources":"Head of Human Resources"}'::jsonb;
begin
  select leave_approval_chain into v_template from public.hr_platform_settings where id = 1;
  if v_template is null then
    v_template := '["line_manager","branch_manager","area_manager","head_of_human_resources"]'::jsonb;
  end if;

  for v_stage in select jsonb_array_elements_text(v_template) loop
    v_resolved := public.resolve_leave_approver(p_employee_id, v_stage);
    if v_resolved is not null then
      v_chain := v_chain || jsonb_build_object(
        'stage_key', v_stage,
        'label', v_labels ->> v_stage,
        'approver_id', v_resolved ->> 'approver_id',
        'approver_name', v_resolved ->> 'approver_name'
      );
    end if;
  end loop;

  return v_chain;
end;
$$;

-- 4. Rewrite sara_batch_approve_leave to use the configurable chain and skip missing stages.
create or replace function public.sara_batch_approve_leave(
  p_request_ids uuid[],
  p_comments text default 'Approved via SARA voice command'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_actor_id uuid := auth.uid();
  v_id uuid;
  v_row record;
  v_employee_id uuid;
  v_chain jsonb;
  v_stage_idx int;
  v_stage jsonb;
  v_can_act boolean;
  v_balance_year int;
  v_approved int := 0;
  v_skipped int := 0;
  v_results jsonb := '[]'::jsonb;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources', 'area_manager', 'head_of_business', 'branch_manager') then
    raise exception 'Not authorized to approve leave requests';
  end if;

  select full_name into v_actor_name from public.profiles where id = v_actor_id;

  foreach v_id in array p_request_ids loop
    begin
      select * into v_row from public.leave_requests where id = v_id;
      if v_row.id is null or v_row.status <> 'pending' then
        v_skipped := v_skipped + 1;
        v_results := v_results || jsonb_build_object('id', v_id::text, 'status', 'skipped', 'reason', 'not pending or missing');
        continue;
      end if;

      v_employee_id := public._leave_request_employee_id(v_row.created_by);

      -- Resolve the chain for this requester.
      select coalesce(
        v_row.approval_chain,
        public.get_leave_approval_chain_for_employee(v_employee_id)
      ) into v_chain;

      -- Persist resolved chain on first call so stage indexing is stable.
      if v_row.approval_chain is null then
        update public.leave_requests set approval_chain = v_chain where id = v_id;
      end if;

      v_stage_idx := coalesce(v_row.approval_level, 1);
      if v_stage_idx < 1 or v_stage_idx > jsonb_array_length(v_chain) then
        v_skipped := v_skipped + 1;
        v_results := v_results || jsonb_build_object('id', v_id::text, 'status', 'skipped', 'reason', 'invalid approval stage');
        continue;
      end if;

      v_stage := v_chain -> (v_stage_idx - 1);

      -- Authorization at the current stage.
      v_can_act := false;
      if v_actor_role in ('super_admin', 'admin', 'head_of_human_resources') then
        v_can_act := true;
      elsif v_actor_role = v_stage ->> 'stage_key' then
        if v_actor_role = 'branch_manager' then
          v_can_act := exists (
            select 1 from public.branches b
            where b.manager_id = v_actor_id
              and b.id = (select branch_id from public.employees where id = v_employee_id)
          );
        elsif v_actor_role = 'area_manager' then
          v_can_act := exists (
            select 1 from public.branch_area_assignments baa
            join public.areas a on a.id = baa.area_id
            where a.manager_employee_id = (select id from public.employees where user_id = v_actor_id)
              and baa.branch_id = (select branch_id from public.employees where id = v_employee_id)
              and baa.is_current = true
          );
        else
          v_can_act := true;
        end if;
      elsif v_actor_id = (v_stage ->> 'approver_id')::uuid then
        -- Direct approver match (e.g. line manager resolved to a specific employee user).
        v_can_act := true;
      end if;

      if not v_can_act then
        v_skipped := v_skipped + 1;
        v_results := v_results || jsonb_build_object('id', v_id::text, 'status', 'skipped', 'reason', 'not authorized at current stage');
        continue;
      end if;

      -- Trail entry.
      insert into public.leave_approvals
        (leave_request_id, stage, stage_role, stage_label, decision,
         approver_id, approver_name, comment, is_cancellation)
      values
        (v_id, v_stage_idx, v_stage ->> 'stage_key', v_stage ->> 'label', 'approved',
         v_actor_id, coalesce(v_actor_name, v_actor_id::text), p_comments, coalesce(v_row.is_cancellation, false));

      v_balance_year := extract(year from coalesce(v_row.start_date, now()))::int;

      if v_stage_idx >= jsonb_array_length(v_chain) then
        -- FINAL stage.
        if coalesce(v_row.is_cancellation, false) then
          update public.leave_requests
            set status = 'cancelled', is_cancellation = false,
                approved_by_name = coalesce(v_actor_name, 'HR'),
                approved_date = now(), approval_comments = p_comments
            where id = v_id;
          if v_row.leave_type <> 'unpaid' and coalesce(v_row.days, 0) > 0 then
            update public.leave_balances
              set used_days = greatest(0, used_days - v_row.days), updated_at = now()
              where employee_id = v_row.created_by
                and year = v_balance_year
                and leave_type = v_row.leave_type;
          end if;
          v_results := v_results || jsonb_build_object('id', v_id::text, 'status', 'cancelled');
        else
          update public.leave_requests
            set status = 'approved',
                approved_by_name = coalesce(v_actor_name, 'HR'),
                approved_date = now(), approval_comments = p_comments
            where id = v_id;
          if v_row.leave_type <> 'unpaid' and coalesce(v_row.days, 0) > 0 then
            update public.leave_balances
              set used_days = used_days + v_row.days, updated_at = now()
              where employee_id = v_row.created_by
                and year = v_balance_year
                and leave_type = v_row.leave_type;
          end if;
          v_results := v_results || jsonb_build_object('id', v_id::text, 'status', 'approved');
        end if;
      else
        -- Non-final stage — advance.
        update public.leave_requests set approval_level = v_stage_idx + 1 where id = v_id;
        v_results := v_results || jsonb_build_object('id', v_id::text, 'status', format('approved_stage_%s', v_stage_idx));
      end if;

      v_approved := v_approved + 1;

      insert into public.notifications (user_id, title, message, type, link)
      values (
        v_row.created_by,
        'Leave request update',
        format('Your leave request was approved by %s.', coalesce(v_actor_name, 'HR')),
        'info',
        '/leave-requests'
      );

    exception when others then
      v_skipped := v_skipped + 1;
      v_results := v_results || jsonb_build_object('id', v_id::text, 'status', 'skipped', 'reason', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('approved', v_approved, 'skipped', v_skipped, 'results', v_results);
end;
$$;

-- Add approval_chain column to leave_requests if missing, so resolved chains can be stable across edits.
alter table public.leave_requests
  add column if not exists approval_chain jsonb;

-- 5. Single RPC for the web UI and SARA to process an approve/reject decision.
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

  -- Resolve / cache the chain.
  v_chain := coalesce(v_row.approval_chain, public.get_leave_approval_chain_for_employee(v_employee_id));
  if v_row.approval_chain is null then
    update public.leave_requests set approval_chain = v_chain where id = p_request_id;
  end if;

  if v_chain is null or jsonb_array_length(v_chain) = 0 then
    raise exception 'No approvers could be resolved for this employee';
  end if;

  v_stage_idx := coalesce(v_row.approval_level, 1);
  if v_stage_idx < 1 or v_stage_idx > jsonb_array_length(v_chain) then
    raise exception 'Invalid approval stage';
  end if;
  v_stage := v_chain -> (v_stage_idx - 1);
  v_stage_key := v_stage ->> 'stage_key';
  v_final := v_stage_idx >= jsonb_array_length(v_chain);

  -- Authorize.
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
    update public.leave_requests set approval_level = v_stage_idx + 1, updated_at = now() where id = p_request_id;
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

-- RPC for the web UI to fetch the resolved chain for a specific leave request.
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
begin
  select * into v_row from public.leave_requests where id = p_request_id;
  if v_row.id is null then return '[]'::jsonb; end if;
  if v_row.approval_chain is not null then return v_row.approval_chain; end if;
  v_employee_id := public._leave_request_employee_id(v_row.created_by);
  return public.get_leave_approval_chain_for_employee(v_employee_id);
end;
$$;

 grant execute on function public.resolve_leave_approver(uuid, text) to authenticated;
 grant execute on function public.get_leave_approval_chain_for_employee(uuid) to authenticated;
 grant execute on function public.get_leave_approval_chain_for_request(uuid) to authenticated;
 grant execute on function public.process_leave_decision(uuid, text, text, text) to authenticated;
 grant execute on function public._leave_request_employee_id(uuid) to authenticated;
