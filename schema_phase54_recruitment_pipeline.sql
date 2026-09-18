-- ============================================================
-- PHASE 54: RECRUITMENT PIPELINE HARDENING
-- ------------------------------------------------------------
-- Additive extension of the existing hr_jobs/hr_candidates lifecycle.
-- Do not create a second candidates, applications, or assessment model.
-- Apply after the existing career lifecycle schema (phase 41+).
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 1. Existing records: criteria, document metadata, pool state
-- ------------------------------------------------------------
alter table public.hr_jobs
  add column if not exists recruitment_criteria jsonb not null default
    '{"weights":{"cv_relevance":30,"technical_skills":25,"assessment_score":25,"interview_score":20},"required_qualifications":[],"required_certifications":[],"experience_threshold":0}'::jsonb,
  add column if not exists application_form_config jsonb not null default
    '{"location":true,"current_company":true,"years_experience":true,"skills":true,"cover_letter":true,"cv_required":false}'::jsonb;

alter table public.hr_candidates
  add column if not exists location text,
  add column if not exists source_detail text,
  add column if not exists cv_file_name text,
  add column if not exists cv_file_size int,
  add column if not exists cv_file_mime text,
  add column if not exists talent_pool_added_at timestamptz,
  add column if not exists blacklisted_at timestamptz,
  add column if not exists blacklisted_by uuid references auth.users(id) on delete set null,
  add column if not exists blacklist_reason text,
  add column if not exists match_score numeric(5,2),
  add column if not exists match_breakdown jsonb not null default '{}'::jsonb;

alter table public.hr_candidates drop constraint if exists hr_candidates_application_source_check;
alter table public.hr_candidates add constraint hr_candidates_application_source_check
  check (application_source in ('portal', 'public_job_link', 'manual', 'referral', 'other', 'import'));

alter table public.hr_candidates drop constraint if exists hr_candidates_application_status_check;
alter table public.hr_candidates add constraint hr_candidates_application_status_check
  check (application_status in (
    'new', 'received', 'screening', 'shortlisted', 'assessment',
    'assessment_passed', 'interview', 'interviewed', 'recommended',
    'offer', 'offer_accepted', 'offer_declined', 'guarantor',
    'onboarding', 'hired', 'talent_pool', 'blacklisted', 'withdrawn',
    'rejected'
  ));

alter table public.hr_screening_configs
  add column if not exists required_skills jsonb not null default '[]'::jsonb,
  add column if not exists preferred_skills jsonb not null default '[]'::jsonb,
  add column if not exists criteria_notes text;

alter table public.candidate_screening_results
  add column if not exists facts jsonb not null default '{}'::jsonb,
  add column if not exists match_breakdown jsonb not null default '{}'::jsonb,
  add column if not exists evidence_scope text not null default 'job_related_only';

alter table public.hr_interviews
  add column if not exists competency_scores jsonb not null default '{}'::jsonb,
  add column if not exists strengths text,
  add column if not exists concerns text,
  add column if not exists outcome text;

create index if not exists idx_hr_candidates_email_lower on public.hr_candidates(lower(email));
create index if not exists idx_hr_candidates_match_score on public.hr_candidates(match_score desc);
create index if not exists idx_hr_candidates_source on public.hr_candidates(application_source);
create index if not exists idx_hr_candidates_location on public.hr_candidates(location);
create index if not exists idx_hr_jobs_department_status on public.hr_jobs(department, status);

