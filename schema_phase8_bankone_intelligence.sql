-- ============================================================
-- PHASE 8: BANKONE INTELLIGENCE
-- Import Engine, Transaction Ledger, Deduplication,
-- Reconciliation, Performance, Appraisal.
--
-- CORRECTED / SAFE RE-RUN VERSION
--
-- IMPORTANT:
-- CREATE TABLE IF NOT EXISTS does NOT add missing columns to an
-- existing table. Therefore this version explicitly ALTERs existing
-- tables to add every Phase 8 column before indexes/policies use them.
--
-- No existing data is deleted.
-- ============================================================


-- ============================================================
-- 0. REQUIRED EXTENSION
-- ============================================================

create extension if not exists pgcrypto;


-- ============================================================
-- 1. BANKONE IMPORT BATCHES
-- ============================================================

create table if not exists public.bankone_import_batches (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  source_format text default 'csv',
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_by_name text,
  uploaded_at timestamptz default now(),
  reporting_period text,
  mapping_config jsonb,
  status text default 'pending',
  total_rows int default 0,
  valid_rows int default 0,
  rejected_rows int default 0,
  duplicate_rows int default 0,
  unmatched_staff_rows int default 0,
  imported_rows int default 0,
  error_message text,
  raw_file_path text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.bankone_import_batches
  add column if not exists filename text;

alter table public.bankone_import_batches
  add column if not exists source_format text default 'csv';

alter table public.bankone_import_batches
  add column if not exists uploaded_by uuid;

alter table public.bankone_import_batches
  add column if not exists uploaded_by_name text;

alter table public.bankone_import_batches
  add column if not exists uploaded_at timestamptz default now();

alter table public.bankone_import_batches
  add column if not exists reporting_period text;

alter table public.bankone_import_batches
  add column if not exists mapping_config jsonb;

alter table public.bankone_import_batches
  add column if not exists status text default 'pending';

alter table public.bankone_import_batches
  add column if not exists total_rows int default 0;

alter table public.bankone_import_batches
  add column if not exists valid_rows int default 0;

alter table public.bankone_import_batches
  add column if not exists rejected_rows int default 0;

alter table public.bankone_import_batches
  add column if not exists duplicate_rows int default 0;

alter table public.bankone_import_batches
  add column if not exists unmatched_staff_rows int default 0;

alter table public.bankone_import_batches
  add column if not exists imported_rows int default 0;

alter table public.bankone_import_batches
  add column if not exists error_message text;

alter table public.bankone_import_batches
  add column if not exists raw_file_path text;

alter table public.bankone_import_batches
  add column if not exists created_at timestamptz default now();

alter table public.bankone_import_batches
  add column if not exists updated_at timestamptz default now();

create index if not exists idx_bankone_batches_status
  on public.bankone_import_batches(status);

create index if not exists idx_bankone_batches_uploaded_at
  on public.bankone_import_batches(uploaded_at desc);


-- ============================================================
-- 2. BANKONE IMPORT ROWS
-- ============================================================

create table if not exists public.bankone_import_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.bankone_import_batches(id) on delete cascade,
  row_number int not null,
  raw_data jsonb not null,
  normalized_data jsonb,
  status text default 'pending',
  validation_errors jsonb default '[]'::jsonb,
  match_type text,
  matched_transaction_id uuid,
  employee_id uuid,
  employee_match_method text,
  transaction_id uuid,
  created_at timestamptz default now()
);

alter table public.bankone_import_rows
  add column if not exists batch_id uuid;

alter table public.bankone_import_rows
  add column if not exists row_number int;

alter table public.bankone_import_rows
  add column if not exists raw_data jsonb;

alter table public.bankone_import_rows
  add column if not exists normalized_data jsonb;

alter table public.bankone_import_rows
  add column if not exists status text default 'pending';

alter table public.bankone_import_rows
  add column if not exists validation_errors jsonb default '[]'::jsonb;

alter table public.bankone_import_rows
  add column if not exists match_type text;

alter table public.bankone_import_rows
  add column if not exists matched_transaction_id uuid;

alter table public.bankone_import_rows
  add column if not exists employee_id uuid;

alter table public.bankone_import_rows
  add column if not exists employee_match_method text;

alter table public.bankone_import_rows
  add column if not exists transaction_id uuid;

alter table public.bankone_import_rows
  add column if not exists created_at timestamptz default now();

create index if not exists idx_bankone_rows_batch
  on public.bankone_import_rows(batch_id);

create index if not exists idx_bankone_rows_status
  on public.bankone_import_rows(status);

create index if not exists idx_bankone_rows_employee
  on public.bankone_import_rows(employee_id);


-- ============================================================
-- 3. BANKONE TRANSACTIONS
-- ============================================================

create table if not exists public.bankone_transactions (
  id uuid primary key default gen_random_uuid(),
  source_system text default 'bankone',
  transaction_reference text,
  transaction_date date,
  transaction_time text,
  staff_identifier text,
  employee_id uuid,
  employee_match_method text,
  branch text,
  transaction_type text,
  transaction_status text,
  amount numeric(18,2),
  channel text,
  product_service text,
  reversal_indicator text,
  original_transaction_reference text,
  customer_account_ref text,
  additional_fields jsonb default '{}'::jsonb,
  dedup_fingerprint text,
  first_imported_batch_id uuid references public.bankone_import_batches(id) on delete set null,
  first_imported_at timestamptz default now(),
  last_updated_at timestamptz default now(),
  created_at timestamptz default now()
);


-- ------------------------------------------------------------
-- CRITICAL FIX:
-- Existing bankone_transactions tables may pre-date Phase 8.
-- CREATE TABLE IF NOT EXISTS does not add these columns.
-- ------------------------------------------------------------

alter table public.bankone_transactions
  add column if not exists source_system text default 'bankone';

alter table public.bankone_transactions
  add column if not exists transaction_reference text;

alter table public.bankone_transactions
  add column if not exists transaction_date date;

alter table public.bankone_transactions
  add column if not exists transaction_time text;

