-- ============================================================
-- PHASE 59 - TRAINING ATTENDANCE / COMPLETION LINK
--
-- Additive and idempotent. Run after PHASE 58.
--
-- Reuses the existing training lifecycle (participants, question
-- sets, assessments, signatures, attendance, employee training
-- records, certificates, audit_logs). Adds a public attendance
-- link for each session:
--
--   /training-attendance/<secure-token>
--
-- The link is opened without a login. The attendee enters their
-- Employee ID, is resolved server-side, answers THREE questions
-- from their *assigned* KSS question set (server-side grading),
-- signs on a signature pad, and the completion is committed
-- idempotently (record + attendance + certificate).
--
-- Security model:
--   * The token is 48 hex chars from gen_random_bytes (not a UUID,
--     not a sequence, not an internal training id).
--   * Public RPCs are SECURITY DEFINER and return only the minimum
--     required to complete THIS training. No employee profile data,
--     no correct answers, no scores before submission.
--   * Signatures are stored under training-attendance/<token-hash>/
--     and are excluded from the generic documents read policy.
--   * Eligibility + idempotency are enforced entirely server-side.
-- ============================================================

-- ------------------------------------------------------------
-- 1. SESSION ATTENDANCE LINK COLUMNS
-- ------------------------------------------------------------
alter table public.training_sessions add column if not exists attendance_token text;
alter table public.training_sessions add column if not exists attendance_link_enabled boolean not null default false;
alter table public.training_sessions add column if not exists attendance_link_created_at timestamptz;
alter table public.training_sessions add column if not exists attendance_link_created_by uuid references auth.users(id) on delete set null;
alter table public.training_sessions add column if not exists attendance_link_regenerated_at timestamptz;

create unique index if not exists idx_training_sessions_attendance_token on public.training_sessions(attendance_token);

-- ------------------------------------------------------------
-- 2. SERVER-SIDE HELPERS (never exposed to anon directly)
-- ------------------------------------------------------------
-- Resolves the session for a valid, enabled attendance token.
create or replace function public.training_attendance_session(p_token text)
returns public.training_sessions
language plpgsql security definer stable set search_path = public as $$
declare
  v public.training_sessions%rowtype;
begin
  if nullif(trim(p_token), '') is null then return v; end if;
  select * into v from public.training_sessions
   where attendance_token = trim(p_token)
     and coalesce(attendance_link_enabled, false);
  return v;
end;
$$;
revoke all on function public.training_attendance_session(text) from public;

-- Resolves the active, eligible employee by their business identifier.
-- Employee ID / staff ID / employee code are case-insensitive. Returns
-- NULL when no record matches. More than one match is rejected (never
-- auto-link ambiguous records).
create or replace function public.training_attendance_employee(
  p_employee_id text
) returns public.employees
language plpgsql security definer stable set search_path = public as $$
declare
  v_query text := upper(trim(coalesce(nullif(p_employee_id, ''), '')));
  v_count bigint;
  v public.employees%rowtype;
begin
  if v_query = '' then return v; end if;
  select count(*) into v_count
    from public.employees e
   where coalesce(e.is_archived, false) = false
     and coalesce(e.employment_status, 'active') <> 'terminated'
     and (
       upper(trim(coalesce(e.employee_number, ''))) = v_query
       or upper(trim(coalesce(e.staff_id, ''))) = v_query
       or upper(trim(coalesce(e.employee_code, ''))) = v_query
     );
  if v_count is null or v_count = 0 or v_count > 1 then return v; end if;
  select e.* into v
    from public.employees e
   where coalesce(e.is_archived, false) = false
     and coalesce(e.employment_status, 'active') <> 'terminated'
     and (
       upper(trim(coalesce(e.employee_number, ''))) = v_query
       or upper(trim(coalesce(e.staff_id, ''))) = v_query
       or upper(trim(coalesce(e.employee_code, ''))) = v_query
     )
   limit 1;
  return v;
end;
$$;
revoke all on function public.training_attendance_employee(text) from public;

