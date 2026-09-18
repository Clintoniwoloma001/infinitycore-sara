-- ============================================================
-- schema_phase41_hr_career_lifecycle.sql
-- ------------------------------------------------------------
-- PURPOSE
--   The complete InfinityCore HR lifecycle:
--
--   JOB -> PUBLIC ADVERT -> APPLICATION (CV + cover letter)
--   -> HR REVIEW -> SARA AI SCREENING -> ASSESSMENT (CBT)
--   -> ANTI-CHEAT/FLAGS -> AI ASSESSMENT ANALYSIS -> INTERVIEW
--   -> OFFER -> ACCEPTANCE -> GUARANTOR -> ONBOARDING
--   -> EMPLOYEE -> USER ACCOUNT -> PAYROLL.
--
--   This phase REUSES the existing schema (hr_jobs, hr_candidates,
--   hr_assessments, hr_interviews, offer_letters, assessment_questions,
--   assessment_monitoring_events, employees, payroll, payroll_config,
--   employee_onboarding_links, guarantor_verifications) and ONLY adds
--   additive columns / new tables / SECURITY DEFINER RPCs where the
--   existing structures cannot express the lifecycle.
--
--   Rules honored:
--     * Idempotent (all DROP IF EXISTS / IF NOT EXISTS / OR REPLACE).
--     * RLS enabled everywhere; never bypassed from the client.
--     * Service-role / security-definer logic only inside RPCs and
--       Edge Functions, never the anon/authenticated RLS path.
--     * Candidate-facing actions are token-gated (256-bit token, only
--       its md5() hash stored) — identical to the onboarding-link model.
--     * AI decisions are advisory only; HR is the decision maker.
--
--   Run in Supabase SQL Editor. Safe to re-run.
-- ============================================================

-- ============================================================
-- 1. HR JOBS — expand into a full job-advert record
-- ============================================================
alter table public.hr_jobs
  add column if not exists designation text,
  add column if not exists branch text,
  add column if not exists openings int default 1,
  add column if not exists responsibilities text,
  add column if not exists qualifications text,
  add column if not exists benefits text,
  add column if not exists application_deadline date,
  add column if not exists assessment_required boolean default false,
  add column if not exists interview_required boolean default true,
  add column if not exists ai_screening_enabled boolean default true,
  add column if not exists screening_min_score numeric(5,2) default 60,
  add column if not exists required_skills jsonb default '[]'::jsonb,
  add column if not exists preferred_skills jsonb default '[]'::jsonb,
  add column if not exists salary_currency text default 'NGN',
  add column if not exists public_token text unique,
  add column if not exists created_by_name text;

create index if not exists idx_hr_jobs_public_token on public.hr_jobs(public_token);
create index if not exists idx_hr_jobs_deadline on public.hr_jobs(application_deadline);

-- Public job listing must remain readable by anonymous visitors
-- (the existing hr_jobs_read RLS already exposes published rows).

-- ============================================================
-- 2. HR CANDIDATES — full application record + fixes
-- ============================================================
-- Fix: Recruitment.jsx/Interviews.jsx use `applied_role` (missing) and
-- other pages read candidate.department/branch — backfill as text.
alter table public.hr_candidates
  add column if not exists applied_role text,
  add column if not exists department text,
  add column if not exists branch text,
  add column if not exists application_token_hash text unique,
  add column if not exists application_source text default 'portal'
    check (application_source in ('portal', 'manual', 'import')),
  add column if not exists education jsonb default '[]'::jsonb,
  add column if not exists work_experience jsonb default '[]'::jsonb,
  add column if not exists skills text[] default '{}'::text[],
  add column if not exists certifications jsonb default '[]'::jsonb,
  add column if not exists candidate_references jsonb default '[]'::jsonb,
  add column if not exists withdrawn_at timestamptz,
  add column if not exists withdrawn_reason text,
  add column if not exists status_change_note text,
  add column if not exists onb_link_id uuid,
  add column if not exists employee_id uuid;

-- Expand application status to the full lifecycle pipeline. Includes the
-- legacy values so existing rows + the Interviews page ('new') still work.
alter table public.hr_candidates drop constraint if exists hr_candidates_application_status_check;
alter table public.hr_candidates add constraint hr_candidates_application_status_check
  check (application_status in (
    'new', 'received', 'screening', 'shortlisted',
    'assessment', 'assessment_passed',
    'interview', 'interviewed', 'recommended',
    'offer', 'offer_accepted', 'offer_declined',
    'guarantor', 'onboarding',
    'hired', 'withdrawn', 'rejected'
  ));

create index if not exists idx_hr_candidates_token on public.hr_candidates(application_token_hash);
create index if not exists idx_hr_candidates_job_status on public.hr_candidates(job_id, application_status);
create index if not exists idx_hr_candidates_applied_role on public.hr_candidates(applied_role);

-- Status history (immutable transition log)
create table if not exists public.hr_candidate_status_history (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.hr_candidates(id) on delete cascade,
  from_status text,
  to_status text not null,
  changed_by uuid references auth.users(id) on delete set null,
  changed_by_name text,
  note text,
  created_at timestamptz default now()
);
alter table public.hr_candidate_status_history enable row level security;
create index if not exists idx_candidate_status_history_c on public.hr_candidate_status_history(candidate_id);

-- Auto-audit every status transition (trigger, security definer — safe
-- against RLS recursion since it only INSERTs into history).
create or replace function public.hr_candidates_status_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_actor text;
begin
  if new.application_status is distinct from old.application_status then
    select coalesce(full_name, '') into v_actor from public.profiles where id = auth.uid();
    insert into public.hr_candidate_status_history
      (candidate_id, from_status, to_status, changed_by, changed_by_name, note)
    values (old.id, old.application_status, new.application_status,
            auth.uid(), v_actor, coalesce(new.status_change_note, ''));
  end if;
  return new;
end; $$;
drop trigger if exists trg_hr_candidates_status_audit on public.hr_candidates;
create trigger trg_hr_candidates_status_audit
  after update on public.hr_candidates
  for each row execute function public.hr_candidates_status_audit();

-- HR notes attached to a candidate
create table if not exists public.hr_candidate_notes (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.hr_candidates(id) on delete cascade,
  note text not null,
  author_id uuid references auth.users(id) on delete set null,
  author_name text,
  created_at timestamptz default now()
);
alter table public.hr_candidate_notes enable row level security;
create index if not exists idx_candidate_notes_c on public.hr_candidate_notes(candidate_id);

-- ============================================================
-- 3. SARA SCREENING — per-job criteria + auditable results
-- ============================================================
create table if not exists public.hr_screening_configs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.hr_jobs(id) on delete cascade,
  version int not null default 1,
  active boolean not null default true,
  weights jsonb not null default '{}'::jsonb,
  min_overall numeric(5,2) not null default 60,
  min_components jsonb not null default '{}'::jsonb,
  mandatory_requirements jsonb not null default '[]'::jsonb,
  preferred_requirements jsonb not null default '[]'::jsonb,
  required_qualifications jsonb not null default '[]'::jsonb,
  required_certifications jsonb not null default '[]'::jsonb,
  assessment_threshold numeric(5,2),
  experience_threshold int default 2,
  assessment_flag_tolerance int default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  unique (job_id, version)
);
alter table public.hr_screening_configs enable row level security;
create index if not exists idx_screening_configs_job on public.hr_screening_configs(job_id, active);

create table if not exists public.candidate_screening_results (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.hr_candidates(id) on delete cascade,
  job_id uuid references public.hr_jobs(id) on delete set null,
  config_version int default 1,
  config_snapshot jsonb not null default '{}'::jsonb,
  components jsonb not null default '{}'::jsonb,
  overall_score numeric(5,2),
  cv_match numeric(5,2),
  experience_match numeric(5,2),
  assessment_score numeric(5,2),
  interview_score numeric(5,2),
  skills_match numeric(5,2),
  flags jsonb not null default '[]'::jsonb,
  strengths jsonb not null default '[]'::jsonb,
  concerns jsonb not null default '[]'::jsonb,
  summary text,
  detailed_analysis jsonb not null default '{}'::jsonb,
  recommended_action text check (recommended_action in
    ('recommended_interview', 'recommended_offer', 'assessment_needed', 'manual_review', 'not_recommended')),
  ai_generated boolean not null default false,
  ai_error text,
  hr_decision text check (hr_decision in ('proceed', 'hold', 'reject')),
  hr_decision_by uuid references auth.users(id) on delete set null,
  hr_decision_at timestamptz,
  hr_decision_notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);
alter table public.candidate_screening_results enable row level security;
create index if not exists idx_screening_results_c on public.candidate_screening_results(candidate_id);
create index if not exists idx_screening_results_job on public.candidate_screening_results(job_id);
create index if not exists idx_screening_results_created on public.candidate_screening_results(created_at);

-- ============================================================
-- 4. ASSESSMENT TEMPLATES + QUESTION BANK
-- ============================================================
create table if not exists public.assessment_templates (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  job_id uuid references public.hr_jobs(id) on delete set null,
  description text,
  category text default 'technical'
    check (category in ('technical', 'behavioral', 'practical', 'psychometric', 'aptitude')),
  source text default 'manual' check (source in ('manual', 'sara', 'import')),
  instructions text,
  status text default 'draft' check (status in ('draft', 'published', 'archived')),
  duration_minutes int default 30,
  pass_mark numeric(5,2) default 60,
  max_questions int,
  shuffle_questions boolean default false,
  randomization boolean default false,
  version int default 1,
  anti_cheat jsonb not null default
    '{"max_flags":3,"flag_severity":"high","close_on_flag":true,"require_hr_review":false,"retake_limit":0,"retake_time_hours":48,"keep_previous_attempt":true,"track_copy_paste":true,"track_context_menu":true,"track_fullscreen":true,"inactivity_timeout_minutes":10}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table public.assessment_templates enable row level security;
create index if not exists idx_assessment_templates_status on public.assessment_templates(status);

create table if not exists public.assessment_template_questions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.assessment_templates(id) on delete cascade,
  question_text text not null,
  question_type text not null check (question_type in
    ('multiple_choice', 'multiple_select', 'true_false', 'short_answer',
     'long_answer', 'numerical', 'scenario', 'ranking', 'file_upload')),
  options jsonb default '[]'::jsonb,
  correct_answer jsonb,
  marks numeric(6,2) not null default 1,
  difficulty text default 'medium' check (difficulty in ('easy', 'medium', 'hard')),
  competency text,
  display_order int default 0,
  created_at timestamptz default now()
);
alter table public.assessment_template_questions enable row level security;
create index if not exists idx_question_template on public.assessment_template_questions(template_id);

-- ============================================================
-- 5. HR ASSESSMENTS (candidate assignment) — extend existing table
-- ============================================================
alter table public.hr_assessments
  add column if not exists template_id uuid references public.assessment_templates(id) on delete set null,
  add column if not exists job_id uuid references public.hr_jobs(id) on delete set null,
  add column if not exists invitation_token_hash text unique,
  add column if not exists expires_at timestamptz,
  add column if not exists started_at timestamptz,
  add column if not exists attempt_count int default 0,
  add column if not exists retake_limit int default 0,
  add column if not exists retake_time_hours numeric default 48,
  add column if not exists keep_previous_attempt boolean default true,
  add column if not exists notification_status text default 'pending'
    check (notification_status in ('pending', 'sent', 'failed'));

alter table public.hr_assessments
  add column if not exists updated_at timestamptz default now();

alter table public.hr_assessments drop constraint if exists hr_assessments_status_check;
alter table public.hr_assessments add constraint hr_assessments_status_check
  check (status in ('pending', 'in_progress', 'completed', 'cancelled', 'flagged', 'expired'));

-- Align assessment_type with the template category set (incl. aptitude).
alter table public.hr_assessments drop constraint if exists hr_assessments_assessment_type_check;
alter table public.hr_assessments add constraint hr_assessments_assessment_type_check
  check (assessment_type in ('technical', 'behavioral', 'practical', 'psychometric', 'aptitude'));

create index if not exists idx_hr_assessments_invite on public.hr_assessments(invitation_token_hash);
create index if not exists idx_hr_assessments_template on public.hr_assessments(template_id);