alter table public.bankone_transactions
  add column if not exists staff_identifier text;

alter table public.bankone_transactions
  add column if not exists employee_id uuid;

alter table public.bankone_transactions
  add column if not exists employee_match_method text;

alter table public.bankone_transactions
  add column if not exists branch text;

alter table public.bankone_transactions
  add column if not exists transaction_type text;

alter table public.bankone_transactions
  add column if not exists transaction_status text;

alter table public.bankone_transactions
  add column if not exists amount numeric(18,2);

alter table public.bankone_transactions
  add column if not exists channel text;

alter table public.bankone_transactions
  add column if not exists product_service text;

alter table public.bankone_transactions
  add column if not exists reversal_indicator text;

alter table public.bankone_transactions
  add column if not exists original_transaction_reference text;

alter table public.bankone_transactions
  add column if not exists customer_account_ref text;

alter table public.bankone_transactions
  add column if not exists additional_fields jsonb
  default '{}'::jsonb;

alter table public.bankone_transactions
  add column if not exists dedup_fingerprint text;

alter table public.bankone_transactions
  add column if not exists first_imported_batch_id uuid;

alter table public.bankone_transactions
  add column if not exists first_imported_at timestamptz default now();

alter table public.bankone_transactions
  add column if not exists last_updated_at timestamptz default now();

alter table public.bankone_transactions
  add column if not exists created_at timestamptz default now();


-- ============================================================
-- 3A. SAFE FOREIGN KEY ADDITIONS
-- ============================================================

do $$
begin

  if not exists (
    select 1
    from pg_constraint
    where conname = 'bankone_transactions_first_imported_batch_id_fkey'
      and conrelid = 'public.bankone_transactions'::regclass
  ) then

    alter table public.bankone_transactions
      add constraint bankone_transactions_first_imported_batch_id_fkey
      foreign key (first_imported_batch_id)
      references public.bankone_import_batches(id)
      on delete set null;

  end if;

end $$;


-- ============================================================
-- 3B. BANKONE TRANSACTION INDEXES
-- ============================================================

create unique index if not exists idx_bankone_txn_unique_ref
  on public.bankone_transactions (
    source_system,
    transaction_reference
  )
  where transaction_reference is not null;

create index if not exists idx_bankone_txn_ref
  on public.bankone_transactions(transaction_reference);

create index if not exists idx_bankone_txn_employee
  on public.bankone_transactions(employee_id);

create index if not exists idx_bankone_txn_date
  on public.bankone_transactions(transaction_date);

create index if not exists idx_bankone_txn_status
  on public.bankone_transactions(transaction_status);

create index if not exists idx_bankone_txn_branch
  on public.bankone_transactions(branch);

create index if not exists idx_bankone_txn_fingerprint
  on public.bankone_transactions(dedup_fingerprint);

create index if not exists idx_bankone_txn_original_ref
  on public.bankone_transactions(original_transaction_reference);


-- ============================================================
-- 4. TRANSACTION STATUS HISTORY
-- ============================================================

create table if not exists public.transaction_status_history (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.bankone_transactions(id) on delete cascade,
  old_status text,
  new_status text,
  changed_at timestamptz default now(),
  changed_by text,
  source text,
  notes text
);

alter table public.transaction_status_history
  add column if not exists transaction_id uuid;

alter table public.transaction_status_history
  add column if not exists old_status text;

alter table public.transaction_status_history
  add column if not exists new_status text;

alter table public.transaction_status_history
  add column if not exists changed_at timestamptz default now();

alter table public.transaction_status_history
  add column if not exists changed_by text;

alter table public.transaction_status_history
  add column if not exists source text;

alter table public.transaction_status_history
  add column if not exists notes text;

create index if not exists idx_txn_history_transaction
  on public.transaction_status_history(transaction_id);

create index if not exists idx_txn_history_changed_at
  on public.transaction_status_history(changed_at desc);


-- ============================================================
-- 5. TRANSACTION RELATIONSHIPS
-- ============================================================

create table if not exists public.transaction_relationships (
  id uuid primary key default gen_random_uuid(),
  parent_transaction_id uuid not null references public.bankone_transactions(id) on delete cascade,
  child_transaction_id uuid not null references public.bankone_transactions(id) on delete cascade,
  relationship_type text not null default 'reversal',
  created_at timestamptz default now(),
  unique(parent_transaction_id, child_transaction_id)
);

alter table public.transaction_relationships
  add column if not exists parent_transaction_id uuid;

alter table public.transaction_relationships
  add column if not exists child_transaction_id uuid;

alter table public.transaction_relationships
  add column if not exists relationship_type text default 'reversal';

alter table public.transaction_relationships
  add column if not exists created_at timestamptz default now();

create index if not exists idx_txn_rel_parent
  on public.transaction_relationships(parent_transaction_id);

create index if not exists idx_txn_rel_child
  on public.transaction_relationships(child_transaction_id);


-- ============================================================
-- 6. BANKONE COLUMN MAPPINGS
-- ============================================================

