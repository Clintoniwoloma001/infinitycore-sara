-- ============================================================
-- PHASE 9: INTEGRATED OPERATIONS
-- Operation-aware imports, onboarding field corrections,
-- assessment persistence and monitoring.
--
-- ALL ADDITIVE.
-- Safe to re-run.
-- Existing data is NOT deleted.
-- Policies are explicitly dropped/recreated because PostgreSQL
-- does not support CREATE POLICY IF NOT EXISTS.
-- ============================================================


-- ============================================================
-- 1. ADD OPERATION TYPE TO BANKONE IMPORT BATCHES
-- ============================================================

ALTER TABLE public.bankone_import_batches
  ADD COLUMN IF NOT EXISTS operation_type text;

-- Set default after ensuring column exists
ALTER TABLE public.bankone_import_batches
  ALTER COLUMN operation_type SET DEFAULT 'generic';

-- Populate existing NULL values
UPDATE public.bankone_import_batches
SET operation_type = 'generic'
WHERE operation_type IS NULL;

-- Recreate the CHECK constraint safely
ALTER TABLE public.bankone_import_batches
  DROP CONSTRAINT IF EXISTS bankone_import_batches_operation_type_check;

ALTER TABLE public.bankone_import_batches
  ADD CONSTRAINT bankone_import_batches_operation_type_check
  CHECK (
    operation_type IN (
      'hr_mpr',
      'staff_performance',
      'target_achievement',
      'appraisal_data',
      'payroll_import',
      'salary_data',
      'allowances',
      'deductions',
      'transport_allowance',
      'other_allowance',
      'customer_reconciliation',
      'failed_transactions',
      'pending_transactions',
      'incomplete_transactions',
      'reversed_transactions',
      'resolution_data',
      'generic'
    )
  );


-- ============================================================
-- 2. ONBOARDING FIELD CORRECTIONS
-- Field-level correction workflow.
--
-- Preserves:
--   - original value
--   - corrected value
--   - HR comment
--   - approval information
-- ============================================================

CREATE TABLE IF NOT EXISTS public.onboarding_field_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  submission_id uuid NOT NULL
    REFERENCES public.employee_onboarding_submissions(id)
    ON DELETE CASCADE,

  verification_id uuid
    REFERENCES public.guarantor_verifications(id)
    ON DELETE SET NULL,

  field_name text NOT NULL,
  field_label text,

  original_value text,
  corrected_value text,

  hr_comment text,

  status text DEFAULT 'requested',

  requested_by uuid
    REFERENCES auth.users(id)
    ON DELETE SET NULL,

  requested_by_name text,
  requested_at timestamptz DEFAULT now(),

  submitted_at timestamptz,

  approved_by uuid
    REFERENCES auth.users(id)
    ON DELETE SET NULL,

  approved_by_name text,
  approved_at timestamptz,

  created_at timestamptz DEFAULT now()
);


-- Ensure columns exist if the table already existed
ALTER TABLE public.onboarding_field_corrections
  ADD COLUMN IF NOT EXISTS submission_id uuid;

ALTER TABLE public.onboarding_field_corrections
  ADD COLUMN IF NOT EXISTS verification_id uuid;

ALTER TABLE public.onboarding_field_corrections
  ADD COLUMN IF NOT EXISTS field_name text;

ALTER TABLE public.onboarding_field_corrections
  ADD COLUMN IF NOT EXISTS field_label text;

ALTER TABLE public.onboarding_field_corrections
  ADD COLUMN IF NOT EXISTS original_value text;

ALTER TABLE public.onboarding_field_corrections
  ADD COLUMN IF NOT EXISTS corrected_value text;

ALTER TABLE public.onboarding_field_corrections
  ADD COLUMN IF NOT EXISTS hr_comment text;

ALTER TABLE public.onboarding_field_corrections
  ADD COLUMN IF NOT EXISTS status text;

ALTER TABLE public.onboarding_field_corrections
  ADD COLUMN IF NOT EXISTS requested_by uuid;

ALTER TABLE public.onboarding_field_corrections
  ADD COLUMN IF NOT EXISTS requested_by_name text;

ALTER TABLE public.onboarding_field_corrections
  ADD COLUMN IF NOT EXISTS requested_at timestamptz;