-- ============================================================
-- 6. ASSESSMENT ATTEMPTS (immutable) + ANSWERS
-- ============================================================
create table if not exists public.assessment_attempts (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.hr_assessments(id) on delete set null,
  candidate_id uuid references public.hr_candidates(id) on delete set null,
  job_id uuid references public.hr_jobs(id) on delete set null,
  attempt_number int not null,
  status text not null default 'in_progress' check (status in
    ('started', 'in_progress', 'submitted', 'auto_submitted', 'flagged', 'expired', 'aborted', 'closed')),
  score numeric(6,2),
  max_score numeric(6,2),
  percentage numeric(5,2),
  passed boolean,
  flagged boolean default false,
  flags_count int default 0,
  questions_count int default 0,
  answered_count int default 0,
  started_at timestamptz default now(),
  submitted_at timestamptz,
  completed_at timestamptz,
  close_reason text,
  review_status text default 'pending' check (review_status in
    ('pending', 'reviewed', 'approved', 'invalidated', 'retake_approved')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_notes text,
  created_at timestamptz default now(),
  unique (assignment_id, attempt_number)
);
alter table public.assessment_attempts enable row level security;
create index if not exists idx_attempts_assignment on public.assessment_attempts(assignment_id);
create index if not exists idx_attempts_candidate on public.assessment_attempts(candidate_id);

create table if not exists public.assessment_attempt_answers (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.assessment_attempts(id) on delete cascade,
  question_id uuid references public.assessment_template_questions(id) on delete set null,
  answer jsonb,
  is_correct boolean,
  marks_earned numeric(6,2) default 0,
  answered_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (attempt_id, question_id)
);
alter table public.assessment_attempt_answers enable row level security;
create index if not exists idx_attempt_answers_attempt on public.assessment_attempt_answers(attempt_id);

-- ============================================================
-- 7. ANTI-CHEAT MONITORING EVENTS — extend the existing table
-- ============================================================
alter table public.assessment_monitoring_events
  add column if not exists attempt_id uuid references public.assessment_attempts(id) on delete cascade,
  add column if not exists severity text default 'low' check (severity in ('low', 'medium', 'high')),
  add column if not exists sequence_number int default 0;

-- The legacy events table FK'd candidate_id to auth.users — but the career
-- flow stores hr_candidates. Align it with assessment_attempts.candidate_id.
alter table public.assessment_monitoring_events
  drop constraint if exists assessment_monitoring_events_candidate_id_fkey;
alter table public.assessment_monitoring_events
  add constraint assessment_monitoring_events_candidate_id_fkey
  foreign key (candidate_id) references public.hr_candidates(id) on delete set null;

alter table public.assessment_monitoring_events drop constraint if exists assessment_monitoring_events_event_type_check;
alter table public.assessment_monitoring_events add constraint assessment_monitoring_events_event_type_check
  check (event_type in (
    'tab_visibility_change', 'tab_hidden', 'tab_visible',
    'window_blur', 'window_focus', 'page_hidden', 'page_visible',
    'copy_attempt', 'paste_attempt', 'cut_attempt', 'context_menu',
    'fullscreen_exit', 'fullscreen_enter', 'multiple_fullscreen_exit',
    'mouse_leave', 'suspicious_activity', 'repeated_navigation',
    'excessive_inactivity', 'rapid_focus_changes', 'flag_threshold_reached',
    'attempt_started', 'attempt_submitted', 'attempt_auto_closed', 'restored'
  ));

create index if not exists idx_mon_events_attempt on public.assessment_monitoring_events(attempt_id);
create index if not exists idx_mon_events_seq on public.assessment_monitoring_events(attempt_id, sequence_number);

-- ============================================================
-- 8. RETAKE REQUESTS
-- ============================================================
create table if not exists public.assessment_retake_requests (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.assessment_attempts(id) on delete cascade,
  assignment_id uuid not null references public.hr_assessments(id) on delete cascade,
  candidate_id uuid references public.hr_candidates(id) on delete cascade,
  job_id uuid references public.hr_jobs(id) on delete set null,
  attempt_number int,
  reason text not null,
  status text default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  requested_at timestamptz default now()
);
alter table public.assessment_retake_requests enable row level security;
create index if not exists idx_retake_status on public.assessment_retake_requests(status, requested_at);

-- ============================================================
-- 9. INTERVIEWS — recommendation + score + round + questions
-- ============================================================
alter table public.hr_interviews
  add column if not exists recommendation text check (recommendation in ('proceed', 'hold', 'reject')),
  add column if not exists score numeric(5,2),
  add column if not exists interview_round int default 1;

create table if not exists public.interview_questions (
  id uuid primary key default gen_random_uuid(),
  interview_id uuid not null references public.hr_interviews(id) on delete cascade,
  question text not null,
  interviewer_id uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);
alter table public.interview_questions enable row level security;
create index if not exists idx_interview_questions_i on public.interview_questions(interview_id);

-- ============================================================
-- 10. OFFER LETTERS — extend + templates
-- ============================================================
-- Offer letter templates with {{placeholders}} (created FIRST so the
-- offer_letters FK below can reference it).
create table if not exists public.offer_letter_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  subject text,
  body text not null,
  is_default boolean default false,
  active boolean default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table public.offer_letter_templates enable row level security;

alter table public.offer_letters
  add column if not exists offer_number text,
  add column if not exists token_hash text unique,
  add column if not exists job_id uuid references public.hr_jobs(id) on delete set null,
  add column if not exists company_name text default 'Infinity Bank',
  add column if not exists department text,
  add column if not exists branch text,
  add column if not exists reporting_manager text,
  add column if not exists start_date date,
  add column if not exists probation_months int default 3,
  add column if not exists annual_salary numeric(14,2),
  add column if not exists monthly_salary numeric(14,2),
  add column if not exists mid_month_salary numeric(14,2),
  add column if not exists end_month_salary numeric(14,2),
  add column if not exists allowances jsonb default '[]'::jsonb,
  add column if not exists benefits text,
  add column if not exists working_hours text,
  add column if not exists leave_entitlement text,
  add column if not exists conditions text,
  add column if not exists other_terms text,
  add column if not exists acceptance_deadline date,
  add column if not exists template_id uuid references public.offer_letter_templates(id) on delete set null,
  add column if not exists body_content text,
  add column if not exists version int default 1,
  add column if not exists generated_by text default 'manual' check (generated_by in ('template', 'manual', 'sara')),
  add column if not exists superseded_by uuid,
  add column if not exists issued_by uuid references auth.users(id) on delete set null,
  add column if not exists issued_at timestamptz,
  add column if not exists accepted_at timestamptz,
  add column if not exists declined_at timestamptz,
  add column if not exists decision_metadata jsonb default '{}'::jsonb,
  add column if not exists decision_signature text,
  add column if not exists employee_id uuid references public.employees(id) on delete set null;

create index if not exists idx_offer_token on public.offer_letters(token_hash);
create index if not exists idx_offer_candidate on public.offer_letters(candidate_id);

-- Onboarding links need the candidate/job links so offer-acceptance
-- (public_respond_to_offer / hr_create_onboarding_link_for_offer) can
-- preserve the source application and never orphan a link.
alter table public.employee_onboarding_links
  add column if not exists candidate_id uuid references public.hr_candidates(id) on delete set null,
  add column if not exists job_id uuid references public.hr_jobs(id) on delete set null;
create index if not exists idx_onb_links_candidate on public.employee_onboarding_links(candidate_id);

-- ============================================================
-- 11. PAYROLL COMPONENTS + EMPLOYEE PACKAGES + SNAPSHOTS
-- ============================================================
create table if not exists public.payroll_salary_components (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  component_type text not null check (component_type in ('allowance', 'deduction')),
  basis text default 'percentage' check (basis in ('percentage', 'fixed')),
  rate numeric(10,4),
  taxable boolean default true,
  recurring boolean default true,
  payment_schedule text default 'both' check (payment_schedule in ('mid_month', 'end_month', 'both')),
  category text default 'other' check (category in ('basic', 'housing', 'transport', 'other')),
  active boolean default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table public.payroll_salary_components enable row level security;

create table if not exists public.employee_salary_packages (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  component_id uuid not null references public.payroll_salary_components(id) on delete cascade,
  amount numeric(14,2),
  rate numeric(10,4),
  effective_date date default current_date,
  active boolean default true,
  snapshot jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  unique (employee_id, component_id)
);
alter table public.employee_salary_packages enable row level security;
create index if not exists idx_salary_packages_emp on public.employee_salary_packages(employee_id);

create table if not exists public.employee_salary_snapshots (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  period_label text,
  gross_annual numeric(14,2) default 0,
  gross_monthly numeric(14,2) default 0,
  basic_monthly numeric(14,2) default 0,
  allowances_total numeric(14,2) default 0,
  deductions_total numeric(14,2) default 0,
  tax_paye numeric(14,2) default 0,
  pension numeric(14,2) default 0,
  other_deductions numeric(14,2) default 0,
  net_monthly numeric(14,2) default 0,
  mid_month numeric(14,2) default 0,
  end_month numeric(14,2) default 0,
  components jsonb not null default '{}'::jsonb,
  calc_timestamp timestamptz default now(),
  unique (employee_id, period_label)
);
alter table public.employee_salary_snapshots enable row level security;

-- ============================================================
-- 12. STORAGE — career CV bucket (private, token-free path upload)
-- ============================================================
insert into storage.buckets (id, name, public)
values ('career', 'career', false)
on conflict (id) do nothing;

-- Anonymous candidates may upload a CV under career/cvs/...
drop policy if exists "career_cv_anon_upload" on storage.objects;
create policy "career_cv_anon_upload" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'career' and (storage.foldername(name))[1] = 'cvs');

-- HR staff may read CVs (signed URLs are generated from this policy)
drop policy if exists "career_cv_hr_read" on storage.objects;
create policy "career_cv_hr_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'career');

-- ============================================================
-- 13. RLS POLICIES (new tables)
-- ============================================================
-- Integration helper: are we an HR-staff member?
create or replace function public.is_hr_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer');
$$;

do $$
declare
  v_role text;
begin
  select public.current_role() into v_role; -- no-op, just validates helper compiles
end $$;

-- hr_candidate_status_history / notes
drop policy if exists "cand_status_history_hr" on public.hr_candidate_status_history;
create policy "cand_status_history_hr" on public.hr_candidate_status_history
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

drop policy if exists "hr_candidate_notes_hr_select" on public.hr_candidate_notes;
create policy "hr_candidate_notes_hr_select" on public.hr_candidate_notes
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

drop policy if exists "hr_candidate_notes_hr_insert" on public.hr_candidate_notes;
create policy "hr_candidate_notes_hr_insert" on public.hr_candidate_notes
  for insert with check (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

-- screening configs + results
drop policy if exists "screening_configs_hr_select" on public.hr_screening_configs;
create policy "screening_configs_hr_select" on public.hr_screening_configs
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

drop policy if exists "screening_results_hr_select" on public.candidate_screening_results;
create policy "screening_results_hr_select" on public.candidate_screening_results
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

-- assessment templates + questions
drop policy if exists "assessment_templates_hr_select" on public.assessment_templates;
create policy "assessment_templates_hr_select" on public.assessment_templates
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

drop policy if exists "assessment_templates_hr_write" on public.assessment_templates;
create policy "assessment_templates_hr_write" on public.assessment_templates
  for all using (public.current_role() in ('super_admin', 'admin', 'hr_manager'))
  with check (public.current_role() in ('super_admin', 'admin', 'hr_manager'));

drop policy if exists "assessment_tq_hr_select" on public.assessment_template_questions;
create policy "assessment_tq_hr_select" on public.assessment_template_questions
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

drop policy if exists "assessment_tq_hr_write" on public.assessment_template_questions;
create policy "assessment_tq_hr_write" on public.assessment_template_questions
  for all using (public.current_role() in ('super_admin', 'admin', 'hr_manager'))
  with check (public.current_role() in ('super_admin', 'admin', 'hr_manager'));

-- hr_assessments: add the missing UPDATE/INSERT eligibility for the
-- token-gated attempt flow (server side). HR can read/write assignments.
drop policy if exists "hr_assessments_hr_update" on public.hr_assessments;
create policy "hr_assessments_hr_update" on public.hr_assessments
  for update using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'))
  with check (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

-- attempts: HR reads only (anything else happens through token RPCs)
drop policy if exists "attempts_hr_select" on public.assessment_attempts;
create policy "attempts_hr_select" on public.assessment_attempts
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

drop policy if exists "attempt_answers_hr_select" on public.assessment_attempt_answers;
create policy "attempt_answers_hr_select" on public.assessment_attempt_answers
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

-- retake requests
drop policy if exists "retake_requests_hr_select" on public.assessment_retake_requests;
create policy "retake_requests_hr_select" on public.assessment_retake_requests
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

-- offer templates
drop policy if exists "offer_templates_hr_select" on public.offer_letter_templates;
create policy "offer_templates_hr_select" on public.offer_letter_templates
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

drop policy if exists "offer_templates_hr_write" on public.offer_letter_templates;
create policy "offer_templates_hr_write" on public.offer_letter_templates
  for all using (public.current_role() in ('super_admin', 'admin', 'hr_manager'))
  with check (public.current_role() in ('super_admin', 'admin', 'hr_manager'));

-- payroll components / packages / snapshots
drop policy if exists "payroll_components_hr_select" on public.payroll_salary_components;
create policy "payroll_components_hr_select" on public.payroll_salary_components
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

drop policy if exists "payroll_components_hr_write" on public.payroll_salary_components;
create policy "payroll_components_hr_write" on public.payroll_salary_components
  for all using (public.current_role() in ('super_admin', 'admin', 'hr_manager'))
  with check (public.current_role() in ('super_admin', 'admin', 'hr_manager'));

drop policy if exists "salary_packages_hr_select" on public.employee_salary_packages;
create policy "salary_packages_hr_select" on public.employee_salary_packages
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

drop policy if exists "salary_snapshots_hr_select" on public.employee_salary_snapshots;
create policy "salary_snapshots_hr_select" on public.employee_salary_snapshots
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

-- interview questions: interviewer or HR
drop policy if exists "interview_questions_select" on public.interview_questions;
create policy "interview_questions_select" on public.interview_questions
  for select using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
  );

drop policy if exists "interview_questions_insert" on public.interview_questions;
create policy "interview_questions_insert" on public.interview_questions
  for insert with check (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

-- ============================================================
-- 14. RPC HELPERS (secure token + audit helpers)
-- ============================================================
-- gen_random_bytes comes from pgcrypto. Hosted Supabase ships it enabled;
-- ensure local dev / fresh projects have it too (idempotent).
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create or replace function public.generate_secure_token()
returns text language sql stable set search_path = public, extensions as $$
  select replace(replace(replace(encode(extensions.gen_random_bytes(32), 'base64'), '+', '-'), '/', '_'), '=', '');
$$;

create or replace function public.hr_audit(p_action text, p_entity text, p_id text, p_details text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_actor text;
begin
  select coalesce(full_name, '') into v_actor from public.profiles where id = auth.uid();
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (p_action, p_entity, p_id, v_actor, p_details, 'info');
end; $$;

-- ============================================================
-- 15. PUBLIC RPCs — anonymous candidate flows
-- ============================================================

-- List published jobs (no auth required). SECURITY DEFINER so anonymous
-- visitors can read published adverts without any direct table grants
-- (works on hosted + local regardless of default-privilege grants).
create or replace function public.public_get_published_jobs()
returns setof public.hr_jobs
language sql stable security definer set search_path = public as $$
  select * from public.hr_jobs
  where status = 'published'
    and (application_deadline is null or application_deadline >= current_date)
  order by published_at desc;
$$;
grant execute on function public.public_get_published_jobs() to anon, authenticated;

-- Fetch one published job by public token. SECURITY DEFINER for the same
-- reason as public_get_published_jobs.
create or replace function public.public_get_job_by_token(p_token text)
returns setof public.hr_jobs
language sql stable security definer set search_path = public as $$
  select * from public.hr_jobs
  where status = 'published' and public_token = p_token
    and (application_deadline is null or application_deadline >= current_date);
$$;
grant execute on function public.public_get_job_by_token(text) to anon, authenticated;

-- Submit a public job application. SECURITY DEFINER so anonymous
-- candidates can apply without touching rows beyond their own record.
-- p_application jsonb may include:
--   full_name*, email*, phone, current_company, years_experience,
--   cover_letter, education[], work_experience[], skills[], certifications[],
--   candidate_references[], branch
-- plus an optional CV upload (path under 'career/cvs/<folder>/...').
create or replace function public.public_apply_for_job(
  p_job_token text,
  p_application jsonb,
  p_cv_path text default null,
  p_cv_name text default null,
  p_cv_size int default null,
  p_cv_mime text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_job record;
  v_candidate_id uuid;
  v_name text := nullif(btrim(coalesce(p_application ->> 'full_name', '')), '');
  v_email text := lower(btrim(coalesce(p_application ->> 'email', '')));
  v_phone text := nullif(btrim(coalesce(p_application ->> 'phone', '')), '');
  v_token text := public.generate_secure_token();
  v_existing uuid;
  v_notify uuid;
begin
  if public.current_role() not in ('customer', 'staff') and public.current_role() is not null then
    null; -- allow any authenticated/anon visitor to apply
  end if;
  if v_name is null then
    raise exception 'Full name is required';
  end if;
  if v_email is null and v_phone is null then
    raise exception 'An email or phone number is required';
  end if;

  select * into v_job from public.hr_jobs
  where public_token = p_job_token and status = 'published';
  if v_job.id is null then
    raise exception 'Invalid or unpublished job';
  end if;
  if v_job.application_deadline is not null and v_job.application_deadline < current_date then
    raise exception 'The application deadline for this job has passed';
  end if;

  -- Prevent duplicate applications for the same job (same email OR phone).
  select id into v_existing from public.hr_candidates
  where job_id = v_job.id
    and ((v_email <> '' and email = v_email) or (v_phone is not null and phone = v_phone))
  limit 1;
  if v_existing is not null then
    raise exception 'You have already applied for this job';
  end if;

  insert into public.hr_candidates (
    job_id, full_name, email, phone, current_company, years_experience,
    cover_letter, cv_file_path, applied_role, department, branch,
    application_status, application_source, education, work_experience,
    skills, certifications, candidate_references, application_token_hash
  ) values (
    v_job.id, v_name, nullif(v_email, ''), v_phone,
    nullif(btrim(coalesce(p_application ->> 'current_company', '')), ''),
    nullif(coalesce((p_application ->> 'years_experience')::text, ''), '')::int,
    btrim(coalesce(p_application ->> 'cover_letter', '')),
    p_cv_path,
    v_job.job_title,
    v_job.department,
    coalesce(nullif(btrim(coalesce(p_application ->> 'branch', '')), ''), v_job.branch),
    'received', 'portal',
    coalesce(p_application -> 'education', '[]'::jsonb),
    coalesce(p_application -> 'work_experience', '[]'::jsonb),
    coalesce(array(select jsonb_array_elements_text(coalesce(p_application -> 'skills', '[]'::jsonb))), '{}'::text[]),
    coalesce(p_application -> 'certifications', '[]'::jsonb),
    coalesce(p_application -> 'candidate_references', '[]'::jsonb),
    md5(v_token)
  ) returning id into v_candidate_id;

  if p_cv_path is not null then
    insert into public.documents (entity_type, entity_id, document_type, file_name, file_path, file_size, mime_type, is_required, uploaded_by)
    values ('hr_candidate', v_candidate_id, 'cv', coalesce(p_cv_name, 'cv.pdf'), p_cv_path,
            p_cv_size, p_cv_mime, true, null);
  end if;

  insert into public.hr_candidate_status_history (candidate_id, from_status, to_status, note)
  values (v_candidate_id, null, 'received', 'Application submitted via public job advert');

  select created_by into v_notify from public.hr_jobs where id = v_job.id;
  if v_notify is not null then
    insert into public.notifications (user_id, title, message, type, link)
    values (v_notify, 'New job application', format('%s applied for %s', v_name, v_job.job_title),
            'hr', '/recruitment');
  end if;

  perform public.hr_audit('APPLICATION_SUBMITTED', 'Candidate', v_candidate_id::text,
    format('Public application by %s for %s', v_name, v_job.job_title));

  return jsonb_build_object('ok', true, 'candidate_id', v_candidate_id,
    'portal_token', v_token, 'job_url', '/careers/jobs/' || v_job.public_token);
end; $$;
grant execute on function public.public_apply_for_job(text, jsonb, text, text, int, text)
  to anon, authenticated;

-- Candidate portal — returns ONLY the candidate's own data.
create or replace function public.public_get_candidate_portal(p_token text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_candidate public.hr_candidates;
  v_job public.hr_jobs;
  v_screen jsonb := '{}'::jsonb;
  v_assessments jsonb := '[]'::jsonb;
  v_offers jsonb := '[]'::jsonb;
  v_history jsonb := '[]'::jsonb;
begin
  select * into v_candidate from public.hr_candidates
  where application_token_hash = md5(p_token);
  if v_candidate.id is null then
    raise exception 'Invalid application token';
  end if;

  if v_candidate.job_id is not null then
    select * into v_job from public.hr_jobs where id = v_candidate.job_id;
  end if;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb) into v_history
  from (select * from public.hr_candidate_status_history where candidate_id = v_candidate.id) t;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'test_name', a.test_name, 'status', a.status, 'score', a.score,
    'pass_score', coalesce((select t.pass_mark from public.assessment_templates t where t.id = a.template_id), a.pass_score),
    'template_title', (select t.title from public.assessment_templates t where t.id = a.template_id),
    'expires_at', a.expires_at, 'created_at', a.created_at,
    'attempts', coalesce((select jsonb_agg(jsonb_build_object(
        'id', at2.id, 'attempt_number', at2.attempt_number, 'status', at2.status,
        'percentage', at2.percentage, 'passed', at2.passed, 'flagged', at2.flagged,
        'flags_count', at2.flags_count, 'submitted_at', at2.submitted_at,
        'review_status', at2.review_status)
      order by at2.attempt_number) from public.assessment_attempts at2 where at2.assignment_id = a.id), '[]'::jsonb)
  ) order by a.created_at desc), '[]'::jsonb) into v_assessments
  from public.hr_assessments a where a.candidate_id = v_candidate.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', o.id, 'candidate_name', o.candidate_name, 'position', o."position",
    'annual_salary', o.annual_salary, 'monthly_salary', o.monthly_salary,
    'status', o.status, 'version', o.version, 'issue_date', o.issue_date,
    'start_date', o.start_date, 'accepted_at', o.accepted_at, 'declined_at', o.declined_at
  ) order by o.created_at desc), '[]'::jsonb) into v_offers
  from public.offer_letters o where o.candidate_id = v_candidate.id;

  return jsonb_build_object(
    'candidate', to_jsonb(v_candidate),
    'job', case when v_job.id is not null then to_jsonb(v_job) else null end,
    'latest_screening', v_screen,
    'assessments', v_assessments,
    'offers', v_offers,
    'status_history', v_history
  );
