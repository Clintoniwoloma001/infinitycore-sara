-- ============================================================
-- PHASE 19 — LEAVE: BRANCH/AREA-SCOPED SECURITY + FIXED BATCH RPC
--
-- Fixes three real gaps in the leave approval flow:
--   (a) RLS on leave_requests only let `admin`/`manager` see/update
--       other people's requests, so the real chain roles
--       (branch_manager, area_manager, head_of_business, hr_manager)
--       could not read OR act on anything server-side.
--   (b) sara_batch_approve_leave wrote to columns that do not exist
--       (request_id, reviewed_by, comments) and set status='approved'
--       at ANY stage — no per-stage gate, no balance deduction.
--   (c) branch managers could act on requests from any branch.
--
-- ALL ADDITIVE. Idempotent (IF NOT EXISTS / OR REPLACE / DROP policy).
-- ============================================================

-- ------------------------------------------------------------
-- 1. LEAVE REQUESTS — scoped RLS (read + update)
--    Branch Manager:  only staff whose branch they manage
--    Area Manager / HoB: senior oversight, all requests
--    HR / Admin:      all requests
--    Requesters:      their own
-- ------------------------------------------------------------
drop policy if exists "leave read" on public.leave_requests;
drop policy if exists "leave read scoped" on public.leave_requests;
create policy "leave read scoped" on public.leave_requests
  for select using (
    created_by = auth.uid()
    or public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
    or public.current_role() in ('area_manager', 'head_of_business')
    or (public.current_role() = 'branch_manager'
        and exists (
          select 1
          from public.employees e
          join public.branches b on b.id = e.branch_id
          where e.user_id = leave_requests.created_by
            and b.manager_id = auth.uid()
        ))
  );

drop policy if exists "leave update" on public.leave_requests;
drop policy if exists "leave update scoped" on public.leave_requests;
create policy "leave update scoped" on public.leave_requests
  for update using (
    created_by = auth.uid()
    or public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
    or public.current_role() in ('area_manager', 'head_of_business')
    or (public.current_role() = 'branch_manager'
        and exists (
          select 1
          from public.employees e
          join public.branches b on b.id = e.branch_id
          where e.user_id = leave_requests.created_by
            and b.manager_id = auth.uid()
        ))
  );

-- ------------------------------------------------------------
-- 2. leave_approvals READ — widen to the new scoped approver set
--    (mirrors the leave_approvals read policy in phase4, adding the
--    scoped branch-manager rule so a scoped BM can view the trail
--    of a request they may act on).
-- ------------------------------------------------------------
drop policy if exists "leave_approvals read" on public.leave_approvals;
create policy "leave_approvals read" on public.leave_approvals
  for select using (
    approver_id = auth.uid()
    or exists (
      select 1 from public.leave_requests lr
      where lr.id = leave_request_id
        and (lr.created_by = auth.uid()
             or public.current_role() in ('super_admin','admin','hr_manager','hr_officer')
             or public.current_role() in ('area_manager','head_of_business')
             or (public.current_role() = 'branch_manager'
                 and exists (
                   select 1 from public.employees e
                   join public.branches b on b.id = e.branch_id
                   where e.user_id = lr.created_by and b.manager_id = auth.uid()
                 )))
    )
  );

