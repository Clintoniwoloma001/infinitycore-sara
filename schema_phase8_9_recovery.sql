-- ============================================================
-- PHASE 10: RECOVERY + COMPLETION MIGRATION
-- schema_phase8_9_recovery.sql
--
-- This single idempotent migration repairs the Phase 8 + Phase 9
-- database foundation. It is safe to run multiple times.
--
-- DEPENDENCY ORDER:
--   1. Base schema (already applied)
--   2. Phase 8 BankOne / Performance / Reconciliation / Leave Rules
--   3. Phase 9 Integrated Operations / Onboarding / Assessment
--
-- WHAT THIS FIXES:
--   ERROR 1: leave_balances_leave_type_check violated by legacy
--           sick/personal rows → archive legacy balance rows,
--           drop + recreate constraint
--   ERROR 2: bankone_import_batches does not exist → create all
--           Phase 8 tables with IF NOT EXISTS
--   ERROR 3: Invalid ON CONFLICT in CREATE TABLE → replaced with
--           partial unique index
--
-- LEGACY LEAVE HANDLING:
--   - leave_requests with sick/personal types are PRESERVED (historical)
--   - leave_balances rows with sick/personal are DELETED (balance only,
--     not request history)
--   - Stale entitled_days (21 for annual, 10 for paternity) are
--     corrected to match leave_rules
--   - The reset_annual_leave_balances function is updated
--
-- ALL STATEMENTS USE IF NOT EXISTS / CREATE OR REPLACE / IF EXISTS.
-- ============================================================

BEGIN;

-- ============================================================
-- PART 1: LEAVE BALANCE REPAIR
-- ============================================================

-- 1a. Archive legacy sick/personal leave BALANCE rows (not requests)
--     We only remove balance tracking rows; historical leave_requests
--     remain untouched for audit.
DELETE FROM public.leave_balances
WHERE leave_type IN ('sick', 'personal');

-- 1b. Update stale entitled_days to match current policy
--     Annual: normal_staff=10, management_staff=15, md=20
--     Maternity=90, Examination=5, Paternity=2
--
--     We determine category from profiles.role:
--       md/super_admin → md (20)
--       admin/hr_manager/branch_manager/area_manager → management (15)
--       everything else → normal_staff (10)
UPDATE public.leave_balances AS lb
SET entitled_days = CASE
  WHEN lb.leave_type = 'annual' AND p.role IN ('md', 'super_admin') THEN 20
  WHEN lb.leave_type = 'annual' AND p.role IN ('admin', 'hr_manager', 'branch_manager', 'area_manager', 'head_of_business', 'operations_manager') THEN 15
  WHEN lb.leave_type = 'annual' THEN 10
  WHEN lb.leave_type = 'maternity' THEN 90
  WHEN lb.leave_type = 'examination' THEN 5
  WHEN lb.leave_type = 'paternity' THEN 2
  ELSE lb.entitled_days
END
FROM public.profiles AS p
WHERE lb.employee_id = p.id;

-- 1c. Drop and recreate the check constraint (now safe — legacy rows removed)
ALTER TABLE public.leave_balances DROP CONSTRAINT IF EXISTS leave_balances_leave_type_check;
ALTER TABLE public.leave_balances ADD CONSTRAINT leave_balances_leave_type_check
  CHECK (leave_type IN ('annual', 'maternity', 'paternity', 'examination', 'unpaid'));

-- 1d. Update the reset function with correct defaults
CREATE OR REPLACE FUNCTION public.reset_annual_leave_balances(target_year int)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  lt text;
  p record;
  ent numeric;