create table if not exists public.bankone_column_mappings (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  mapping jsonb not null default '{}'::jsonb,
  is_default boolean default false,
  is_active boolean default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.bankone_column_mappings
  add column if not exists name text;

alter table public.bankone_column_mappings
  add column if not exists description text;

alter table public.bankone_column_mappings
  add column if not exists mapping jsonb
  default '{}'::jsonb;

alter table public.bankone_column_mappings
  add column if not exists is_default boolean default false;

alter table public.bankone_column_mappings
  add column if not exists is_active boolean default true;

alter table public.bankone_column_mappings
  add column if not exists created_by uuid;

alter table public.bankone_column_mappings
  add column if not exists created_at timestamptz default now();

alter table public.bankone_column_mappings
  add column if not exists updated_at timestamptz default now();

insert into public.bankone_column_mappings (
  name,
  description,
  mapping,
  is_default,
  is_active
)
select
  'BankOne Default Export',
  'Auto-generated default mapping. Adjust column names to match your BankOne export.',
  jsonb_build_object(
    'transaction_reference', 'transaction_reference',
    'transaction_date', 'transaction_date',
    'transaction_time', 'transaction_time',
    'staff_identifier', 'staff_identifier',
    'branch', 'branch',
    'transaction_type', 'transaction_type',
    'transaction_status', 'transaction_status',
    'amount', 'amount',
    'channel', 'channel',
    'product_service', 'product_service',
    'reversal_indicator', 'reversal_indicator',
    'original_transaction_reference', 'original_transaction_reference',
    'customer_account_ref', 'customer_account_ref'
  ),
  true,
  true
where not exists (
  select 1
  from public.bankone_column_mappings
  where is_default = true
);


-- ============================================================
-- 7. EMPLOYEE BANKONE IDENTIFIERS
-- ============================================================

create table if not exists public.employee_bankone_identifiers (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  identifier_type text not null,
  identifier_value text not null,
  is_verified boolean default false,
  verified_by uuid references auth.users(id) on delete set null,
  verified_at timestamptz,
  created_at timestamptz default now(),
  unique(identifier_type, identifier_value)
);

alter table public.employee_bankone_identifiers
  add column if not exists employee_id uuid;

alter table public.employee_bankone_identifiers
  add column if not exists identifier_type text;

alter table public.employee_bankone_identifiers
  add column if not exists identifier_value text;

alter table public.employee_bankone_identifiers
  add column if not exists is_verified boolean default false;

alter table public.employee_bankone_identifiers
  add column if not exists verified_by uuid;

alter table public.employee_bankone_identifiers
  add column if not exists verified_at timestamptz;

alter table public.employee_bankone_identifiers
  add column if not exists created_at timestamptz default now();

create index if not exists idx_emp_bankone_emp
  on public.employee_bankone_identifiers(employee_id);

create index if not exists idx_emp_bankone_type_val
  on public.employee_bankone_identifiers(identifier_type, identifier_value);


-- ============================================================
-- 8. PERFORMANCE METRICS
-- ============================================================

create table if not exists public.performance_metrics (
  id uuid primary key default gen_random_uuid(),
  metric_name text not null,
  description text,
  metric_type text default 'quantity',
  department text,
  employee_category text,
  applicable_role text,
  branch text,
  target_period text default 'monthly',
  target_quantity numeric(18,2),
  target_monetary_value numeric(18,2),
  minimum_threshold numeric(18,2),
  achievement_bands jsonb default '[]'::jsonb,
  score_weight numeric(5,2) default 0,
  effective_date date default current_date,
  expiry_date date,
  is_active boolean default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.performance_metrics
  add column if not exists metric_name text;

alter table public.performance_metrics
  add column if not exists description text;

alter table public.performance_metrics
  add column if not exists metric_type text default 'quantity';

alter table public.performance_metrics
  add column if not exists department text;

alter table public.performance_metrics
  add column if not exists employee_category text;

alter table public.performance_metrics
  add column if not exists applicable_role text;

alter table public.performance_metrics
  add column if not exists branch text;

alter table public.performance_metrics
  add column if not exists target_period text default 'monthly';

alter table public.performance_metrics
  add column if not exists target_quantity numeric(18,2);

alter table public.performance_metrics
  add column if not exists target_monetary_value numeric(18,2);

alter table public.performance_metrics
  add column if not exists minimum_threshold numeric(18,2);

alter table public.performance_metrics
  add column if not exists achievement_bands jsonb
  default '[]'::jsonb;

alter table public.performance_metrics
  add column if not exists score_weight numeric(5,2)
  default 0;

alter table public.performance_metrics
  add column if not exists effective_date date
  default current_date;

alter table public.performance_metrics
  add column if not exists expiry_date date;

alter table public.performance_metrics
  add column if not exists is_active boolean default true;

alter table public.performance_metrics
  add column if not exists created_by uuid;

alter table public.performance_metrics
  add column if not exists created_at timestamptz default now();

alter table public.performance_metrics
  add column if not exists updated_at timestamptz default now();

create index if not exists idx_perf_metrics_active
  on public.performance_metrics(is_active);

create index if not exists idx_perf_metrics_dept
  on public.performance_metrics(department);


-- ============================================================
-- 9. PERFORMANCE RESULTS
-- ============================================================

create table if not exists public.performance_results (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references public.employees(id) on delete cascade,
  employee_name text,
  metric_id uuid references public.performance_metrics(id) on delete set null,
  metric_name text,
  period_label text not null,
  period_start date,
  period_end date,
  target_value numeric(18,2),
  actual_value numeric(18,2),
  achievement_pct numeric(8,2),
  performance_status text,
  score numeric(8,2),
  weight numeric(5,2),
  weighted_score numeric(8,2),
  rank int,
  calculated_at timestamptz default now(),
  source text default 'bankone_import',
  created_at timestamptz default now(),
  unique(employee_id, metric_id, period_label)
);

alter table public.performance_results
  add column if not exists employee_id uuid;

alter table public.performance_results
  add column if not exists employee_name text;

alter table public.performance_results
  add column if not exists metric_id uuid;

alter table public.performance_results
  add column if not exists metric_name text;

alter table public.performance_results
  add column if not exists period_label text;

alter table public.performance_results
  add column if not exists period_start date;

alter table public.performance_results
  add column if not exists period_end date;

alter table public.performance_results
  add column if not exists target_value numeric(18,2);

alter table public.performance_results
  add column if not exists actual_value numeric(18,2);

alter table public.performance_results
  add column if not exists achievement_pct numeric(8,2);

alter table public.performance_results
  add column if not exists performance_status text;

alter table public.performance_results
  add column if not exists score numeric(8,2);

alter table public.performance_results
  add column if not exists weight numeric(5,2);

alter table public.performance_results
  add column if not exists weighted_score numeric(8,2);

alter table public.performance_results
  add column if not exists rank int;

alter table public.performance_results
  add column if not exists calculated_at timestamptz default now();

alter table public.performance_results
  add column if not exists source text default 'bankone_import';

alter table public.performance_results
  add column if not exists created_at timestamptz default now();

create index if not exists idx_perf_results_emp
  on public.performance_results(employee_id);

create index if not exists idx_perf_results_period
  on public.performance_results(period_label);

create index if not exists idx_perf_results_metric
  on public.performance_results(metric_id);


-- ============================================================
-- 10. APPRAISAL PERIODS
-- ============================================================

create table if not exists public.appraisal_periods (
  id uuid primary key default gen_random_uuid(),
  period_label text not null,
  start_date date,
  end_date date,
  status text default 'open',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(period_label)
);

alter table public.appraisal_periods
  add column if not exists period_label text;

alter table public.appraisal_periods
  add column if not exists start_date date;

alter table public.appraisal_periods
  add column if not exists end_date date;

alter table public.appraisal_periods
  add column if not exists status text default 'open';

alter table public.appraisal_periods
  add column if not exists created_by uuid;

alter table public.appraisal_periods
  add column if not exists created_at timestamptz default now();

alter table public.appraisal_periods
  add column if not exists updated_at timestamptz default now();


-- ============================================================
-- 11. APPRAISAL RESULTS
-- ============================================================

create table if not exists public.appraisal_results (
  id uuid primary key default gen_random_uuid(),
  appraisal_period_id uuid not null references public.appraisal_periods(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  employee_name text,
  department text,
  role text,
  kpi_data jsonb default '[]'::jsonb,
  overall_rating text,
  overall_score numeric(8,2),
  manager_comments text,
  hr_comments text,
  status text default 'draft',
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  approval_history jsonb default '[]'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(appraisal_period_id, employee_id)
);

alter table public.appraisal_results
  add column if not exists appraisal_period_id uuid;

alter table public.appraisal_results
  add column if not exists employee_id uuid;

alter table public.appraisal_results
  add column if not exists employee_name text;

alter table public.appraisal_results
  add column if not exists department text;

alter table public.appraisal_results
  add column if not exists role text;

alter table public.appraisal_results
  add column if not exists kpi_data jsonb
  default '[]'::jsonb;

alter table public.appraisal_results
  add column if not exists overall_rating text;

alter table public.appraisal_results
  add column if not exists overall_score numeric(8,2);

alter table public.appraisal_results
  add column if not exists manager_comments text;

alter table public.appraisal_results
  add column if not exists hr_comments text;

alter table public.appraisal_results
  add column if not exists status text default 'draft';

alter table public.appraisal_results
  add column if not exists approved_by uuid;

alter table public.appraisal_results
  add column if not exists approved_at timestamptz;

alter table public.appraisal_results
  add column if not exists approval_history jsonb
  default '[]'::jsonb;

alter table public.appraisal_results
  add column if not exists created_by uuid;

alter table public.appraisal_results
  add column if not exists created_at timestamptz default now();

alter table public.appraisal_results
  add column if not exists updated_at timestamptz default now();

create index if not exists idx_appraisal_results_emp
  on public.appraisal_results(employee_id);

create index if not exists idx_appraisal_results_period
  on public.appraisal_results(appraisal_period_id);


-- ============================================================
-- 12. RECONCILIATION CASES
-- ============================================================

create table if not exists public.reconciliation_cases (
  id uuid primary key default gen_random_uuid(),
  case_reference text unique,
  transaction_id uuid references public.bankone_transactions(id) on delete set null,
  transaction_reference text,
  employee_id uuid references public.employees(id) on delete set null,
  employee_name text,
  branch text,
  amount numeric(18,2),
  transaction_date date,
  transaction_type text,
  original_status text,
  current_status text,
  exception_type text,
  detected_date timestamptz default now(),
  detected_by text,
  assigned_to uuid references auth.users(id) on delete set null,
  assigned_to_name text,
  priority text default 'medium',
  status text default 'new',
  resolution_notes text,
  resolution_submitted_by uuid references auth.users(id) on delete set null,
  resolution_submitted_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_by_name text,
  resolved_at timestamptz,
  closed_by uuid references auth.users(id) on delete set null,
  closed_by_name text,
  closed_at timestamptz,
  related_reversal_ref text,
  related_transaction_ids jsonb default '[]'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.reconciliation_cases
  add column if not exists case_reference text;

alter table public.reconciliation_cases
  add column if not exists transaction_id uuid;

alter table public.reconciliation_cases
  add column if not exists transaction_reference text;

alter table public.reconciliation_cases
  add column if not exists employee_id uuid;

alter table public.reconciliation_cases
  add column if not exists employee_name text;

alter table public.reconciliation_cases
  add column if not exists branch text;

alter table public.reconciliation_cases
  add column if not exists amount numeric(18,2);

alter table public.reconciliation_cases
  add column if not exists transaction_date date;

alter table public.reconciliation_cases
  add column if not exists transaction_type text;

alter table public.reconciliation_cases
  add column if not exists original_status text;

alter table public.reconciliation_cases
  add column if not exists current_status text;

alter table public.reconciliation_cases
  add column if not exists exception_type text;

alter table public.reconciliation_cases
  add column if not exists detected_date timestamptz default now();

alter table public.reconciliation_cases
  add column if not exists detected_by text;

alter table public.reconciliation_cases
  add column if not exists assigned_to uuid;

alter table public.reconciliation_cases
  add column if not exists assigned_to_name text;

alter table public.reconciliation_cases
  add column if not exists priority text default 'medium';

alter table public.reconciliation_cases
  add column if not exists status text default 'new';

alter table public.reconciliation_cases
  add column if not exists resolution_notes text;

alter table public.reconciliation_cases
  add column if not exists resolution_submitted_by uuid;

alter table public.reconciliation_cases
  add column if not exists resolution_submitted_at timestamptz;

alter table public.reconciliation_cases
  add column if not exists resolved_by uuid;

alter table public.reconciliation_cases
  add column if not exists resolved_by_name text;

alter table public.reconciliation_cases
  add column if not exists resolved_at timestamptz;

alter table public.reconciliation_cases
  add column if not exists closed_by uuid;

alter table public.reconciliation_cases
  add column if not exists closed_by_name text;

alter table public.reconciliation_cases
  add column if not exists closed_at timestamptz;

alter table public.reconciliation_cases
  add column if not exists related_reversal_ref text;

alter table public.reconciliation_cases
  add column if not exists related_transaction_ids jsonb
  default '[]'::jsonb;

alter table public.reconciliation_cases
  add column if not exists created_by uuid;

alter table public.reconciliation_cases
  add column if not exists created_at timestamptz default now();

alter table public.reconciliation_cases
  add column if not exists updated_at timestamptz default now();

create index if not exists idx_recon_cases_status
  on public.reconciliation_cases(status);

create index if not exists idx_recon_cases_exception
  on public.reconciliation_cases(exception_type);

create index if not exists idx_recon_cases_txn
  on public.reconciliation_cases(transaction_id);

create index if not exists idx_recon_cases_assigned
  on public.reconciliation_cases(assigned_to);

create index if not exists idx_recon_cases_employee
  on public.reconciliation_cases(employee_id);


-- ============================================================
-- 13. RECONCILIATION CASE EVENTS
-- ============================================================

create table if not exists public.reconciliation_case_events (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.reconciliation_cases(id) on delete cascade,
  event_type text not null,
  event_data jsonb default '{}'::jsonb,
  comment text,
  created_by uuid references auth.users(id) on delete set null,
  created_by_name text,
  created_at timestamptz default now()
);

alter table public.reconciliation_case_events
  add column if not exists case_id uuid;

alter table public.reconciliation_case_events
  add column if not exists event_type text;

alter table public.reconciliation_case_events
  add column if not exists event_data jsonb
  default '{}'::jsonb;

alter table public.reconciliation_case_events
  add column if not exists comment text;

alter table public.reconciliation_case_events
  add column if not exists created_by uuid;

alter table public.reconciliation_case_events
  add column if not exists created_by_name text;

alter table public.reconciliation_case_events
  add column if not exists created_at timestamptz default now();

create index if not exists idx_recon_events_case
  on public.reconciliation_case_events(case_id);

create index if not exists idx_recon_events_created
  on public.reconciliation_case_events(created_at desc);


-- ============================================================
-- 14. LEAVE RULES
-- ============================================================

create table if not exists public.leave_rules (
  id uuid primary key default gen_random_uuid(),
  leave_type text not null,
  employee_category text,
  entitled_days numeric(5,1),
  description text,
  is_active boolean default true,
  effective_date date default current_date,
  expiry_date date,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(leave_type, employee_category)
);

alter table public.leave_rules
  add column if not exists leave_type text;

alter table public.leave_rules
  add column if not exists employee_category text;

alter table public.leave_rules
  add column if not exists entitled_days numeric(5,1);

alter table public.leave_rules
  add column if not exists description text;

alter table public.leave_rules
  add column if not exists is_active boolean default true;

alter table public.leave_rules
  add column if not exists effective_date date default current_date;

alter table public.leave_rules
  add column if not exists expiry_date date;

alter table public.leave_rules
  add column if not exists created_by uuid;

alter table public.leave_rules
  add column if not exists created_at timestamptz default now();

alter table public.leave_rules
  add column if not exists updated_at timestamptz default now();

insert into public.leave_rules (
  leave_type,
  employee_category,
  entitled_days,
  description
)
select
  'annual',
  'normal_staff',
  10,
  'Annual leave for basic staff'
where not exists (
  select 1
  from public.leave_rules
  where leave_type = 'annual'
    and employee_category = 'normal_staff'
);

insert into public.leave_rules (
  leave_type,
  employee_category,
  entitled_days,
  description
)
select
  'annual',
  'management_staff',
  15,
  'Annual leave for management staff'
where not exists (
  select 1
  from public.leave_rules
  where leave_type = 'annual'
    and employee_category = 'management_staff'
);

insert into public.leave_rules (
  leave_type,
  employee_category,
  entitled_days,
  description
)
select
  'annual',
  'md',
  20,
  'Annual leave for MD'
where not exists (
  select 1
  from public.leave_rules
  where leave_type = 'annual'
    and employee_category = 'md'
);

insert into public.leave_rules (
  leave_type,
  employee_category,
  entitled_days,
  description
)
select
  'maternity',
  null,
  90,
  'Maternity leave — 3 months'
where not exists (
  select 1
  from public.leave_rules
  where leave_type = 'maternity'
    and employee_category is null
);

insert into public.leave_rules (
  leave_type,
  employee_category,
  entitled_days,
  description
)
select
  'examination',
  null,
  5,
  'Examination leave'
where not exists (
  select 1
  from public.leave_rules
  where leave_type = 'examination'
    and employee_category is null
);

insert into public.leave_rules (
  leave_type,
  employee_category,
  entitled_days,
  description
)
select
  'paternity',
  null,
  2,
  'Paternity leave'
where not exists (
  select 1
  from public.leave_rules
  where leave_type = 'paternity'
    and employee_category is null
);


-- ============================================================
-- 15. TRANSPORT ALLOWANCE CONFIG
-- ============================================================

create table if not exists public.transport_allowance_config (
  id uuid primary key default gen_random_uuid(),
  employee_category text,
  branch text,
  allowance_type text default 'transport',
  amount numeric(12,2) not null,
  effective_date date default current_date,
  expiry_date date,
  eligibility text,
  frequency text default 'monthly',
  payroll_treatment text default 'addition',
  is_active boolean default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.transport_allowance_config
  add column if not exists employee_category text;

alter table public.transport_allowance_config
  add column if not exists branch text;

alter table public.transport_allowance_config
  add column if not exists allowance_type text default 'transport';

alter table public.transport_allowance_config
  add column if not exists amount numeric(12,2);

alter table public.transport_allowance_config
  add column if not exists effective_date date default current_date;

alter table public.transport_allowance_config
  add column if not exists expiry_date date;

alter table public.transport_allowance_config
  add column if not exists eligibility text;

alter table public.transport_allowance_config
  add column if not exists frequency text default 'monthly';

alter table public.transport_allowance_config
  add column if not exists payroll_treatment text default 'addition';

alter table public.transport_allowance_config
  add column if not exists is_active boolean default true;

alter table public.transport_allowance_config
  add column if not exists created_by uuid;

alter table public.transport_allowance_config
  add column if not exists created_at timestamptz default now();

alter table public.transport_allowance_config
  add column if not exists updated_at timestamptz default now();

create index if not exists idx_transport_allowance_active
  on public.transport_allowance_config(is_active);


-- ============================================================
-- 16. PERFORMANCE ADJUSTMENTS
-- ============================================================

create table if not exists public.performance_adjustments (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid references public.bankone_transactions(id) on delete set null,
  field_name text not null,
  original_value text,
  corrected_value text,
  reason text not null,
  requested_by uuid references auth.users(id) on delete set null,
  requested_by_name text,
  approved_by uuid references auth.users(id) on delete set null,
  approved_by_name text,
  status text default 'pending',
  evidence text,
  created_at timestamptz default now(),
  approved_at timestamptz
);

alter table public.performance_adjustments
  add column if not exists transaction_id uuid;

alter table public.performance_adjustments
  add column if not exists field_name text;

alter table public.performance_adjustments
  add column if not exists original_value text;

alter table public.performance_adjustments
  add column if not exists corrected_value text;

alter table public.performance_adjustments
  add column if not exists reason text;

alter table public.performance_adjustments
  add column if not exists requested_by uuid;

alter table public.performance_adjustments
  add column if not exists requested_by_name text;

alter table public.performance_adjustments
  add column if not exists approved_by uuid;

alter table public.performance_adjustments
  add column if not exists approved_by_name text;

alter table public.performance_adjustments
  add column if not exists status text default 'pending';

alter table public.performance_adjustments
  add column if not exists evidence text;

alter table public.performance_adjustments
  add column if not exists created_at timestamptz default now();

alter table public.performance_adjustments
  add column if not exists approved_at timestamptz;

create index if not exists idx_perf_adj_txn
  on public.performance_adjustments(transaction_id);

create index if not exists idx_perf_adj_status
  on public.performance_adjustments(status);


-- ============================================================
-- 17. RLS
-- ============================================================

alter table public.bankone_import_batches enable row level security;
alter table public.bankone_import_rows enable row level security;
alter table public.bankone_transactions enable row level security;
alter table public.transaction_status_history enable row level security;
alter table public.transaction_relationships enable row level security;
alter table public.bankone_column_mappings enable row level security;
alter table public.employee_bankone_identifiers enable row level security;
alter table public.performance_metrics enable row level security;
alter table public.performance_results enable row level security;
alter table public.appraisal_periods enable row level security;
alter table public.appraisal_results enable row level security;
alter table public.reconciliation_cases enable row level security;
alter table public.reconciliation_case_events enable row level security;
alter table public.leave_rules enable row level security;
alter table public.transport_allowance_config enable row level security;
alter table public.performance_adjustments enable row level security;


-- ============================================================
-- 18. HELPER FUNCTIONS
-- ============================================================

create or replace function public.can_manage_bankone()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer',
    'operations_manager'
  );
$$;


create or replace function public.can_manage_hr_config()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager'
  );
$$;


create or replace function public.can_manage_reconciliation()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer',
    'operations_manager',
    'branch_manager'
  );
$$;


-- ============================================================
-- 19. DROP PHASE 8 POLICIES BEFORE RECREATING
-- Prevents "policy already exists" errors on rerun.
-- ============================================================

drop policy if exists "bankone_batches read"
  on public.bankone_import_batches;

drop policy if exists "bankone_batches insert"
  on public.bankone_import_batches;

drop policy if exists "bankone_batches update"
  on public.bankone_import_batches;

drop policy if exists "bankone_rows read"
  on public.bankone_import_rows;

drop policy if exists "bankone_rows insert"
  on public.bankone_import_rows;

drop policy if exists "bankone_rows update"
  on public.bankone_import_rows;

drop policy if exists "bankone_rows delete"
  on public.bankone_import_rows;

drop policy if exists "bankone_txn read"
  on public.bankone_transactions;

drop policy if exists "bankone_txn insert"
  on public.bankone_transactions;

drop policy if exists "bankone_txn update"
  on public.bankone_transactions;

drop policy if exists "txn_history read"
  on public.transaction_status_history;

drop policy if exists "txn_history insert"
  on public.transaction_status_history;

drop policy if exists "txn_rel read"
  on public.transaction_relationships;

drop policy if exists "txn_rel insert"
  on public.transaction_relationships;

drop policy if exists "txn_rel delete"
  on public.transaction_relationships;

drop policy if exists "bankone_mapping read"
  on public.bankone_column_mappings;

drop policy if exists "bankone_mapping insert"
  on public.bankone_column_mappings;

drop policy if exists "bankone_mapping update"
  on public.bankone_column_mappings;

drop policy if exists "bankone_mapping delete"
  on public.bankone_column_mappings;

drop policy if exists "emp_bankone read"
  on public.employee_bankone_identifiers;

drop policy if exists "emp_bankone insert"
  on public.employee_bankone_identifiers;

drop policy if exists "emp_bankone update"
  on public.employee_bankone_identifiers;

drop policy if exists "emp_bankone delete"
  on public.employee_bankone_identifiers;

drop policy if exists "perf_metrics read"
  on public.performance_metrics;

drop policy if exists "perf_metrics insert"
  on public.performance_metrics;

drop policy if exists "perf_metrics update"
  on public.performance_metrics;

drop policy if exists "perf_metrics delete"
  on public.performance_metrics;

drop policy if exists "perf_results read"
  on public.performance_results;

drop policy if exists "perf_results insert"
  on public.performance_results;

drop policy if exists "perf_results update"
  on public.performance_results;

drop policy if exists "perf_results delete"
  on public.performance_results;

drop policy if exists "appraisal_periods read"
  on public.appraisal_periods;

drop policy if exists "appraisal_periods insert"
  on public.appraisal_periods;

drop policy if exists "appraisal_periods update"
  on public.appraisal_periods;

drop policy if exists "appraisal_results read"
  on public.appraisal_results;

drop policy if exists "appraisal_results insert"
  on public.appraisal_results;

drop policy if exists "appraisal_results update"
  on public.appraisal_results;

drop policy if exists "appraisal_results delete"
  on public.appraisal_results;

drop policy if exists "recon_cases read"
  on public.reconciliation_cases;

drop policy if exists "recon_cases insert"
  on public.reconciliation_cases;

drop policy if exists "recon_cases update"
  on public.reconciliation_cases;

drop policy if exists "recon_events read"
  on public.reconciliation_case_events;

drop policy if exists "recon_events insert"
  on public.reconciliation_case_events;

drop policy if exists "leave_rules read"
  on public.leave_rules;

drop policy if exists "leave_rules insert"
  on public.leave_rules;

drop policy if exists "leave_rules update"
  on public.leave_rules;

drop policy if exists "leave_rules delete"
  on public.leave_rules;

drop policy if exists "transport_allowance read"
  on public.transport_allowance_config;

drop policy if exists "transport_allowance insert"
  on public.transport_allowance_config;

drop policy if exists "transport_allowance update"
  on public.transport_allowance_config;

drop policy if exists "transport_allowance delete"
  on public.transport_allowance_config;

drop policy if exists "perf_adj read"
  on public.performance_adjustments;

drop policy if exists "perf_adj insert"
  on public.performance_adjustments;

drop policy if exists "perf_adj update"
  on public.performance_adjustments;


-- ============================================================
-- 20. BANKONE IMPORT BATCH POLICIES
-- ============================================================

create policy "bankone_batches read"
on public.bankone_import_batches
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer',
    'operations_manager',
    'branch_manager',
    'head_of_business',
    'area_manager'
  )
);