ALTER TABLE public.onboarding_field_corrections
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz;

ALTER TABLE public.onboarding_field_corrections
  ADD COLUMN IF NOT EXISTS approved_by uuid;

ALTER TABLE public.onboarding_field_corrections
  ADD COLUMN IF NOT EXISTS approved_by_name text;

ALTER TABLE public.onboarding_field_corrections
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

ALTER TABLE public.onboarding_field_corrections
  ADD COLUMN IF NOT EXISTS created_at timestamptz;


-- Recreate status constraint safely
ALTER TABLE public.onboarding_field_corrections
  DROP CONSTRAINT IF EXISTS onboarding_field_corrections_status_check;

ALTER TABLE public.onboarding_field_corrections
  ADD CONSTRAINT onboarding_field_corrections_status_check
  CHECK (
    status IN (
      'requested',
      'submitted',
      'approved',
      'rejected'
    )
  );


-- Defaults for existing installations
ALTER TABLE public.onboarding_field_corrections
  ALTER COLUMN status SET DEFAULT 'requested';

ALTER TABLE public.onboarding_field_corrections
  ALTER COLUMN requested_at SET DEFAULT now();

ALTER TABLE public.onboarding_field_corrections
  ALTER COLUMN created_at SET DEFAULT now();


-- Foreign keys may already exist on a newly created table.
-- Do not blindly recreate them here.


-- Indexes
CREATE INDEX IF NOT EXISTS idx_onboarding_corrections_sub
  ON public.onboarding_field_corrections(submission_id);

CREATE INDEX IF NOT EXISTS idx_onboarding_corrections_status
  ON public.onboarding_field_corrections(status);


-- RLS
ALTER TABLE public.onboarding_field_corrections
  ENABLE ROW LEVEL SECURITY;


-- Remove old policies before recreating
DROP POLICY IF EXISTS "onboarding_corrections read"
  ON public.onboarding_field_corrections;

DROP POLICY IF EXISTS "onboarding_corrections insert"
  ON public.onboarding_field_corrections;

DROP POLICY IF EXISTS "onboarding_corrections update"
  ON public.onboarding_field_corrections;


-- SELECT
CREATE POLICY "onboarding_corrections read"
ON public.onboarding_field_corrections
FOR SELECT
USING (
  auth.role() = 'authenticated'
  AND public.current_role() IN (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer'
  )
);


-- INSERT
CREATE POLICY "onboarding_corrections insert"
ON public.onboarding_field_corrections
FOR INSERT
WITH CHECK (
  public.current_role() IN (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer'
  )
);


-- UPDATE
CREATE POLICY "onboarding_corrections update"
ON public.onboarding_field_corrections
FOR UPDATE
USING (
  public.current_role() IN (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer'
  )
)
WITH CHECK (
  public.current_role() IN (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer'
  )
);


-- ============================================================
-- 3. ASSESSMENT QUESTIONS
-- Persisted questions per assessment so candidates receive
-- a stable question set during an assessment attempt.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.assessment_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  assessment_id uuid NOT NULL
    REFERENCES public.hr_assessments(id)
    ON DELETE CASCADE,

  question_text text NOT NULL,

  question_type text DEFAULT 'multiple_choice',

  options jsonb DEFAULT '[]'::jsonb,

  correct_answer text,

  difficulty text DEFAULT 'medium',

  competency text,

  display_order int DEFAULT 0,

  created_at timestamptz DEFAULT now()
);


-- Ensure columns exist on previously-created table
ALTER TABLE public.assessment_questions
  ADD COLUMN IF NOT EXISTS assessment_id uuid;

ALTER TABLE public.assessment_questions
  ADD COLUMN IF NOT EXISTS question_text text;

ALTER TABLE public.assessment_questions
  ADD COLUMN IF NOT EXISTS question_type text;

ALTER TABLE public.assessment_questions
  ADD COLUMN IF NOT EXISTS options jsonb;

ALTER TABLE public.assessment_questions
  ADD COLUMN IF NOT EXISTS correct_answer text;

ALTER TABLE public.assessment_questions
  ADD COLUMN IF NOT EXISTS difficulty text;

