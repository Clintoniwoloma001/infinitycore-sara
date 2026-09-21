-- Phase 66/67 — Assessment analytics, Sara role-fit suggestions, and
-- deterministic question shuffling for the CBT pipeline.
--
-- Run in Supabase SQL Editor AFTER 20260921000002_assessment_template_antcheat_default.sql.
-- Idempotent / additive — safe to re-run.
--
-- Contents:
--   1. assessment_suggestions  — audit trail of Sara advisory suggestions
--      (role-fit / analysis). HR selects via RLS; writes only happen through
--      the sara-candidate-analysis edge function (service role, bypasses RLS).
--   2. hr_list_assessment_completions()          — Assessor Reports data.
--   3. hr_list_assessment_suggestions(...)       — suggestion history.
--   4. hr_act_on_assessment_suggestion(...)      — Apply / Dismiss a suggestion.
--   5. hr_reassign_candidate_role(...)           — apply a role-fit suggestion.
--   6. assessment_attempts.shuffle_seed column   — per-attempt shuffle seed.
--   7. public_start_assessment_attempt recreated — deterministic question AND
--      option shuffling (honours template.shuffle_questions and
--      anti_cheat->>'shuffle_options'), plus restores saved answers on resume.
--   8. anti_cheat key backfill — normalise the new keys
--      (require_fullscreen / track_focus_changes / shuffle_options) onto
--      existing templates and fold them into the column DEFAULT.

-- ============================================================
-- 1. ASSESSMENT SUGGESTIONS
-- ============================================================
create table if not exists public.assessment_suggestions (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references public.hr_candidates(id) on delete cascade,
  attempt_id uuid references public.assessment_attempts(id) on delete cascade,
  kind text not null default 'analysis' check (kind in ('role_fit', 'analysis')),
  suggested_job_id uuid references public.hr_jobs(id) on delete set null,
  suggested_role text,
  title text not null,
  summary text,
  rationale text,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'applied', 'dismissed')),
  source text not null default 'sara',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  resolution_note text
);
alter table public.assessment_suggestions enable row level security;
create index if not exists idx_assessment_suggestions_candidate on public.assessment_suggestions(candidate_id);
create index if not exists idx_assessment_suggestions_status on public.assessment_suggestions(status, created_at);

-- HR reads only. Writes are performed by the edge function's service role
-- (bypasses RLS) and by the SECURITY DEFINER RPCs below.
drop policy if exists "assessment_suggestions_hr_select" on public.assessment_suggestions;
create policy "assessment_suggestions_hr_select" on public.assessment_suggestions
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

-- ============================================================
-- 2. HR RPCs
-- ============================================================

-- Assessor Reports / completion breakdown. One row per submitted attempt with
-- candidate, applied role, template, dates, percentage, pass/fail, flags and
-- a percentage comparison against the same template and same applied role.
create or replace function public.hr_list_assessment_completions()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_rows jsonb;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized';
  end if;

  select coalesce(jsonb_agg(row_json order by (row_json ->> 'submitted_at') desc), '[]'::jsonb)
    into v_rows
  from (
    select jsonb_build_object(
      'attempt_id', at.id,
      'attempt_number', at.attempt_number,
      'status', at.status,
      'percentage', at.percentage,
      'max_score', at.max_score,
      'score', at.score,
      'passed', at.passed,
      'flagged', at.flagged,
      'flags_count', at.flags_count,
      'started_at', at.started_at,
      'submitted_at', at.submitted_at,
      'completed_at', at.completed_at,
      'time_taken_seconds', case
        when at.submitted_at is not null and at.started_at is not null
        then greatest(0, extract(epoch from (at.submitted_at - at.started_at)))::int
        else null end,
      'review_status', at.review_status,
      'candidate', jsonb_build_object(
        'candidate_id', c.id,
        'full_name', c.full_name,
        'email', c.email,
        'applied_role', c.applied_role,
        'application_status', c.application_status
      ),
      'assignment', jsonb_build_object(
        'assignment_id', a.id,
        'status', a.status,
        'invited_at', a.created_at,
        'test_name', a.test_name
      ),
      'template', jsonb_build_object(
        'template_id', t.id,
        'title', t.title,
        'category', t.category,
        'pass_mark', t.pass_mark,
        'duration_minutes', t.duration_minutes,
        'shuffle_questions', t.shuffle_questions
      ),
      'job', case when j.id is not null then jsonb_build_object(
        'job_id', j.id,
        'job_title', j.job_title,
        'department', j.department,
        'role_category', j.role_category
      ) else null end,
      'stats', jsonb_build_object(
        'template_average_percentage', tv.template_avg,
        'role_average_percentage', rv.role_avg
      )
    ) as row_json
    from public.assessment_attempts at
    left join public.hr_assessments a on a.id = at.assignment_id
    left join public.assessment_templates t on t.id = a.template_id
    left join public.hr_candidates c on c.id = at.candidate_id
    left join public.hr_jobs j on j.id = coalesce(at.job_id, a.job_id, c.job_id)
    left join lateral (
      select round(avg(x.percentage), 2) as template_avg
      from public.assessment_attempts x
      join public.hr_assessments xa on xa.id = x.assignment_id
      where xa.template_id = a.template_id
        and x.percentage is not null
        and x.status in ('submitted', 'auto_submitted', 'flagged')
    ) tv on true
    left join lateral (
      select round(avg(x.percentage), 2) as role_avg
      from public.assessment_attempts x
      left join public.hr_assessments xa on xa.id = x.assignment_id
      left join public.hr_candidates xc on xc.id = x.candidate_id
      where coalesce(x.job_id, xa.job_id, xc.job_id) = coalesce(at.job_id, a.job_id, c.job_id)
        and x.percentage is not null
        and x.status in ('submitted', 'auto_submitted', 'flagged')
    ) rv on true
    where at.status in ('submitted', 'auto_submitted', 'flagged')
      and at.percentage is not null
  ) sub;

  return v_rows;