-- ------------------------------------------------------------
-- 2. Immutable application/timeline events
-- ------------------------------------------------------------
create table if not exists public.recruitment_application_events (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.hr_candidates(id) on delete restrict,
  application_id uuid not null references public.hr_candidates(id) on delete restrict,
  job_id uuid references public.hr_jobs(id) on delete set null,
  event_type text not null,
  action text not null,
  actor_id uuid references auth.users(id) on delete set null,
  actor_type text not null default 'system',
  actor_name text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_recruitment_events_candidate on public.recruitment_application_events(candidate_id, created_at);
create index if not exists idx_recruitment_events_application on public.recruitment_application_events(application_id, created_at);
create index if not exists idx_recruitment_events_job on public.recruitment_application_events(job_id, created_at);
create index if not exists idx_recruitment_events_type on public.recruitment_application_events(event_type);

alter table public.recruitment_application_events enable row level security;
drop policy if exists recruitment_events_hr_read on public.recruitment_application_events;
create policy recruitment_events_hr_read on public.recruitment_application_events
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

create or replace function public.prevent_recruitment_event_mutation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  raise exception 'Recruitment history is immutable';
end; $$;

drop trigger if exists trg_recruitment_events_immutable on public.recruitment_application_events;
create trigger trg_recruitment_events_immutable
before update or delete on public.recruitment_application_events
for each row execute function public.prevent_recruitment_event_mutation();

create or replace function public.record_recruitment_event(
  p_candidate_id uuid,
  p_event_type text,
  p_action text,
  p_metadata jsonb default '{}'::jsonb,
  p_actor_type text default null
)
returns public.recruitment_application_events
language plpgsql security definer set search_path = public as $$
declare
  v_candidate public.hr_candidates;
  v_actor text;
  v_event public.recruitment_application_events;
begin
  select * into v_candidate from public.hr_candidates where id = p_candidate_id;
  if v_candidate.id is null then raise exception 'Candidate not found'; end if;
  select coalesce(full_name, '') into v_actor from public.profiles where id = auth.uid();
  insert into public.recruitment_application_events
    (candidate_id, application_id, job_id, event_type, action, actor_id, actor_type, actor_name, metadata)
  values
    (v_candidate.id, v_candidate.id, v_candidate.job_id, p_event_type, p_action,
     auth.uid(), coalesce(p_actor_type, case when auth.uid() is null then 'system' else 'hr' end),
     nullif(v_actor, ''), coalesce(p_metadata, '{}'::jsonb))
  returning * into v_event;
  return v_event;
end; $$;

create or replace function public.recruitment_candidate_event_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_actor text;
begin
  select coalesce(full_name, '') into v_actor from public.profiles where id = auth.uid();
  if tg_op = 'INSERT' then
    insert into public.recruitment_application_events
      (candidate_id, application_id, job_id, event_type, action, actor_id, actor_type, actor_name, metadata)
    values (new.id, new.id, new.job_id, 'APPLICATION_RECEIVED', 'Application received', auth.uid(),
      case when auth.uid() is null then 'public' else 'hr' end, nullif(v_actor, ''),
      jsonb_build_object('source', coalesce(new.application_source, 'other'), 'stage', new.application_status));
  elsif new.application_status is distinct from old.application_status then
    insert into public.recruitment_application_events
      (candidate_id, application_id, job_id, event_type, action, actor_id, actor_type, actor_name, metadata)
    values (new.id, new.id, new.job_id,
      case when new.application_status = 'hired' then 'CANDIDATE_EMPLOYED' else 'STAGE_CHANGED' end,
      case when new.application_status = 'hired' then 'Candidate employed' else 'Recruitment stage changed' end, auth.uid(),
      case when auth.uid() is null then 'system' else 'hr' end, nullif(v_actor, ''),
      jsonb_build_object('from_stage', old.application_status, 'to_stage', new.application_status,
        'note', coalesce(new.status_change_note, '')));
  end if;
  return new;
end; $$;

drop trigger if exists trg_recruitment_candidate_events on public.hr_candidates;
create trigger trg_recruitment_candidate_events
after insert or update of application_status on public.hr_candidates
for each row execute function public.recruitment_candidate_event_trigger();

create or replace function public.recruitment_assessment_event_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.candidate_id is null then return new; end if;
  if tg_op = 'INSERT' then
    perform public.record_recruitment_event(new.candidate_id, 'ASSESSMENT_GENERATED', 'Assessment generated', jsonb_build_object('assessment_id', new.id, 'test_name', new.test_name));
    perform public.record_recruitment_event(new.candidate_id, 'ASSESSMENT_SENT', 'Assessment invitation sent', jsonb_build_object('assessment_id', new.id));
  elsif new.status is distinct from old.status and new.status = 'in_progress' then
    perform public.record_recruitment_event(new.candidate_id, 'ASSESSMENT_STARTED', 'Assessment started', jsonb_build_object('assessment_id', new.id));
  elsif new.status is distinct from old.status and new.status = 'completed' then
    perform public.record_recruitment_event(new.candidate_id, 'ASSESSMENT_COMPLETED', 'Assessment completed', jsonb_build_object('assessment_id', new.id, 'score', new.score, 'pass_score', new.pass_score));
  end if;
  return new;
end; $$;

drop trigger if exists trg_recruitment_assessment_events on public.hr_assessments;
create trigger trg_recruitment_assessment_events
after insert or update of status on public.hr_assessments
for each row execute function public.recruitment_assessment_event_trigger();

create or replace function public.recruitment_interview_event_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.candidate_id is not null and tg_op = 'INSERT' then
    perform public.record_recruitment_event(new.candidate_id, 'INTERVIEW_CREATED', 'Interview invitation created', jsonb_build_object('interview_id', new.id, 'scheduled_date', new.scheduled_date));
  end if;
  return new;
end; $$;

drop trigger if exists trg_recruitment_interview_events on public.hr_interviews;
create trigger trg_recruitment_interview_events
after insert on public.hr_interviews
for each row execute function public.recruitment_interview_event_trigger();

create or replace function public.recruitment_offer_event_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.candidate_id is null then return new; end if;
  if tg_op = 'INSERT' then
    perform public.record_recruitment_event(new.candidate_id, 'OFFER_GENERATED', 'Offer generated', jsonb_build_object('offer_id', new.id, 'status', new.status));
  elsif new.status is distinct from old.status and new.status in ('issued', 'accepted', 'declined') then
    perform public.record_recruitment_event(new.candidate_id, case when new.status = 'issued' then 'OFFER_SENT' when new.status = 'accepted' then 'OFFER_ACCEPTED' else 'OFFER_REJECTED' end, 'Offer status changed', jsonb_build_object('offer_id', new.id, 'status', new.status));
  end if;
  return new;
end; $$;

drop trigger if exists trg_recruitment_offer_events on public.offer_letters;
create trigger trg_recruitment_offer_events
after insert or update of status on public.offer_letters
for each row execute function public.recruitment_offer_event_trigger();

-- ------------------------------------------------------------
-- 3. Talent pool and internal role-match alerts
-- ------------------------------------------------------------
create table if not exists public.recruitment_talent_pool (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null unique references public.hr_candidates(id) on delete restrict,
  added_by uuid references auth.users(id) on delete set null,
  tags jsonb not null default '[]'::jsonb,
  preferred_areas jsonb not null default '[]'::jsonb,
  notes text,
  active boolean not null default true,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.recruitment_talent_pool_matches (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.hr_jobs(id) on delete cascade,
  candidate_id uuid not null references public.hr_candidates(id) on delete restrict,
  match_score numeric(5,2) not null,
  reasons jsonb not null default '[]'::jsonb,
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, candidate_id)
);

create index if not exists idx_talent_pool_active on public.recruitment_talent_pool(active, added_at);
create index if not exists idx_talent_pool_matches_job on public.recruitment_talent_pool_matches(job_id, match_score desc);
create index if not exists idx_talent_pool_matches_candidate on public.recruitment_talent_pool_matches(candidate_id);

alter table public.recruitment_talent_pool enable row level security;
alter table public.recruitment_talent_pool_matches enable row level security;
drop policy if exists talent_pool_hr_read on public.recruitment_talent_pool;
create policy talent_pool_hr_read on public.recruitment_talent_pool
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));
drop policy if exists talent_pool_matches_hr_read on public.recruitment_talent_pool_matches;
create policy talent_pool_matches_hr_read on public.recruitment_talent_pool_matches
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