create policy "bankone_batches insert"
on public.bankone_import_batches
for insert
with check (public.can_manage_bankone());

create policy "bankone_batches update"
on public.bankone_import_batches
for update
using (public.can_manage_bankone());


-- ============================================================
-- 21. BANKONE IMPORT ROW POLICIES
-- ============================================================

create policy "bankone_rows read"
on public.bankone_import_rows
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer',
    'operations_manager',
    'branch_manager',
    'head_of_business',
    'area_manager'
  )
);

create policy "bankone_rows insert"
on public.bankone_import_rows
for insert
with check (public.can_manage_bankone());

create policy "bankone_rows update"
on public.bankone_import_rows
for update
using (public.can_manage_bankone());

create policy "bankone_rows delete"
on public.bankone_import_rows
for delete
using (public.can_manage_bankone());


-- ============================================================
-- 22. BANKONE TRANSACTION POLICIES
-- ============================================================

create policy "bankone_txn read"
on public.bankone_transactions
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer',
    'operations_manager',
    'branch_manager',
    'head_of_business',
    'area_manager',
    'loan_officer',
    'relationship_manager'
  )
);

create policy "bankone_txn insert"
on public.bankone_transactions
for insert
with check (public.can_manage_bankone());

create policy "bankone_txn update"
on public.bankone_transactions
for update
using (public.can_manage_bankone());