-- Shared validation for the public flow. Raises a generic error when the
-- token/employee/eligibility checks fail and returns the three resolved IDs
-- as scalars (PL/pgSQL forbids record variables in multi-item INTO lists).
create or replace function public.training_attendance_verify(
  p_token text,
  p_employee_id text,
  out v_session_id uuid,
  out v_employee_id uuid,
  out v_participant_id uuid
)
language plpgsql security definer set search_path = public as $$
declare
  v_session public.training_sessions%rowtype;
  v_employee public.employees%rowtype;
  v_participant public.training_participants%rowtype;
begin
  select * into v_session from public.training_attendance_session(p_token);
  if v_session.id is null then
    raise exception 'This training attendance link is invalid or has been disabled.';
  end if;
  if v_session.status = 'cancelled' then
    raise exception 'This training session has been cancelled.';
  end if;
  select * into v_employee from public.training_attendance_employee(p_employee_id);
  if v_employee.id is null then
    raise exception 'The Employee ID could not be verified for this training.';
  end if;
  select * into v_participant
    from public.training_participants
   where session_id = v_session.id and employee_id = v_employee.id;
  if v_participant.id is null then
    raise exception 'You are not assigned to this training session.';
  end if;
  v_session_id := v_session.id;
  v_employee_id := v_employee.id;
  v_participant_id := v_participant.id;
end;
$$;
revoke all on function public.training_attendance_verify(text, text) from public;

-- Query the deterministic THREE-question subset used for the public
-- attendance assessment (same selection as the grading RPC).
create or replace function public.training_attendance_questions(p_question_set_id uuid)
returns jsonb
language sql security definer stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', q.id, 'prompt', q.prompt, 'question_type', q.question_type,
    'options', q.options, 'marks', q.marks, 'display_order', q.display_order
  ) order by q.display_order, q.id), '[]'::jsonb)
  from (
    select * from public.training_questions q
     where q.question_set_id = p_question_set_id
     order by q.display_order, q.id
     limit 3
  ) q;
$$;
revoke all on function public.training_attendance_questions(uuid) from public;