ALTER TABLE public.assessment_questions
  ADD COLUMN IF NOT EXISTS competency text;

ALTER TABLE public.assessment_questions
  ADD COLUMN IF NOT EXISTS display_order int;

ALTER TABLE public.assessment_questions
  ADD COLUMN IF NOT EXISTS created_at timestamptz;


-- Defaults
ALTER TABLE public.assessment_questions
  ALTER COLUMN question_type SET DEFAULT 'multiple_choice';

ALTER TABLE public.assessment_questions
  ALTER COLUMN options SET DEFAULT '[]'::jsonb;

ALTER TABLE public.assessment_questions
  ALTER COLUMN difficulty SET DEFAULT 'medium';

ALTER TABLE public.assessment_questions
  ALTER COLUMN display_order SET DEFAULT 0;

ALTER TABLE public.assessment_questions
  ALTER COLUMN created_at SET DEFAULT now();


-- Constraints
ALTER TABLE public.assessment_questions
  DROP CONSTRAINT IF EXISTS assessment_questions_question_type_check;

ALTER TABLE public.assessment_questions
  ADD CONSTRAINT assessment_questions_question_type_check
  CHECK (
    question_type IN (
      'multiple_choice',
      'true_false',
      'short_answer',
      'rating'
    )
  );


ALTER TABLE public.assessment_questions
  DROP CONSTRAINT IF EXISTS assessment_questions_difficulty_check;

ALTER TABLE public.assessment_questions
  ADD CONSTRAINT assessment_questions_difficulty_check
  CHECK (
    difficulty IN (
      'easy',
      'medium',
      'hard'
    )
  );


-- Index
CREATE INDEX IF NOT EXISTS idx_assessment_questions_assessment
  ON public.assessment_questions(assessment_id);


-- RLS
ALTER TABLE public.assessment_questions
  ENABLE ROW LEVEL SECURITY;


-- Remove existing policies
DROP POLICY IF EXISTS "assessment_questions read"
  ON public.assessment_questions;

DROP POLICY IF EXISTS "assessment_questions insert"
  ON public.assessment_questions;

DROP POLICY IF EXISTS "assessment_questions update"
  ON public.assessment_questions;

DROP POLICY IF EXISTS "assessment_questions delete"
  ON public.assessment_questions;


-- SELECT
CREATE POLICY "assessment_questions read"
ON public.assessment_questions
FOR SELECT
USING (
  auth.role() = 'authenticated'
);


-- INSERT
CREATE POLICY "assessment_questions insert"
ON public.assessment_questions
FOR INSERT
WITH CHECK (
  public.current_role() IN (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer'
  )
);


-- UPDATE
CREATE POLICY "assessment_questions update"
ON public.assessment_questions
FOR UPDATE
USING (
  public.current_role() IN (
    'super_admin',
    'admin',
    'hr_manager'
  )
)
WITH CHECK (
  public.current_role() IN (
    'super_admin',
    'admin',
    'hr_manager'
  )
);


-- DELETE
CREATE POLICY "assessment_questions delete"
ON public.assessment_questions
FOR DELETE
USING (
  public.current_role() IN (
    'super_admin',
    'admin',
    'hr_manager'
  )
);


-- ============================================================
-- 4. ASSESSMENT ATTEMPT MONITORING
-- Anti-cheat / assessment activity event log.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.assessment_monitoring_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  assessment_id uuid
    REFERENCES public.hr_assessments(id)
    ON DELETE SET NULL,

  candidate_id uuid
    REFERENCES auth.users(id)
    ON DELETE SET NULL,

  event_type text NOT NULL,

  event_data jsonb DEFAULT '{}'::jsonb,

  created_at timestamptz DEFAULT now()
);


-- Ensure columns exist
ALTER TABLE public.assessment_monitoring_events
  ADD COLUMN IF NOT EXISTS assessment_id uuid;

ALTER TABLE public.assessment_monitoring_events
  ADD COLUMN IF NOT EXISTS candidate_id uuid;

ALTER TABLE public.assessment_monitoring_events
  ADD COLUMN IF NOT EXISTS event_type text;

ALTER TABLE public.assessment_monitoring_events
  ADD COLUMN IF NOT EXISTS event_data jsonb;