-- ============================================================
-- 23. TRANSACTION STATUS HISTORY POLICIES
-- ============================================================

create policy "txn_history read"
on public.transaction_status_history
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer',
    'operations_manager',
    'branch_manager'
  )
);

create policy "txn_history insert"
on public.transaction_status_history
for insert
with check (public.can_manage_bankone());


-- ============================================================
-- 24. TRANSACTION RELATIONSHIP POLICIES
-- ============================================================

create policy "txn_rel read"
on public.transaction_relationships
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer',
    'operations_manager',
    'branch_manager'
  )
);

create policy "txn_rel insert"
on public.transaction_relationships
for insert
with check (public.can_manage_bankone());

create policy "txn_rel delete"
on public.transaction_relationships
for delete
using (public.can_manage_bankone());


-- ============================================================
-- 25. COLUMN MAPPING POLICIES
-- ============================================================

create policy "bankone_mapping read"
on public.bankone_column_mappings
for select
using (auth.role() = 'authenticated');

create policy "bankone_mapping insert"
on public.bankone_column_mappings
for insert
with check (public.can_manage_hr_config());

create policy "bankone_mapping update"
on public.bankone_column_mappings
for update
using (public.can_manage_hr_config());

create policy "bankone_mapping delete"
on public.bankone_column_mappings
for delete
using (public.can_manage_hr_config());