end; $$;
grant execute on function public.public_get_candidate_portal(text) to anon, authenticated;

-- Assessment: fetch assignment + template intro (no answers yet).
create or replace function public.public_get_assessment_by_token(p_token text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_assignment public.hr_assessments;
  v_template public.assessment_templates;
  v_candidate public.hr_candidates;
  v_attempts jsonb;
begin
  select * into v_assignment from public.hr_assessments
  where invitation_token_hash = md5(p_token);
  if v_assignment.id is null then
    raise exception 'Invalid assessment invitation';
  end if;
  if v_assignment.expires_at is not null and v_assignment.expires_at < now() then
    update public.hr_assessments set status = 'expired', updated_at = now()
    where id = v_assignment.id;
    raise exception 'This assessment invitation has expired';
  end if;

  select * into v_template from public.assessment_templates where id = v_assignment.template_id;
  if v_template.id is null or v_template.status <> 'published' then
    raise exception 'This assessment is not available';
  end if;

  select * into v_candidate from public.hr_candidates where id = v_assignment.candidate_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', at2.id, 'attempt_number', at2.attempt_number, 'status', at2.status,
    'percentage', at2.percentage, 'passed', at2.passed, 'flagged', at2.flagged,
    'flags_count', at2.flags_count, 'submitted_at', at2.submitted_at, 'review_status', at2.review_status)
    order by at2.attempt_number), '[]'::jsonb) into v_attempts
  from public.assessment_attempts at2 where at2.assignment_id = v_assignment.id;

  return jsonb_build_object(
    'assignment_id', v_assignment.id,
    'candidate', case when v_candidate.id is not null then to_jsonb(v_candidate) else null end,
    'assignment', to_jsonb(v_assignment),
    'template', to_jsonb(v_template),
    'attempts', v_attempts
  );