BEGIN
  FOR p IN SELECT id, coalesce(full_name, email) AS full_name, role FROM public.profiles LOOP
    -- Annual: category-dependent
    ent := CASE
      WHEN p.role IN ('md', 'super_admin') THEN 20
      WHEN p.role IN ('admin', 'hr_manager', 'branch_manager', 'area_manager', 'head_of_business', 'operations_manager') THEN 15
      ELSE 10
    END;
    INSERT INTO public.leave_balances (employee_id, employee_name, year, leave_type, entitled_days, used_days)
    VALUES (p.id, p.full_name, target_year, 'annual', ent, 0)
    ON CONFLICT (employee_id, year, leave_type) DO UPDATE SET entitled_days = EXCLUDED.entitled_days;

    -- Maternity
    INSERT INTO public.leave_balances (employee_id, employee_name, year, leave_type, entitled_days, used_days)
    VALUES (p.id, p.full_name, target_year, 'maternity', 90, 0)
    ON CONFLICT (employee_id, year, leave_type) DO UPDATE SET entitled_days = 90;

    -- Examination
    INSERT INTO public.leave_balances (employee_id, employee_name, year, leave_type, entitled_days, used_days)
    VALUES (p.id, p.full_name, target_year, 'examination', 5, 0)
    ON CONFLICT (employee_id, year, leave_type) DO UPDATE SET entitled_days = 5;

    -- Paternity
    INSERT INTO public.leave_balances (employee_id, employee_name, year, leave_type, entitled_days, used_days)
    VALUES (p.id, p.full_name, target_year, 'paternity', 2, 0)
    ON CONFLICT (employee_id, year, leave_type) DO UPDATE SET entitled_days = 2;
  END LOOP;
END; $$;

-- 1e. Create leave_rules table if not exists (Phase 8 may have failed)
CREATE TABLE IF NOT EXISTS public.leave_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  leave_type text NOT NULL CHECK (leave_type IN ('annual', 'maternity', 'examination', 'paternity', 'unpaid')),
  employee_category text CHECK (employee_category IN ('normal_staff', 'management_staff', 'md') OR employee_category IS NULL),
  entitled_days numeric NOT NULL,
  description text,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (leave_type, employee_category)
);

ALTER TABLE public.leave_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "leave_rules read" ON public.leave_rules;
CREATE POLICY "leave_rules read" ON public.leave_rules
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "leave_rules write" ON public.leave_rules;
CREATE POLICY "leave_rules write" ON public.leave_rules
  FOR ALL USING (public.current_role() IN ('super_admin', 'admin', 'hr_manager'))
  WITH CHECK (public.current_role() IN ('super_admin', 'admin', 'hr_manager'));

-- 1f. Seed correct leave rules (idempotent)
INSERT INTO public.leave_rules (leave_type, employee_category, entitled_days, description) VALUES
  ('annual', 'normal_staff', 10, 'Annual leave for basic staff'),
  ('annual', 'management_staff', 15, 'Annual leave for management staff'),
  ('annual', 'md', 20, 'Annual leave for MD'),
  ('maternity', NULL, 90, 'Maternity leave — 3 months'),
  ('examination', NULL, 5, 'Examination leave'),
  ('paternity', NULL, 2, 'Paternity leave')
ON CONFLICT (leave_type, employee_category) DO UPDATE SET
  entitled_days = EXCLUDED.entitled_days,
  description = EXCLUDED.description,
  is_active = true;

-- ============================================================
-- PART 2: BANKONE FOUNDATION (Phase 8 tables)
-- ============================================================

-- 2a. Import batches
CREATE TABLE IF NOT EXISTS public.bankone_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename text NOT NULL,
  source_format text DEFAULT 'csv',
  operation_type text DEFAULT 'generic' CHECK (operation_type IN (
    'hr_mpr', 'staff_performance', 'target_achievement', 'appraisal_data',
    'payroll_import', 'salary_data', 'allowances', 'deductions',
    'transport_allowance', 'other_allowance',
    'customer_reconciliation', 'failed_transactions', 'pending_transactions',
    'incomplete_transactions', 'reversed_transactions', 'resolution_data',
    'generic'
  )),
  status text DEFAULT 'preview' CHECK (status IN ('preview', 'importing', 'completed', 'completed_with_warnings', 'failed')),
  reporting_period text,
  total_rows int DEFAULT 0,
  imported_rows int DEFAULT 0,
  duplicate_rows int DEFAULT 0,
  unmatched_staff_rows int DEFAULT 0,
  rejected_rows int DEFAULT 0,
  mapping_config jsonb DEFAULT '{}'::jsonb,
  uploaded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  uploaded_by_name text,
  uploaded_at timestamptz DEFAULT now(),
  confirmed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  confirmed_by_name text,
  confirmed_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bankone_batches_status ON public.bankone_import_batches(status);
CREATE INDEX IF NOT EXISTS idx_bankone_batches_uploaded_at ON public.bankone_import_batches(uploaded_at DESC);