-- ============================================================
-- 26. EMPLOYEE BANKONE IDENTIFIER POLICIES
-- ============================================================

create policy "emp_bankone read"
on public.employee_bankone_identifiers
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer'
  )
);

create policy "emp_bankone insert"
on public.employee_bankone_identifiers
for insert
with check (
  public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer'
  )
);

create policy "emp_bankone update"
on public.employee_bankone_identifiers
for update
using (
  public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager'
  )
);

create policy "emp_bankone delete"
on public.employee_bankone_identifiers
for delete
using (
  public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager'
  )
);


-- ============================================================
-- 27. PERFORMANCE METRICS POLICIES
-- ============================================================

create policy "perf_metrics read"
on public.performance_metrics
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer',
    'operations_manager',
    'branch_manager',
    'head_of_business',
    'area_manager'
  )
);

create policy "perf_metrics insert"
on public.performance_metrics
for insert
with check (public.can_manage_hr_config());

create policy "perf_metrics update"
on public.performance_metrics
for update
using (public.can_manage_hr_config());

create policy "perf_metrics delete"
on public.performance_metrics
for delete
using (public.can_manage_hr_config());


-- ============================================================
-- 28. PERFORMANCE RESULTS POLICIES
-- ============================================================

create policy "perf_results read"
on public.performance_results
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer',
    'operations_manager',
    'branch_manager',
    'head_of_business',
    'area_manager'
  )
);

