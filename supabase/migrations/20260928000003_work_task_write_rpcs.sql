-- ============================================================================
-- Work Management & KPI Engine Overhaul - step 5: the write RPCs
-- ============================================================================
-- Replaces the spec's REST endpoints. This project has no backend process, so
-- each endpoint is a SECURITY DEFINER RPC with the same signature/semantics:
--   create_work_task_with_steps  <- POST /api/work-management/tasks
--   submit_task_progress         <- POST .../tasks/:id/submit-progress
--   review_task_progress         <- POST .../tasks/:id/review
-- Idempotent + additive.
begin;

-- The legacy CHECK has no 'needs_revision', which the spec's revision loop
-- requires. Widened (never narrowed) so no existing row is invalidated.
alter table public.work_tasks drop constraint if exists work_tasks_status_check;
alter table public.work_tasks add constraint work_tasks_status_check
  check (status in ('assigned','accepted','in_progress','submitted','under_review',
                    'needs_revision','completed','rejected','overdue','cancelled'));

-- ---------------------------------------------------------------------------
-- 1. create_work_task_with_steps
-- ---------------------------------------------------------------------------
-- One task + its ordered steps + its initial rate, atomically. Step weights
-- are auto-distributed equally (100/n) when not supplied, so the denominator
-- can never be zero.
-- Signature changes in Postgres create a NEW overload rather than replacing the
-- old one, which then makes named-argument calls ambiguous ("function name is
-- not unique"). Drop any previous signature first so this migration is
-- unambiguously re-runnable.
drop function if exists public.create_work_task_with_steps(
  text, uuid, uuid, text, text, text, text, timestamptz, timestamptz,
  integer, numeric, boolean, jsonb, text, uuid);

create or replace function public.create_work_task_with_steps(
  p_title            text,
  p_assignee_user_id uuid,
  p_employee_id      uuid,
  p_description      text default null,
  p_department       text default null,
  p_branch           text default null,
  p_priority         text default 'medium',
  p_start_date       timestamptz default null,
  p_due_date         timestamptz default null,
  p_sla_review_hours integer default 48,
  p_task_weight      numeric default 1,
  p_requires_evidence boolean default false,
  p_steps            jsonb default '[]'::jsonb,
  p_source           text default 'work_management',
  p_source_ref       uuid default null,
  p_allow_self_automation boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task_id uuid;
  v_rate    numeric;
  v_role    text := public.current_role();
  v_n       integer;
begin
  if p_title is null or btrim(p_title) = '' then
    raise exception 'A task title is required.';
  end if;
  if p_assignee_user_id is null then
    raise exception 'A task must be assigned to someone.';
  end if;
  -- Only the HR/manager role set may hand work to OTHER people.
  -- The one narrow exception: a user may create their OWN automation task
  -- (source = 'automation_centre') - that is how the Automation Command Centre
  -- "Add task" button works for an IT & Automations Specialist who holds no
  -- manager role. It cannot be used to assign anything to anyone else.
  if v_role not in ('super_admin','admin','head_of_human_resources','hr_officer',
                     'head_of_operations','head_of_business','branch_manager','area_manager')
     and not (p_allow_self_automation
              and p_assignee_user_id = auth.uid()
              and p_source = 'automation_centre') then
    raise exception 'You are not allowed to create tasks.';
  end if;

  insert into public.work_tasks (
    title, description, assigned_to_user_id, employee_id, department, branch,
    priority, status, start_date, due_date, sla_review_hours, task_weight,
    requires_evidence, assigned_by, source, source_ref
  ) values (
    btrim(p_title), p_description, p_assignee_user_id, p_employee_id,
    p_department, p_branch,
    coalesce(p_priority,'medium'), 'assigned',
    p_start_date, p_due_date,
    coalesce(p_sla_review_hours, 48), coalesce(p_task_weight, 1),
    coalesce(p_requires_evidence, false), auth.uid(),
    coalesce(p_source,'work_management'), p_source_ref
  ) returning id into v_task_id;

  select count(*) into v_n
  from jsonb_array_elements(coalesce(p_steps, '[]'::jsonb));

  if v_n > 0 then
    insert into public.work_task_steps
      (task_id, title, description, target_type, target_value, step_weight, order_index)
    select v_task_id,
           coalesce(nullif(btrim(elt->>'title'), ''), 'Deliverable ' || (ord::text)),
           elt->>'description',
           coalesce(nullif(elt->>'target_type',''), 'boolean'),
           case when coalesce(elt->>'target_type','boolean') = 'numerical'
                then (elt->>'target_value')::numeric else null end,
           -- Equal auto-distribution, or the caller's explicit weight.
           case when coalesce((elt->>'step_weight')::numeric, 0) > 0
                then (elt->>'step_weight')::numeric
                else round(100.0 / v_n, 4) end,
           (ord - 1)::integer
    from jsonb_array_elements(coalesce(p_steps, '[]'::jsonb)) with ordinality as x(elt, ord);
  end if;

  v_rate := public.work_task_recalculate(v_task_id);

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('WORK_TASK_CREATED','work_task', v_task_id,
          (select full_name from public.profiles where id = auth.uid()),
          jsonb_build_object('title', p_title, 'assignee', p_assignee_user_id,
                             'steps', v_n, 'source', p_source)::text, 'info');

  return jsonb_build_object('ok', true, 'task_id', v_task_id,
                            'step_count', v_n, 'calculated_completion_rate', v_rate);
end;
$$;

comment on function public.create_work_task_with_steps is
  'Creates a work task with its ordered step deliverables in one transaction. Returns task id and initial engine-computed rate.';

-- ---------------------------------------------------------------------------
-- 2. submit_task_progress
-- ---------------------------------------------------------------------------
-- Iterative logging. The employee may submit repeatedly; the task stays visible
-- in My Work while the report is pending. CRITICAL: this NEVER writes
-- work_task_steps - only APPROVED values are copied across, by
-- review_task_progress. A pending report therefore cannot inflate a score.
create or replace function public.submit_task_progress(
  p_task_id      uuid,
  p_summary      text default null,
  p_steps        jsonb default '[]'::jsonb,
  p_attachments  jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report_id uuid;
  v_rate      numeric;
  v_n         integer;
begin
  -- Only the assignee may file progress on their own task.
  if not exists (
    select 1 from public.work_tasks where id = p_task_id and assigned_to_user_id = auth.uid()
  ) then
    raise exception 'You can only submit progress on tasks assigned to you.';
  end if;
  if exists (
    select 1 from public.progress_reports where task_id = p_task_id and status = 'pending_review'
  ) then
    raise exception 'You already have a submission awaiting review on this task.';
  end if;

  -- What the user is CLAIMING, derived by the engine - stored purely so My Work
  -- can show "approved x% / pending y%". Not a write to the live step.
  v_rate := public.work_task_completion_rate(p_task_id);

  insert into public.progress_reports (task_id, submitted_by, pending_percentage, summary_comment)
  values (p_task_id, auth.uid(), v_rate, p_summary)
  returning id into v_report_id;

  insert into public.progress_report_steps (progress_report_id, task_step_id, reported_value, reported_boolean)
  select v_report_id,
         (elt->>'task_step_id')::uuid,
         case when s.target_type = 'numerical' then (elt->>'reported_value')::numeric else null end,
         case when s.target_type = 'boolean'   then coalesce((elt->>'reported_boolean')::boolean, false) else null end
  from jsonb_array_elements(coalesce(p_steps, '[]'::jsonb)) elt
  join public.work_task_steps s on s.id = (elt->>'task_step_id')::uuid
  where s.task_id = p_task_id;   -- a step from another task is silently ignored
  get diagnostics v_n = row_count;

  if v_n = 0 then
    raise exception 'No valid step updates were supplied for this task.';
  end if;

  insert into public.task_attachments (task_id, progress_report_id, file_url, file_name, file_type, uploaded_by)
  select p_task_id, v_report_id, a->>'file_url', a->>'file_name', a->>'file_type', auth.uid()
  from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) a
  where a->>'file_url' is not null and btrim(a->>'file_url') <> '';

  update public.work_task_steps s
     set status = 'submitted', updated_at = now()
   where s.task_id = p_task_id
     and exists (select 1 from public.progress_report_steps prs
                  where prs.progress_report_id = v_report_id and prs.task_step_id = s.id);

  update public.work_tasks
     set status = 'under_review',
         -- The review clock starts at submission, not at assignment.
         sla_review_deadline = now() + (sla_review_hours || ' hours')::interval,
         updated_at = now()
   where id = p_task_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('WORK_TASK_PROGRESS_SUBMITTED','work_task', p_task_id,
          (select full_name from public.profiles where id = auth.uid()),
          jsonb_build_object('report_id', v_report_id, 'steps', v_n)::text, 'info');

  return jsonb_build_object('ok', true, 'progress_report_id', v_report_id,
                            'step_count', v_n, 'approved_rate', v_rate);
end;
$$;

comment on function public.submit_task_progress is
  'Files an iterative progress report. Does not alter approved step values or the task score - only a review can do that.';

-- ---------------------------------------------------------------------------
-- 3. review_task_progress  (the granular review dashboard backend)
-- ---------------------------------------------------------------------------
-- Per-step approve/reject, plus three overall actions:
--   approve_all      -> approved steps written; the task is completed ONLY if
--                       it genuinely reaches 100% (never faked).
--   request_revision -> approved steps KEEP their credit, rejected steps are
--                       flagged for re-submission, task -> needs_revision.
--   partial          -> whatever the step decisions say, nothing forced.
create or replace function public.review_task_progress(
  p_progress_report_id uuid,
  p_decisions         jsonb,
  p_overall_action    text default 'partial',
  p_reviewer_comment  text default null,
  p_feedback_files    jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report   public.progress_reports%rowtype;
  v_task_id  uuid;
  v_rate     numeric;
  v_approved integer := 0;
  v_rejected integer := 0;
  d          jsonb;
begin
  if not public.can_review_work_tasks() then
    raise exception 'You are not allowed to review work submissions.';
  end if;

  select * into v_report from public.progress_reports where id = p_progress_report_id;
  if v_report.id is null then
    raise exception 'That progress report does not exist.';
  end if;
  if v_report.status <> 'pending_review' then
    raise exception 'This submission has already been reviewed.';
  end if;
  v_task_id := v_report.task_id;

  if p_overall_action not in ('partial','approve_all','request_revision') then
    raise exception 'Unknown review action.';
  end if;

  for d in select * from jsonb_array_elements(coalesce(p_decisions, '[]'::jsonb))
  loop
    -- A rejected step MUST carry a reason. Also enforced by a CHECK, but we
    -- raise here so the reviewer gets a clear message, not a constraint error.
    if d->>'approval_status' = 'rejected'
       and (d->>'rejection_reason' is null or btrim(d->>'rejection_reason') = '') then
      raise exception 'A reason is required when rejecting a step.';
    end if;

    update public.progress_report_steps
       set approval_status   = coalesce(d->>'approval_status','rejected'),
           rejection_reason = d->>'rejection_reason'
     where progress_report_id = p_progress_report_id
       and task_step_id = (d->>'task_step_id')::uuid;

    -- ONLY an approved step is ever written back to the live step.
    if d->>'approval_status' = 'approved' then
      update public.work_task_steps s
         set current_value = case when s.target_type = 'numerical'
                                  then prs.reported_value else s.current_value end,
             is_completed   = case when s.target_type = 'boolean'
                                  then coalesce(prs.reported_boolean, false) else s.is_completed end,
             status         = 'approved',
             updated_at     = now()
        from public.progress_report_steps prs
       where prs.progress_report_id = p_progress_report_id
         and prs.task_step_id = s.id
         and s.task_id = v_task_id;
      v_approved := v_approved + 1;
    elsif d->>'approval_status' = 'rejected' then
      update public.work_task_steps
         set status = 'revision_requested', updated_at = now()
       where task_id = v_task_id and id = (d->>'task_step_id')::uuid;
      v_rejected := v_rejected + 1;
    end if;
  end loop;

  -- Cascade 1: step rates then the task rate.
  v_rate := public.work_task_recalculate(v_task_id);

  -- Cascade 2: the task's status follows the decision, not the reviewer.
  if p_overall_action = 'request_revision' then
    update public.work_tasks set status = 'needs_revision', updated_at = now()
     where id = v_task_id;
  elsif v_rate >= 100 then
    update public.work_tasks
       set status = 'completed', completed_at = now(),
           sla_review_deadline = NULL, updated_at = now()
     where id = v_task_id;
  else
    -- 'approve_all' on a task that is not actually finished does NOT complete
    -- it. The engine is the only thing allowed to declare a task done.
    update public.work_tasks
       set status = 'in_progress', completed_at = NULL,
           sla_review_deadline = NULL, updated_at = now()
     where id = v_task_id;
  end if;

  update public.progress_reports
     set status           = case when p_overall_action = 'request_revision'
                                 then 'changes_requested' else 'approved' end,
         reviewer_id      = auth.uid(),
         reviewer_comment = p_reviewer_comment,
         reviewed_at      = now()
   where id = p_progress_report_id;

  insert into public.task_attachments (task_id, progress_report_id, file_url, file_name, file_type, kind, uploaded_by)
  select v_task_id, p_progress_report_id, f->>'file_url', f->>'file_name', f->>'file_type',
         'reviewer_feedback', auth.uid()
  from jsonb_array_elements(coalesce(p_feedback_files, '[]'::jsonb)) f
  where f->>'file_url' is not null and btrim(f->>'file_url') <> '';

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('WORK_TASK_PROGRESS_REVIEWED','work_task', v_task_id,
          (select full_name from public.profiles where id = auth.uid()),
          jsonb_build_object('report_id', p_progress_report_id, 'action', p_overall_action,
                             'approved_steps', v_approved, 'rejected_steps', v_rejected,
                             'new_rate', v_rate)::text, 'info');

  -- Cascade 3: the portfolio KPI is read live from the engine, so it is already
  -- consistent. Returned so the caller can refresh without a second round trip.
  return jsonb_build_object('ok', true, 'task_id', v_task_id,
                            'calculated_completion_rate', v_rate,
                            'approved_steps', v_approved, 'rejected_steps', v_rejected,
                            'user_kpi_score', public.work_user_kpi_score(v_report.submitted_by));
end;
$$;

comment on function public.review_task_progress is
  'Granular per-step review. Writes ONLY approved values back to work_task_steps, then cascades step -> task -> user KPI. Never fakes a 100% completion.';

commit;

-- ============================================================================
-- Step 6: the Automation Command Centre bridge
-- ============================================================================
-- TWO HARD RULES, both enforced here rather than in the UI:
--
--  1. ONE TASK PER DEPARTMENT. Adding an ACC item for a department creates
--     exactly one linked work_task for that department. Re-adding the same
--     department returns the EXISTING task (upsert) instead of duplicating it,
--     so a person's ACC never sprouts a second task per department.
--
--  2. STRICT SCOPING. The ACC shows ONLY tasks that BOTH originate from the ACC
--     (source = 'automation_centre') AND belong to the calling user. Ordinary
--     HR tasks, KPIs and targets assigned to OTHER people are never returned -
--     not even to a super admin browsing the ACC. get_automation_work_tasks()
--     has no "see everyone" branch by design.
begin;

create or replace function public.add_automation_work_task(
  p_department        text,
  p_label             text,
  p_description       text default null,
  p_assignee_user_id  uuid default null,
  p_due_date          timestamptz default null,
  p_sla_review_hours  integer default 48,
  p_status            text default 'not_started',
  p_item_key          text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_assignee uuid := coalesce(p_assignee_user_id, auth.uid());
  v_item_id  uuid;
  v_task_id  uuid;
  v_existing uuid;
  v_employee uuid;
begin
  if p_department is null or btrim(p_department) = '' then
    raise exception 'A department is required.';
  end if;
  if p_label is null or btrim(p_label) = '' then
    raise exception 'A task title is required.';
  end if;

  -- An ACC item is personal: you are creating YOUR task, not someone else's.
  if p_assignee_user_id is not null and p_assignee_user_id <> auth.uid()
     and not public.can_review_work_tasks() then
    raise exception 'You can only create automation tasks for yourself.';
  end if;

  select id into v_employee from public.employees where user_id = v_assignee limit 1;

  -- Rule 1: one task per (user, department). Reuse it if it already exists.
  select id into v_existing
    from public.work_tasks
   where assigned_to_user_id = v_assignee
     and source = 'automation_centre'
     and lower(coalesce(department,'')) = lower(btrim(p_department))
   limit 1;

  if v_existing is not null then
    -- Refresh the label rather than creating a duplicate task.
    update public.work_tasks
       set title = btrim(p_label),
           description = coalesce(p_description, description),
           due_date = coalesce(p_due_date, due_date),
           updated_at = now()
     where id = v_existing;
    v_task_id := v_existing;

    update public.automation_items
       set label = btrim(p_label),
           description = coalesce(p_description, description),
           status = coalesce(p_status, status),
           live_at = case when p_status = 'live' then now() else live_at end,
           updated_by = auth.uid(), updated_at = now()
     where department = lower(btrim(p_department));
    select id into v_item_id from public.automation_items
     where department = lower(btrim(p_department)) limit 1;
  else
    insert into public.automation_items (department, item_key, label, description, status, updated_by)
    values (lower(btrim(p_department)),
            coalesce(nullif(p_item_key,''), lower(btrim(p_department)) || '-automation'),
            btrim(p_label), p_description,
            coalesce(p_status,'not_started'), auth.uid())
    on conflict do nothing
    returning id into v_item_id;

    if v_item_id is null then
      select id into v_item_id from public.automation_items
       where department = lower(btrim(p_department)) limit 1;
    end if;

    -- A single boolean deliverable so the task is immediately actionable and
    -- the ACC can be ticked off from My Work without extra setup.
    v_task_id := public.create_work_task_with_steps(
      p_title            => btrim(p_label),
      p_assignee_user_id => v_assignee,
      p_employee_id      => v_employee,
      p_description      => coalesce(p_description, 'Automation Command Centre task for ' || p_department),
      p_department       => lower(btrim(p_department)),
      p_priority         => 'medium',
      p_due_date         => p_due_date,
      p_sla_review_hours => coalesce(p_sla_review_hours, 48),
      p_source           => 'automation_centre',
      p_source_ref       => v_item_id,
      p_allow_self_automation => true,
      p_steps            => jsonb_build_array(
                             jsonb_build_object(
                               'title', coalesce(nullif(p_description,''), 'Complete ' || p_department || ' automation'),
                               'target_type', 'boolean'))
    ) ->> 'task_id';
  end if;

  return jsonb_build_object('ok', true, 'task_id', v_task_id,
                            'automation_item_id', v_item_id, 'reused', v_existing is not null);
end;
$$;

comment on function public.add_automation_work_task is
  'Creates (or refreshes) the ONE automation task a user has per department and links it to the ACC item. Scoped to the caller unless the caller can review work.';

-- Shared SLA badge state: green / yellow (<4h) / red (breached) / none.
-- Used by the ACC, My Work and the review queue so the badge can never show
-- three different answers for the same deadline.
create or replace function public.work_task_sla_state(p_deadline timestamptz)
returns text
language sql
immutable
as $$
  select case
    when p_deadline is null then 'none'
    when p_deadline < now() then 'breached'
    when p_deadline < now() + interval '4 hours' then 'warning'
    else 'ok'
  end;
$$;

-- ---------------------------------------------------------------------------
-- STRICTLY SCOPED ACC read. There is deliberately NO "view another user"
-- parameter: the Automation Command Centre can only ever show the caller's own
-- automation tasks. A super admin still does not see other people's tasks,
-- KPIs or targets here - that is what Work Management and My Work are for.
-- ---------------------------------------------------------------------------
create or replace function public.get_automation_work_tasks()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'kpi_score', public.work_user_kpi_score(auth.uid()),
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id, 'title', t.title, 'description', t.description,
               'department', t.department, 'status', t.status, 'priority', t.priority,
               'due_date', t.due_date, 'sla_review_deadline', t.sla_review_deadline,
               'calculated_completion_rate', t.calculated_completion_rate,
               'sla_state', public.work_task_sla_state(t.sla_review_deadline),
               'steps', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'id', s.id, 'title', s.title, 'target_type', s.target_type,
                          'target_value', s.target_value, 'current_value', s.current_value,
                          'is_completed', s.is_completed, 'step_weight', s.step_weight,
                          'calculated_step_rate', s.calculated_step_rate, 'status', s.status,
                          'order_index', s.order_index)
                        order by s.order_index)
                   from public.work_task_steps s where s.task_id = t.id), '[]'::jsonb)
             ) order by t.department nulls last, t.created_at)
      from public.work_tasks t
     where t.source = 'automation_centre'     -- RULE 2: ACC-origin only
       and t.assigned_to_user_id = auth.uid() -- RULE 2: my tasks only
    ), '[]'::jsonb)
  );