-- ------------------------------------------------------------
-- 3. HR: GENERATE / REGENERATE THE ATTENDANCE LINK
-- ------------------------------------------------------------
create or replace function public.generate_training_attendance_link(
  p_session_id uuid,
  p_regenerate boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_session public.training_sessions%rowtype;
  v_token text;
begin
  if not public.training_is_hr() then raise exception 'Not authorized to manage training attendance links.'; end if;
  select * into v_session from public.training_sessions where id = p_session_id;
  if not found then raise exception 'Training session not found.'; end if;

  if coalesce(p_regenerate, false) then
    v_token := encode(gen_random_bytes(24), 'hex');
    update public.training_sessions
       set attendance_token = v_token,
           attendance_link_enabled = true,
           attendance_link_created_at = coalesce(attendance_link_created_at, now()),
           attendance_link_created_by = coalesce(attendance_link_created_by, auth.uid()),
           attendance_link_regenerated_at = now(),
           updated_by = auth.uid()
     where id = p_session_id;
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values ('TRAINING_ATTENDANCE_LINK_REGENERATED', 'TrainingSession', p_session_id::text,
      coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
      'A new secure attendance link was generated for this training.', 'info');
    return jsonb_build_object('ok', true, 'token', v_token, 'regenerated', true,
      'created_at', now());
  end if;

  if nullif(trim(coalesce(v_session.attendance_token, '')), '') is not null then
    -- Idempotent: reuse the existing link unless regenerating.
    return jsonb_build_object('ok', true, 'token', v_session.attendance_token,
      'regenerated', false, 'created_at', v_session.attendance_link_created_at);
  end if;

  v_token := encode(gen_random_bytes(24), 'hex');
  update public.training_sessions
     set attendance_token = v_token,
         attendance_link_enabled = true,
         attendance_link_created_at = now(),
         attendance_link_created_by = auth.uid(),
         updated_by = auth.uid()
   where id = p_session_id;
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('TRAINING_ATTENDANCE_LINK_GENERATED', 'TrainingSession', p_session_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    'A secure attendance link was generated for this training.', 'info');
  return jsonb_build_object('ok', true, 'token', v_token, 'regenerated', false,
    'created_at', now());
end;
$$;
grant execute on function public.generate_training_attendance_link(uuid, boolean) to authenticated;

-- ------------------------------------------------------------
-- 4. HR: SESSION COMPLETION READ MODELS
-- ------------------------------------------------------------
create or replace function public.get_training_session_completion(p_session_id uuid)
returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare
  v_rows jsonb;
  v_summary jsonb;
begin
  if not public.training_is_manager() then raise exception 'Not authorized to view training completion.'; end if;
  if not exists (select 1 from public.training_sessions where id = p_session_id) then
    raise exception 'Training session not found.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'participant_id', tp.id,
    'employee_id', tp.employee_id,
    'full_name', e.full_name,
    'employee_number', coalesce(e.employee_number, e.staff_id, e.employee_code),
    'department', e.department,
    'branch', coalesce(b.branch_name, e.branch),
    'question_set_number', qs.set_number,
    'participant_status', tp.status,
    'opened_at', tp.opened_at,
    'submitted_at', tp.submitted_at,
    'completed_at', tp.completed_at,
    'assessment_status', ta.status,
    'score', ta.score,
    'max_score', ta.max_score,
    'percentage', ta.percentage,
    'passed', ta.passed,
    'completion_status', r.completion_status,
    'signature_submitted', s.id is not null,
    'certificate_id', c.id,
    'certificate_number', c.certificate_number
  ) order by tp.created_at, tp.id), '[]'::jsonb)
  into v_rows
  from public.training_participants tp
  join public.employees e on e.id = tp.employee_id
  left join public.branches b on b.id = e.branch_id
  left join public.training_question_sets qs on qs.id = tp.question_set_id
  left join public.training_assessments ta on ta.participant_id = tp.id
  left join public.employee_training_records r on r.participant_id = tp.id
  left join public.training_signatures s on s.participant_id = tp.id
  left join public.training_certificates c on c.employee_training_record_id = r.id
  where tp.session_id = p_session_id;

  select jsonb_build_object(
    'assigned', jsonb_array_length(coalesce(v_rows, '[]'::jsonb)),
    'started', (select count(*) from public.training_participants tp where tp.session_id = p_session_id and tp.status in ('in_progress', 'completed', 'failed')),
    'in_progress', (select count(*) from public.training_participants tp where tp.session_id = p_session_id and tp.status = 'in_progress'),
    'completed', (select count(*) from public.training_participants tp where tp.session_id = p_session_id and tp.status = 'completed'),
    'passed', (select count(*) from public.training_assessments ta join public.training_participants tp on tp.id = ta.participant_id where tp.session_id = p_session_id and coalesce(ta.passed, false)),
    'failed', (select count(*) from public.training_participants tp where tp.session_id = p_session_id and tp.status = 'failed'),
    'pending', (select count(*) from public.training_participants tp where tp.session_id = p_session_id and tp.status not in ('completed', 'failed', 'withdrawn', 'absent')),
    'certificates', (select count(*) from public.training_certificates c join public.employee_training_records r on r.id = c.employee_training_record_id where r.session_id = p_session_id)
  ) into v_summary;

  return jsonb_build_object('summary', v_summary, 'participants', v_rows);
end;
$$;
grant execute on function public.get_training_session_completion(uuid) to authenticated;

-- ------------------------------------------------------------
-- 5. PUBLIC RPCs (attendance link flow)
-- ------------------------------------------------------------
-- Public session context shown on the attendance page.
create or replace function public.get_training_attendance_context(p_token text)
returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare
  v_session public.training_sessions%rowtype;
