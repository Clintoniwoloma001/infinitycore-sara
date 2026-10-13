-- ============================================================================
-- PHASE 73 - ONE CANONICAL OBLIGATION READ MODEL (Command Centre <-> Workspace)
-- ============================================================================
-- Run AFTER 20261111000003_audit_obligation_edit_actions.sql.
-- Idempotent, additive, transaction-wrapped. Nothing is dropped, no Phase
-- 71/72/72b/72c row is rewritten and NO new status value is introduced.
--
-- WHY THIS MIGRATION
-- Three screens read the SAME three tables (audit_obligations,
-- audit_obligation_assignments, audit_submissions) but answered three
-- different questions with three different JOINs, so they disagreed:
--
--   * get_audit_command_center() reported every ASSIGNMENT (one row per
--     person) and get_audit_obligation_register() reported every OBLIGATION,
--     defaulting its filter to 'draft' - so an ACTIVE obligation was invisible
--     in the register by default.
--   * get_audit_workspace() built its schedule with an INNER join over
--     assignments and hard-filtered o.status = 'active'. An obligation that had
--     just been created - the one with NO responsible person yet - therefore
--     appeared NOWHERE in the Audit Workspace, and its Kanban board rendered
--     one card PER ASSIGNMENT with no completion percentage and no notion of
--     "who is still outstanding".
--   * The Shared Audit Schedule and a Submissions list did not exist as
--     workspace reads at all.
--
-- The fix is ONE derived read model, computed once, in Postgres:
--   public.audit_obligation_states(p_status)  - one row per obligation with the
--       assignment rollup, the completion percentage, the outstanding-person
--       list, the derived SLA state and the derived LIFECYCLE.
--   public.get_audit_obligation_overview(p_status) - the authenticated, scoped
--       gate in front of it (used by the Command Centre).
--   public.get_audit_workspace() - re-issued to return obligations / schedule /
--       submissions from that same rollup.
--
-- COMPLETION RULE (the single business rule, enforced once, in SQL):
--   required_persons  = the obligation's assignments (a LEFT join, so an
--                       obligation with no responsible person is 0, never 100%)
--   satisfied         = per assignment:
--                          requires_submission  -> status in ('accepted','closed')
--                          !requires_submission -> acknowledged (when
--                                                  acknowledgement is required)
--   completion_pct    = 100 * satisfied / required_persons   (0 when none)
--   A submission that is 'submitted', 'under_review', 'resubmitted',
--   'returned_for_correction' or 'rejected' is NOT a satisfied person: it is
--   either still awaiting an audit decision or has been sent back for a
--   correction that has not yet been made. Repeats by the same person do not
--   inflate the count, because the count is over ASSIGNMENTS, not submissions.
--
--   All satisfied  -> the obligation is COMPLETED. It is never auto-CLOSED:
--   'closed' on audit_obligations.status is the Head of Audit's formal sign-off
--   and stays a deliberate, audited action (set_audit_obligation_status /
--   update_audit_obligation), exactly as before.
--
-- WRITE PATH: unchanged. RLS still grants READ only; the only new write is
-- audit_assign_obligation_users(), a SECURITY DEFINER RPC with the same Head-
-- of-Audit gate as issue_audit_obligation(), which issues ONE obligation to
-- SEVERAL people in a single atomic call without ever duplicating an assignment.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. THE CANONICAL PER-OBLIGATION STATE
-- ---------------------------------------------------------------------------
-- One jsonb row per obligation. The lifecycle values are DERIVED labels for
-- the board's visual columns; the canonical statuses stay where they are
-- (audit_obligations.status and audit_obligation_assignments.status).
--
--   not_started         -> board column "Pending / Not started"
--   needs_clarification -> "Needs clarification"   (a submission was returned
--                          for correction / rejected and is still open)
--   blocked             -> "Cannot proceed / blocked" (paused obligation)
--   in_progress         -> "In progress"           (partial completion)
--   awaiting_approval   -> "Awaiting final review" (every responsible person
--                          has responded, none of it is accepted yet)
--   completed           -> "Completed"             (every responsible person
--                          has satisfied the configured completion criteria)
--
-- Not executable directly by a browser: the gates in section 2/3/4 are the
-- only entry points.
create or replace function public.audit_obligation_states(p_status text default null)
returns setof jsonb
language sql
stable
security definer
set search_path = public
as $$
  with enrolled as (
    select
      o.id as obligation_id,
      o.reference, o.title, o.description, o.instructions,
      o.obligation_type, o.department, o.status, o.priority, o.risk_rating,
      o.requires_acknowledgement, o.requires_submission,
      o.required_documents, o.recurrence_rule, o.next_occurrence,
      o.submission_deadline,
      o.acknowledgement_deadline, o.review_deadline,
      o.accountable_owner_user_id, o.created_at, o.updated_at,
      a.id as assignment_id,
      a.status as assignment_status,
      a.acknowledged_at,
      a.last_submitted_at,
      coalesce(a.submission_deadline, o.submission_deadline, o.next_occurrence) as due_date,
      p.full_name as owner_name,
      p.email as owner_email,
      -- THE completion predicate for one responsible person.
      case
        when a.id is null then false
        when not o.requires_submission
          then (not o.requires_acknowledgement or a.acknowledged_at is not null)
        else a.status in ('accepted', 'closed')
      end as is_complete,
      -- "has done something": acknowledged, submitted, under review, returned,
      -- resubmitted, accepted or rejected. Used to tell In progress from
      -- Pending, and to recognise "everyone has responded" (awaiting review).
      case
        when a.id is null then false
        when a.status = 'not_started' and a.acknowledged_at is null then false
        else true
      end as has_progressed,
      -- A person the audit office has sent back to (or refused) is NOT done.
      case
        when a.id is null then false
        when a.status in ('returned_for_correction', 'rejected') then true
        else false
      end as needs_clarification
    from public.audit_obligations o
    left join public.audit_obligation_assignments a on a.obligation_id = o.id
    left join public.profiles p on p.id = a.assigned_user_id
    where o.status <> 'archived'
      and (p_status is null or o.status = p_status)
  ),
  rolled as (
    select
      obligation_id,
      (count(assignment_id))::int as assigned_count,
      (count(*) filter (where is_complete))::int as complete_count,
      (count(*) filter (where has_progressed))::int as progress_count,
      bool_or(needs_clarification) as any_clarification
    from enrolled
    group by obligation_id
  ),
  people as (
    select
      obligation_id,
      jsonb_agg(jsonb_build_object(
        'assignment_id', assignment_id,
        'name', coalesce(owner_name, 'Unassigned'),
        'email', owner_email,
        'status', assignment_status,
        'is_complete', is_complete,
        'has_progressed', has_progressed,
        'needs_clarification', needs_clarification,
        'due_date', due_date
      ) order by coalesce(owner_name, 'zzz')) filter (where assignment_id is not null) as assignees,
      jsonb_agg(coalesce(owner_name, 'Unassigned') order by coalesce(owner_name, 'zzz'))
        filter (where assignment_id is not null and not is_complete) as outstanding_names,
      (count(*) filter (where assignment_id is not null and not is_complete))::int as outstanding_count
    from enrolled
    group by obligation_id
  ),
  canonical as (
    select distinct on (obligation_id) * from enrolled
  )
  select jsonb_build_object(
    'id', o.obligation_id,
    'reference', o.reference,
    'title', o.title,
    'description', o.description,
    'instructions', o.instructions,
    'obligation_type', o.obligation_type,
    'department', o.department,
    'status', o.status,
    'priority', o.priority,
    'risk_rating', o.risk_rating,
    'requires_acknowledgement', o.requires_acknowledgement,
    'requires_submission', o.requires_submission,
    'required_documents', coalesce(o.required_documents, '[]'::jsonb),
    'recurrence_rule', o.recurrence_rule,
    'next_occurrence', o.next_occurrence,
    'submission_deadline', o.submission_deadline,
    'acknowledgement_deadline', o.acknowledgement_deadline,
    'review_deadline', o.review_deadline,
    'effective_deadline', coalesce(o.submission_deadline, o.next_occurrence),
    'due_date', coalesce(o.submission_deadline, o.next_occurrence),
    'accountable_owner_user_id', o.accountable_owner_user_id,
    'assigned_count', r.assigned_count,
    'complete_count', r.complete_count,
    'progress_count', r.progress_count,
    'outstanding_count', r.assigned_count - r.complete_count,
    'completion_pct', case when r.assigned_count = 0 then 0
                           else round(100.0 * r.complete_count / r.assigned_count, 1) end,
    'progress_pct', case when r.assigned_count = 0 then 0
                         else round(100.0 * r.progress_count / r.assigned_count, 1) end,
    'all_complete', (r.assigned_count > 0 and r.complete_count = r.assigned_count),
    'all_responded', (r.assigned_count > 0 and r.progress_count = r.assigned_count),
    'assignees', coalesce(pe.assignees, '[]'::jsonb),
    'outstanding_names', coalesce(pe.outstanding_names, '[]'::jsonb),
    'days_until_due', (coalesce(o.submission_deadline, o.next_occurrence) - current_date)::int,
    'is_overdue', (coalesce(o.submission_deadline, o.next_occurrence) is not null
                   and coalesce(o.submission_deadline, o.next_occurrence) < current_date
                   and not (r.assigned_count > 0 and r.complete_count = r.assigned_count)),
    'sla_state', case
                   when o.status = 'closed' then 'closed'
                   when coalesce(o.submission_deadline, o.next_occurrence) is null then 'not_due'
                   when coalesce(o.submission_deadline, o.next_occurrence) < current_date then 'overdue'
                   when coalesce(o.submission_deadline, o.next_occurrence) = current_date then 'due_today'
                   when coalesce(o.submission_deadline, o.next_occurrence) <= current_date + 7 then 'due_soon'
                   else 'upcoming' end,
    'lifecycle', case
                   when o.status = 'closed' then 'completed'
                   when o.status = 'paused'
                        and not (r.assigned_count > 0 and r.complete_count = r.assigned_count)
                     then 'blocked'
                   when r.assigned_count > 0 and r.complete_count = r.assigned_count
                     then 'completed'
                   when r.any_clarification
                     then 'needs_clarification'
                   when r.assigned_count > 0 and r.progress_count = r.assigned_count
                        and o.requires_submission
                     then 'awaiting_approval'
                   when r.progress_count > 0 then 'in_progress'
                   else 'not_started' end,
    'created_at', o.created_at,
    'updated_at', o.updated_at
  )
  from canonical o
  join rolled r on r.obligation_id = o.obligation_id
  left join people pe on pe.obligation_id = o.obligation_id
  order by o.reference