create policy "perf_results insert"
on public.performance_results
for insert
with check (
  public.can_manage_bankone()
  or public.can_manage_hr_config()
);

create policy "perf_results update"
on public.performance_results
for update
using (
  public.can_manage_bankone()
  or public.can_manage_hr_config()
);

create policy "perf_results delete"
on public.performance_results
for delete
using (public.can_manage_hr_config());


-- ============================================================
-- 29. APPRAISAL PERIOD POLICIES
-- ============================================================

create policy "appraisal_periods read"
on public.appraisal_periods
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer',
    'operations_manager',
    'branch_manager',
    'head_of_business'
  )
);

create policy "appraisal_periods insert"
on public.appraisal_periods
for insert
with check (public.can_manage_hr_config());

create policy "appraisal_periods update"
on public.appraisal_periods
for update
using (public.can_manage_hr_config());


-- ============================================================
-- 30. APPRAISAL RESULT POLICIES
-- ============================================================

create policy "appraisal_results read"
on public.appraisal_results
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer',
    'operations_manager',
    'branch_manager',
    'head_of_business'
  )
);

create policy "appraisal_results insert"
on public.appraisal_results
for insert
with check (
  public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer'
  )
);

create policy "appraisal_results update"
on public.appraisal_results
for update
using (
  public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager'
  )
);