ALTER TABLE public.bankone_import_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bankone_batches read" ON public.bankone_import_batches;
CREATE POLICY "bankone_batches read" ON public.bankone_import_batches
  FOR SELECT USING (auth.role() = 'authenticated' AND public.current_role() NOT IN ('customer'));
DROP POLICY IF EXISTS "bankone_batches write" ON public.bankone_import_batches;
CREATE POLICY "bankone_batches write" ON public.bankone_import_batches
  FOR ALL USING (public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'operations_manager'))
  WITH CHECK (public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'operations_manager'));

-- 2b. Import rows (raw staged data)
CREATE TABLE IF NOT EXISTS public.bankone_import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.bankone_import_batches(id) ON DELETE CASCADE,
  row_number int NOT NULL,
  raw_data jsonb NOT NULL,
  mapped_data jsonb DEFAULT '{}'::jsonb,
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'valid', 'duplicate', 'error', 'existing', 'changed', 'unmatched_staff', 'imported', 'reversed', 'resolved', 'still_outstanding')),
  match_type text,
  transaction_id uuid,
  employee_id uuid,
  employee_match_method text,
  validation_errors jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bankone_rows_batch ON public.bankone_import_rows(batch_id);
CREATE INDEX IF NOT EXISTS idx_bankone_rows_status ON public.bankone_import_rows(status);

ALTER TABLE public.bankone_import_rows ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bankone_rows read" ON public.bankone_import_rows;
CREATE POLICY "bankone_rows read" ON public.bankone_import_rows
  FOR SELECT USING (auth.role() = 'authenticated' AND public.current_role() NOT IN ('customer'));

-- 2c. Normalized transactions
CREATE TABLE IF NOT EXISTS public.bankone_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid REFERENCES public.bankone_import_batches(id) ON DELETE SET NULL,
  source_system text NOT NULL DEFAULT 'bankone',
  transaction_reference text,
  transaction_date date,
  transaction_type text,
  account_number text,
  customer_name text,
  staff_id text,
  staff_name text,
  amount numeric,
  status text DEFAULT 'new' CHECK (status IN ('new', 'existing', 'duplicate', 'changed', 'reversed', 'resolved', 'still_outstanding', 'failed', 'pending', 'incomplete')),
  previous_status text,
  reversal_of uuid REFERENCES public.bankone_transactions(id) ON DELETE SET NULL,
  reversal_reference text,
  is_reversal boolean DEFAULT false,
  previously_reversed boolean DEFAULT false,
  employee_id uuid,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Partial unique index: only enforce uniqueness when a reference exists.
-- (ON CONFLICT belongs in INSERT statements, not table constraints.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_bankone_txn_unique_ref
  ON public.bankone_transactions (source_system, transaction_reference)
  WHERE transaction_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bankone_txn_ref ON public.bankone_transactions(transaction_reference);
CREATE INDEX IF NOT EXISTS idx_bankone_txn_date ON public.bankone_transactions(transaction_date);
CREATE INDEX IF NOT EXISTS idx_bankone_txn_status ON public.bankone_transactions(status);
CREATE INDEX IF NOT EXISTS idx_bankone_txn_staff ON public.bankone_transactions(staff_id);
CREATE INDEX IF NOT EXISTS idx_bankone_txn_emp ON public.bankone_transactions(employee_id);

ALTER TABLE public.bankone_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bankone_txn read" ON public.bankone_transactions;
CREATE POLICY "bankone_txn read" ON public.bankone_transactions
  FOR SELECT USING (auth.role() = 'authenticated' AND public.current_role() NOT IN ('customer'));
DROP POLICY IF EXISTS "bankone_txn write" ON public.bankone_transactions;
CREATE POLICY "bankone_txn write" ON public.bankone_transactions
  FOR ALL USING (public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'operations_manager'))
  WITH CHECK (public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'operations_manager'));

-- 2d. Transaction status history
CREATE TABLE IF NOT EXISTS public.transaction_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES public.bankone_transactions(id) ON DELETE CASCADE,
  previous_status text,
  new_status text,
  changed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_by_name text,
  reason text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_txn_history_txn ON public.transaction_status_history(transaction_id);