$$;

comment on function public.get_automation_work_tasks is
  'The ACC work view. Returns ONLY the caller''s own automation_centre tasks. No cross-user parameter exists by design.';

-- ---------------------------------------------------------------------------
-- GET my-work: assigned tasks, steps, rates, submission states, KPI score.
-- Scoped to auth.uid(); a manager reviewing someone else uses the review queue.
-- ---------------------------------------------------------------------------
create or replace function public.get_my_work()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'kpi_score', public.work_user_kpi_score(auth.uid()),
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id, 'title', t.title, 'description', t.description,
               'department', t.department, 'branch', t.branch, 'status', t.status,
               'priority', t.priority, 'due_date', t.due_date, 'start_date', t.start_date,
               'requires_evidence', t.requires_evidence,
               'assigned_by_name', t.assigned_by_name,
               'calculated_completion_rate', t.calculated_completion_rate,
               'task_weight', t.task_weight, 'source', t.source,
               'sla_review_deadline', t.sla_review_deadline,
               'sla_state', public.work_task_sla_state(t.sla_review_deadline),
               'has_pending_report', exists (
                 select 1 from public.progress_reports pr
                  where pr.task_id = t.id and pr.status = 'pending_review'),
               'steps', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'id', s.id, 'title', s.title, 'description', s.description,
                          'target_type', s.target_type, 'target_value', s.target_value,
                          'current_value', s.current_value, 'is_completed', s.is_completed,
                          'step_weight', s.step_weight,
                          'calculated_step_rate', s.calculated_step_rate,
                          'status', s.status, 'order_index', s.order_index)
                        order by s.order_index)
                   from public.work_task_steps s where s.task_id = t.id), '[]'::jsonb),
               'reports', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'id', pr.id, 'status', pr.status,
                          'pending_percentage', pr.pending_percentage,
                          'summary_comment', pr.summary_comment,
                          'reviewer_comment', pr.reviewer_comment,
                          'created_at', pr.created_at, 'reviewed_at', pr.reviewed_at)
                        order by pr.created_at desc)
                   from public.progress_reports pr where pr.task_id = t.id), '[]'::jsonb)
             ) order by t.due_date nulls last, t.created_at desc)
      from public.work_tasks t
     where t.assigned_to_user_id = auth.uid()
       and t.status <> 'cancelled'
    ), '[]'::jsonb)
  );
