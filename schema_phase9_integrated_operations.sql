-- ============================================================
-- PHASE 9: INTEGRATED OPERATIONS — Operation-aware imports,
-- onboarding field corrections, assessment persistence.
--
-- ALL ADDITIVE. Run after all prior schema files.
-- Safe to re-run: every statement uses IF NOT EXISTS / OR REPLACE.
-- ============================================================

-- ============================================================
-- 1. Add operation_type to bankone_import_batches
-- ============================================================
alter table public.bankone_import_batches
  add column if not exists operation_type text default 'generic'
  check (operation_type in (
    'hr_mpr', 'staff_performance', 'target_achievement', 'appraisal_data',
    'payroll_import', 'salary_data', 'allowances', 'deductions',
    'transport_allowance', 'other_allowance',
    'customer_reconciliation', 'failed_transactions', 'pending_transactions',
    'incomplete_transactions', 'reversed_transactions', 'resolution_data',
    'generic'
  ));

-- ============================================================
-- 2. ONBOARDING FIELD CORRECTIONS — field-level correction workflow
--    Preserves original value, HR comment, corrected value, approval
-- ============================================================
create table if not exists public.onboarding_field_corrections (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.employee_onboarding_submissions(id) on delete cascade,
  verification_id uuid references public.guarantor_verifications(id) on delete set null,
  field_name text not null,
  field_label text,
  original_value text,
  corrected_value text,
  hr_comment text,
  status text default 'requested' check (status in (
    'requested', 'submitted', 'approved', 'rejected'
  )),
  requested_by uuid references auth.users(id) on delete set null,
  requested_by_name text,
  requested_at timestamptz default now(),
  submitted_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  approved_by_name text,
  approved_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists idx_onboarding_corrections_sub on public.onboarding_field_corrections(submission_id);
create index if not exists idx_onboarding_corrections_status on public.onboarding_field_corrections(status);

alter table public.onboarding_field_corrections enable row level security;

create policy "onboarding_corrections read" on public.onboarding_field_corrections
  for select using (
    auth.role() = 'authenticated'
    and public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
  );
create policy "onboarding_corrections insert" on public.onboarding_field_corrections
  for insert with check (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));
create policy "onboarding_corrections update" on public.onboarding_field_corrections
  for update using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

-- ============================================================
-- 3. ASSESSMENT QUESTIONS — persisted questions per assessment
--    so candidates get a stable version (not regenerated mid-attempt)
-- ============================================================
create table if not exists public.assessment_questions (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.hr_assessments(id) on delete cascade,
  question_text text not null,
  question_type text default 'multiple_choice' check (question_type in (
    'multiple_choice', 'true_false', 'short_answer', 'rating'
  )),
  options jsonb default '[]'::jsonb,
  correct_answer text,
  difficulty text default 'medium' check (difficulty in ('easy', 'medium', 'hard')),
  competency text,
  display_order int default 0,
  created_at timestamptz default now()
);

create index if not exists idx_assessment_questions_assessment on public.assessment_questions(assessment_id);

alter table public.assessment_questions enable row level security;

create policy "assessment_questions read" on public.assessment_questions
  for select using (auth.role() = 'authenticated');
create policy "assessment_questions insert" on public.assessment_questions
  for insert with check (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));
create policy "assessment_questions update" on public.assessment_questions
  for update using (public.current_role() in ('super_admin', 'admin', 'hr_manager'));
create policy "assessment_questions delete" on public.assessment_questions
  for delete using (public.current_role() in ('super_admin', 'admin', 'hr_manager'));

-- ============================================================
-- 4. ASSESSMENT ATTEMPT MONITORING — anti-cheat event log
-- ============================================================
create table if not exists public.assessment_monitoring_events (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid references public.hr_assessments(id) on delete set null,
  candidate_id uuid references auth.users(id) on delete set null,
  event_type text not null check (event_type in (
    'tab_visibility_change', 'window_blur', 'window_focus',
    'copy_attempt', 'paste_attempt', 'fullscreen_exit',
    'mouse_leave', 'suspicious_activity', 'attempt_started', 'attempt_submitted'
  )),
  event_data jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_assessment_monitoring_assessment on public.assessment_monitoring_events(assessment_id);
create index if not exists idx_assessment_monitoring_candidate on public.assessment_monitoring_events(candidate_id);

alter table public.assessment_monitoring_events enable row level security;

create policy "assessment_monitoring read" on public.assessment_monitoring_events
  for select using (
    auth.role() = 'authenticated'
    and public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
  );
create policy "assessment_monitoring insert" on public.assessment_monitoring_events
  for insert with check (auth.role() = 'authenticated');

-- ============================================================
-- 5. INTERVIEW MEETING LINKS
-- ============================================================
alter table public.hr_interviews
  add column if not exists meeting_provider text check (meeting_provider in ('google_meet', 'zoom', 'manual')),
  add column if not exists meeting_url text,
  add column if not exists interview_date date,
  add column if not exists interview_time text;

-- ============================================================
-- 6. EMPLOYEE CATEGORY on employees (for leave rule determination)
-- ============================================================
alter table public.employees
  add column if not exists employee_category text default 'normal_staff'
  check (employee_category in ('normal_staff', 'management_staff', 'md'));