ALTER TABLE public.transaction_status_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "txn_history read" ON public.transaction_status_history;
CREATE POLICY "txn_history read" ON public.transaction_status_history
  FOR SELECT USING (auth.role() = 'authenticated' AND public.current_role() NOT IN ('customer'));

-- 2e. Transaction relationships (original → reversal)
CREATE TABLE IF NOT EXISTS public.transaction_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_transaction_id uuid NOT NULL REFERENCES public.bankone_transactions(id) ON DELETE CASCADE,
  reversal_transaction_id uuid NOT NULL REFERENCES public.bankone_transactions(id) ON DELETE CASCADE,
  relationship_type text DEFAULT 'reversal',
  created_at timestamptz DEFAULT now(),
  UNIQUE (original_transaction_id, reversal_transaction_id)
);

ALTER TABLE public.transaction_relationships ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "txn_rel read" ON public.transaction_relationships;
CREATE POLICY "txn_rel read" ON public.transaction_relationships
  FOR SELECT USING (auth.role() = 'authenticated' AND public.current_role() NOT IN ('customer'));

-- 2f. Column mappings
CREATE TABLE IF NOT EXISTS public.bankone_column_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  operation_type text DEFAULT 'generic',
  is_default boolean DEFAULT false,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.bankone_column_mappings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bankone_mappings read" ON public.bankone_column_mappings;
CREATE POLICY "bankone_mappings read" ON public.bankone_column_mappings
  FOR SELECT USING (auth.role() = 'authenticated' AND public.current_role() NOT IN ('customer'));
DROP POLICY IF EXISTS "bankone_mappings write" ON public.bankone_column_mappings;
CREATE POLICY "bankone_mappings write" ON public.bankone_column_mappings
  FOR ALL USING (public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'operations_manager'))
  WITH CHECK (public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'operations_manager'));

-- 2g. Employee BankOne identifiers (mapping)
CREATE TABLE IF NOT EXISTS public.employee_bankone_identifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bankone_staff_id text NOT NULL,
  bankone_employee_number text,
  mapped_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  mapped_at timestamptz DEFAULT now(),
  UNIQUE (employee_id, bankone_staff_id)
);

ALTER TABLE public.employee_bankone_identifiers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bankone_emp_id read" ON public.employee_bankone_identifiers;
CREATE POLICY "bankone_emp_id read" ON public.employee_bankone_identifiers
  FOR SELECT USING (auth.role() = 'authenticated' AND public.current_role() NOT IN ('customer'));