end; $$;
grant execute on function public.hr_list_assessment_completions() to authenticated;

-- Suggestion history for a candidate (optional filter).
create or replace function public.hr_list_assessment_suggestions(p_candidate_id uuid default null)
returns setof public.assessment_suggestions
language sql stable security definer set search_path = public as $$
  select * from public.assessment_suggestions
  where (p_candidate_id is null or candidate_id = p_candidate_id)
  order by created_at desc;
$$;
grant execute on function public.hr_list_assessment_suggestions(uuid) to authenticated;

-- Mark a suggestion Apply / Dismissed (advisory advice stays logged forever).
create or replace function public.hr_act_on_assessment_suggestion(
  p_suggestion_id uuid,
  p_action text,
  p_note text default null
) returns public.assessment_suggestions
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_row public.assessment_suggestions;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized';
  end if;
  if p_action not in ('applied', 'dismissed') then
    raise exception 'Invalid action';
  end if;
  update public.assessment_suggestions
     set status = p_action,
         resolved_at = now(),
         resolved_by = auth.uid(),
         resolution_note = coalesce(p_note, resolution_note)
   where id = p_suggestion_id
  returning * into v_row;
  if v_row.id is null then
    raise exception 'Suggestion not found';
  end if;
  perform public.hr_audit('ASSESSMENT_SUGGESTION_' || upper(p_action), 'AssessmentSuggestion',
    p_suggestion_id::text, format('Sara suggestion %s', p_action));
  return v_row;
end; $$;
grant execute on function public.hr_act_on_assessment_suggestion(uuid, text, text) to authenticated;