create or replace function public.hr_move_candidate_to_talent_pool(
  p_candidate_id uuid,
  p_note text default null,
  p_preferred_areas jsonb default '[]'::jsonb
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_candidate public.hr_candidates;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then raise exception 'Not authorized'; end if;
  select * into v_candidate from public.hr_candidates where id = p_candidate_id;
  if v_candidate.id is null then raise exception 'Candidate not found'; end if;
  update public.hr_candidates set application_status = 'talent_pool', talent_pool_added_at = coalesce(talent_pool_added_at, now()),
    status_change_note = coalesce(nullif(p_note, ''), 'Moved to talent pool') where id = p_candidate_id;
  insert into public.recruitment_talent_pool (candidate_id, added_by, preferred_areas, notes)
  values (p_candidate_id, auth.uid(), coalesce(p_preferred_areas, '[]'::jsonb), nullif(p_note, ''))
  on conflict (candidate_id) do update set active = true, updated_at = now(), notes = coalesce(excluded.notes, recruitment_talent_pool.notes),
    preferred_areas = coalesce(excluded.preferred_areas, recruitment_talent_pool.preferred_areas);
  perform public.record_recruitment_event(p_candidate_id, 'TALENT_POOL_ADDED', 'Candidate moved to Talent Pool',
    jsonb_build_object('note', coalesce(p_note, '')));
  perform public.hr_audit('CANDIDATE_MOVED_TO_TALENT_POOL', 'Candidate', p_candidate_id::text, coalesce(p_note, 'Candidate retained in Talent Pool'));
  return jsonb_build_object('ok', true, 'candidate_id', p_candidate_id, 'status', 'talent_pool');
end; $$;
grant execute on function public.hr_move_candidate_to_talent_pool(uuid, text, jsonb) to authenticated;

create or replace function public.hr_blacklist_candidate(p_candidate_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_candidate public.hr_candidates;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager') then raise exception 'Only authorized HR managers can blacklist candidates'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'A documented reason is required'; end if;
  select * into v_candidate from public.hr_candidates where id = p_candidate_id;
  if v_candidate.id is null then raise exception 'Candidate not found'; end if;
  update public.hr_candidates set application_status = 'blacklisted', blacklisted_at = now(), blacklisted_by = auth.uid(),
    blacklist_reason = btrim(p_reason), status_change_note = 'Candidate blacklisted with documented reason' where id = p_candidate_id;
  update public.recruitment_talent_pool set active = false, updated_at = now() where candidate_id = p_candidate_id;
  perform public.record_recruitment_event(p_candidate_id, 'CANDIDATE_BLACKLISTED', 'Candidate blacklisted',
    jsonb_build_object('reason', btrim(p_reason)));
  perform public.hr_audit('CANDIDATE_BLACKLISTED', 'Candidate', p_candidate_id::text, btrim(p_reason));
  return jsonb_build_object('ok', true, 'candidate_id', p_candidate_id, 'status', 'blacklisted');
end; $$;
grant execute on function public.hr_blacklist_candidate(uuid, text) to authenticated;

create or replace function public.hr_generate_talent_pool_matches(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_job public.hr_jobs;
  v_candidate record;
  v_requirements jsonb;
  v_required_count int;
  v_match_count int;
  v_skill_score numeric;
  v_experience_score numeric;
  v_score numeric;
  v_reasons jsonb;
  v_count int := 0;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then raise exception 'Not authorized'; end if;
  select * into v_job from public.hr_jobs where id = p_job_id;
  if v_job.id is null then raise exception 'Job not found'; end if;
  v_requirements := coalesce(v_job.required_skills, '[]'::jsonb) || coalesce(v_job.preferred_skills, '[]'::jsonb);
  v_required_count := jsonb_array_length(v_requirements);

  for v_candidate in
    select c.* from public.recruitment_talent_pool p
    join public.hr_candidates c on c.id = p.candidate_id
    where p.active = true and c.application_status <> 'blacklisted'
  loop
    if v_required_count = 0 then
      v_skill_score := 50;
      v_match_count := 0;
    else
      select count(*) into v_match_count
      from jsonb_array_elements_text(v_requirements) req
      where exists (
        select 1 from unnest(coalesce(v_candidate.skills, '{}'::text[])) skill
        where lower(skill) = lower(req) or lower(skill) like '%' || lower(req) || '%'
      ) or position(lower(req) in lower(coalesce(v_candidate.cover_letter, '') || ' ' || coalesce(v_candidate.current_company, ''))) > 0;
      v_skill_score := round((v_match_count::numeric / greatest(v_required_count, 1)) * 100, 2);
    end if;
    v_experience_score := case when coalesce(v_job.experience_years, 0) <= 0 then 100
      else least(100, round(coalesce(v_candidate.years_experience, 0)::numeric / v_job.experience_years * 100, 2)) end;
    v_score := round(v_skill_score * 0.7 + v_experience_score * 0.3, 2);
    if v_score >= 70 then
      v_reasons := jsonb_build_array(
        format('%s of %s configured skills appear in the documented profile', v_match_count, greatest(v_required_count, 0)),
        format('%s years documented experience against %s years requested', coalesce(v_candidate.years_experience, 0), coalesce(v_job.experience_years, 0))
      );
      insert into public.recruitment_talent_pool_matches (job_id, candidate_id, match_score, reasons)
      values (p_job_id, v_candidate.id, v_score, v_reasons)
      on conflict (job_id, candidate_id) do update set match_score = excluded.match_score, reasons = excluded.reasons,
        status = case when recruitment_talent_pool_matches.status = 'dismissed' then 'dismissed' else 'open' end, updated_at = now();
      update public.hr_candidates set match_score = v_score, match_breakdown = jsonb_build_object(
        'skills', v_skill_score, 'experience', v_experience_score, 'weights', jsonb_build_object('skills', 70, 'experience', 30),
        'reasons', v_reasons) where id = v_candidate.id;
      begin
        insert into public.notifications (user_id, title, message, type, link)
        values (v_job.created_by, 'SARA Talent Pool Match',
          format('Boss, I noticed the new %s role. A Talent Pool candidate has a documented %s%% job-related match. Can we review the candidate together?', v_job.job_title, v_score),
          'hr', '/recruitment?job=' || p_job_id::text || '&tab=talent-pool');
      exception when others then null;
      end;
      v_count := v_count + 1;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'job_id', p_job_id, 'matches', v_count);
end; $$;
grant execute on function public.hr_generate_talent_pool_matches(uuid) to authenticated;

create or replace function public.recruitment_job_pool_match_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.id is not null and public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    perform public.hr_generate_talent_pool_matches(new.id);
  end if;
  return new;
end; $$;

drop trigger if exists trg_recruitment_job_pool_match on public.hr_jobs;
create trigger trg_recruitment_job_pool_match
after insert on public.hr_jobs
for each row execute function public.recruitment_job_pool_match_trigger();

-- ------------------------------------------------------------
-- 4. Secure candidate creation/CV replacement and interviews
-- ------------------------------------------------------------
create or replace function public.hr_create_manual_candidate(p_data jsonb)
returns public.hr_candidates language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_candidate public.hr_candidates;
  v_job_id uuid;
  v_job public.hr_jobs;
  v_name text := nullif(btrim(coalesce(p_data ->> 'full_name', '')), '');
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then raise exception 'Not authorized'; end if;
  if v_name is null then raise exception 'Full name is required'; end if;
  if nullif(p_data ->> 'job_id', '') is not null then v_job_id := (p_data ->> 'job_id')::uuid; end if;
  if v_job_id is not null then
    select * into v_job from public.hr_jobs where id = v_job_id;
    if v_job.id is null then raise exception 'Job not found'; end if;
  end if;
  insert into public.hr_candidates (
    job_id, full_name, email, phone, location, current_company, years_experience, cover_letter,
    applied_role, department, branch, application_status, application_source, source_detail, skills
  ) values (
    v_job_id, v_name, nullif(lower(btrim(coalesce(p_data ->> 'email', ''))), ''),
    nullif(btrim(coalesce(p_data ->> 'phone', '')), ''), nullif(btrim(coalesce(p_data ->> 'location', '')), ''),
    nullif(btrim(coalesce(p_data ->> 'current_company', '')), ''),
    case when nullif(p_data ->> 'years_experience', '') is null then null else (p_data ->> 'years_experience')::int end,
    nullif(btrim(coalesce(p_data ->> 'cover_letter', '')), ''),
    coalesce(nullif(btrim(coalesce(p_data ->> 'applied_role', '')), ''), v_job.job_title),
    coalesce(nullif(btrim(coalesce(p_data ->> 'department', '')), ''), v_job.department),
    coalesce(nullif(btrim(coalesce(p_data ->> 'branch', '')), ''), v_job.branch),
    'received', 'manual', nullif(btrim(coalesce(p_data ->> 'source_detail', '')), ''),
    case when jsonb_typeof(p_data -> 'skills') = 'array'
      then array(select jsonb_array_elements_text(p_data -> 'skills')) else '{}'::text[] end
  ) returning * into v_candidate;
  insert into public.hr_candidate_status_history (candidate_id, from_status, to_status, changed_by, changed_by_name, note)
  values (v_candidate.id, null, 'received', auth.uid(), (select full_name from public.profiles where id = auth.uid()), 'Manual candidate created by HR');
  perform public.hr_audit('CANDIDATE_CREATED', 'Candidate', v_candidate.id::text, 'Manual candidate created');
  return v_candidate;
end; $$;
grant execute on function public.hr_create_manual_candidate(jsonb) to authenticated;

create or replace function public.hr_attach_candidate_cv(
  p_candidate_id uuid, p_path text, p_name text, p_size int, p_mime text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_candidate public.hr_candidates;
  v_mime text := lower(coalesce(p_mime, ''));
  v_name text := lower(coalesce(p_name, ''));
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then raise exception 'Not authorized'; end if;
  if p_path is null or position('..' in p_path) > 0 then raise exception 'Invalid CV path'; end if;
  select * into v_candidate from public.hr_candidates where id = p_candidate_id;
  if v_candidate.id is null then raise exception 'Candidate not found'; end if;
  if p_path not like 'cvs/%' and p_path not like ('recruitment/' || p_candidate_id::text || '/cv/%') then raise exception 'CV path is outside the recruitment namespace'; end if;
  if p_size is null or p_size <= 0 or p_size > 10485760 then raise exception 'CV must be between 1 byte and 10 MB'; end if;
  if v_mime not in ('application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
     and v_name !~* '\.(pdf|doc|docx)$' then raise exception 'CV must be PDF, DOC or DOCX'; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'career' and name = p_path) then raise exception 'Uploaded CV object was not found'; end if;

  update public.hr_candidates set cv_file_path = p_path, cv_file_name = p_name, cv_file_size = p_size, cv_file_mime = p_mime,
    status_change_note = 'CV uploaded or replaced' where id = p_candidate_id;
  insert into public.documents (entity_type, entity_id, document_type, file_name, file_path, file_size, mime_type, is_required, uploaded_by)
  values ('hr_candidate', p_candidate_id, 'cv', coalesce(p_name, 'resume'), p_path, p_size, p_mime, true, auth.uid());
  perform public.record_recruitment_event(p_candidate_id, 'CV_UPLOADED', 'CV uploaded or replaced',
    jsonb_build_object('file_name', p_name, 'file_size', p_size, 'mime_type', p_mime));
  perform public.hr_audit('CV_UPLOADED', 'Candidate', p_candidate_id::text, coalesce(p_name, 'CV uploaded or replaced'));
  return jsonb_build_object('ok', true, 'candidate_id', p_candidate_id, 'path', p_path);
end; $$;
grant execute on function public.hr_attach_candidate_cv(uuid, text, text, int, text) to authenticated;

create or replace function public.hr_schedule_recruitment_interview(p_candidate_id uuid, p_data jsonb)
returns public.hr_interviews language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_candidate public.hr_candidates;
  v_interview public.hr_interviews;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then raise exception 'Not authorized'; end if;
  select * into v_candidate from public.hr_candidates where id = p_candidate_id;
  if v_candidate.id is null then raise exception 'Candidate not found'; end if;
  if nullif(p_data ->> 'scheduled_date', '') is null then raise exception 'Interview date and time are required'; end if;
  insert into public.hr_interviews (
    candidate_id, candidate_name, candidate_email, "position", interview_type, location, platform, meeting_url,
    scheduled_date, duration_minutes, status, interviewer_id, interview_instructions, notification_status,
    interview_round
  ) values (
    p_candidate_id, v_candidate.full_name, coalesce(v_candidate.email, ''),
    coalesce(nullif(p_data ->> 'position', ''), v_candidate.applied_role),
    coalesce(nullif(p_data ->> 'interview_type', ''), 'PHYSICAL'),
    nullif(p_data ->> 'location', ''), nullif(p_data ->> 'platform', ''), nullif(p_data ->> 'meeting_url', ''),
    (p_data ->> 'scheduled_date')::timestamptz, coalesce((p_data ->> 'duration_minutes')::int, 30), 'scheduled',
    coalesce(nullif(p_data ->> 'interviewer_id', '')::uuid, auth.uid()), nullif(p_data ->> 'notes', ''), 'pending',
    coalesce((p_data ->> 'interview_round')::int, 1)
  ) returning * into v_interview;
  update public.hr_candidates set application_status = 'interview', status_change_note = 'Interview invitation created'
    where id = p_candidate_id and application_status in ('received', 'screening', 'shortlisted', 'assessment_passed', 'assessment');
  perform public.hr_audit('INTERVIEW_CREATED', 'Interview', v_interview.id::text, 'Interview invitation created');
  return v_interview;
end; $$;
grant execute on function public.hr_schedule_recruitment_interview(uuid, jsonb) to authenticated;

create or replace function public.hr_complete_recruitment_interview(
  p_interview_id uuid, p_feedback text, p_rating numeric, p_competency_scores jsonb default '{}',
  p_strengths text default null, p_concerns text default null, p_recommendation text default 'hold', p_outcome text default null
)
returns public.hr_interviews language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_interview public.hr_interviews;
  v_target text;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then raise exception 'Not authorized'; end if;
  if p_rating is null or p_rating < 0 or p_rating > 5 then raise exception 'Rating must be between 0 and 5'; end if;
  if p_recommendation not in ('proceed', 'hold', 'reject') then raise exception 'Invalid interview recommendation'; end if;
  update public.hr_interviews set status = 'completed', feedback = nullif(p_feedback, ''), rating = p_rating,
    competency_scores = coalesce(p_competency_scores, '{}'::jsonb), strengths = nullif(p_strengths, ''),
    concerns = nullif(p_concerns, ''), recommendation = p_recommendation, outcome = nullif(p_outcome, ''), updated_at = now()
    where id = p_interview_id returning * into v_interview;
  if v_interview.id is null then raise exception 'Interview not found'; end if;
  v_target := case when p_recommendation = 'proceed' then 'recommended' when p_recommendation = 'reject' then 'rejected' else 'interviewed' end;
  update public.hr_candidates set application_status = v_target, status_change_note = 'Interview completed: ' || p_recommendation
    where id = v_interview.candidate_id and application_status not in ('hired', 'offer_accepted', 'onboarding', 'blacklisted');
  perform public.record_recruitment_event(v_interview.candidate_id, 'INTERVIEW_COMPLETED', 'Interview completed',
    jsonb_build_object('interview_id', p_interview_id, 'rating', p_rating, 'recommendation', p_recommendation,
      'competency_scores', coalesce(p_competency_scores, '{}'::jsonb)));
  perform public.hr_audit('INTERVIEW_COMPLETED', 'Interview', p_interview_id::text, 'Interview feedback recorded');
  return v_interview;
end; $$;
grant execute on function public.hr_complete_recruitment_interview(uuid, text, numeric, jsonb, text, text, text, text) to authenticated;

-- ------------------------------------------------------------
-- 5. Safer HR profile/status/config RPCs
-- ------------------------------------------------------------
create or replace function public.hr_advance_application(p_candidate_id uuid, p_status text, p_note text default null)
returns public.hr_candidates language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_row public.hr_candidates;
  v_from text;
  v_allowed boolean := false;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then raise exception 'Not authorized'; end if;
  if p_status not in ('received', 'screening', 'shortlisted', 'assessment', 'assessment_passed', 'interview', 'interviewed', 'recommended', 'offer', 'offer_accepted', 'onboarding', 'hired', 'rejected', 'withdrawn', 'talent_pool', 'blacklisted') then raise exception 'Invalid recruitment stage'; end if;
  select application_status into v_from from public.hr_candidates where id = p_candidate_id;
  if v_from is null then raise exception 'Candidate not found'; end if;
  if v_from = p_status then v_allowed := true;
  elsif v_from in ('new', 'received') and p_status in ('screening', 'shortlisted', 'assessment', 'interview', 'rejected', 'withdrawn', 'talent_pool', 'blacklisted') then v_allowed := true;
  elsif v_from = 'screening' and p_status in ('shortlisted', 'assessment', 'interview', 'rejected', 'talent_pool', 'blacklisted') then v_allowed := true;
  elsif v_from = 'shortlisted' and p_status in ('assessment', 'interview', 'rejected', 'talent_pool', 'blacklisted') then v_allowed := true;
  elsif v_from = 'assessment' and p_status in ('assessment_passed', 'interview', 'rejected', 'talent_pool', 'blacklisted') then v_allowed := true;
  elsif v_from = 'assessment_passed' and p_status in ('interview', 'interviewed', 'rejected', 'talent_pool', 'blacklisted') then v_allowed := true;
  elsif v_from = 'interview' and p_status in ('interviewed', 'recommended', 'offer', 'rejected', 'talent_pool', 'blacklisted') then v_allowed := true;
  elsif v_from = 'interviewed' and p_status in ('recommended', 'offer', 'rejected', 'talent_pool', 'blacklisted') then v_allowed := true;
  elsif v_from = 'recommended' and p_status in ('offer', 'rejected', 'talent_pool', 'blacklisted') then v_allowed := true;
  elsif v_from = 'offer' and p_status in ('offer_accepted', 'onboarding', 'rejected', 'talent_pool', 'blacklisted') then v_allowed := true;
  elsif v_from = 'offer_accepted' and p_status in ('onboarding', 'hired') then v_allowed := true;
  elsif v_from = 'onboarding' and p_status = 'hired' then v_allowed := true;
  elsif v_from = 'talent_pool' and p_status in ('screening', 'shortlisted', 'assessment', 'interview', 'rejected', 'blacklisted') then v_allowed := true;
  end if;
  if not v_allowed then raise exception 'Invalid transition from % to %', v_from, p_status; end if;
  update public.hr_candidates set application_status = p_status, status_change_note = p_note where id = p_candidate_id returning * into v_row;
  perform public.hr_audit('APPLICATION_STATUS_CHANGED', 'Candidate', p_candidate_id::text, format('%s -> %s', v_from, p_status));
  return v_row;
end; $$;
grant execute on function public.hr_advance_application(uuid, text, text) to authenticated;

create or replace function public.hr_update_candidate_profile(p_candidate_id uuid, p_data jsonb)
returns public.hr_candidates language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_row public.hr_candidates;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then raise exception 'Not authorized'; end if;
  update public.hr_candidates set
    full_name = coalesce(nullif(p_data ->> 'full_name', ''), full_name),
    email = coalesce(nullif(lower(p_data ->> 'email'), ''), email),
    phone = coalesce(nullif(p_data ->> 'phone', ''), phone),
    location = coalesce(nullif(p_data ->> 'location', ''), location),
    current_company = coalesce(nullif(p_data ->> 'current_company', ''), current_company),
    years_experience = case when nullif(p_data ->> 'years_experience', '') is null then years_experience else (p_data ->> 'years_experience')::int end,
    education = coalesce(p_data -> 'education', education), work_experience = coalesce(p_data -> 'work_experience', work_experience),
    skills = case when jsonb_typeof(p_data -> 'skills') = 'array' then array(select jsonb_array_elements_text(p_data -> 'skills')) else skills end,
    certifications = coalesce(p_data -> 'certifications', certifications), candidate_references = coalesce(p_data -> 'candidate_references', candidate_references),
    status_change_note = 'Candidate profile updated by HR', updated_at = now()
    where id = p_candidate_id returning * into v_row;
  if v_row.id is null then raise exception 'Candidate not found'; end if;
  perform public.record_recruitment_event(p_candidate_id, 'CANDIDATE_EDITED', 'Candidate profile updated', '{}'::jsonb);
  perform public.hr_audit('CANDIDATE_EDITED', 'Candidate', p_candidate_id::text, 'Candidate profile updated');
  return v_row;
end; $$;
grant execute on function public.hr_update_candidate_profile(uuid, jsonb) to authenticated;

create or replace function public.upsert_screening_config(p_job_id uuid, p_config jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_version int;
  v_weight_total numeric;
  v_job public.hr_jobs;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager') then raise exception 'Not authorized to configure screening'; end if;
  select * into v_job from public.hr_jobs where id = p_job_id;
  if v_job.id is null then raise exception 'Job not found'; end if;
  select coalesce(sum(value::numeric), 0)
    into v_weight_total from jsonb_each_text(coalesce(p_config -> 'weights', '{}'::jsonb));
  if v_weight_total <> 100 then raise exception 'Recruitment criteria weights must total 100 (received %)', v_weight_total; end if;
  select coalesce(max(version), 0) + 1 into v_version from public.hr_screening_configs where job_id = p_job_id;
  update public.hr_screening_configs set active = false where job_id = p_job_id and active = true;
  insert into public.hr_screening_configs (
    job_id, version, active, weights, min_overall, min_components, mandatory_requirements, preferred_requirements,
    required_qualifications, required_certifications, required_skills, preferred_skills, criteria_notes,
    assessment_threshold, experience_threshold, assessment_flag_tolerance, created_by
  ) values (
    p_job_id, v_version, true, coalesce(p_config -> 'weights', '{}'::jsonb), coalesce((p_config ->> 'min_overall')::numeric, 60),
    coalesce(p_config -> 'min_components', '{}'::jsonb), coalesce(p_config -> 'mandatory_requirements', '[]'::jsonb),
    coalesce(p_config -> 'preferred_requirements', '[]'::jsonb), coalesce(p_config -> 'required_qualifications', '[]'::jsonb),
    coalesce(p_config -> 'required_certifications', '[]'::jsonb), coalesce(p_config -> 'required_skills', v_job.required_skills, '[]'::jsonb),
    coalesce(p_config -> 'preferred_skills', v_job.preferred_skills, '[]'::jsonb), nullif(p_config ->> 'criteria_notes', ''),
    (p_config ->> 'assessment_threshold')::numeric, coalesce((p_config ->> 'experience_threshold')::int, coalesce(v_job.experience_years, 0)),
    coalesce((p_config ->> 'assessment_flag_tolerance')::int, 0), auth.uid()
  );
  update public.hr_jobs set recruitment_criteria = p_config where id = p_job_id;
  perform public.hr_audit('SCREENING_CONFIG_SAVED', 'Job', p_job_id::text, format('Recruitment criteria v%s saved; weights total 100', v_version));
  return jsonb_build_object('ok', true, 'version', v_version, 'weight_total', v_weight_total);
end; $$;
grant execute on function public.upsert_screening_config(uuid, jsonb) to authenticated;

-- ------------------------------------------------------------
-- 6. Public projections, duplicate/CV validation and source audit
-- ------------------------------------------------------------
drop function if exists public.public_get_published_jobs();
create or replace function public.public_get_published_jobs()
returns setof jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', id, 'job_title', job_title, 'department', department, 'designation', designation, 'branch', branch,
    'location', location, 'employment_type', employment_type, 'experience_years', experience_years,
    'salary_min', salary_min, 'salary_max', salary_max, 'salary_currency', salary_currency, 'description', description,
    'responsibilities', responsibilities, 'requirements', requirements, 'qualifications', qualifications, 'benefits', benefits,
    'application_deadline', application_deadline, 'assessment_required', assessment_required, 'interview_required', interview_required,
    'required_skills', required_skills, 'preferred_skills', preferred_skills, 'application_form_config', application_form_config,
    'public_token', public_token, 'published_at', published_at
  ) from public.hr_jobs where status = 'published' and (application_deadline is null or application_deadline >= current_date)
  order by published_at desc;
$$;
grant execute on function public.public_get_published_jobs() to anon, authenticated;

drop function if exists public.public_get_job_by_token(text);
create or replace function public.public_get_job_by_token(p_token text)
returns setof jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', id, 'job_title', job_title, 'department', department, 'designation', designation, 'branch', branch,
    'location', location, 'employment_type', employment_type, 'experience_years', experience_years,
    'salary_min', salary_min, 'salary_max', salary_max, 'salary_currency', salary_currency, 'description', description,
    'responsibilities', responsibilities, 'requirements', requirements, 'qualifications', qualifications, 'benefits', benefits,
    'application_deadline', application_deadline, 'assessment_required', assessment_required, 'interview_required', interview_required,
    'required_skills', required_skills, 'preferred_skills', preferred_skills, 'application_form_config', application_form_config,
    'public_token', public_token, 'published_at', published_at
  ) from public.hr_jobs where status = 'published' and public_token = p_token
    and (application_deadline is null or application_deadline >= current_date);
$$;
grant execute on function public.public_get_job_by_token(text) to anon, authenticated;

create or replace function public.public_apply_for_job(
  p_job_token text, p_application jsonb, p_cv_path text default null, p_cv_name text default null,
  p_cv_size int default null, p_cv_mime text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_job public.hr_jobs;
  v_candidate_id uuid;
  v_name text := nullif(btrim(coalesce(p_application ->> 'full_name', '')), '');
  v_email text := lower(nullif(btrim(coalesce(p_application ->> 'email', '')), ''));
  v_phone text := nullif(btrim(coalesce(p_application ->> 'phone', '')), '');
  v_token text := public.generate_secure_token();
  v_existing uuid;
begin
  if v_name is null then raise exception 'Full name is required'; end if;
  if v_email is null and v_phone is null then raise exception 'An email or phone number is required'; end if;
  select * into v_job from public.hr_jobs where public_token = p_job_token and status = 'published';
  if v_job.id is null then raise exception 'Invalid or unpublished job'; end if;
  if v_job.application_deadline is not null and v_job.application_deadline < current_date then raise exception 'The application deadline for this job has passed'; end if;
  if p_cv_path is not null then
    if position('..' in p_cv_path) > 0 or p_cv_path not like 'cvs/%' then raise exception 'Invalid CV storage path'; end if;
    if p_cv_size is null or p_cv_size <= 0 or p_cv_size > 10485760 then raise exception 'CV must be between 1 byte and 10 MB'; end if;
    if lower(coalesce(p_cv_mime, '')) not in ('application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
       and lower(coalesce(p_cv_name, '')) !~* '\.(pdf|doc|docx)$' then raise exception 'CV must be PDF, DOC or DOCX'; end if;
    if not exists (select 1 from storage.objects where bucket_id = 'career' and name = p_cv_path) then raise exception 'Uploaded CV object was not found'; end if;
  end if;
  select id into v_existing from public.hr_candidates where job_id = v_job.id
    and ((v_email is not null and lower(email) = v_email) or (v_phone is not null and phone = v_phone)) limit 1;
  if v_existing is not null then raise exception 'You have already applied for this job'; end if;

  insert into public.hr_candidates (
    job_id, full_name, email, phone, location, current_company, years_experience, cover_letter, cv_file_path, cv_file_name,
    cv_file_size, cv_file_mime, applied_role, department, branch, application_status, application_source, source_detail,
    education, work_experience, skills, certifications, candidate_references, application_token_hash
  ) values (
    v_job.id, v_name, v_email, v_phone, nullif(btrim(coalesce(p_application ->> 'location', '')), ''),
    nullif(btrim(coalesce(p_application ->> 'current_company', '')), ''),
    case when nullif(p_application ->> 'years_experience', '') is null then null else greatest(0, least(80, (p_application ->> 'years_experience')::int)) end,
    nullif(btrim(coalesce(p_application ->> 'cover_letter', '')), ''), p_cv_path, p_cv_name, p_cv_size, p_cv_mime,
    v_job.job_title, v_job.department, coalesce(v_job.branch, nullif(p_application ->> 'branch', '')), 'received', 'public_job_link',
    'Public Job Link', coalesce(case when jsonb_typeof(p_application -> 'education') = 'array' then p_application -> 'education' end, '[]'::jsonb),
    coalesce(case when jsonb_typeof(p_application -> 'work_experience') = 'array' then p_application -> 'work_experience' end, '[]'::jsonb),
    case when jsonb_typeof(p_application -> 'skills') = 'array' then array(select jsonb_array_elements_text(p_application -> 'skills')) else '{}'::text[] end,
    coalesce(case when jsonb_typeof(p_application -> 'certifications') = 'array' then p_application -> 'certifications' end, '[]'::jsonb),
    coalesce(case when jsonb_typeof(p_application -> 'candidate_references') = 'array' then p_application -> 'candidate_references' end, '[]'::jsonb), md5(v_token)
  ) returning id into v_candidate_id;
  if p_cv_path is not null then
    insert into public.documents (entity_type, entity_id, document_type, file_name, file_path, file_size, mime_type, is_required, uploaded_by)
    values ('hr_candidate', v_candidate_id, 'cv', coalesce(p_cv_name, 'resume'), p_cv_path, p_cv_size, p_cv_mime, true, null);
    perform public.record_recruitment_event(v_candidate_id, 'CV_UPLOADED', 'CV uploaded with public application',
      jsonb_build_object('file_name', p_cv_name, 'file_size', p_cv_size, 'mime_type', p_cv_mime), 'public');
  end if;
  insert into public.hr_candidate_status_history (candidate_id, from_status, to_status, note)
    values (v_candidate_id, null, 'received', 'Application submitted via public job link');
  if v_job.created_by is not null then
    insert into public.notifications (user_id, title, message, type, link)
      values (v_job.created_by, 'New job application', format('%s applied for %s', v_name, v_job.job_title), 'hr', '/recruitment');
  end if;
  perform public.hr_audit('APPLICATION_SUBMITTED', 'Candidate', v_candidate_id::text, format('Public Job Link application for %s', v_job.job_title));
  return jsonb_build_object('ok', true, 'candidate_id', v_candidate_id, 'portal_token', v_token,
    'job_url', '/careers/jobs/' || v_job.public_token, 'application_id', v_candidate_id, 'source', 'public_job_link');
end; $$;
grant execute on function public.public_apply_for_job(text, jsonb, text, text, int, text) to anon, authenticated;

-- ------------------------------------------------------------
-- 7. Restrict recruitment storage and candidate writes
-- ------------------------------------------------------------
drop policy if exists career_cv_anon_upload on storage.objects;
drop policy if exists "career_cv_anon_upload" on storage.objects;
create policy career_cv_public_upload on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'career' and (storage.foldername(name))[1] = 'cvs'
    and position('..' in name) = 0
    and lower(coalesce(metadata ->> 'mimetype', '')) in ('application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    and coalesce((metadata ->> 'size')::bigint, 0) between 1 and 10485760
  );
create policy career_cv_hr_upload on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'career' and (storage.foldername(name))[1] = 'recruitment'
    and public.is_hr_staff() and position('..' in name) = 0
    and lower(coalesce(metadata ->> 'mimetype', '')) in ('application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    and coalesce((metadata ->> 'size')::bigint, 0) between 1 and 10485760
  );
drop policy if exists career_cv_hr_read on storage.objects;
create policy career_cv_hr_read on storage.objects
  for select to authenticated using (bucket_id = 'career' and public.is_hr_staff());

drop policy if exists hr_candidates_insert on public.hr_candidates;
drop policy if exists "hr_candidates_insert" on public.hr_candidates;
create policy hr_candidates_insert on public.hr_candidates
  for insert with check (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));
drop policy if exists hr_candidates_read on public.hr_candidates;
drop policy if exists "hr_candidates_read" on public.hr_candidates;
create policy hr_candidates_read on public.hr_candidates
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));
drop policy if exists hr_candidates_update on public.hr_candidates;
drop policy if exists "hr_candidates_update" on public.hr_candidates;
create policy hr_candidates_update on public.hr_candidates
  for update using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'))
  with check (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

drop policy if exists hr_jobs_read on public.hr_jobs;
drop policy if exists "hr_jobs_read" on public.hr_jobs;
create policy hr_jobs_read on public.hr_jobs
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));
revoke select on public.hr_jobs from anon;
drop policy if exists hr_jobs_insert on public.hr_jobs;
drop policy if exists "hr_jobs_insert" on public.hr_jobs;
create policy hr_jobs_insert on public.hr_jobs
  for insert with check (public.current_role() in ('super_admin', 'admin', 'hr_manager'));