DROP POLICY IF EXISTS "bankone_emp_id write" ON public.employee_bankone_identifiers;
CREATE POLICY "bankone_emp_id write" ON public.employee_bankone_identifiers
  FOR ALL USING (public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer'))
  WITH CHECK (public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

-- 2h. Performance metrics
CREATE TABLE IF NOT EXISTS public.performance_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_name text NOT NULL,
  metric_code text UNIQUE,
  category text,
  unit text DEFAULT 'count',
  description text,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.performance_metrics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "perf_metrics read" ON public.performance_metrics;
CREATE POLICY "perf_metrics read" ON public.performance_metrics
  FOR SELECT USING (auth.role() = 'authenticated' AND public.current_role() NOT IN ('customer'));

-- 2i. Performance results
CREATE TABLE IF NOT EXISTS public.performance_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  employee_name text,
  metric_id uuid REFERENCES public.performance_metrics(id) ON DELETE SET NULL,
  period text,
  period_start date,
  period_end date,
  target_value numeric,
  actual_value numeric,
  achievement_percentage numeric,
  source text DEFAULT 'bankone',
  batch_id uuid REFERENCES public.bankone_import_batches(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_perf_results_emp ON public.performance_results(employee_id);
CREATE INDEX IF NOT EXISTS idx_perf_results_period ON public.performance_results(period);

ALTER TABLE public.performance_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "perf_results read" ON public.performance_results;
CREATE POLICY "perf_results read" ON public.performance_results
  FOR SELECT USING (auth.role() = 'authenticated' AND public.current_role() NOT IN ('customer'));

-- 2j. Appraisal periods
CREATE TABLE IF NOT EXISTS public.appraisal_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  period_type text DEFAULT 'annual',
  start_date date,
  end_date date,
  status text DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.appraisal_periods ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "appraisal_periods read" ON public.appraisal_periods;
CREATE POLICY "appraisal_periods read" ON public.appraisal_periods
  FOR SELECT USING (auth.role() = 'authenticated' AND public.current_role() NOT IN ('customer'));

-- 2k. Appraisal results
CREATE TABLE IF NOT EXISTS public.appraisal_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  employee_name text,
  period_id uuid REFERENCES public.appraisal_periods(id) ON DELETE SET NULL,
  overall_score numeric,
  kpi_score numeric,
  behavioral_score numeric,
  rating text,
  reviewer_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewer_name text,
  comments text,
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'reviewed', 'approved', 'rejected')),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_appraisal_results_emp ON public.appraisal_results(employee_id);

ALTER TABLE public.appraisal_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "appraisal_results read" ON public.appraisal_results;
CREATE POLICY "appraisal_results read" ON public.appraisal_results
  FOR SELECT USING (auth.role() = 'authenticated' AND public.current_role() NOT IN ('customer'));

-- 2l. Reconciliation cases
CREATE TABLE IF NOT EXISTS public.reconciliation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_reference text UNIQUE,
  transaction_id uuid REFERENCES public.bankone_transactions(id) ON DELETE SET NULL,
  transaction_reference text,
  customer_account text,
  amount numeric,
  transaction_date date,
  transaction_type text,
  source text DEFAULT 'bankone',
  current_status text DEFAULT 'detected' CHECK (current_status IN (
    'detected', 'under_review', 'resolution_requested', 'resolution_submitted', 'verified', 'closed', 'reopened'
  )),
  previous_status text,
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_to_name text,
  resolution_requested text,
  resolution_submitted text,
  resolution_date timestamptz,
  resolution_notes text,
  case_type text CHECK (case_type IN ('failed', 'pending', 'incomplete', 'unknown', 'reversed', 'duplicate', 'resolved', 'potential_duplicate_reversal')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recon_cases_status ON public.reconciliation_cases(current_status);
CREATE INDEX IF NOT EXISTS idx_recon_cases_txn ON public.reconciliation_cases(transaction_id);
CREATE INDEX IF NOT EXISTS idx_recon_cases_assigned ON public.reconciliation_cases(assigned_to);

ALTER TABLE public.reconciliation_cases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "recon_cases read" ON public.reconciliation_cases;
CREATE POLICY "recon_cases read" ON public.reconciliation_cases
  FOR SELECT USING (auth.role() = 'authenticated' AND public.current_role() NOT IN ('customer'));
DROP POLICY IF EXISTS "recon_cases write" ON public.reconciliation_cases;
CREATE POLICY "recon_cases write" ON public.reconciliation_cases
  FOR ALL USING (public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'operations_manager'))
  WITH CHECK (public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'operations_manager'));

-- 2m. Reconciliation case events
CREATE TABLE IF NOT EXISTS public.reconciliation_case_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.reconciliation_cases(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_name text,
  notes text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recon_events_case ON public.reconciliation_case_events(case_id);

ALTER TABLE public.reconciliation_case_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "recon_events read" ON public.reconciliation_case_events;
CREATE POLICY "recon_events read" ON public.reconciliation_case_events
  FOR SELECT USING (auth.role() = 'authenticated' AND public.current_role() NOT IN ('customer'));

-- 2n. Performance adjustments
CREATE TABLE IF NOT EXISTS public.performance_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  result_id uuid NOT NULL REFERENCES public.performance_results(id) ON DELETE CASCADE,
  adjusted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  adjusted_by_name text,
  previous_value numeric,
  new_value numeric,
  reason text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.performance_adjustments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "perf_adj read" ON public.performance_adjustments;
CREATE POLICY "perf_adj read" ON public.performance_adjustments
  FOR SELECT USING (auth.role() = 'authenticated' AND public.current_role() NOT IN ('customer'));

-- 2o. Transport allowance config
CREATE TABLE IF NOT EXISTS public.transport_allowance_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  employee_name text,
  branch text,
  amount numeric NOT NULL DEFAULT 0,
  period text,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.transport_allowance_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "transport_allow read" ON public.transport_allowance_config;
CREATE POLICY "transport_allow read" ON public.transport_allowance_config
  FOR SELECT USING (auth.role() = 'authenticated' AND public.current_role() NOT IN ('customer'));
DROP POLICY IF EXISTS "transport_allow write" ON public.transport_allowance_config;
CREATE POLICY "transport_allow write" ON public.transport_allowance_config
  FOR ALL USING (public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'operations_manager'))
  WITH CHECK (public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'operations_manager'));