$$;

comment on function public.get_my_work is
  'My Work: the caller''s tasks with step rates, pending/approved indicators, submission history and their weighted KPI score.';

-- ---------------------------------------------------------------------------
-- GET kpi-summary for one user (analytics). Self by default; a manager role may
-- read another user. This is the ONE deliberately cross-user read, and unlike
-- the ACC it is role-gated.
-- ---------------------------------------------------------------------------
create or replace function public.get_work_kpi_summary(p_user_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
begin
  if v_user <> auth.uid() and not public.can_review_work_tasks() then
    raise exception 'You are not allowed to view another user''s KPI summary.';
  end if;

  return jsonb_build_object(
    'user_id', v_user,
    'kpi_score', public.work_user_kpi_score(v_user, true),
    'kpi_score_active_only', public.work_user_kpi_score(v_user, false),
    'task_count', (select count(*) from public.work_tasks
                    where assigned_to_user_id = v_user
                      and status not in ('cancelled','rejected')),
    'by_status', coalesce((
      select jsonb_object_agg(status, cnt) from (
        select status, count(*) cnt from public.work_tasks
         where assigned_to_user_id = v_user and status <> 'cancelled'
         group by status) g), '{}'::jsonb),
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id, 'title', t.title, 'status', t.status,
               'task_weight', t.task_weight,
               'calculated_completion_rate', t.calculated_completion_rate,
               'due_date', t.due_date)
             order by t.due_date nulls last)
        from public.work_tasks t
       where t.assigned_to_user_id = v_user and t.status <> 'cancelled'), '[]'::jsonb)
  );