-- ------------------------------------------------------------
-- 3. REWRITE: sara_batch_approve_leave
--    Walks the SAME 4-stage chain as the web UI. It only
--    approves when the authenticated user holds the CURRENT
--    stage's role (branch managers additionally must manage the
--    requester's branch). Final stage applies the real outcome:
--      - normal leave  -> approved + days deducted from balance
--      - cancellation  -> cancelled  + days restored to balance
--    Correct leave_approvals columns. Never bypasses authorization.
-- ------------------------------------------------------------
create or replace function public.sara_batch_approve_leave(
  p_request_ids uuid[],
  p_comments text default 'Approved via SARA voice command'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_id uuid;
  v_row record;
  v_stage int;
  v_stage_role text;
  v_stage_label text;
  v_can_act boolean;
  v_requester_branch_id uuid;
  v_balance_year int;
  v_approved int := 0;
  v_skipped int := 0;
  v_results jsonb := '[]'::jsonb;
begin
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager', 'area_manager', 'head_of_business', 'branch_manager') then
    raise exception 'Not authorized to approve leave requests';
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  foreach v_id in array p_request_ids loop
    begin
      select * into v_row from public.leave_requests where id = v_id;
      if v_row.id is null or v_row.status <> 'pending' then
        v_skipped := v_skipped + 1;
        v_results := v_results || jsonb_build_object('id', v_id::text, 'status', 'skipped', 'reason', 'not pending or missing');
        continue;
      end if;

      v_stage := coalesce(v_row.approval_level, 1);

      select role, label into v_stage_role, v_stage_label
      from (values
        (1, 'branch_manager',   'Branch Manager'),
        (2, 'area_manager',     'Area Manager'),
        (3, 'head_of_business', 'Head of Business'),
        (4, 'hr_manager',       'HR (Final)')
      ) t(level, role, label)
      where t.level = v_stage;

      -- Authorization at the current stage.
      v_can_act := false;
      if v_actor_role in ('super_admin', 'admin', 'hr_manager') then
        v_can_act := true; -- HR/admin may act at any stage
      elsif v_actor_role = v_stage_role then
        if v_actor_role = 'branch_manager' then
          select e.branch_id into v_requester_branch_id
          from public.employees e
          where e.user_id = v_row.created_by
          limit 1;
          v_can_act := exists (
            select 1 from public.branches b
            where b.id = v_requester_branch_id and b.manager_id = auth.uid()
          );
        else
          v_can_act := true;
        end if;
      end if;

      if not v_can_act then
        v_skipped := v_skipped + 1;
        v_results := v_results || jsonb_build_object('id', v_id::text, 'status', 'skipped', 'reason', 'not authorized at current stage');
        continue;
      end if;

      -- Trail entry (correct schema: stage_role + stage_label are NOT NULL).
      insert into public.leave_approvals
        (leave_request_id, stage, stage_role, stage_label, decision,
         approver_id, approver_name, comment, is_cancellation)
      values
        (v_id, v_stage, v_stage_role, v_stage_label, 'approved',
         auth.uid(), coalesce(v_actor_name, auth.uid()::text), p_comments, coalesce(v_row.is_cancellation, false));

      v_balance_year := extract(year from coalesce(v_row.start_date, now()))::int;

      if v_stage >= 4 then
        -- FINAL stage — apply the real outcome.
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
        -- Non-final stage — advance to the next approver.
        update public.leave_requests set approval_level = v_stage + 1 where id = v_id;
        v_results := v_results || jsonb_build_object('id', v_id::text, 'status', format('approved_stage_%s', v_stage));
      end if;

      v_approved := v_approved + 1;

      insert into public.notifications (user_id, title, message, type, link)
      values (v_row.created_by, 'Leave Update',
              format('Your %s leave request was approved at the %s stage by %s via SARA.',
                     v_row.leave_type, v_stage_label, coalesce(v_actor_name, 'HR')),
              'workflow', '/leave-requests');
    exception when others then
      v_results := v_results || jsonb_build_object('id', v_id::text, 'status', 'error', 'error', SQLERRM);
    end;
  end loop;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'SARA_BATCH_APPROVE_LEAVE',
    'LeaveRequest',
    array_to_string(p_request_ids, ','),
    coalesce(v_actor_name, auth.uid()::text),
    format('SARA batch approved/applied %s leave request(s), skipped %s', v_approved, v_skipped),
    'warning'
  );

  return jsonb_build_object('ok', true, 'approved_count', v_approved, 'skipped_count', v_skipped, 'results', v_results);
end; $$;
grant execute on function public.sara_batch_approve_leave(uuid[], text) to authenticated;

-- ============================================================
-- DONE. All changes are additive and idempotent.
-- ============================================================