-- ============================================================
-- PART 3: PHASE 9 TABLES
-- ============================================================

-- 3a. Onboarding field corrections
CREATE TABLE IF NOT EXISTS public.onboarding_field_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL,
  verification_id uuid,
  field_name text NOT NULL,
  field_label text,
  original_value text,
  corrected_value text,
  hr_comment text,
  status text DEFAULT 'requested' CHECK (status IN ('requested', 'submitted', 'approved', 'rejected')),
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_by_name text,
  requested_at timestamptz DEFAULT now(),
  submitted_at timestamptz,
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_by_name text,
  approved_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- Add FK only if the submissions table exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'employee_onboarding_submissions') THEN
    ALTER TABLE public.onboarding_field_corrections
      DROP CONSTRAINT IF EXISTS onboarding_field_corrections_submission_id_fkey;
    ALTER TABLE public.onboarding_field_corrections
      ADD CONSTRAINT onboarding_field_corrections_submission_id_fkey
      FOREIGN KEY (submission_id) REFERENCES public.employee_onboarding_submissions(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_onboarding_corrections_sub ON public.onboarding_field_corrections(submission_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_corrections_status ON public.onboarding_field_corrections(status);

ALTER TABLE public.onboarding_field_corrections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "onboarding_corrections read" ON public.onboarding_field_corrections;
CREATE POLICY "onboarding_corrections read" ON public.onboarding_field_corrections
  FOR SELECT USING (auth.role() = 'authenticated' AND public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer'));
DROP POLICY IF EXISTS "onboarding_corrections insert" ON public.onboarding_field_corrections;
CREATE POLICY "onboarding_corrections insert" ON public.onboarding_field_corrections
  FOR INSERT WITH CHECK (public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer'));
DROP POLICY IF EXISTS "onboarding_corrections update" ON public.onboarding_field_corrections;
CREATE POLICY "onboarding_corrections update" ON public.onboarding_field_corrections
  FOR UPDATE USING (public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

-- 3b. Assessment questions (persisted per assessment)
CREATE TABLE IF NOT EXISTS public.assessment_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL,
  question_text text NOT NULL,
  question_type text DEFAULT 'multiple_choice' CHECK (question_type IN ('multiple_choice', 'true_false', 'short_answer', 'rating')),
  options jsonb DEFAULT '[]'::jsonb,
  correct_answer text,
  difficulty text DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
  competency text,
  display_order int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Add FK if assessments table exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'hr_assessments') THEN
    ALTER TABLE public.assessment_questions
      DROP CONSTRAINT IF EXISTS assessment_questions_assessment_id_fkey;
    ALTER TABLE public.assessment_questions
      ADD CONSTRAINT assessment_questions_assessment_id_fkey
      FOREIGN KEY (assessment_id) REFERENCES public.hr_assessments(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_assessment_questions_assessment ON public.assessment_questions(assessment_id);

ALTER TABLE public.assessment_questions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "assessment_questions read" ON public.assessment_questions;
CREATE POLICY "assessment_questions read" ON public.assessment_questions
  FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "assessment_questions write" ON public.assessment_questions;
CREATE POLICY "assessment_questions write" ON public.assessment_questions
  FOR ALL USING (public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer'))
  WITH CHECK (public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

-- 3c. Assessment monitoring events (anti-cheat)
CREATE TABLE IF NOT EXISTS public.assessment_monitoring_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid,
  candidate_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'tab_visibility_change', 'window_blur', 'window_focus',
    'copy_attempt', 'paste_attempt', 'fullscreen_exit',
    'mouse_leave', 'suspicious_activity', 'attempt_started', 'attempt_submitted'
  )),
  event_data jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'hr_assessments') THEN
    ALTER TABLE public.assessment_monitoring_events
      DROP CONSTRAINT IF EXISTS assessment_monitoring_events_assessment_id_fkey;
    ALTER TABLE public.assessment_monitoring_events
      ADD CONSTRAINT assessment_monitoring_events_assessment_id_fkey
      FOREIGN KEY (assessment_id) REFERENCES public.hr_assessments(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_assessment_monitoring_assessment ON public.assessment_monitoring_events(assessment_id);
CREATE INDEX IF NOT EXISTS idx_assessment_monitoring_candidate ON public.assessment_monitoring_events(candidate_id);

ALTER TABLE public.assessment_monitoring_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "assessment_monitoring read" ON public.assessment_monitoring_events;
CREATE POLICY "assessment_monitoring read" ON public.assessment_monitoring_events
  FOR SELECT USING (auth.role() = 'authenticated' AND public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer'));
DROP POLICY IF EXISTS "assessment_monitoring insert" ON public.assessment_monitoring_events;
CREATE POLICY "assessment_monitoring insert" ON public.assessment_monitoring_events
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- 3d. Interview meeting fields
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'hr_interviews') THEN
    ALTER TABLE public.hr_interviews
      ADD COLUMN IF NOT EXISTS meeting_provider text CHECK (meeting_provider IN ('google_meet', 'zoom', 'manual'));
    ALTER TABLE public.hr_interviews
      ADD COLUMN IF NOT EXISTS meeting_url text;
    ALTER TABLE public.hr_interviews
      ADD COLUMN IF NOT EXISTS interview_date date;
    ALTER TABLE public.hr_interviews
      ADD COLUMN IF NOT EXISTS interview_time text;
  END IF;
END $$;

-- 3e. Employee category on employees table
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'employees') THEN
    ALTER TABLE public.employees
      ADD COLUMN IF NOT EXISTS employee_category text DEFAULT 'normal_staff'
      CHECK (employee_category IN ('normal_staff', 'management_staff', 'md'));
  END IF;
END $$;

-- 3f. Add operation_type to bankone_import_batches (if column missing)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'bankone_import_batches') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'bankone_import_batches' AND column_name = 'operation_type') THEN
      ALTER TABLE public.bankone_import_batches
        ADD COLUMN operation_type text DEFAULT 'generic' CHECK (operation_type IN (
          'hr_mpr', 'staff_performance', 'target_achievement', 'appraisal_data',
          'payroll_import', 'salary_data', 'allowances', 'deductions',
          'transport_allowance', 'other_allowance',
          'customer_reconciliation', 'failed_transactions', 'pending_transactions',
          'incomplete_transactions', 'reversed_transactions', 'resolution_data',
          'generic'
        ));
    END IF;
  END IF;
END $$;

-- ============================================================
-- PART 4: VERIFICATION QUERIES
-- ============================================================
-- Run these after the migration to confirm objects exist:
--
-- SELECT to_regclass('public.bankone_import_batches');
-- SELECT to_regclass('public.bankone_transactions');
-- SELECT to_regclass('public.bankone_import_rows');
-- SELECT to_regclass('public.transaction_status_history');
-- SELECT to_regclass('public.transaction_relationships');
-- SELECT to_regclass('public.reconciliation_cases');
-- SELECT to_regclass('public.reconciliation_case_events');
-- SELECT to_regclass('public.performance_metrics');
-- SELECT to_regclass('public.performance_results');
-- SELECT to_regclass('public.appraisal_periods');
-- SELECT to_regclass('public.appraisal_results');
-- SELECT to_regclass('public.leave_rules');
-- SELECT to_regclass('public.transport_allowance_config');
-- SELECT to_regclass('public.performance_adjustments');
-- SELECT to_regclass('public.onboarding_field_corrections');
-- SELECT to_regclass('public.assessment_questions');
-- SELECT to_regclass('public.assessment_monitoring_events');
--
-- -- Verify active leave rules:
-- SELECT leave_type, employee_category, entitled_days FROM public.leave_rules WHERE is_active = true ORDER BY leave_type, employee_category;
--
-- -- Verify no legacy leave types in balances:
-- SELECT DISTINCT leave_type FROM public.leave_balances;
--
-- -- Verify constraint:
-- SELECT con.conname, pg_get_constraintdef(con.oid) FROM pg_constraint con
--   JOIN pg_class rel ON rel.oid = con.conrelid
--   WHERE rel.relname = 'leave_balances' AND con.contype = 'c';

COMMIT;