create policy "appraisal_results delete"
on public.appraisal_results
for delete
using (
  public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager'
  )
);


-- ============================================================
-- 31. RECONCILIATION CASE POLICIES
-- ============================================================

create policy "recon_cases read"
on public.reconciliation_cases
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer',
    'operations_manager',
    'branch_manager',
    'head_of_business',
    'area_manager'
  )
);

create policy "recon_cases insert"
on public.reconciliation_cases
for insert
with check (public.can_manage_reconciliation());

create policy "recon_cases update"
on public.reconciliation_cases
for update
using (public.can_manage_reconciliation());


-- ============================================================
-- 32. RECONCILIATION EVENTS POLICIES
-- ============================================================

create policy "recon_events read"
on public.reconciliation_case_events
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer',
    'operations_manager',
    'branch_manager'
  )
);

create policy "recon_events insert"
on public.reconciliation_case_events
for insert
with check (public.can_manage_reconciliation());


-- ============================================================
-- 33. LEAVE RULE POLICIES
-- ============================================================

create policy "leave_rules read"
on public.leave_rules
for select
using (auth.role() = 'authenticated');

create policy "leave_rules insert"
on public.leave_rules
for insert
with check (public.can_manage_hr_config());

create policy "leave_rules update"
on public.leave_rules
for update
using (public.can_manage_hr_config());

create policy "leave_rules delete"
on public.leave_rules
for delete
using (public.can_manage_hr_config());


-- ============================================================
-- 34. TRANSPORT ALLOWANCE POLICIES
-- ============================================================

create policy "transport_allowance read"
on public.transport_allowance_config
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer'
  )
);

create policy "transport_allowance insert"
on public.transport_allowance_config
for insert
with check (public.can_manage_hr_config());

create policy "transport_allowance update"
on public.transport_allowance_config
for update
using (public.can_manage_hr_config());

create policy "transport_allowance delete"
on public.transport_allowance_config
for delete
using (public.can_manage_hr_config());


-- ============================================================
-- 35. PERFORMANCE ADJUSTMENT POLICIES
-- ============================================================

create policy "perf_adj read"
on public.performance_adjustments
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer'
  )
);

create policy "perf_adj insert"
on public.performance_adjustments
for insert
with check (
  public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer'
  )
);

create policy "perf_adj update"
on public.performance_adjustments
for update
using (
  public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager'
  )
);


-- ============================================================
-- 36. LEAVE TYPE EXTENSION
-- ============================================================

alter table public.leave_balances
  drop constraint if exists leave_balances_leave_type_check;

alter table public.leave_balances
  add constraint leave_balances_leave_type_check
  check (
    leave_type in (
      'annual',
      'maternity',
      'paternity',
      'examination',
      'unpaid'
    )
  );


-- ============================================================
-- 37. AUTO-GENERATE RECONCILIATION CASE REFERENCES
-- ============================================================

create or replace function public.generate_case_reference()
returns trigger
language plpgsql
as $$
begin

  if new.case_reference is null then

    new.case_reference =
      'REC-' ||
      extract(year from now())::text ||
      '-' ||
      lpad(
        (
          coalesce(
            (
              select max(seq)
              from (
                select
                  (regexp_match(
                    case_reference,
                    'REC-\d{4}-(\d+)'
                  ))[1]::int as seq
                from public.reconciliation_cases
                where case_reference ~ 'REC-\d{4}-\d+'
              ) t
            ),
            0
          ) + 1
        )::text,
        4,
        '0'
      );

  end if;

  return new;

end;
$$;


drop trigger if exists trg_generate_case_ref
on public.reconciliation_cases;

create trigger trg_generate_case_ref
before insert
on public.reconciliation_cases
for each row
execute function public.generate_case_reference();


-- ============================================================
-- 38. AUTO-UPDATE BANKONE TRANSACTION TIMESTAMP
-- ============================================================

create or replace function public.touch_bankone_transaction()
returns trigger
language plpgsql
as $$
begin

  new.last_updated_at = now();

  return new;

end;
$$;


drop trigger if exists trg_touch_bankone_txn
on public.bankone_transactions;

create trigger trg_touch_bankone_txn
before update
on public.bankone_transactions
for each row
execute function public.touch_bankone_transaction();


-- ============================================================
-- 39. FINAL SAFETY CHECK
-- ============================================================
-- This deliberately raises an error if transaction_status somehow
-- still does not exist. Under normal execution it should return
-- successfully.

do $$
begin

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'bankone_transactions'
      and column_name = 'transaction_status'
  ) then

    raise exception
      'PHASE 8 SAFETY CHECK FAILED: bankone_transactions.transaction_status is missing';

  end if;

end $$;


-- ============================================================
-- PHASE 8 COMPLETE
-- ============================================================