drop policy if exists hr_jobs_update on public.hr_jobs;
drop policy if exists "hr_jobs_update" on public.hr_jobs;
create policy hr_jobs_update on public.hr_jobs
  for update using (created_by = auth.uid() or public.current_role() in ('super_admin', 'admin', 'hr_manager'))
  with check (public.current_role() in ('super_admin', 'admin', 'hr_manager'));

-- ------------------------------------------------------------
-- 8. Real recruitment dashboard aggregates
-- ------------------------------------------------------------
create or replace function public.hr_recruitment_dashboard_stats()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_by_job jsonb;
  v_by_department jsonb;
  v_funnel jsonb;
  v_stage_time jsonb;
  v_sources jsonb;
  v_assessment_pass numeric;
  v_interview_conversion numeric;
  v_offer_conversion numeric;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then raise exception 'Not authorized'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('job_id', x.job_id, 'job_title', x.job_title, 'applications', x.applications) order by x.applications desc), '[]'::jsonb)
    into v_by_job from (select c.job_id, coalesce(j.job_title, c.applied_role, 'Unassigned') job_title, count(*) applications
      from public.hr_candidates c left join public.hr_jobs j on j.id = c.job_id group by c.job_id, j.job_title, c.applied_role) x;
  select coalesce(jsonb_agg(jsonb_build_object('department', coalesce(department, 'Unassigned'), 'applications', applications) order by applications desc), '[]'::jsonb)
    into v_by_department from (select department, count(*) applications from public.hr_candidates group by department) x;
  select coalesce(jsonb_object_agg(application_status, total), '{}'::jsonb) into v_funnel
    from (select application_status, count(*) total from public.hr_candidates group by application_status) x;
  select coalesce(jsonb_object_agg(stage, round(avg(days_in_stage)::numeric, 2)), '{}'::jsonb) into v_stage_time
    from (with transitions as (
      select to_status stage, created_at, lead(created_at) over (partition by candidate_id order by created_at) next_at
      from public.hr_candidate_status_history
    ) select stage, extract(epoch from (coalesce(next_at, now()) - created_at)) / 86400 days_in_stage from transitions) x;
  select coalesce(jsonb_object_agg(coalesce(application_source, 'other'), total), '{}'::jsonb) into v_sources
    from (select application_source, count(*) total from public.hr_candidates group by application_source) x;
  select case when count(*) = 0 then 0 else round((count(*) filter (where coalesce(score, 0) >= coalesce(pass_score, 60))::numeric / count(*) * 100), 2) end into v_assessment_pass
    from public.hr_assessments where status = 'completed';
  select case when count(*) = 0 then 0 else round((count(*) filter (where status = 'completed')::numeric / count(*) * 100), 2) end into v_interview_conversion
    from public.hr_interviews;
  select case when count(*) = 0 then 0 else round((count(*) filter (where status = 'accepted')::numeric / count(*) * 100), 2) end into v_offer_conversion
    from public.offer_letters where status in ('issued', 'accepted', 'declined');
  return jsonb_build_object(
    'open_jobs', (select count(*) from public.hr_jobs where status = 'published'),
    'applications', (select count(*) from public.hr_candidates),
    'new_applicants', (select count(*) from public.hr_candidates where created_at >= current_date),
    'assessment_pending', (select count(*) from public.hr_candidates where application_status = 'assessment'),
    'assessment_completed', (select count(*) from public.hr_assessments where status = 'completed'),
    'interview_pending', (select count(*) from public.hr_candidates where application_status = 'interview'),
    'offers_pending', (select count(*) from public.hr_candidates where application_status = 'offer'),
    'hired', (select count(*) from public.hr_candidates where application_status = 'hired'),
    'talent_pool', (select count(*) from public.recruitment_talent_pool where active = true),
    'rejected', (select count(*) from public.hr_candidates where application_status = 'rejected'),
    'blacklisted', (select count(*) from public.hr_candidates where application_status = 'blacklisted'),
    'by_job', v_by_job, 'by_department', v_by_department, 'funnel', v_funnel,
    'average_time_in_stage_days', v_stage_time, 'assessment_pass_rate', v_assessment_pass,
    'interview_conversion', v_interview_conversion, 'offer_conversion', v_offer_conversion, 'source_breakdown', v_sources
  );
end; $$;
grant execute on function public.hr_recruitment_dashboard_stats() to authenticated;

-- Done. Public applicants remain anonymous; CVs are private and HR-only.