begin
  select * into v_session from public.training_attendance_session(p_token);
  if v_session.id is null then raise exception 'This training attendance link is invalid or has been disabled.'; end if;
  if v_session.status = 'cancelled' then raise exception 'This training session has been cancelled.'; end if;
  return jsonb_build_object(
    'session_id', v_session.id,
    'title', v_session.title,
    'training_type', v_session.training_type,
    'description', v_session.description,
    'facilitator', v_session.facilitator,
    'training_date', v_session.training_date,
    'start_time', v_session.start_time,
    'end_time', v_session.end_time,
    'duration_minutes', v_session.duration_minutes,
    'delivery_type', v_session.delivery_type,
    'venue_label', coalesce(v_session.venue_name, v_session.location),
    'meeting_platform', v_session.meeting_platform,
    'assessment_required', v_session.assessment_required,
    'certificate_enabled', v_session.certificate_enabled
  );
end;
$$;
grant execute on function public.get_training_attendance_context(text) to anon, authenticated;

-- Resolve the attendee from their Employee ID.
create or replace function public.resolve_training_attendance_employee(
  p_token text,
  p_employee_id text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_session public.training_sessions%rowtype;
  v_employee public.employees%rowtype;
  v_participant public.training_participants%rowtype;
  v_session_id uuid;
  v_employee_id uuid;
  v_participant_id uuid;
  v_record public.employee_training_records%rowtype;
  v_certificate public.training_certificates%rowtype;
  v_employee_identifier text;
  v_masked text;
begin
  select * into v_session_id, v_employee_id, v_participant_id
    from public.training_attendance_verify(p_token, p_employee_id);
  select * into v_session from public.training_sessions where id = v_session_id;
  select * into v_employee from public.employees where id = v_employee_id;
  select * into v_participant from public.training_participants where id = v_participant_id;

  select coalesce(employee_number, staff_id, employee_code)
    into v_employee_identifier from public.employees where id = v_employee.id;

  -- Masked confirmation name ("John D.") so the right person can confirm
  -- while minimal information is exposed.
  v_masked := case
    when position(' ' in coalesce(v_employee.full_name, '')) > 0
      then split_part(v_employee.full_name, ' ', 1) || ' ' || left(split_part(v_employee.full_name, ' ', -1), 1) || '.'
    else coalesce(v_employee.full_name, 'Employee')
  end;

  if v_participant.status in ('completed', 'failed', 'withdrawn') then
    select * into v_record from public.employee_training_records where participant_id = v_participant.id;
    select * into v_certificate from public.training_certificates where employee_training_record_id = v_record.id;
    return jsonb_build_object(
      'valid', false, 'already_completed', true,
      'status', v_participant.status,
      'name_masked', v_masked,
      'employee_id', v_employee_identifier,
      'completion_status', v_record.completion_status,
      'completed_at', v_record.completed_at,
      'certificate', case when v_certificate.id is null then null else jsonb_build_object(
        'id', v_certificate.id, 'certificate_number', v_certificate.certificate_number
      ) end
    );
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('TRAINING_ATTENDANCE_EMPLOYEE_IDENTIFIED', 'TrainingSession', v_session.id::text,
    'training-attendance', 'Employee identified by ID for public attendance flow.', 'info');

  return jsonb_build_object(
    'valid', true, 'already_completed', false,
    'name_masked', v_masked,
    'employee_id', v_employee_identifier,
    'participant_id', v_participant.id,
    'question_set_number', (select set_number from public.training_question_sets where id = v_participant.question_set_id),
    'assessment_required', v_session.assessment_required
  );
end;
$$;
grant execute on function public.resolve_training_attendance_employee(text, text) to anon, authenticated;

-- Load the attendee's THREE assigned questions (no correct answers).
create or replace function public.load_training_attendance_questions(
  p_token text,
  p_employee_id text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_session public.training_sessions%rowtype;
  v_employee public.employees%rowtype;
  v_participant public.training_participants%rowtype;
  v_session_id uuid;
  v_employee_id uuid;
  v_participant_id uuid;
  v_questions jsonb;
begin
  select * into v_session_id, v_employee_id, v_participant_id
    from public.training_attendance_verify(p_token, p_employee_id);
  select * into v_session from public.training_sessions where id = v_session_id;
  select * into v_employee from public.employees where id = v_employee_id;
  select * into v_participant from public.training_participants where id = v_participant_id;

  if v_participant.status in ('completed', 'failed', 'withdrawn') then
    raise exception 'This training record has already been submitted.';
  end if;
  if not v_session.assessment_required then
    return jsonb_build_object('assessment_required', false, 'questions', '[]'::jsonb);
  end if;

  v_questions := public.training_attendance_questions(v_participant.question_set_id);

  update public.training_participants
     set status = case when status = 'assigned' then 'in_progress' else status end,
         opened_at = coalesce(opened_at, now())
   where id = v_participant.id;
  update public.training_assessments set status = 'in_progress'
   where participant_id = v_participant.id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('TRAINING_ATTENDANCE_ASSESSMENT_STARTED', 'TrainingParticipant', v_participant.id::text,
    'training-attendance', 'Public attendance assessment started.', 'info');

  return jsonb_build_object(
    'assessment_required', true, 'questions', v_questions,
    'question_set_number', (select set_number from public.training_question_sets where id = v_participant.question_set_id)
  );
end;
$$;
grant execute on function public.load_training_attendance_questions(text, text) to anon, authenticated;

-- Grade the THREE answers server-side. Returns passed/score only.
create or replace function public.submit_training_attendance_quiz(
  p_token text,
  p_employee_id text,
  p_answers jsonb default '[]'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_session public.training_sessions%rowtype;
  v_employee public.employees%rowtype;
  v_participant public.training_participants%rowtype;
  v_session_id uuid;
  v_employee_id uuid;
  v_participant_id uuid;
  v_assessment public.training_assessments%rowtype;
  v_question public.training_questions%rowtype;
  v_item jsonb;
  v_answer jsonb;
  v_correct boolean;
  v_score numeric := 0;
  v_max numeric := 0;
  v_percentage numeric;
  v_passed boolean := true;
begin
  select * into v_session_id, v_employee_id, v_participant_id
    from public.training_attendance_verify(p_token, p_employee_id);
  select * into v_session from public.training_sessions where id = v_session_id;
  select * into v_employee from public.employees where id = v_employee_id;
  select * into v_participant from public.training_participants where id = v_participant_id;

  if v_participant.status in ('completed', 'failed', 'withdrawn') then
    raise exception 'This training record has already been submitted.';
  end if;

  if not v_session.assessment_required then
    return jsonb_build_object('passed', true, 'score', null, 'max_score', null, 'percentage', null);
  end if;

  select * into v_assessment
    from public.training_assessments where participant_id = v_participant.id for update;
  if v_assessment.id is null then raise exception 'Assessment was not assigned.'; end if;

  for v_question in select q.* from public.training_questions q
    where q.question_set_id = v_participant.question_set_id
    order by q.display_order, q.id limit 3 loop
    v_max := v_max + v_question.marks;
    select item into v_item from jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) item
     where item ->> 'question_id' = v_question.id::text limit 1;
    v_answer := case when v_item is null then null else v_item -> 'answer' end;
    v_correct := case
      when v_answer is null then false
      when v_question.question_type in ('short_text', 'numerical')
        then lower(trim(coalesce(v_answer #>> '{}', ''))) = lower(trim(coalesce(v_question.correct_answer #>> '{}', '')))
      else v_answer = v_question.correct_answer
    end;
    if v_correct then v_score := v_score + v_question.marks; end if;
    insert into public.training_answers (assessment_id, question_id, answer, is_correct, awarded_marks)
    values (v_assessment.id, v_question.id, v_answer, v_correct, case when v_correct then v_question.marks else 0 end)
    on conflict (assessment_id, question_id) do update
      set answer = excluded.answer, is_correct = excluded.is_correct, awarded_marks = excluded.awarded_marks, submitted_at = now();
  end loop;

  v_percentage := case when v_max > 0 then round((v_score / v_max) * 100, 2) else 0 end;
  v_passed := v_percentage >= v_session.assessment_pass_mark;

  update public.training_assessments
     set status = 'graded', score = v_score, max_score = v_max, percentage = v_percentage,
         passed = v_passed, submitted_at = now(), graded_at = now()
   where id = v_assessment.id;

  if not v_passed then
    -- Failures follow the existing retake rules: the participant is marked
    -- failed and cannot silently retry without HR intervention.
    update public.training_participants
       set status = 'failed', submitted_at = now(), completed_at = now()
     where id = v_participant.id;
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('TRAINING_ATTENDANCE_ASSESSMENT_SUBMITTED', 'TrainingParticipant', v_participant.id::text,
    'training-attendance',
    jsonb_build_object('score', v_score, 'max_score', v_max, 'percentage', v_percentage, 'passed', v_passed)::text,
    'info');

  return jsonb_build_object(
    'passed', v_passed, 'score', v_score, 'max_score', v_max, 'percentage', v_percentage,
    'participant_id', v_participant.id
  );
end;
$$;
grant execute on function public.submit_training_attendance_quiz(text, text, jsonb) to anon, authenticated;

-- Commit the completed attendance: signature + attendance + training
-- record + certificate. Idempotent — a repeated/returning submission never
-- duplicates records or certificates.
create or replace function public.complete_training_attendance(
  p_token text,
  p_employee_id text,
  p_signature_path text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_session public.training_sessions%rowtype;
  v_employee public.employees%rowtype;
  v_participant public.training_participants%rowtype;
  v_session_id uuid;
  v_employee_id uuid;
  v_participant_id uuid;
  v_assessment public.training_assessments%rowtype;
  v_record public.employee_training_records%rowtype;
  v_certificate public.training_certificates%rowtype;
  v_signature_id uuid;
  v_record_id uuid;
  v_certificate_id uuid;
  v_certificate_number text;
  v_employee_identifier text;
  v_set_number integer;
  v_token_hash text;
  v_already boolean := false;
begin
  select * into v_session_id, v_employee_id, v_participant_id
    from public.training_attendance_verify(p_token, p_employee_id);
  select * into v_session from public.training_sessions where id = v_session_id;
  select * into v_employee from public.employees where id = v_employee_id;
  select * into v_participant from public.training_participants where id = v_participant_id;

  if v_participant.status in ('completed', 'failed', 'withdrawn') then
    -- Idempotent path: return the existing record/certificate.
    select * into v_record from public.employee_training_records where participant_id = v_participant.id;
    select * into v_certificate from public.training_certificates where employee_training_record_id = v_record.id;
    v_already := true;
    v_record_id := v_record.id;
    v_certificate_id := v_certificate.id;
    v_certificate_number := v_certificate.certificate_number;
  else
    if v_session.assessment_required then
      select * into v_assessment from public.training_assessments where participant_id = v_participant.id for update;
      if v_assessment.id is null or not coalesce(v_assessment.passed, false) then
        raise exception 'You must pass the training assessment before completing this training.';
      end if;
    end if;

    if nullif(trim(coalesce(p_signature_path, '')), '') is null then
      raise exception 'A signature is required before completing the training.';
    end if;
    v_token_hash := md5(trim(p_token));
    if p_signature_path not like 'training-attendance/' || v_token_hash || '/%.png'
       or position('..' in p_signature_path) > 0 then
      raise exception 'Invalid signature storage path.';
    end if;
    if length(p_signature_path) > 512 then raise exception 'Invalid signature storage path.'; end if;

    insert into public.training_signatures (participant_id, employee_id, storage_path, declaration_accepted, declaration_text)
    values (v_participant.id, v_employee.id, p_signature_path, true,
            'I confirm that I attended and completed this training and that the signature above is my own.')
    returning id into v_signature_id;

    insert into public.training_attendance (session_id, participant_id, employee_id, attended, duration_minutes, attendance_status, recorded_by)
    values (v_session.id, v_participant.id, v_employee.id, true, v_session.duration_minutes, 'completed', auth.uid())
    on conflict (participant_id) do update set
      attended = true, duration_minutes = excluded.duration_minutes, attendance_status = 'completed', recorded_at = now();

    select set_number into v_set_number from public.training_question_sets where id = v_participant.question_set_id;
    select coalesce(employee_number, staff_id, employee_code) into v_employee_identifier from public.employees where id = v_employee.id;

    insert into public.employee_training_records (
      participant_id, session_id, employee_id, training_title, training_type,
      training_date, duration_minutes, facilitator, completion_status,
      assessment_score, assessment_max_score, assessment_percentage,
      assessment_passed, question_set_number, signature_id
    ) values (
      v_participant.id, v_session.id, v_employee.id, v_session.title, v_session.training_type,
      v_session.training_date, v_session.duration_minutes, v_session.facilitator, 'completed',
      v_assessment.score, v_assessment.max_score, v_assessment.percentage,
      v_assessment.passed, v_set_number, v_signature_id
    )
    on conflict (participant_id) do nothing
    returning id into v_record_id;
    if v_record_id is null then
      select id into v_record_id from public.employee_training_records where participant_id = v_participant.id;
      v_already := true;
    end if;

    update public.training_participants
       set status = 'completed', submitted_at = coalesce(submitted_at, now()), completed_at = coalesce(completed_at, now())
     where id = v_participant.id;

    if v_session.certificate_enabled then
      select * into v_certificate from public.training_certificates where employee_training_record_id = v_record_id;
      if not found then
        v_certificate_number := public.next_training_certificate_number(v_session.training_type);
        insert into public.training_certificates (
          employee_training_record_id, session_id, employee_id, employee_identifier,
          certificate_number, certificate_type, training_title, training_type,
          training_date, duration_minutes, facilitator, issued_by
        ) values (
          v_record_id, v_session.id, v_employee.id, v_employee_identifier,
          v_certificate_number,
          case when v_session.training_type = 'kss' then 'kss' else 'training' end,
          v_session.title, v_session.training_type, v_session.training_date,
          v_session.duration_minutes, v_session.facilitator, null
        )
        on conflict (employee_training_record_id) do nothing
        returning id into v_certificate_id;
        if v_certificate_id is null then
          select id into v_certificate_id from public.training_certificates where employee_training_record_id = v_record_id;
        end if;
      else
        v_certificate_id := v_certificate.id;
        v_certificate_number := v_certificate.certificate_number;
      end if;
    end if;

    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values ('TRAINING_ATTENDANCE_COMPLETED', 'TrainingParticipant', v_participant.id::text,
      'training-attendance', 'Public attendance/completion flow finished successfully.', 'info');
    if v_certificate_id is not null then
      insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
      values ('TRAINING_CERTIFICATE_GENERATED', 'TrainingCertificate', v_certificate_id::text,
        'training-attendance', coalesce(v_certificate_number, 'Attendance completion certificate'), 'info');
    end if;
  end if;

  return jsonb_build_object(
    'ok', true, 'already_completed', v_already,
    'record_id', v_record_id,
    'participant_status', v_participant.status,
    'certificate', case when v_certificate_id is null then null else jsonb_build_object(
      'id', v_certificate_id, 'certificate_number', v_certificate_number
    ) end
  );
end;
$$;
grant execute on function public.complete_training_attendance(text, text, text) to anon, authenticated;

-- ------------------------------------------------------------
-- 6. STORAGE POLICIES — attendance signatures
--
-- Uploaded by the anonymous attendance page under
-- training-attendance/<token-hash>/; never publicly readable.
-- ------------------------------------------------------------
drop policy if exists "training_attendance_sig_upload" on storage.objects;
create policy "training_attendance_sig_upload" on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'documents'
    and name like 'training-attendance/%'
    and position('..' in name) = 0
    and length(name) <= 512
  );

-- Exclude the attendance signature namespace from the generic
-- authenticated documents read policy (recreated idempotently).
drop policy if exists "documents authenticated read" on storage.objects;
create policy "documents authenticated read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and name not like 'guarantor/%'
    and name not like 'chat/%'
    and name not like 'training-attendance/%'
  );

drop policy if exists "training_attendance_sig_hr_read" on storage.objects;
create policy "training_attendance_sig_hr_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and name like 'training-attendance/%'
    and public.training_is_hr()
  );

-- ------------------------------------------------------------
-- DONE
-- ------------------------------------------------------------