ALTER TABLE public.assessment_monitoring_events
  ADD COLUMN IF NOT EXISTS created_at timestamptz;


-- Defaults
ALTER TABLE public.assessment_monitoring_events
  ALTER COLUMN event_data SET DEFAULT '{}'::jsonb;

ALTER TABLE public.assessment_monitoring_events
  ALTER COLUMN created_at SET DEFAULT now();


-- Event type constraint
ALTER TABLE public.assessment_monitoring_events
  DROP CONSTRAINT IF EXISTS assessment_monitoring_events_event_type_check;

ALTER TABLE public.assessment_monitoring_events
  ADD CONSTRAINT assessment_monitoring_events_event_type_check
  CHECK (
    event_type IN (
      'tab_visibility_change',
      'window_blur',
      'window_focus',
      'copy_attempt',
      'paste_attempt',
      'fullscreen_exit',
      'mouse_leave',
      'suspicious_activity',
      'attempt_started',
      'attempt_submitted'
    )
  );


-- Indexes
CREATE INDEX IF NOT EXISTS idx_assessment_monitoring_assessment
  ON public.assessment_monitoring_events(assessment_id);

CREATE INDEX IF NOT EXISTS idx_assessment_monitoring_candidate
  ON public.assessment_monitoring_events(candidate_id);

CREATE INDEX IF NOT EXISTS idx_assessment_monitoring_event_type
  ON public.assessment_monitoring_events(event_type);

CREATE INDEX IF NOT EXISTS idx_assessment_monitoring_created_at
  ON public.assessment_monitoring_events(created_at);


-- RLS
ALTER TABLE public.assessment_monitoring_events
  ENABLE ROW LEVEL SECURITY;


-- Remove existing policies
DROP POLICY IF EXISTS "assessment_monitoring read"
  ON public.assessment_monitoring_events;

DROP POLICY IF EXISTS "assessment_monitoring insert"
  ON public.assessment_monitoring_events;


-- HR/admin read access
CREATE POLICY "assessment_monitoring read"
ON public.assessment_monitoring_events
FOR SELECT
USING (
  auth.role() = 'authenticated'
  AND public.current_role() IN (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer'
  )
);


-- Authenticated users may submit monitoring events
CREATE POLICY "assessment_monitoring insert"
ON public.assessment_monitoring_events
FOR INSERT
WITH CHECK (
  auth.role() = 'authenticated'
);


-- ============================================================
-- 5. INTERVIEW MEETING LINKS
-- ============================================================

ALTER TABLE public.hr_interviews
  ADD COLUMN IF NOT EXISTS meeting_provider text;

ALTER TABLE public.hr_interviews
  ADD COLUMN IF NOT EXISTS meeting_url text;

ALTER TABLE public.hr_interviews
  ADD COLUMN IF NOT EXISTS interview_date date;

ALTER TABLE public.hr_interviews
  ADD COLUMN IF NOT EXISTS interview_time text;


-- Meeting provider constraint
ALTER TABLE public.hr_interviews
  DROP CONSTRAINT IF EXISTS hr_interviews_meeting_provider_check;

ALTER TABLE public.hr_interviews
  ADD CONSTRAINT hr_interviews_meeting_provider_check
  CHECK (
    meeting_provider IN (
      'google_meet',
      'zoom',
      'manual'
    )
    OR meeting_provider IS NULL
  );


-- ============================================================
-- 6. EMPLOYEE CATEGORY
-- Used for leave-rule determination.
-- ============================================================

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS employee_category text;


-- Default
ALTER TABLE public.employees
  ALTER COLUMN employee_category SET DEFAULT 'normal_staff';


-- Populate existing NULL records
UPDATE public.employees
SET employee_category = 'normal_staff'
WHERE employee_category IS NULL;


-- Constraint
ALTER TABLE public.employees
  DROP CONSTRAINT IF EXISTS employees_employee_category_check;

ALTER TABLE public.employees
  ADD CONSTRAINT employees_employee_category_check
  CHECK (
    employee_category IN (
      'normal_staff',
      'management_staff',
      'md'
    )
  );


-- ============================================================
-- PHASE 9 COMPLETE
-- ============================================================