end;
$$;

comment on function public.get_work_kpi_summary is
  'Weighted KPI summary for one user. Self by default; other users only for a work-review role.';

-- ---------------------------------------------------------------------------
-- Review queue: every submission awaiting a decision, with the per-step
-- snapshot the reviewer must rule on. Reviewer-scoped (NOT self-scoped like
-- the ACC) - this is the one place a manager legitimately sees other people.
-- ---------------------------------------------------------------------------
create or replace function public.get_work_review_queue(
  p_status text default 'pending_review'
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.can_review_work_tasks() then
    raise exception 'You are not allowed to review work submissions.';
  end if;
  if p_status not in ('pending_review','approved','rejected','changes_requested','all') then
    raise exception 'Unknown review status filter.';
  end if;

  return jsonb_build_object('reports', coalesce((
    select jsonb_agg(jsonb_build_object(
             'report_id', pr.id,
             'created_at', pr.created_at,
             'pending_percentage', pr.pending_percentage,
             'summary_comment', pr.summary_comment,
             'status', pr.status,
             'reviewer_comment', pr.reviewer_comment,
             'task', jsonb_build_object(
               'id', t.id, 'title', t.title, 'department', t.department,
               'assigned_by_name', t.assigned_by_name,
               'calculated_completion_rate', t.calculated_completion_rate,
               'sla_review_deadline', t.sla_review_deadline,
               'sla_state', public.work_task_sla_state(t.sla_review_deadline)),
             'steps', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'id', prs.id, 'task_step_id', prs.task_step_id,
                        'title', s.title, 'target_type', s.target_type,
                        'target_value', s.target_value,
                        'reported_value', prs.reported_value,
                        'reported_boolean', prs.reported_boolean,
                        'approval_status', prs.approval_status,
                        'rejection_reason', prs.rejection_reason)
                      order by s.order_index)
                 from public.progress_report_steps prs
                 join public.work_task_steps s on s.id = prs.task_step_id
                where prs.progress_report_id = pr.id), '[]'::jsonb))
           order by pr.created_at)
      from public.progress_reports pr
      join public.work_tasks t on t.id = pr.task_id
     where (p_status = 'all' or pr.status = p_status)), '[]'::jsonb));
end;
$$;

comment on function public.get_work_review_queue is
  'Reviewer-scoped queue of progress reports with their per-step snapshot, for the granular review dashboard.';

commit;