end; $$;
grant execute on function public.public_get_assessment_by_token(text) to anon, authenticated;

-- Start / resume an attempt. Returns questions WITHOUT correct answers.
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
  v_resume uuid;
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

    insert into public.assessment_attempts
      (assignment_id, candidate_id, job_id, attempt_number, status)
    values (
      v_assignment.id, v_assignment.candidate_id, v_assignment.job_id,
      coalesce(v_assignment.attempt_count, 0) + 1, 'in_progress'
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

  select coalesce(jsonb_agg(
    jsonb_build_object('id', q.id, 'question_text', q.question_text, 'question_type', q.question_type,
      'options', q.options, 'marks', q.marks, 'difficulty', q.difficulty,
      'competency', q.competency, 'display_order', q.display_order)
    order by q.display_order, q.created_at), '[]'::jsonb) into v_questions
  from public.assessment_template_questions q
  where q.template_id = v_template.id;

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
    'resumed', (v_resume is not null)
  );
end; $$;
grant execute on function public.public_start_assessment_attempt(text) to anon, authenticated;

-- Save one answer (autosave path). Upsert, keeps history of latest value.
create or replace function public.public_save_assessment_answer(
  p_token text, p_attempt_id uuid, p_question_id uuid, p_answer jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_attempt public.assessment_attempts;
  v_answer_count int;
  v_new boolean;
begin
  select * into v_attempt from public.assessment_attempts where id = p_attempt_id;
  if v_attempt.id is null then
    raise exception 'Attempt not found';
  end if;
  -- Verify the token owns this attempt
  if (select invitation_token_hash from public.hr_assessments where id = v_attempt.assignment_id) <> md5(p_token) then
    raise exception 'Token does not match this attempt';
  end if;
  if v_attempt.status not in ('started', 'in_progress') then
    raise exception 'This attempt is no longer in progress';
  end if;

  insert into public.assessment_attempt_answers (attempt_id, question_id, answer, updated_at)
  values (p_attempt_id, p_question_id, p_answer, now())
  on conflict (attempt_id, question_id)
  do update set answer = excluded.answer, updated_at = now();

  select count(*) into v_answer_count from public.assessment_attempt_answers
  where attempt_id = p_attempt_id and answer is not null;

  v_new := (select exists(select 1 from public.assessment_attempt_answers
            where attempt_id = p_attempt_id and question_id = p_question_id and answer is not null));

  update public.assessment_attempts
  set answered_count = v_answer_count, status = 'in_progress'
  where id = p_attempt_id;

  return jsonb_build_object('ok', true, 'answered_count', v_answer_count);
end; $$;
grant execute on function public.public_save_assessment_answer(text, uuid, uuid, jsonb)
  to anon, authenticated;

-- Record an anti-cheat/monitoring event. Applies template flag policy.
create or replace function public.public_record_assessment_event(
  p_token text, p_attempt_id uuid, p_event_type text, p_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_attempt public.assessment_attempts;
  v_assignment public.hr_assessments;
  v_template public.assessment_templates;
  v_severity text := 'low';
  v_seq int := 0;
  v_flags_count int := 0;
  v_max_flags int := 3;
  v_close_on_flag boolean := true;
  v_require_review boolean := false;
  v_close_reason text;
begin
  select * into v_attempt from public.assessment_attempts where id = p_attempt_id;
  if v_attempt.id is null then
    raise exception 'Attempt not found';
  end if;
  if (select invitation_token_hash from public.hr_assessments where id = v_attempt.assignment_id) <> md5(p_token) then
    raise exception 'Token does not match this attempt';
  end if;

  select * into v_assignment from public.hr_assessments where id = v_attempt.assignment_id;
  select * into v_template from public.assessment_templates where id = v_assignment.template_id;

  if p_event_type in ('suspicious_activity', 'repeated_navigation', 'rapid_focus_changes',
                      'multiple_fullscreen_exit', 'excessive_inactivity') then
    v_severity := 'high';
  elsif p_event_type in ('paste_attempt', 'context_menu') then
    v_severity := 'medium';
  end if;

  select coalesce(max(sequence_number), 0) + 1 into v_seq
  from public.assessment_monitoring_events where attempt_id = p_attempt_id;

  insert into public.assessment_monitoring_events
    (attempt_id, assessment_id, candidate_id, event_type, severity, sequence_number, event_data)
  values (v_attempt.id, v_assignment.id, v_assignment.candidate_id, p_event_type, v_severity, v_seq, p_metadata);

  -- Flag policy
  v_flags_count := v_attempt.flags_count + case when v_severity = 'high' then 1 else 0 end;
  v_max_flags := coalesce((v_template.anti_cheat ->> 'max_flags')::int, 3);
  v_close_on_flag := coalesce((v_template.anti_cheat ->> 'close_on_flag')::bool, false);
  v_require_review := coalesce((v_template.anti_cheat ->> 'require_hr_review')::bool, false);

  update public.assessment_attempts
  set flags_count = v_flags_count,
      flagged = (v_flags_count >= v_max_flags)
  where id = p_attempt_id;

  if v_flags_count >= v_max_flags and (v_close_on_flag or v_require_review) then
    v_close_reason := format('Anti-cheat flag threshold reached (%s/%s flags)', v_flags_count, v_max_flags);
    update public.assessment_attempts
      set status = 'flagged', submitted_at = now(), completed_at = now(),
          close_reason = v_close_reason, flagged = true
      where id = p_attempt_id;
    update public.hr_assessments set status = 'flagged', updated_at = now()
      where id = v_assignment.id;

    v_seq := v_seq + 1;
    insert into public.assessment_monitoring_events
      (attempt_id, assessment_id, candidate_id, event_type, severity, sequence_number, event_data)
    values (v_attempt.id, v_assignment.id, v_assignment.candidate_id, 'attempt_auto_closed', 'high', v_seq,
            jsonb_build_object('reason', v_close_reason));

    return jsonb_build_object('ok', true, 'event_recorded', true, 'flags_count', v_flags_count,
      'max_flags', v_max_flags, 'closed', true, 'close_reason', v_close_reason,
      'require_hr_review', v_require_review);
  end if;

  return jsonb_build_object('ok', true, 'event_recorded', true, 'flags_count', v_flags_count,
    'max_flags', v_max_flags, 'closed', false, 'require_hr_review', v_require_review);
end; $$;
grant execute on function public.public_record_assessment_event(text, uuid, text, jsonb)
  to anon, authenticated;

-- Internal: recompute an attempt's score (used on submit + HR regrade).
create or replace function public.recompute_attempt_score(p_attempt_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_attempt public.assessment_attempts;
  v_total numeric := 0;
  v_earned numeric := 0;
  v_pct numeric;
  v_pass numeric;
begin
  select * into v_attempt from public.assessment_attempts where id = p_attempt_id;
  if v_attempt.id is null then return; end if;

  select coalesce(sum(a.marks_earned), 0),
         coalesce(sum(q.marks), 0), coalesce(max(t.pass_mark), 60)
  into v_earned, v_total, v_pass
  from public.assessment_attempt_answers a
  left join public.assessment_template_questions q on q.id = a.question_id
  left join public.hr_assessments h on h.id = v_attempt.assignment_id
  left join public.assessment_templates t on t.id = h.template_id
  where a.attempt_id = p_attempt_id;

  v_pct := case when coalesce(v_total, 0) > 0 then round(v_earned / v_total * 100, 2) else 0 end;

  update public.assessment_attempts
  set score = v_earned, max_score = v_total, percentage = v_pct,
      passed = (v_pct >= v_pass)
  where id = p_attempt_id;
end; $$;

-- Submit + grade an attempt. p_answers is a map of question_id -> value.
create or replace function public.public_submit_assessment_attempt(
  p_token text, p_attempt_id uuid, p_answers jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_attempt public.assessment_attempts;
  v_assignment public.hr_assessments;
  v_q record;
  v_ans jsonb;
  v_correct boolean;
  v_marks numeric := 0;
  v_q_total numeric := 0;
  v_answer_count int := 0;
  v_pct numeric;
  v_pass numeric;
  v_seq int := 1;
begin
  select * into v_attempt from public.assessment_attempts where id = p_attempt_id;
  if v_attempt.id is null then
    raise exception 'Attempt not found';
  end if;
  if (select invitation_token_hash from public.hr_assessments where id = v_attempt.assignment_id) <> md5(p_token) then
    raise exception 'Token does not match this attempt';
  end if;
  if v_attempt.status not in ('started', 'in_progress') then
    raise exception 'This attempt is no longer in progress';
  end if;

  select * into v_assignment from public.hr_assessments where id = v_attempt.assignment_id;

  for v_q in
    select q.* from public.assessment_template_questions q
    where q.template_id = v_assignment.template_id
  loop
    v_ans := p_answers -> v_q.id::text;
    v_correct := null;
    v_marks := 0;
    v_q_total := v_q_total + coalesce(v_q.marks, 0);

    if v_ans is not null then
      v_answer_count := v_answer_count + 1;
      if v_q.question_type in ('multiple_choice', 'true_false', 'numerical') then
        v_correct := (
          case v_q.question_type
            when 'true_false' then lower(btrim(v_ans::text, '""')) = lower(btrim(v_q.correct_answer::text, '""'))
            when 'numerical' then abs(
                 coalesce(nullif(btrim(v_ans::text, '"'), '')::numeric, 0) -
                 coalesce(nullif(btrim(v_q.correct_answer::text, '"'), '')::numeric, 0)
               ) <= 0.01
            else btrim(v_ans::text, '""') = btrim(coalesce(v_q.correct_answer ->> 0, v_q.correct_answer::text), '""')
          end
        );
      elsif v_q.question_type in ('multiple_select', 'ranking') then
        v_correct := (
          select (select jsonb_agg(e order by ord)
                  from jsonb_array_elements_text(coalesce(v_ans, '[]'::jsonb)) with ordinality t(e, ord))
            is not distinct from v_q.correct_answer
        );
      end if;
      if v_correct is true then
        v_marks := coalesce(v_q.marks, 0);
      end if;
    end if;

    insert into public.assessment_attempt_answers (attempt_id, question_id, answer, is_correct, marks_earned, answered_at)
    values (p_attempt_id, v_q.id, v_ans, v_correct, v_marks, now())
    on conflict (attempt_id, question_id)
    do update set answer = excluded.answer, is_correct = excluded.is_correct,
                  marks_earned = excluded.marks_earned, answered_at = now();
  end loop;

  perform public.recompute_attempt_score(p_attempt_id);
  select * into v_attempt from public.assessment_attempts where id = p_attempt_id;
  v_pct := v_attempt.percentage;
  v_pass := coalesce((select t.pass_mark from public.assessment_templates t
                      join public.hr_assessments h on h.template_id = t.id
                      where h.id = v_assignment.id), 60);

  update public.assessment_attempts
  set status = 'submitted', submitted_at = now(), completed_at = now(),
      answered_count = v_answer_count
  where id = p_attempt_id;

  update public.hr_assessments
  set status = 'completed', score = v_pct, total_score = 100, pass_score = v_pass,
      notes = case when v_pct >= v_pass then 'Passed' else 'Failed' end,
      completed_at = now(), updated_at = now()
  where id = v_assignment.id;

  select coalesce(max(sequence_number), 0) + 1 into v_seq
  from public.assessment_monitoring_events where attempt_id = p_attempt_id;
  insert into public.assessment_monitoring_events
    (attempt_id, assessment_id, candidate_id, event_type, severity, sequence_number, event_data)
  values (p_attempt_id, v_assignment.id, v_assignment.candidate_id, 'attempt_submitted', 'low', v_seq,
          jsonb_build_object('percentage', v_pct, 'passed', v_pct >= v_pass));

  -- Auto-advance pipeline to "assessment_passed" when the candidate passed.
  if v_pct >= v_pass and v_assignment.candidate_id is not null then
    update public.hr_candidates
    set application_status = 'assessment_passed', status_change_note = 'Assessment passed'
    where id = v_assignment.candidate_id
      and application_status in ('assessment', 'screening', 'shortlisted', 'received');
  end if;

  perform public.hr_audit('ASSESSMENT_SUBMITTED', 'AssessmentAttempt', p_attempt_id::text,
    format('Attempt %s scored %s%%', v_attempt.attempt_number, v_pct));

  return jsonb_build_object('ok', true, 'attempt', to_jsonb(v_attempt),
    'percentage', v_pct, 'passed', (v_pct >= v_pass), 'pass_mark', v_pass,
    'questions_count', v_q_total);
end; $$;
grant execute on function public.public_submit_assessment_attempt(text, uuid, jsonb)
  to anon, authenticated;

-- Candidate requests a retake.
create or replace function public.public_request_assessment_retake(p_token text, p_attempt_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_attempt public.assessment_attempts;
  v_request_id uuid;
  v_assignment uuid;
begin
  select * into v_attempt from public.assessment_attempts where id = p_attempt_id;
  if v_attempt.id is null then
    raise exception 'Attempt not found';
  end if;
  if v_attempt.status not in ('flagged', 'submitted', 'auto_submitted') then
    raise exception 'Retake can only be requested for a completed or flagged attempt';
  end if;
  if (select invitation_token_hash from public.hr_assessments where id = v_attempt.assignment_id) <> md5(p_token) then
    raise exception 'Token does not match this attempt';
  end if;
  -- no duplicate pending request
  if exists(select 1 from public.assessment_retake_requests
            where attempt_id = p_attempt_id and status = 'pending') then
    raise exception 'A retake request is already pending review';
  end if;

  select id into v_assignment from public.hr_assessments where id = v_attempt.assignment_id;
  insert into public.assessment_retake_requests
    (attempt_id, assignment_id, candidate_id, job_id, attempt_number, reason)
  values (p_attempt_id, v_assignment, v_attempt.candidate_id, v_attempt.job_id,
          v_attempt.attempt_number, coalesce(nullif(btrim(p_reason), ''), 'No reason provided'))
  returning id into v_request_id;

  perform public.hr_audit('RETAKE_REQUESTED', 'AssessmentAttempt', p_attempt_id::text,
    format('Candidate requested retake of attempt %s', v_attempt.attempt_number));

  return jsonb_build_object('ok', true, 'request_id', v_request_id);
end; $$;
grant execute on function public.public_request_assessment_retake(text, uuid, text)
  to anon, authenticated;

-- Offer — fetch the current offer by its acceptance token.
create or replace function public.public_get_offer_by_token(p_token text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_offer public.offer_letters;
  v_candidate public.hr_candidates;
  v_job public.hr_jobs;
begin
  select * into v_offer from public.offer_letters
  where token_hash = md5(p_token);
  if v_offer.id is null then
    raise exception 'Offer not found or not yet issued';
  end if;
  if v_offer.status not in ('issued', 'accepted') then
    raise exception 'This offer is not active';
  end if;
  if v_offer.superseded_by is not null then
    raise exception 'This offer version has been superseded by a new version';
  end if;

  select * into v_candidate from public.hr_candidates where id = v_offer.candidate_id;
  select * into v_job from public.hr_jobs where id = v_offer.job_id;

  return jsonb_build_object(
    'offer', to_jsonb(v_offer),
    'candidate', case when v_candidate.id is not null then to_jsonb(v_candidate) else null end,
    'job', case when v_job.id is not null then to_jsonb(v_job) else null end
  );
end; $$;
grant execute on function public.public_get_offer_by_token(text) to anon, authenticated;

-- Candidate accepts / declines an offer. On accept an onboarding link is
-- auto-created (candidate_id is preserved on the link so nothing orphans).
create or replace function public.public_respond_to_offer(
  p_token text, p_decision text, p_signature text default null, p_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_offer public.offer_letters;
  v_candidate public.hr_candidates;
  v_job public.hr_jobs;
  v_link uuid;
  v_token text := public.generate_secure_token();
  v_expires timestamptz := now() + interval '7 days';
begin
  if p_decision not in ('accept', 'decline') then
    raise exception 'Decision must be accept or decline';
  end if;

  select * into v_offer from public.offer_letters
  where token_hash = md5(p_token);
  if v_offer.id is null then
    raise exception 'Offer not found';
  end if;
  if v_offer.superseded_by is not null then
    raise exception 'This offer version has been superseded';
  end if;
  if v_offer.status = 'accepted' then
    raise exception 'This offer has already been accepted';
  end if;
  if v_offer.status = 'declined' then
    raise exception 'This offer has already been declined';
  end if;
  if v_offer.status not in ('issued', 'draft') then
    raise exception 'Offer is not active';
  end if;
  if v_offer.acceptance_deadline is not null and v_offer.acceptance_deadline < current_date then
    raise exception 'The acceptance deadline for this offer has passed';
  end if;

  select * into v_candidate from public.hr_candidates where id = v_offer.candidate_id;
  select * into v_job from public.hr_jobs where id = v_offer.job_id;

  if p_decision = 'accept' then
    update public.offer_letters
    set status = 'accepted', accepted_at = now(),
        decision_metadata = p_metadata,
        decision_signature = coalesce(p_signature, ''),
        updated_at = now()
    where id = v_offer.id;

    if v_candidate.id is not null then
      update public.hr_candidates
      set application_status = 'offer_accepted', status_change_note = 'Offer accepted by candidate'
      where id = v_candidate.id;

      -- Auto-create onboarding link so the candidate flows into onboarding.
      if v_candidate.onb_link_id is null then
        insert into public.employee_onboarding_links
          (token_hash, candidate_name, candidate_email, candidate_phone, "position",
           department, branch, employment_type, expiry, expires_at, status, created_by)
        values (md5(v_token), v_candidate.full_name, coalesce(v_candidate.email, ''),
                v_candidate.phone, coalesce(v_job.job_title, v_offer."position"),
                coalesce(v_offer.department, v_candidate.department),
                coalesce(v_offer.branch, v_candidate.branch),
                v_offer.employment_type, v_expires, v_expires, 'PENDING', null)
        returning id into v_link;

        update public.hr_candidates set onb_link_id = v_link where id = v_candidate.id;
        update public.employee_onboarding_links set candidate_id = v_candidate.id, job_id = v_offer.job_id
        where id = v_link;
      end if;

      insert into public.hr_candidate_status_history (candidate_id, from_status, to_status, note)
      values (v_candidate.id, v_offer.status, 'offer_accepted', 'Offer accepted — onboarding link generated');
    end if;

    perform public.hr_audit('OFFER_ACCEPTED', 'OfferLetter', v_offer.id::text,
      format('Offer accepted by %s', coalesce(v_candidate.full_name, 'candidate')));
  else
    update public.offer_letters
    set status = 'declined', declined_at = now(), decision_metadata = p_metadata, updated_at = now()
    where id = v_offer.id;

    if v_candidate.id is not null then
      update public.hr_candidates
      set application_status = 'offer_declined', status_change_note = 'Offer declined by candidate'
      where id = v_candidate.id;
      insert into public.hr_candidate_status_history (candidate_id, from_status, to_status, note)
      values (v_candidate.id, v_offer.status, 'offer_declined', 'Offer declined by candidate');
    end if;

    perform public.hr_audit('OFFER_DECLINED', 'OfferLetter', v_offer.id::text,
      format('Offer declined by %s', coalesce(v_candidate.full_name, 'candidate')));
  end if;

  return jsonb_build_object('ok', true, 'status', p_decision,
    'onboarding_link_generated', (p_decision = 'accept'));
end; $$;
grant execute on function public.public_respond_to_offer(text, text, text, jsonb)
  to anon, authenticated;

-- ============================================================
-- 16. HR RPCs — recruitment/screening/assessment/offer operations
-- ============================================================

-- Safe application status transition (with audit + history via trigger).
create or replace function public.hr_advance_application(p_candidate_id uuid, p_status text, p_note text default null)
returns public.hr_candidates
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_row public.hr_candidates;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized';
  end if;
  update public.hr_candidates
  set application_status = p_status, status_change_note = p_note
  where id = p_candidate_id
  returning * into v_row;
  if v_row.id is null then
    raise exception 'Candidate not found';
  end if;
  perform public.hr_audit('APPLICATION_STATUS_CHANGED', 'Candidate', p_candidate_id::text,
    format('Status changed to %s', p_status));
  return v_row;
end; $$;
grant execute on function public.hr_advance_application(uuid, text, text) to authenticated;

-- Update candidate application/profile data (education, experience, skills…).
create or replace function public.hr_update_candidate_profile(p_candidate_id uuid, p_data jsonb)
returns public.hr_candidates
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_row public.hr_candidates;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized';
  end if;
  update public.hr_candidates set
    full_name = coalesce(nullif(p_data ->> 'full_name', ''), full_name),
    email = coalesce(nullif(p_data ->> 'email', ''), email),
    phone = coalesce(nullif(p_data ->> 'phone', ''), phone),
    current_company = coalesce(nullif(p_data ->> 'current_company', ''), current_company),
    years_experience = coalesce(case when (p_data ->> 'years_experience')::text <> ''
                                     then (p_data ->> 'years_experience')::int else null end, years_experience),
    education = coalesce(p_data -> 'education', education),
    work_experience = coalesce(p_data -> 'work_experience', work_experience),
    skills = case when (p_data -> 'skills') is not null
                   then array(select jsonb_array_elements_text(p_data -> 'skills')) else skills end,
    certifications = coalesce(p_data -> 'certifications', certifications),
    candidate_references = coalesce(p_data -> 'candidate_references', candidate_references)
  where id = p_candidate_id
  returning * into v_row;
  return v_row;
end; $$;
grant execute on function public.hr_update_candidate_profile(uuid, jsonb) to authenticated;

-- Add an HR note to a candidate.
create or replace function public.hr_add_candidate_note(p_candidate_id uuid, p_note text)
returns public.hr_candidate_notes
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_row public.hr_candidate_notes;
  v_name text;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized';
  end if;
  select coalesce(full_name, '') into v_name from public.profiles where id = auth.uid();
  insert into public.hr_candidate_notes (candidate_id, note, author_id, author_name)
  values (p_candidate_id, p_note, auth.uid(), v_name)
  returning * into v_row;
  return v_row;
end; $$;
grant execute on function public.hr_add_candidate_note(uuid, text) to authenticated;

-- Save / version a screening criteria config for a job.
create or replace function public.upsert_screening_config(p_job_id uuid, p_config jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_version int;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to configure screening';
  end if;
  if not exists(select 1 from public.hr_jobs where id = p_job_id) then
    raise exception 'Job not found';
  end if;

  select coalesce(max(version), 0) + 1 into v_version from public.hr_screening_configs where job_id = p_job_id;

  update public.hr_screening_configs set active = false
  where job_id = p_job_id and active = true;

  insert into public.hr_screening_configs
    (job_id, version, active, weights, min_overall, min_components,
     mandatory_requirements, preferred_requirements, required_qualifications,
     required_certifications, assessment_threshold, experience_threshold,
     assessment_flag_tolerance, created_by)
  values (p_job_id, v_version, true,
    coalesce(p_config -> 'weights', '{}'::jsonb),
    coalesce((p_config ->> 'min_overall')::numeric, 60),
    coalesce(p_config -> 'min_components', '{}'::jsonb),
    coalesce(p_config -> 'mandatory_requirements', '[]'::jsonb),
    coalesce(p_config -> 'preferred_requirements', '[]'::jsonb),
    coalesce(p_config -> 'required_qualifications', '[]'::jsonb),
    coalesce(p_config -> 'required_certifications', '[]'::jsonb),
    (case when p_config ->> 'assessment_threshold' is not null then (p_config ->> 'assessment_threshold')::numeric end),
    coalesce((p_config ->> 'experience_threshold')::int, 2),
    coalesce((p_config ->> 'assessment_flag_tolerance')::int, 0),
    auth.uid());

  perform public.hr_audit('SCREENING_CONFIG_SAVED', 'Job', p_job_id::text,
    format('Screening criteria v%s created', v_version));

  return jsonb_build_object('ok', true, 'version', v_version);
end; $$;
grant execute on function public.upsert_screening_config(uuid, jsonb) to authenticated;

-- Manual (non-AI) screening fallback so HR work never blocks on AI.
-- Weights come from the job's active screening config. Rule-based scoring:
-- experience, skills match, assessment score, interview score, text relevance.
create or replace function public.hr_run_manual_screening(p_candidate_ids uuid[], p_job_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_cfg record;
  v_candidate record;
  v_weights jsonb;
  v_experience numeric;
  v_skills numeric;
  v_assessment numeric;
  v_interview numeric;
  v_cv numeric;
  v_cover numeric;
  v_overall numeric;
  v_skills_list text[];
  v_all_text text;
  v_count int := 0;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized';
  end if;

  select * into v_cfg from public.hr_screening_configs
  where job_id = p_job_id and active = true order by version desc limit 1;

  v_weights := coalesce(v_cfg.weights, '{}'::jsonb);

  for v_candidate in
    select c.* from public.hr_candidates c where c.id = any(p_candidate_ids)
  loop
    -- experience (0-100)
    v_experience := least(100, round(coalesce(v_candidate.years_experience, 0) / greatest(coalesce(v_cfg.experience_threshold, 2), 1) * 100));

    -- skills match: overlap of job required+preferred skills with candidate skills + text
    v_skills_list := array(
      select jsonb_array_elements_text(coalesce(v_cfg.weights -> 'skills_source', '[]'::jsonb))
    );
    v_all_text := lower(coalesce(v_candidate.full_name, '') || ' ' || coalesce(v_candidate.cover_letter, '') || ' ' || coalesce(array_to_string(v_candidate.skills, ' '), ''));
    select round(100 * count(*)) into v_skills -- placeholder, refined below
    from unnest(v_skills_list) s where position(lower(s) in v_all_text) > 0;

    -- assessment
    select coalesce(max(a.score), 0) into v_assessment from public.hr_assessments a
    where a.candidate_id = v_candidate.id and a.status = 'completed';

    -- interview
    select coalesce(max(h.rating), 0) * 20 into v_interview from public.hr_interviews h
    where h.candidate_id = v_candidate.id and h.status = 'completed';

    v_cv := 0; v_cover := 0;
    -- crude relevance: share of required skills found in text
    if (select count(*) from jsonb_array_elements_text(coalesce(v_cfg.required_qualifications, '[]'::jsonb)) e) > 0 then
      select round(avg(m)) into v_cv from (
        select case when position(lower(e::text) in v_all_text) > 0 then 100 else 0 end as m
        from jsonb_array_elements_text(v_cfg.required_qualifications) e
      ) t;
    end if;

    v_overall := round(
      coalesce((v_weights ->> 'education')::numeric, 0) / 100 * 50 +
      coalesce((v_weights ->> 'experience')::numeric, 25) / 100 * v_experience +
      coalesce((v_weights ->> 'technical_skills')::numeric, 20) / 100 * coalesce(v_skills, 50) +
      coalesce((v_weights ->> 'cv_relevance')::numeric, 10) / 100 * v_cv +
      coalesce((v_weights ->> 'cover_letter_relevance')::numeric, 10) / 100 * v_cover +
      coalesce((v_weights ->> 'assessment_score')::numeric, 15) / 100 * v_assessment +
      coalesce((v_weights ->> 'interview_score')::numeric, 5) / 100 * v_interview
    , 2);

    if v_overall > 100 then v_overall := 100; end if;

    insert into public.candidate_screening_results
      (candidate_id, job_id, config_version, config_snapshot, components, overall_score,
       cv_match, experience_match, assessment_score, interview_score, skills_match,
       flags, strengths, concerns, summary, recommended_action, ai_generated, created_by)
    values (v_candidate.id, p_job_id, coalesce(v_cfg.version, 1), v_weights,
      jsonb_build_object('education', 50, 'experience', v_experience, 'technical_skills', coalesce(v_skills, 50),
        'cv_relevance', v_cv, 'cover_letter_relevance', v_cover, 'assessment_score', v_assessment, 'interview_score', v_interview),
      v_overall, v_cv, v_experience, v_assessment, v_interview, coalesce(v_skills, 50),
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
      'Manual screening (AI unavailable) — HR to review.',
      case when v_overall >= coalesce(v_cfg.min_overall, 60) then 'recommended_interview' else 'manual_review' end,
      false, auth.uid());

    v_count := v_count + 1;
  end loop;

  perform public.hr_audit('SCREENING_MANUAL_RUN', 'Job', p_job_id::text,
    format('Manual screening computed for %s candidates', v_count));

  return jsonb_build_object('ok', true, 'candidates', v_count);
end; $$;
grant execute on function public.hr_run_manual_screening(uuid[], uuid) to authenticated;

-- HR records an explicit screening decision.
create or replace function public.hr_set_screening_decision(p_result_id uuid, p_decision text, p_notes text default null)
returns public.candidate_screening_results
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_row public.candidate_screening_results;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized';
  end if;
  update public.candidate_screening_results
  set hr_decision = p_decision, hr_decision_by = auth.uid(),
      hr_decision_at = now(), hr_decision_notes = p_notes
  where id = p_result_id
  returning * into v_row;
  return v_row;
end; $$;
grant execute on function public.hr_set_screening_decision(uuid, text, text) to authenticated;

-- Create an assessment invitation for a candidate (returns link token).
create or replace function public.hr_create_assessment_invitation(
  p_candidate_id uuid, p_template_id uuid, p_job_id uuid default null, p_expires_days int default 7
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_token text := public.generate_secure_token();
  v_template public.assessment_templates;
  v_id uuid;
  v_name text;
  v_candidate public.hr_candidates;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized';
  end if;
  select * into v_template from public.assessment_templates where id = p_template_id;
  if v_template.id is null then
    raise exception 'Assessment template not found';
  end if;
  if v_template.status <> 'published' then
    raise exception 'Assessment template must be published before inviting candidates';
  end if;
  select * into v_candidate from public.hr_candidates where id = p_candidate_id;
  if v_candidate.id is null then
    raise exception 'Candidate not found';
  end if;

  insert into public.hr_assessments (
    candidate_id, job_id, template_id, assessment_type, test_name, status,
    invitation_token_hash, expires_at, retake_limit, retake_time_hours,
    keep_previous_attempt, created_by
  ) values (
    p_candidate_id, coalesce(p_job_id, v_candidate.job_id),
    p_template_id, v_template.category, v_template.title, 'pending',
    md5(v_token), now() + (greatest(1, least(p_expires_days, 90)) || ' days')::interval,
    coalesce((v_template.anti_cheat ->> 'retake_limit')::int, 0),
    coalesce((v_template.anti_cheat ->> 'retake_time_hours')::numeric, 48),
    coalesce((v_template.anti_cheat ->> 'keep_previous_attempt')::bool, true),
    auth.uid()
  ) returning id into v_id;

  update public.hr_candidates
  set application_status = 'assessment', status_change_note = 'Assessment invitation sent'
  where id = p_candidate_id and application_status in ('received', 'screening', 'shortlisted');

  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('ASSESSMENT_INVITED', 'Assessment', v_id::text, coalesce(v_name, ''),
          format('%s invited to %s', v_candidate.full_name, v_template.title), 'info');

  return jsonb_build_object('ok', true, 'assignment_id', v_id,
    'invitation_token', v_token,
    'url', '/careers/assessment/' || v_token,
    'expires_at', now() + (greatest(1, least(p_expires_days, 90)) || ' days')::interval);
end; $$;
grant execute on function public.hr_create_assessment_invitation(uuid, uuid, uuid, int) to authenticated;

-- Approve / reject a retake request.
create or replace function public.hr_decide_assessment_retake(p_request_id uuid, p_decision text, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_request public.assessment_retake_requests;
  v_attempt_id uuid;
  v_assignment uuid;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized';
  end if;
  select * into v_request from public.assessment_retake_requests where id = p_request_id;
  if v_request.id is null then
    raise exception 'Retake request not found';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'Retake request already decided';
  end if;

  update public.assessment_retake_requests
  set status = p_decision, decided_by = auth.uid(), decided_at = now(), decision_note = p_note
  where id = p_request_id;

  if p_decision = 'approved' then
    -- mark previous attempt, reopen the assignment for the next attempt
    update public.assessment_attempts
    set review_status = 'retake_approved', reviewed_by = auth.uid(), reviewed_at = now(), review_notes = p_note
    where id = v_request.attempt_id;

    update public.hr_assessments
    set status = 'pending', updated_at = now()
    where id = v_request.assignment_id;

    insert into public.assessment_monitoring_events
      (attempt_id, assessment_id, candidate_id, event_type, severity, sequence_number, event_data)
    values (v_request.attempt_id, v_request.assignment_id, v_request.candidate_id, 'restored', 'low',
      (select coalesce(max(sequence_number), 0) + 1 from public.assessment_monitoring_events where attempt_id = v_request.attempt_id),
      jsonb_build_object('retake_approved_by', auth.uid()));
  end if;

  perform public.hr_audit('RETAKE_' || upper(p_decision), 'AssessmentRetake', p_request_id::text,
    format('Retake request %s by HR', p_decision));

  return jsonb_build_object('ok', true, 'status', p_decision);
end; $$;
grant execute on function public.hr_decide_assessment_retake(uuid, text, text) to authenticated;

-- HR marks an attempt review status / grades a subjective question.
create or replace function public.hr_mark_attempt_review(p_attempt_id uuid, p_status text, p_notes text default null)
returns public.assessment_attempts
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_row public.assessment_attempts;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized';
  end if;
  update public.assessment_attempts
  set review_status = p_status, review_notes = p_notes, reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_attempt_id
  returning * into v_row;
  return v_row;
end; $$;
grant execute on function public.hr_mark_attempt_review(uuid, text, text) to authenticated;

create or replace function public.hr_grade_assessment_question(p_attempt_id uuid, p_question_id uuid, p_marks numeric, p_feedback text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_row public.assessment_attempt_answers;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized';
  end if;
  update public.assessment_attempt_answers
  set marks_earned = p_marks, is_correct = true,
      answer = jsonb_set(coalesce(answer, '{}'::jsonb), '{hr_feedback}', to_jsonb(coalesce(p_feedback, '')))
  where attempt_id = p_attempt_id and question_id = p_question_id
  returning * into v_row;
  perform public.recompute_attempt_score(p_attempt_id);
  return jsonb_build_object('ok', true, 'recomputed', true);
end; $$;
grant execute on function public.hr_grade_assessment_question(uuid, uuid, numeric, text) to authenticated;

-- Create an offer letter for a candidate. Versions are never mutated —
-- modifications to an issued offer create a new version row.
create or replace function public.hr_create_offer(p_candidate_id uuid, p_job_id uuid default null, p_offer jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_name text;
  v_token text := public.generate_secure_token();
  v_offer_id uuid;
  v_offer_no text;
  v_candidate public.hr_candidates;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized to issue offers';
  end if;
  select * into v_candidate from public.hr_candidates where id = p_candidate_id;
  if v_candidate.id is null then
    raise exception 'Candidate not found';
  end if;
  select coalesce(full_name, '') into v_name from public.profiles where id = auth.uid();

  v_offer_no := 'OFR-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(v_token, 1, 6));

  insert into public.offer_letters (
    candidate_id, job_id, candidate_name, "position", company_name,
    department, branch, employment_type, annual_salary, monthly_salary,
    mid_month_salary, end_month_salary, allowances, benefits,
    start_date, probation_months, reporting_manager, working_hours,
    leave_entitlement, conditions, other_terms, acceptance_deadline,
    salary, template_id, body_content, version, generated_by,
    offer_number, token_hash, status, created_by
  ) values (
    p_candidate_id, coalesce(p_job_id, v_candidate.job_id),
    v_candidate.full_name,
    coalesce(nullif(p_offer ->> 'position', ''), v_candidate.applied_role),
    coalesce(nullif(p_offer ->> 'company_name', ''), 'Infinity Bank'),
    coalesce(nullif(p_offer ->> 'department', ''), v_candidate.department),
    coalesce(nullif(p_offer ->> 'branch', ''), v_candidate.branch),
    coalesce(nullif(p_offer ->> 'employment_type', ''), 'full_time'),
    coalesce((p_offer ->> 'annual_salary')::numeric, 0),
    coalesce((p_offer ->> 'monthly_salary')::numeric,
       round(coalesce((p_offer ->> 'annual_salary')::numeric, 0) / 12, 2)),
    coalesce((p_offer ->> 'mid_month_salary')::numeric,
       round(coalesce((p_offer ->> 'monthly_salary')::numeric,
             coalesce((p_offer ->> 'annual_salary')::numeric, 0) / 12) * 0.5, 2)),
    coalesce((p_offer ->> 'end_month_salary')::numeric, 0),
    coalesce(p_offer -> 'allowances', '[]'::jsonb),
    nullif(btrim(coalesce(p_offer ->> 'benefits', '')), ''),
    coalesce((p_offer ->> 'start_date')::date, current_date),
    coalesce((p_offer ->> 'probation_months')::int, 3),
    nullif(btrim(coalesce(p_offer ->> 'reporting_manager', '')), ''),
    nullif(btrim(coalesce(p_offer ->> 'working_hours', '')), ''),
    nullif(btrim(coalesce(p_offer ->> 'leave_entitlement', '')), ''),
    nullif(btrim(coalesce(p_offer ->> 'conditions', '')), ''),
    nullif(btrim(coalesce(p_offer ->> 'other_terms', '')), ''),
    coalesce((p_offer ->> 'acceptance_deadline')::date,
      (current_date + interval '7 days')::date),
    coalesce((p_offer ->> 'salary')::numeric, 0),
    nullif((p_offer ->> 'template_id')::uuid, null),
    nullif(btrim(coalesce(p_offer ->> 'body_content', '')), ''),
    1,
    coalesce(nullif(p_offer ->> 'generated_by', ''), 'manual'),
    v_offer_no, md5(v_token), 'draft', auth.uid()
  ) returning id into v_offer_id;

  update public.hr_candidates
  set application_status = 'offer', status_change_note = 'Offer created'
  where id = p_candidate_id
    and application_status not in ('hired', 'offer_accepted', 'onboarding', 'guarantor');

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('OFFER_GENERATED', 'OfferLetter', v_offer_id::text, coalesce(v_name, ''),
          format('Offer %s created for %s', v_offer_no, v_candidate.full_name), 'info');

  return jsonb_build_object('ok', true, 'offer_id', v_offer_id, 'offer_number', v_offer_no,
    'token', v_token, 'status', 'draft');
end; $$;
grant execute on function public.hr_create_offer(uuid, uuid, jsonb) to authenticated;

-- Issue an offer (sets the token + candidate status to 'offer').
create or replace function public.hr_issue_offer(p_offer_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_offer public.offer_letters;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized';
  end if;
  select * into v_offer from public.offer_letters where id = p_offer_id;
  if v_offer.id is null then
    raise exception 'Offer not found';
  end if;
  if v_offer.status = 'issued' then
    raise exception 'Offer is already issued';
  end if;
  if v_offer.status = 'accepted' then
    raise exception 'Offer already accepted';
  end if;

  update public.offer_letters
  set status = 'issued', issued_by = auth.uid(), issued_at = now(), updated_at = now()
  where id = p_offer_id;

  update public.hr_candidates
  set application_status = 'offer', status_change_note = 'Offer issued'
  where id = v_offer.candidate_id and application_status in ('recommended', 'interviewed', 'offer');

  perform public.hr_audit('OFFER_ISSUED', 'OfferLetter', p_offer_id::text,
    format('Offer %s issued', v_offer.offer_number));

  return jsonb_build_object('ok', true, 'status', 'issued');
end; $$;
grant execute on function public.hr_issue_offer(uuid) to authenticated;

-- Modify an offer. Draft offers update in place; issued offers create a
-- NEW version (previous version is marked withdrawn/superseded).
create or replace function public.hr_modify_offer(p_offer_id uuid, p_offer jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_offer public.offer_letters;
  v_token text := public.generate_secure_token();
  v_new_id uuid;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized';
  end if;
  select * into v_offer from public.offer_letters where id = p_offer_id;
  if v_offer.id is null then
    raise exception 'Offer not found';
  end if;

  if v_offer.status in ('draft') then
    update public.offer_letters set
      "position" = coalesce(nullif(p_offer ->> 'position', ''), "position"),
      company_name = coalesce(nullif(p_offer ->> 'company_name', ''), company_name),
      department = coalesce(nullif(p_offer ->> 'department', ''), department),
      branch = coalesce(nullif(p_offer ->> 'branch', ''), branch),
      annual_salary = coalesce((p_offer ->> 'annual_salary')::numeric, annual_salary),
      monthly_salary = coalesce((p_offer ->> 'monthly_salary')::numeric, monthly_salary),
      mid_month_salary = coalesce((p_offer ->> 'mid_month_salary')::numeric, mid_month_salary),
      end_month_salary = coalesce((p_offer ->> 'end_month_salary')::numeric, end_month_salary),
      allowances = coalesce(p_offer -> 'allowances', allowances),
      benefits = coalesce(nullif(p_offer ->> 'benefits', ''), benefits),
      start_date = coalesce((p_offer ->> 'start_date')::date, start_date),
      probation_months = coalesce((p_offer ->> 'probation_months')::int, probation_months),
      reporting_manager = coalesce(nullif(p_offer ->> 'reporting_manager', ''), reporting_manager),
      working_hours = coalesce(nullif(p_offer ->> 'working_hours', ''), working_hours),
      leave_entitlement = coalesce(nullif(p_offer ->> 'leave_entitlement', ''), leave_entitlement),
      conditions = coalesce(nullif(p_offer ->> 'conditions', ''), conditions),
      other_terms = coalesce(nullif(p_offer ->> 'other_terms', ''), other_terms),
      acceptance_deadline = coalesce((p_offer ->> 'acceptance_deadline')::date, acceptance_deadline),
      body_content = coalesce(nullif(p_offer ->> 'body_content', ''), body_content),
      updated_at = now()
    where id = p_offer_id;
    perform public.hr_audit('OFFER_MODIFIED', 'OfferLetter', p_offer_id::text, 'Draft offer updated');
    return jsonb_build_object('ok', true, 'offer_id', p_offer_id, 'new_version', v_offer.version);
  elsif v_offer.status in ('issued', 'draft') then
    -- create new version row
    insert into public.offer_letters (
      candidate_id, job_id, candidate_name, "position", company_name, department, branch,
      employment_type, salary, annual_salary, monthly_salary, mid_month_salary, end_month_salary,
      allowances, benefits, start_date, probation_months, reporting_manager, working_hours,
      leave_entitlement, conditions, other_terms, acceptance_deadline, template_id, body_content,
      version, generated_by, offer_number, token_hash, status, created_by
    ) values (
      v_offer.candidate_id, v_offer.job_id, v_offer.candidate_name,
      coalesce(nullif(p_offer ->> 'position', ''), v_offer."position"),
      coalesce(nullif(p_offer ->> 'company_name', ''), v_offer.company_name),
      coalesce(nullif(p_offer ->> 'department', ''), v_offer.department),
      coalesce(nullif(p_offer ->> 'branch', ''), v_offer.branch),
      v_offer.employment_type, coalesce((p_offer ->> 'salary')::numeric, v_offer.salary),
      coalesce((p_offer ->> 'annual_salary')::numeric, v_offer.annual_salary),
      coalesce((p_offer ->> 'monthly_salary')::numeric, v_offer.monthly_salary),
      coalesce((p_offer ->> 'mid_month_salary')::numeric, v_offer.mid_month_salary),
      coalesce((p_offer ->> 'end_month_salary')::numeric, v_offer.end_month_salary),
      coalesce(p_offer -> 'allowances', v_offer.allowances),
      coalesce(nullif(p_offer ->> 'benefits', ''), v_offer.benefits),
      coalesce((p_offer ->> 'start_date')::date, v_offer.start_date),
      coalesce((p_offer ->> 'probation_months')::int, v_offer.probation_months),
      coalesce(nullif(p_offer ->> 'reporting_manager', ''), v_offer.reporting_manager),
      coalesce(nullif(p_offer ->> 'working_hours', ''), v_offer.working_hours),
      coalesce(nullif(p_offer ->> 'leave_entitlement', ''), v_offer.leave_entitlement),
      coalesce(nullif(p_offer ->> 'conditions', ''), v_offer.conditions),
      coalesce(nullif(p_offer ->> 'other_terms', ''), v_offer.other_terms),
      coalesce((p_offer ->> 'acceptance_deadline')::date, v_offer.acceptance_deadline),
      v_offer.template_id,
      coalesce(nullif(p_offer ->> 'body_content', ''), v_offer.body_content),
      v_offer.version + 1, v_offer.generated_by, v_offer.offer_number, md5(v_token), 'draft', auth.uid()
    ) returning id into v_new_id;

    -- supersede old
    update public.offer_letters
    set superseded_by = v_new_id, status = 'withdrawn', updated_at = now()
    where id = p_offer_id;

    perform public.hr_audit('OFFER_MODIFIED', 'OfferLetter', p_offer_id::text,
      format('Offer %s v%s superseded by v%s', v_offer.offer_number, v_offer.version, v_offer.version + 1));

    return jsonb_build_object('ok', true, 'offer_id', v_new_id,
      'new_version', v_offer.version + 1, 'token', v_token, 'status', 'draft');
  else
    raise exception 'Offer in status %s cannot be modified', v_offer.status;
  end if;
end; $$;
grant execute on function public.hr_modify_offer(uuid, jsonb) to authenticated;

-- Withdraw an offer (soft, audited).
create or replace function public.hr_withdraw_offer(p_offer_id uuid, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_offer public.offer_letters;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized';
  end if;
  select * into v_offer from public.offer_letters where id = p_offer_id;
  if v_offer.id is null then
    raise exception 'Offer not found';
  end if;
  if v_offer.status = 'accepted' then
    raise exception 'Accepted offers cannot be withdrawn';
  end if;
  update public.offer_letters
  set status = 'withdrawn', other_terms = coalesce(other_terms, '') || E'\nWithdrawn: ' || coalesce(p_note, ''),
      updated_at = now()
  where id = p_offer_id;
  perform public.hr_audit('OFFER_WITHDRAWN', 'OfferLetter', p_offer_id::text, coalesce(p_note, 'Offer withdrawn'));
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.hr_withdraw_offer(uuid, text) to authenticated;

-- Create an onboarding link for an accepted candidate (HR-manual alternative).
create or replace function public.hr_create_onboarding_link_for_offer(p_offer_id uuid, p_expires_days int default 7)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_offer public.offer_letters;
  v_candidate public.hr_candidates;
  v_token text := public.generate_secure_token();
  v_link uuid;
  v_expires timestamptz := now() + (greatest(1, least(p_expires_days, 90)) || ' days')::interval;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized';
  end if;
  select * into v_offer from public.offer_letters where id = p_offer_id;
  if v_offer.id is null then
    raise exception 'Offer not found';
  end if;
  select * into v_candidate from public.hr_candidates where id = v_offer.candidate_id;
  if v_candidate.id is null then
    raise exception 'Candidate not found';
  end if;

  insert into public.employee_onboarding_links
    (token_hash, candidate_name, candidate_email, candidate_phone, "position",
     department, branch, employment_type, expiry, expires_at, status, created_by)
  values (md5(v_token), v_candidate.full_name, coalesce(v_candidate.email, ''),
          v_candidate.phone, coalesce(v_offer."position", v_candidate.applied_role),
          coalesce(v_offer.department, v_candidate.department),
          coalesce(v_offer.branch, v_candidate.branch),
          v_offer.employment_type, v_expires, v_expires, 'PENDING', auth.uid())
  returning id into v_link;

  update public.hr_candidates set onb_link_id = v_link, application_status = 'onboarding',
    status_change_note = 'Onboarding link generated'
  where id = v_candidate.id;
  update public.employee_onboarding_links set candidate_id = v_candidate.id, job_id = v_offer.job_id
  where id = v_link;

  perform public.hr_audit('ONBOARDING_LINK_GENERATED', 'Candidate', v_candidate.id::text,
    format('Onboarding link created from offer %s', v_offer.offer_number));

  return jsonb_build_object('ok', true, 'link_id', v_link,
    'token', v_token, 'url', '/onboarding/' || v_token, 'expires_at', v_expires);
end; $$;
grant execute on function public.hr_create_onboarding_link_for_offer(uuid, int) to authenticated;

-- ============================================================
-- 17. PAYROLL RPCs — components + breakdown snapshots
-- ============================================================
create or replace function public.upsert_salary_component(p_comp jsonb)
returns public.payroll_salary_components
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_row public.payroll_salary_components;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to manage payroll configuration';
  end if;
  insert into public.payroll_salary_components
    (name, component_type, basis, rate, taxable, recurring, payment_schedule, category, active, created_by)
  values (
    btrim(coalesce(p_comp ->> 'name', '')),
    coalesce(p_comp ->> 'component_type', 'allowance'),
    coalesce(p_comp ->> 'basis', 'percentage'),
    coalesce((p_comp ->> 'rate')::numeric, 0),
    coalesce((p_comp ->> 'taxable')::bool, true),
    coalesce((p_comp ->> 'recurring')::bool, true),
    coalesce(p_comp ->> 'payment_schedule', 'both'),
    coalesce(p_comp ->> 'category', 'other'),
    coalesce((p_comp ->> 'active')::bool, true),
    auth.uid()
  )
  on conflict (name)
  do update set
    component_type = excluded.component_type,
    basis = excluded.basis,
    rate = excluded.rate,
    taxable = excluded.taxable,
    recurring = excluded.recurring,
    payment_schedule = excluded.payment_schedule,
    category = excluded.category,
    active = excluded.active,
    updated_at = now()
  returning * into v_row;
  return v_row;
end; $$;
grant execute on function public.upsert_salary_component(jsonb) to authenticated;

-- Assign a component to an employee with an amount snapshot.
create or replace function public.assign_employee_salary_component(
  p_employee_id uuid, p_component_id uuid, p_amount numeric default null, p_rate numeric default null
) returns public.employee_salary_packages
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_emp public.employees;
  v_comp public.payroll_salary_components;
  v_rate numeric;
  v_amount numeric;
  v_row public.employee_salary_packages;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized';
  end if;
  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then raise exception 'Employee not found'; end if;
  select * into v_comp from public.payroll_salary_components where id = p_component_id;
  if v_comp.id is null then raise exception 'Component not found'; end if;

  v_rate := coalesce(p_rate, v_comp.rate, 0);
  v_amount := coalesce(p_amount,
    case when v_comp.basis = 'percentage'
         then round(coalesce(v_emp.salary, 0) * v_rate / 100, 2)
         else v_rate end);

  insert into public.employee_salary_packages
    (employee_id, component_id, amount, rate, snapshot, active, created_by)
  values (p_employee_id, p_component_id, v_amount, v_rate,
    to_jsonb(v_comp), true, auth.uid())
  on conflict (employee_id, component_id)
  do update set amount = excluded.amount, rate = excluded.rate,
                snapshot = excluded.snapshot, active = true, effective_date = current_date
  returning * into v_row;
  return v_row;
end; $$;
grant execute on function public.assign_employee_salary_component(uuid, uuid, numeric, numeric) to authenticated;

-- Remove an employee component (soft).
create or replace function public.remove_employee_salary_component(p_employee_id uuid, p_component_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized';
  end if;
  update public.employee_salary_packages
  set active = false
  where employee_id = p_employee_id and component_id = p_component_id;
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.remove_employee_salary_component(uuid, uuid) to authenticated;

-- Compute a full salary breakdown + persist a snapshot. Uses the same
-- payroll_config engine rules as compute_payroll (pension bands + PAYE).
create or replace function public.calculate_employee_salary_breakdown(p_employee_id uuid, p_period_label text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_emp public.employees;
  v_config jsonb;
  v_pension_rate numeric;
  v_relief_min numeric;
  v_relief_pct numeric;
  v_bands jsonb;
  v_other numeric;
  v_band jsonb;
  v_i int;
  v_band_count int;
  v_prev numeric;
  v_upper numeric;
  v_package record;
  v_monthly numeric;
  v_gross numeric := 0;
  v_basic numeric := 0;
  v_allowances numeric := 0;
  v_deductions numeric := 0;
  v_taxable_allow numeric := 0;
  v_pension numeric;
  v_annual numeric;
  v_taxable numeric;
  v_relief numeric;
  v_tax_annual numeric := 0;
  v_tax numeric;
  v_net numeric;
  v_mid numeric;
  v_end numeric;
  v_comps jsonb := '[]'::jsonb;
  v_label text;
  v_mid_ratio numeric := 0.5;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized';
  end if;
  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then raise exception 'Employee not found'; end if;

  select config into v_config from public.payroll_config where id = 1;
  v_pension_rate := coalesce((v_config ->> 'pension_employee_rate')::numeric, 0.08);
  v_relief_min := coalesce((v_config ->> 'consolidated_relief_min')::numeric, 200000);
  v_relief_pct := coalesce((v_config ->> 'consolidated_relief_percent')::numeric, 0.20);
  v_other := coalesce((v_config ->> 'default_other_deduction')::numeric, 0);
  v_bands := coalesce(v_config -> 'tax_bands', '[{"up_to":null,"rate":0.0}]'::jsonb);
  v_mid_ratio := coalesce((v_config ->> 'mid_month_ratio')::numeric, 0.5);

  -- base salary is MONTHLY (consistent with compute_payroll)
  v_basic := coalesce(v_emp.salary, 0);
  v_monthly := v_basic;

  for v_package in
    select * from public.employee_salary_packages where employee_id = p_employee_id and active = true
  loop
    if v_package.snapshot ->> 'component_type' = 'allowance' then
      v_allowances := v_allowances + coalesce(v_package.amount, 0);
      if coalesce((v_package.snapshot ->> 'taxable')::bool, true) then
        v_taxable_allow := v_taxable_allow + coalesce(v_package.amount, 0);
      end if;
      v_comps := v_comps || jsonb_build_object(
        'name', v_package.snapshot ->> 'name', 'component_type', 'allowance',
        'amount', coalesce(v_package.amount, 0), 'payment_schedule', v_package.snapshot ->> 'payment_schedule');
    else
      v_deductions := v_deductions + coalesce(v_package.amount, 0);
      v_comps := v_comps || jsonb_build_object(
        'name', v_package.snapshot ->> 'name', 'component_type', 'deduction',
        'amount', coalesce(v_package.amount, 0), 'payment_schedule', v_package.snapshot ->> 'payment_schedule');
    end if;
  end loop;

  v_gross := v_basic + v_allowances;
  v_pension := round(v_basic * v_pension_rate, 2);

  -- Annual taxable = (basic + taxable allowances - pension)*12 then relief
  v_annual := (v_basic + v_taxable_allow) * 12;
  v_relief := greatest(v_relief_min, v_relief_pct * v_annual);
  v_taxable := greatest(0, v_annual - (v_pension * 12) - v_relief);

  v_tax_annual := 0; v_prev := 0; v_band_count := jsonb_array_length(v_bands); v_i := 0;
  while v_i < v_band_count loop
    v_band := v_bands -> v_i;
    if v_taxable <= v_prev then exit; end if;
    if (v_band ->> 'up_to') is null then
      v_upper := v_taxable;
    else
      v_upper := least(v_taxable, (v_band ->> 'up_to')::numeric);
    end if;
    v_tax_annual := v_tax_annual + greatest(0, (v_upper - v_prev) * coalesce((v_band ->> 'rate')::numeric, 0));
    if v_taxable <= v_upper then exit; end if;
    v_prev := v_upper;
    v_i := v_i + 1;
  end loop;
  v_tax := round(v_tax_annual / 12, 2);

  v_net := greatest(0, round(v_gross - v_tax - v_pension - v_other - v_deductions, 2));
  v_mid := round(v_net * v_mid_ratio, 2);
  v_end := round(v_net - v_mid, 2);
  v_label := coalesce(nullif(p_period_label, ''), 'CURRENT');

  insert into public.employee_salary_snapshots
    (employee_id, period_label, gross_annual, gross_monthly, basic_monthly,
     allowances_total, deductions_total, tax_paye, pension, other_deductions,
     net_monthly, mid_month, end_month, components)
  values (p_employee_id, v_label, round(v_annual, 2), v_gross, v_basic,
          v_allowances, round(v_deductions + v_tax + v_pension + v_other, 2),
          v_tax, v_pension, v_other, v_net, v_mid, v_end, v_comps)
  on conflict (employee_id, period_label)
  do update set gross_annual = excluded.gross_annual, gross_monthly = excluded.gross_monthly,
    basic_monthly = excluded.basic_monthly, allowances_total = excluded.allowances_total,
    deductions_total = excluded.deductions_total, tax_paye = excluded.tax_paye,
    pension = excluded.pension, other_deductions = excluded.other_deductions,
    net_monthly = excluded.net_monthly, mid_month = excluded.mid_month,
    end_month = excluded.end_month, components = excluded.components,
    calc_timestamp = now();

  return jsonb_build_object('ok', true, 'employee_id', p_employee_id,
    'period_label', v_label,
    'breakdown', jsonb_build_object(
      'gross_annual', round(v_annual, 2),
      'basic_monthly', v_basic,
      'allowances_total', v_allowances,
      'gross_monthly', v_gross,
      'pension', v_pension,
      'tax_paye', v_tax,
      'other_deductions', v_other,
      'component_deductions', v_deductions,
      'deductions_total', round(v_deductions + v_tax + v_pension + v_other, 2),
      'net_monthly', v_net,
      'mid_month', v_mid,
      'end_month', v_end,
      'components', v_comps
    ));
end; $$;
grant execute on function public.calculate_employee_salary_breakdown(uuid, text) to authenticated;

-- ============================================================
-- 18. LEGACY TABLE GRANTS
--     The lifecycle tables created in earlier phases rely on the
--     Supabase default privileges (GRANT ALL on new tables to
--     anon/authenticated/service_role). Fresh/local databases may
--     not have those defaults, so re-assert the equivalent grants
--     here. RLS remains the security gate — grants only let the
--     row policies be evaluated (never bypass them).
-- ============================================================
grant select on public.hr_jobs to anon, authenticated;
grant insert, update, delete on public.hr_jobs to authenticated;
grant select, insert, update, delete on public.hr_candidates to authenticated;
grant select, insert, update, delete on public.hr_assessments to authenticated;
grant select, insert, update, delete on public.offer_letters to authenticated;
-- Legacy org tables consumed by the recruitment/onboarding/payroll flow rely on
-- default privileges on hosted; assert the equivalent grants for fresh/local DBs.
grant select, insert, update, delete on public.employees to authenticated;
grant select, insert, update on public.notifications to authenticated;

-- ============================================================
-- 19. FINAL SANITY: index + audit visibility
-- ============================================================
create index if not exists idx_offer_letters_issued on public.offer_letters(status, issued_at);
create index if not exists idx_assignment_lookup on public.hr_assessments(candidate_id, template_id);

select 'schema_phase41_hr_career_lifecycle.sql applied successfully' as result;