-- Apply a role-fit suggestion: safely re-point the candidate's role.
create or replace function public.hr_reassign_candidate_role(
  p_candidate_id uuid,
  p_job_id uuid default null,
  p_applied_role text default null,
  p_note text default null,
  p_suggestion_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_row public.hr_candidates;
  v_job public.hr_jobs;
  v_old_job uuid;
  v_old_role text;
  v_job_title text;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized';
  end if;

  select * into v_row from public.hr_candidates where id = p_candidate_id;
  if v_row.id is null then
    raise exception 'Candidate not found';
  end if;
  v_old_job := v_row.job_id;
  v_old_role := v_row.applied_role;

  if p_job_id is not null and p_job_id <> v_old_job then
    select * into v_job from public.hr_jobs where id = p_job_id;
    if v_job.id is null then
      raise exception 'Job not found';
    end if;
    v_job_title := v_job.job_title;
  end if;

  if p_job_id is null and p_applied_role is null then
    raise exception 'Nothing to change';
  end if;

  update public.hr_candidates
     set job_id = coalesce(p_job_id, job_id),
         applied_role = coalesce(nullif(p_applied_role, ''), applied_role),
         status_change_note = coalesce(p_note, status_change_note)
   where id = p_candidate_id
  returning * into v_row;

  perform public.hr_audit('CANDIDATE_ROLE_REASSIGNED', 'Candidate', p_candidate_id::text,
    format('Role: "%s" -> "%s"', coalesce(v_old_role, coalesce(v_old_job::text, 'none')),
           coalesce(v_job_title, p_applied_role, coalesce(v_old_role, '—'))));

  if p_suggestion_id is not null then
    update public.assessment_suggestions
       set status = 'applied', resolved_at = now(), resolved_by = auth.uid(),
           resolution_note = coalesce(p_note, 'Role-fit suggestion applied')
     where id = p_suggestion_id;
  end if;

  return jsonb_build_object('ok', true, 'candidate', to_jsonb(v_row));
end; $$;
grant execute on function public.hr_reassign_candidate_role(uuid, uuid, text, text, uuid) to authenticated;

-- ============================================================
-- 6/7. SHUFFLE SEED + PUBLIC START ATTEMPT (with shuffle + resume answers)
-- ============================================================
alter table public.assessment_attempts
  add column if not exists shuffle_seed bigint;

-- Recreated: honours template.shuffle_questions (question order) and
-- anti_cheat->>'shuffle_options' (option order within choice questions). The
-- per-attempt seed is random once and reused for every resume, so a
-- candidate who reloads sees the same ordering. Question/option ordering is a
-- deterministic md5() sort — no hex<->bit casts, works on all Postgres.
create or replace function public.public_start_assessment_attempt(p_token text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_assignment public.hr_assessments;
  v_template public.assessment_templates;
  v_attempt public.assessment_attempts;
  v_tpl jsonb;
  v_max_flags int;
  v_questions jsonb;
  v_answers jsonb;
  v_resume uuid;
  v_seed bigint;
  v_shuffle_questions boolean := false;
  v_shuffle_options boolean := false;
  v_total_marks numeric := 0;
begin
  select * into v_assignment from public.hr_assessments
  where invitation_token_hash = md5(p_token);
  if v_assignment.id is null then
    raise exception 'Invalid assessment invitation';
  end if;
  if v_assignment.status in ('completed', 'cancelled', 'expired') then
    raise exception 'This assessment is no longer open';
  end if;
  if v_assignment.expires_at is not null and v_assignment.expires_at < now() then
    update public.hr_assessments set status = 'expired' where id = v_assignment.id;
    raise exception 'This assessment invitation has expired';
  end if;

  select * into v_template from public.assessment_templates where id = v_assignment.template_id;
  if v_template.id is null or v_template.status <> 'published' then
    raise exception 'Assessment is not published';
  end if;

  -- Resume an in-flight attempt if one exists.
  select id into v_resume from public.assessment_attempts
  where assignment_id = v_assignment.id and status in ('started', 'in_progress')
  order by attempt_number desc limit 1;
  if v_resume is not null then
    select * into v_attempt from public.assessment_attempts where id = v_resume;
  else
    v_tpl := v_template.anti_cheat;
    v_max_flags := coalesce((v_tpl ->> 'max_flags')::int, 3);
    -- Enforce retake limit
    if v_assignment.attempt_count >= 1 + coalesce(v_assignment.retake_limit, 0) then
      raise exception 'Assessment retake limit reached';
    end if;

    v_seed := floor(random() * 4611686018427387904)::bigint + 1; -- ~2^62

    insert into public.assessment_attempts
      (assignment_id, candidate_id, job_id, attempt_number, status, shuffle_seed)
    values (
      v_assignment.id, v_assignment.candidate_id, v_assignment.job_id,
      coalesce(v_assignment.attempt_count, 0) + 1, 'in_progress', v_seed
    ) returning * into v_attempt;

    update public.hr_assessments
      set status = 'in_progress', started_at = coalesce(started_at, now()),
          attempt_count = attempt_count + 1, updated_at = now()
      where id = v_assignment.id;

    insert into public.assessment_monitoring_events
      (attempt_id, assessment_id, candidate_id, event_type, severity, sequence_number, event_data)
    values (v_attempt.id, v_assignment.id, v_assignment.candidate_id, 'attempt_started', 'low', 1,
            jsonb_build_object('attempt_number', v_attempt.attempt_number));

    -- Move the candidate into the assessment pipeline stage (only forward).
    if v_assignment.candidate_id is not null then
      update public.hr_candidates
      set application_status = 'assessment',
          status_change_note = 'Assessment attempt started'
      where id = v_assignment.candidate_id
        and application_status in ('received', 'screening', 'shortlisted');
    end if;
  end if;

  v_seed := coalesce(v_attempt.shuffle_seed, 1);
  v_shuffle_questions := coalesce(v_template.shuffle_questions, false);
  v_shuffle_options := coalesce((v_template.anti_cheat ->> 'shuffle_options')::boolean, false);

  select coalesce(jsonb_agg(q_json order by sort_key, created_at), '[]'::jsonb)
    into v_questions
  from (
    select q.id,
           q.created_at,
           case when v_shuffle_questions
                then md5(q.id::text || v_seed::text)
                else lpad(q.display_order::text, 20, '0') || '-' || q.id::text
           end as sort_key,
           jsonb_build_object(
             'id', q.id,
             'question_text', q.question_text,
             'question_type', q.question_type,
             'options', case
               when v_shuffle_options and q.question_type in ('multiple_choice', 'multiple_select')
               then (select jsonb_agg(o.value order by md5(o.value::text || v_seed::text))
                     from jsonb_array_elements(coalesce(q.options, '[]'::jsonb)) o)
               else coalesce(q.options, '[]'::jsonb)
             end,
             'marks', q.marks,
             'difficulty', q.difficulty,
             'competency', q.competency,
             'display_order', q.display_order
           ) as q_json
    from public.assessment_template_questions q
    where q.template_id = v_template.id
  ) sub
  order by sort_key, created_at;

  select coalesce(jsonb_agg(jsonb_build_object('question_id', an.question_id, 'answer', an.answer)
                            order by an.question_id), '[]'::jsonb)
    into v_answers
  from public.assessment_attempt_answers an
  where an.attempt_id = v_attempt.id and an.answer is not null;

  select coalesce(sum(q.marks), 0) into v_total_marks
  from public.assessment_template_questions q where q.template_id = v_template.id;

  return jsonb_build_object(
    'attempt', to_jsonb(v_attempt),
    'assignment', to_jsonb(v_assignment),
    'template', jsonb_build_object(
      'title', v_template.title, 'description', v_template.description,
      'instructions', v_template.instructions, 'duration_minutes', v_template.duration_minutes,
      'pass_mark', v_template.pass_mark, 'shuffle_questions', v_template.shuffle_questions,
      'randomization', v_template.randomization, 'anti_cheat', v_template.anti_cheat,
      'max_marks', v_total_marks
    ),
    'questions', v_questions,
    'answers', v_answers,
    'resumed', (v_resume is not null)
  );
end; $$;
grant execute on function public.public_start_assessment_attempt(text) to anon, authenticated;

-- ============================================================
-- 8. ANTI-CHEAT KEY BACKFILL (normalise new keys on existing templates)
-- ============================================================
do $$
declare
  v_row record;
  v_new jsonb;
begin
  for v_row in
    select id, anti_cheat from public.assessment_templates
  loop
    v_new := v_row.anti_cheat;
    if v_new is null then
      v_new := '{}'::jsonb;
    end if;
    if not v_new ? 'require_fullscreen' then
      v_new := v_new || jsonb_build_object('require_fullscreen',
        coalesce((v_new ->> 'track_fullscreen')::boolean, true));
    end if;
    if not v_new ? 'track_focus_changes' then
      v_new := v_new || jsonb_build_object('track_focus_changes',
        coalesce((v_new ->> 'track_focus_changes')::boolean, true));
    end if;
    if not v_new ? 'shuffle_options' then
      v_new := v_new || jsonb_build_object('shuffle_options',
        coalesce((v_new ->> 'shuffle_options')::boolean, false));
    end if;
    update public.assessment_templates set anti_cheat = v_new where id = v_row.id;
  end loop;

  alter table public.assessment_templates
    alter column anti_cheat set default
    '{"max_flags":3,"flag_severity":"high","close_on_flag":true,"require_hr_review":false,"retake_limit":0,"retake_time_hours":48,"keep_previous_attempt":true,"track_copy_paste":true,"track_context_menu":true,"track_fullscreen":true,"require_fullscreen":true,"track_focus_changes":true,"shuffle_options":false,"inactivity_timeout_minutes":10}'::jsonb;
end;
$$;