$$;

-- Browser callers must go through a gate, never straight at the rollup.
revoke all on function public.audit_obligation_states(text) from public;
revoke all on function public.audit_obligation_states(text) from authenticated;

-- ---------------------------------------------------------------------------
-- 2. THE SCOPED OVERVIEW (Command Centre, Workspace, Department head)
-- ---------------------------------------------------------------------------
-- Same rollup, three audiences, one scope rule decided on the SERVER:
--   command-centre reader / workspace member -> every non-archived obligation
--   department head                          -> their OWN department only
-- Anyone else is refused before a single row is produced.
create or replace function public.get_audit_obligation_overview(p_status text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_unscoped boolean := public.is_audit_command_center_reader()
                        or public.is_audit_workspace_member();
  v_rows jsonb;
begin
  if not (v_unscoped or public.is_department_head()) then
    raise exception 'AUDIT_FORBIDDEN:You are not permitted to view audit obligations.';
  end if;

  v_rows := coalesce((
    select jsonb_agg(x order by x->>'reference')
      from public.audit_obligation_states(p_status) as x_items(x)
     where v_unscoped or x->>'department' = public.current_department()
  ), '[]'::jsonb);

  return jsonb_build_object(
    'ok', true,
    'as_of', current_date,
    'scope', case when v_unscoped then 'all' else public.current_department() end,
    'obligations', v_rows,
    'summary', (
      select jsonb_build_object(
        'obligations', jsonb_array_length(v_rows),
        'by_lifecycle', coalesce((
          select jsonb_object_agg(x.k, x.n) from (
            select y->>'lifecycle' as k, count(*)::int as n
              from jsonb_array_elements(v_rows) as y_items(y)
             group by y->>'lifecycle'
          ) x), '{}'::jsonb),
        'assigned', coalesce((select sum((y->>'assigned_count')::int)
                                from jsonb_array_elements(v_rows) as y_items(y)), 0),
        'satisfied', coalesce((select sum((y->>'complete_count')::int)
                                from jsonb_array_elements(v_rows) as y_items(y)), 0),
        'completion_pct', case
          when coalesce((select sum((y->>'assigned_count')::int)
                          from jsonb_array_elements(v_rows) as y_items(y)), 0) = 0 then 0
          else round(100.0
                     * coalesce((select sum((y->>'complete_count')::int)
                                  from jsonb_array_elements(v_rows) as y_items(y)), 0)
                     / coalesce((select sum((y->>'assigned_count')::int)
                                  from jsonb_array_elements(v_rows) as y_items(y)), 0), 1)
        end
      )
    )
  );
end;
$$;

revoke all on function public.get_audit_obligation_overview(text) from public;
grant execute on function public.get_audit_obligation_overview(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. ISSUE ONE OBLIGATION TO SEVERAL RESPONSIBLE PEOPLE IN ONE CALL
-- ---------------------------------------------------------------------------
-- The existing issue_audit_obligation() takes ONE person; assigning three
-- responsible persons meant three round trips with no atomicity. This is the
-- same gate, the same department resolution (from the assignee's own profile,
-- never from the client) and the same audit row per assignment - it simply
-- loops. on conflict do nothing means re-issuing the same people can NEVER
-- duplicate an assignment or silently reset someone's live progress.
create or replace function public.audit_assign_obligation_users(
  p_obligation_id uuid,
  p_user_ids uuid[],
  p_acknowledgement_deadline date default null,
  p_submission_deadline date default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref text;
  v_user uuid;
  v_dept text;
  v_id uuid;
  v_inserted int := 0;
  v_skipped int := 0;
begin
  if not (public.has_permission('audit.obligations.manage')
          or public.current_role() in ('super_admin', 'admin', 'head_of_audit')) then
    raise exception 'AUDIT_FORBIDDEN:Only the Head of Audit can issue audit obligations.';
  end if;
  if p_user_ids is null or array_length(p_user_ids, 1) is null then
    raise exception 'ASSIGNEES_REQUIRED:Choose at least one responsible person.';
  end if;

  select reference into v_ref from public.audit_obligations where id = p_obligation_id;
  if v_ref is null then
    raise exception 'UNKNOWN_OBLIGATION:That obligation does not exist.';
  end if;
  if exists (select 1 from public.audit_obligations
              where id = p_obligation_id and status = 'archived') then
    raise exception 'OBLIGATION_ARCHIVED:An archived obligation cannot be issued.';
  end if;

  foreach v_user in array p_user_ids loop
    -- Reset per iteration: on conflict do nothing leaves v_id untouched, so a
    -- skipped duplicate must not be counted as a new assignment.
    v_id := null;
    -- The department is resolved from the assignee's OWN profile row.
    select department into v_dept from public.profiles where id = v_user;
    if v_dept is null then
      raise exception 'UNKNOWN_ASSIGNEE:One of the selected users could not be found.';
    end if;

    insert into public.audit_obligation_assignments (
      obligation_id, assigned_user_id, department,
      acknowledgement_deadline, submission_deadline, original_submission_deadline
    ) values (
      p_obligation_id, v_user, v_dept,
      p_acknowledgement_deadline, p_submission_deadline, p_submission_deadline
    )
    on conflict (obligation_id, assigned_user_id) do nothing
    returning id into v_id;

    if v_id is not null then
      v_inserted := v_inserted + 1;
      insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
      values ('AUDIT_OBLIGATION_ISSUED', 'AuditObligationAssignment', v_id::text,
              (select full_name from public.profiles where id = auth.uid()),
              jsonb_build_object('reference', v_ref, 'obligation_id', p_obligation_id,
                                 'assignee', v_user, 'department', v_dept,
                                 'success', true)::text,
              'info');
    else
      v_skipped := v_skipped + 1;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'reference', v_ref,
                            'assigned', v_inserted, 'skipped', v_skipped);
end;
$$;

revoke all on function public.audit_assign_obligation_users(uuid, uuid[], date, date) from public;
grant execute on function public.audit_assign_obligation_users(uuid, uuid[], date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. THE SHARED AUDIT WORKSPACE, RE-ISSUED ON THE CANONICAL READ MODEL
-- ---------------------------------------------------------------------------
-- The gate, the viewer and the return shape are unchanged in spirit; the
-- payload is now the obligation rollup plus a real submission list, so the
-- Workspace, the Command Centre and the register read one truth.
--
-- 'schedule' keeps its name for the existing page contract but is now
-- OBLIGATION-shaped and includes the obligations with NO responsible person
-- yet (they are the audit office's own work, not an empty state).
-- 'my_assignments', 'review_queue' and 'outstanding_tasks' are unchanged in
-- meaning - Realtime-driven refetches on any write keep them in step.
create or replace function public.get_audit_workspace()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_states jsonb;
begin
  if not public.is_audit_workspace_member() then
    raise exception 'AUDIT_FORBIDDEN:The shared Audit Workspace is limited to audit department staff.';
  end if;

  v_states := coalesce((
    select jsonb_agg(x order by x->>'reference')
      from public.audit_obligation_states(null) x
  ), '[]'::jsonb);

  return jsonb_build_object(
    'ok', true,
    'as_of', current_date,
    'viewer', jsonb_build_object(
      'user_id', auth.uid(),
      'department', public.current_department()
    ),
    -- Every obligation the audit office can see, one card each, with the
    -- assignment rollup: completion %, who is outstanding, lifecycle column.
    'obligations', v_states,
    'completion', (
      select jsonb_build_object(
        'obligations', jsonb_array_length(v_states),
        'by_lifecycle', coalesce((
          select jsonb_object_agg(x.k, x.n) from (
            select y->>'lifecycle' as k, count(*)::int as n
              from jsonb_array_elements(v_states) as y_items(y)
             group by y->>'lifecycle'
          ) x), '{}'::jsonb),
        'assignments', (
          select count(*)::int from public.audit_obligation_assignments a
            join public.audit_obligations o on o.id = a.obligation_id
           where o.status <> 'archived'),
        'satisfied', (
          select count(*)::int from public.audit_obligation_assignments a
            join public.audit_obligations o on o.id = a.obligation_id
           where o.status <> 'archived'
             and a.status in ('accepted', 'closed'))
      )
    ),
    -- The schedule view: only obligations that actually carry scheduling
    -- information. Nothing is generated or written here, so a refresh can
    -- never duplicate a schedule entry.
    'schedule', coalesce((
      select jsonb_agg(x order by (x->>'effective_deadline') nulls last, x->>'reference')
        from jsonb_array_elements(v_states) as x_items(x)
       where (x->>'effective_deadline') is not null
          or (x->>'recurrence_rule') is not null
          or (x->>'next_occurrence') is not null
    ), '[]'::jsonb),
    'my_assignments', coalesce((
      select jsonb_agg(x order by x.due_date nulls last, x.reference)
      from (
        select o.id as obligation_id, o.reference, o.title, o.instructions,
               o.status as obligation_status,
               o.required_documents,
               a.id as assignment_id, a.status as assignment_status,
               a.acknowledgement_deadline, a.acknowledged_at,
               a.submission_deadline,
               a.department as department,
               coalesce(a.submission_deadline, o.submission_deadline, o.next_occurrence) as due_date,
               (coalesce(a.submission_deadline, o.submission_deadline, o.next_occurrence)
                 - current_date)::int as days_until_due,
               (select st->>'completion_pct' from jsonb_array_elements(v_states) as st_items(st)
                 where (st->>'id')::uuid = a.obligation_id limit 1) as completion_pct,
               (select st->>'lifecycle' from jsonb_array_elements(v_states) as st_items(st)
                 where (st->>'id')::uuid = a.obligation_id limit 1) as lifecycle
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
               s.obligation_id,
               o.reference, o.title as obligation_title, o.department,
               p.full_name as submitted_by_name,
               (select st->>'lifecycle' from jsonb_array_elements(v_states) as st_items(st)
                 where (st->>'id')::uuid = s.obligation_id limit 1) as lifecycle
        from public.audit_submissions s
        join public.audit_obligations o on o.id = s.obligation_id
        left join public.profiles p on p.id = s.submitted_by
        where s.status in ('submitted', 'resubmitted', 'under_review')
      ) x
    ), '[]'::jsonb),
    -- Submissions, for the Submissions tab. Same RLS-shaped visibility as the
    -- review queue above (the workspace is already gated to audit staff).
    'submissions', coalesce((
      select jsonb_agg(x order by x.submitted_at desc)
      from (
        select s.id as submission_id, s.assignment_id, s.version, s.status,
               s.submitted_at, s.reviewed_at, s.correction_reason,
               s.correction_fields, s.submitted_by,
               s.obligation_id,
               o.reference, o.title as obligation_title, o.department,
               o.obligation_type,
               coalesce(a.submission_deadline, o.submission_deadline, o.next_occurrence) as due_date,
               (coalesce(a.submission_deadline, o.submission_deadline, o.next_occurrence)
                 - current_date)::int as days_until_due,
               p.full_name as submitted_by_name,
               p2.full_name as reviewed_by_name
        from public.audit_submissions s
        join public.audit_obligations o on o.id = s.obligation_id
        left join public.audit_obligation_assignments a on a.id = s.assignment_id
        left join public.profiles p on p.id = s.submitted_by
        left join public.profiles p2 on p2.id = s.reviewed_by
        where o.status <> 'archived'
      ) x
    ), '[]'::jsonb),
    'outstanding_tasks', coalesce((
      select jsonb_agg(x order by x.sla_rank, (x.state->>'effective_deadline') nulls last)
      from (
        select y as state,
               case when (y->>'effective_deadline') is null then 8
                    when (y->>'sla_state') = 'overdue' then 0
                    when (y->>'sla_state') = 'due_today' then 1
                    when (y->>'sla_state') = 'due_soon' then 2
                    else 3 end as sla_rank
          from jsonb_array_elements(v_states) as y_items(y)
         where (y->>'lifecycle') <> 'completed'
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_audit_workspace() from public;
grant execute on function public.get_audit_workspace() to authenticated;

commit;
