-- ============================================================
-- PHASE 8: BANKONE INTELLIGENCE — Import Engine, Transaction
-- Ledger, Deduplication, Reconciliation, Performance, Appraisal.
--
-- ALL ADDITIVE. Run after all prior schema files.
-- Safe to re-run: every statement uses IF NOT EXISTS / OR REPLACE.
--
-- InfinityCore consumes BankOne exports (Excel/CSV). BankOne remains
-- the core transaction system. InfinityCore is the intelligence layer.
-- ============================================================

-- ============================================================
-- 1. BANKONE IMPORT BATCHES — tracks each upload session
-- ============================================================
create table if not exists public.bankone_import_batches (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  source_format text default 'csv',          -- csv | xlsx
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_by_name text,
  uploaded_at timestamptz default now(),
  reporting_period text,                      -- e.g. "September Week 1"
  mapping_config jsonb,                        -- { source_column: target_field }
  status text default 'pending' check (status in (
    'pending', 'validating', 'preview', 'confirmed',
    'importing', 'completed', 'completed_with_warnings',
    'cancelled', 'failed'
  )),
  total_rows int default 0,
  valid_rows int default 0,
  rejected_rows int default 0,
  duplicate_rows int default 0,
  unmatched_staff_rows int default 0,
  imported_rows int default 0,
  error_message text,
  raw_file_path text,                         -- optional storage path for the original file
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_bankone_batches_status on public.bankone_import_batches(status);
create index if not exists idx_bankone_batches_uploaded_at on public.bankone_import_batches(uploaded_at desc);

-- ============================================================
-- 2. BANKONE IMPORT ROWS — raw, unmodified row data per batch
--    (RAW DATA PRESERVATION — never lose original BankOne info)
-- ============================================================
create table if not exists public.bankone_import_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.bankone_import_batches(id) on delete cascade,
  row_number int not null,
  raw_data jsonb not null,                     -- original cell values keyed by source header
  normalized_data jsonb,                        -- mapped + normalized InfinityCore fields
  status text default 'pending' check (status in (
    'valid', 'warning', 'error', 'duplicate',
    'unmatched_staff', 'imported', 'rejected'
  )),
  validation_errors jsonb default '[]'::jsonb, -- [{ message, severity }]
  match_type text,                             -- how dedup matched: reference | fingerprint | null
  matched_transaction_id uuid,                 -- FK to bankone_transactions if duplicate
  employee_id uuid,                            -- matched employee (null if unmatched)
  employee_match_method text,                 -- employee_id | staff_code | bankone_id | email | name | manual
  transaction_id uuid,                         -- FK to bankone_transactions after import
  created_at timestamptz default now()
);

create index if not exists idx_bankone_rows_batch on public.bankone_import_rows(batch_id);
create index if not exists idx_bankone_rows_status on public.bankone_import_rows(status);
create index if not exists idx_bankone_rows_employee on public.bankone_import_rows(employee_id);

-- ============================================================
-- 3. BANKONE TRANSACTIONS — normalized, deduplicated ledger
--    Core unique identity: source_system + transaction_reference
-- ============================================================
create table if not exists public.bankone_transactions (
  id uuid primary key default gen_random_uuid(),
  source_system text default 'bankone',
  transaction_reference text,                  -- primary identity from BankOne
  transaction_date date,
  transaction_time text,
  staff_identifier text,                       -- officer name/code as in source
  employee_id uuid,                            -- matched InfinityCore employee
  employee_match_method text,
  branch text,
  transaction_type text,
  transaction_status text,                     -- completed | failed | pending | reversed | incomplete
  amount numeric(18, 2),
  channel text,
  product_service text,
  reversal_indicator text,
  original_transaction_reference text,         -- links reversal to original
  customer_account_ref text,                   -- only where legitimately available
  additional_fields jsonb default '{}'::jsonb, -- preserve all other source fields
  dedup_fingerprint text,                       -- deterministic fallback identity
  first_imported_batch_id uuid references public.bankone_import_batches(id) on delete set null,
  first_imported_at timestamptz default now(),
  last_updated_at timestamptz default now(),
  created_at timestamptz default now(),
  unique (source_system, transaction_reference) on conflict (transaction_reference) where transaction_reference is not null
);

create index if not exists idx_bankone_txn_ref on public.bankone_transactions(transaction_reference);
create index if not exists idx_bankone_txn_employee on public.bankone_transactions(employee_id);
create index if not exists idx_bankone_txn_date on public.bankone_transactions(transaction_date);
create index if not exists idx_bankone_txn_status on public.bankone_transactions(transaction_status);
create index if not exists idx_bankone_txn_branch on public.bankone_transactions(branch);
create index if not exists idx_bankone_txn_fingerprint on public.bankone_transactions(dedup_fingerprint);
create index if not exists idx_bankone_txn_original_ref on public.bankone_transactions(original_transaction_reference);

-- ============================================================
-- 4. TRANSACTION STATUS HISTORY — lifecycle of each transaction
--    Preserves the full history when status changes across imports
-- ============================================================
create table if not exists public.transaction_status_history (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.bankone_transactions(id) on delete cascade,
  old_status text,
  new_status text,
  changed_at timestamptz default now(),
  changed_by text,                             -- import batch id or user
  source text,                                 -- which import batch triggered the change
  notes text
);

create index if not exists idx_txn_history_transaction on public.transaction_status_history(transaction_id);
create index if not exists idx_txn_history_changed_at on public.transaction_status_history(changed_at desc);

-- ============================================================
-- 5. TRANSACTION RELATIONSHIPS — links originals to reversals
-- ============================================================
create table if not exists public.transaction_relationships (
  id uuid primary key default gen_random_uuid(),
  parent_transaction_id uuid not null references public.bankone_transactions(id) on delete cascade,
  child_transaction_id uuid not null references public.bankone_transactions(id) on delete cascade,
  relationship_type text not null default 'reversal' check (relationship_type in (
    'reversal', 'double_reversal', 'correction', 'related'
  )),
  created_at timestamptz default now(),
  unique (parent_transaction_id, child_transaction_id)
);

create index if not exists idx_txn_rel_parent on public.transaction_relationships(parent_transaction_id);
create index if not exists idx_txn_rel_child on public.transaction_relationships(child_transaction_id);

-- ============================================================
-- 6. BANKONE COLUMN MAPPINGS — configurable, stored in DB
--    so future BankOne formats can be mapped without code changes
-- ============================================================
create table if not exists public.bankone_column_mappings (
  id uuid primary key default gen_random_uuid(),
  name text not null,                          -- e.g. "BankOne Default Export"
  description text,
  mapping jsonb not null default '{}'::jsonb,  -- { "Transaction Ref": "transaction_reference", ... }
  is_default boolean default false,
  is_active boolean default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Seed a sensible default mapping
insert into public.bankone_column_mappings (name, description, mapping, is_default, is_active)
values (
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
)
on conflict do nothing;

-- ============================================================
-- 7. EMPLOYEE BANKONE IDENTIFIERS — staff-to-BankOne mapping
--    for confident staff identification beyond name matching
-- ============================================================
create table if not exists public.employee_bankone_identifiers (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  identifier_type text not null check (identifier_type in (
    'employee_id', 'staff_code', 'bankone_officer_id', 'email', 'normalized_name', 'manual'
  )),
  identifier_value text not null,
  is_verified boolean default false,
  verified_by uuid references auth.users(id) on delete set null,
  verified_at timestamptz,
  created_at timestamptz default now(),
  unique (identifier_type, identifier_value)
);

create index if not exists idx_emp_bankone_emp on public.employee_bankone_identifiers(employee_id);
create index if not exists idx_emp_bankone_type_val on public.employee_bankone_identifiers(identifier_type, identifier_value);

-- ============================================================
-- 8. PERFORMANCE METRICS — configurable HR performance criteria
-- ============================================================
create table if not exists public.performance_metrics (
  id uuid primary key default gen_random_uuid(),
  metric_name text not null,
  description text,
  metric_type text default 'quantity' check (metric_type in (
    'quantity', 'monetary', 'percentage', 'rating'
  )),
  department text,                              -- null = all departments
  employee_category text,                       -- null = all categories
  applicable_role text,                         -- null = all roles
  branch text,                                  -- null = all branches
  target_period text default 'monthly' check (target_period in (
    'daily', 'weekly', 'monthly', 'quarterly', 'yearly'
  )),
  target_quantity numeric(18, 2),
  target_monetary_value numeric(18, 2),
  minimum_threshold numeric(18, 2),
  achievement_bands jsonb default '[]'::jsonb,  -- [{ label, min_pct, max_pct }]
  score_weight numeric(5, 2) default 0,          -- percentage weight, e.g. 20.00
  effective_date date default current_date,
  expiry_date date,
  is_active boolean default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_perf_metrics_active on public.performance_metrics(is_active);
create index if not exists idx_perf_metrics_dept on public.performance_metrics(department);

-- ============================================================
-- 9. PERFORMANCE RESULTS — calculated actuals vs targets
-- ============================================================
create table if not exists public.performance_results (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references public.employees(id) on delete cascade,
  employee_name text,
  metric_id uuid references public.performance_metrics(id) on delete set null,
  metric_name text,
  period_label text not null,                   -- e.g. "2025-09"
  period_start date,
  period_end date,
  target_value numeric(18, 2),
  actual_value numeric(18, 2),
  achievement_pct numeric(8, 2),                -- actual / target * 100
  performance_status text,                      -- below_target | meets_target | exceeds_target | exceptional
  score numeric(8, 2),
  weight numeric(5, 2),
  weighted_score numeric(8, 2),
  rank int,
  calculated_at timestamptz default now(),
  source text default 'bankone_import',         -- provenance
  created_at timestamptz default now(),
  unique (employee_id, metric_id, period_label)
);

create index if not exists idx_perf_results_emp on public.performance_results(employee_id);
create index if not exists idx_perf_results_period on public.performance_results(period_label);
create index if not exists idx_perf_results_metric on public.performance_results(metric_id);

-- ============================================================
-- 10. APPRAISAL PERIODS
-- ============================================================
create table if not exists public.appraisal_periods (
  id uuid primary key default gen_random_uuid(),
  period_label text not null,                   -- e.g. "H1 2025"
  start_date date,
  end_date date,
  status text default 'open' check (status in ('open', 'in_review', 'closed')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (period_label)
);

-- ============================================================
-- 11. APPRAISAL RESULTS — per-employee appraisal with KPIs
-- ============================================================
create table if not exists public.appraisal_results (
  id uuid primary key default gen_random_uuid(),
  appraisal_period_id uuid not null references public.appraisal_periods(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  employee_name text,
  department text,
  role text,
  kpi_data jsonb default '[]'::jsonb,           -- [{ metric_name, target, actual, achievement_pct, score, weight, weighted_score }]
  overall_rating text,                          -- below_target | meets_target | exceeds_target | exceptional
  overall_score numeric(8, 2),
  manager_comments text,
  hr_comments text,
  status text default 'draft' check (status in (
    'draft', 'submitted', 'reviewed', 'approved', 'rejected'
  )),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  approval_history jsonb default '[]'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (appraisal_period_id, employee_id)
);

create index if not exists idx_appraisal_results_emp on public.appraisal_results(employee_id);
create index if not exists idx_appraisal_results_period on public.appraisal_results(appraisal_period_id);

-- ============================================================
-- 12. RECONCILIATION CASES — exception management
-- ============================================================
create table if not exists public.reconciliation_cases (
  id uuid primary key default gen_random_uuid(),
  case_reference text unique,                   -- human-readable, e.g. "REC-2025-0001"
  transaction_id uuid references public.bankone_transactions(id) on delete set null,
  transaction_reference text,
  employee_id uuid references public.employees(id) on delete set null,
  employee_name text,
  branch text,
  amount numeric(18, 2),
  transaction_date date,
  transaction_type text,
  original_status text,
  current_status text,
  exception_type text check (exception_type in (
    'failed', 'pending', 'incomplete', 'reversed', 'duplicate',
    'reversal_detected', 'reversal_already_processed', 'unknown_staff', 'other'
  )),
  detected_date timestamptz default now(),
  detected_by text,                             -- import batch id
  assigned_to uuid references auth.users(id) on delete set null,
  assigned_to_name text,
  priority text default 'medium' check (priority in ('low', 'medium', 'high', 'critical')),
  status text default 'new' check (status in (
    'new', 'pending', 'failed', 'incomplete', 'under_review',
    'resolution_requested', 'resolved', 'closed', 'reopened',
    'duplicate', 'reversal_detected', 'reversal_already_processed'
  )),
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

create index if not exists idx_recon_cases_status on public.reconciliation_cases(status);
create index if not exists idx_recon_cases_exception on public.reconciliation_cases(exception_type);
create index if not exists idx_recon_cases_txn on public.reconciliation_cases(transaction_id);
create index if not exists idx_recon_cases_assigned on public.reconciliation_cases(assigned_to);
create index if not exists idx_recon_cases_employee on public.reconciliation_cases(employee_id);

-- ============================================================
-- 13. RECONCILIATION CASE EVENTS — audit trail per case
-- ============================================================
create table if not exists public.reconciliation_case_events (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.reconciliation_cases(id) on delete cascade,
  event_type text not null check (event_type in (
    'created', 'assigned', 'commented', 'evidence_attached',
    'resolution_requested', 'resolution_submitted', 'reviewed',
    'approved_closure', 'reopened', 'status_changed', 'closed'
  )),
  event_data jsonb default '{}'::jsonb,
  comment text,
  created_by uuid references auth.users(id) on delete set null,
  created_by_name text,
  created_at timestamptz default now()
);

create index if not exists idx_recon_events_case on public.reconciliation_case_events(case_id);
create index if not exists idx_recon_events_created on public.reconciliation_case_events(created_at desc);

-- ============================================================
-- 14. LEAVE RULES — database-backed, replaces hardcoded constants
-- ============================================================
create table if not exists public.leave_rules (
  id uuid primary key default gen_random_uuid(),
  leave_type text not null check (leave_type in (
    'annual', 'maternity', 'examination', 'paternity', 'sick', 'personal', 'unpaid'
  )),
  employee_category text,                      -- normal_staff | management_staff | md | null = all
  entitled_days numeric(5, 1),
  description text,
  is_active boolean default true,
  effective_date date default current_date,
  expiry_date date,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (leave_type, employee_category)
);

-- Seed the actual HR policy
insert into public.leave_rules (leave_type, employee_category, entitled_days, description) values
  ('annual', 'normal_staff', 20, 'Annual leave for normal staff'),
  ('annual', 'management_staff', 15, 'Annual leave for management staff'),
  ('annual', 'md', 20, 'Annual leave for MD'),
  ('maternity', null, 90, 'Maternity leave — 3 months'),
  ('examination', null, 5, 'Examination leave'),
  ('paternity', null, 2, 'Paternity leave'),
  ('sick', null, 10, 'Sick leave'),
  ('personal', null, 5, 'Personal leave')
on conflict do nothing;

-- ============================================================
-- 15. TRANSPORT ALLOWANCE CONFIG
-- ============================================================
create table if not exists public.transport_allowance_config (
  id uuid primary key default gen_random_uuid(),
  employee_category text,
  branch text,                                  -- null = all branches
  allowance_type text default 'transport',
  amount numeric(12, 2) not null,
  effective_date date default current_date,
  expiry_date date,
  eligibility text,
  frequency text default 'monthly' check (frequency in ('daily', 'weekly', 'monthly', 'quarterly', 'yearly')),
  payroll_treatment text default 'addition' check (payroll_treatment in ('addition', 'reimbursement')),
  is_active boolean default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_transport_allowance_active on public.transport_allowance_config(is_active);

-- ============================================================
-- 16. PERFORMANCE ADJUSTMENTS — corrections to BankOne-derived data
--    (never overwrite the source; record the correction with audit)
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
  status text default 'pending' check (status in ('pending', 'approved', 'rejected')),
  evidence text,
  created_at timestamptz default now(),
  approved_at timestamptz
);

create index if not exists idx_perf_adj_txn on public.performance_adjustments(transaction_id);
create index if not exists idx_perf_adj_status on public.performance_adjustments(status);

-- ============================================================
-- ROW LEVEL SECURITY
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

-- Helper: roles that can manage BankOne data
create or replace function public.can_manage_bankone()
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'operations_manager');
$$;

-- Helper: roles that can manage HR config
create or replace function public.can_manage_hr_config()
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_role() in ('super_admin', 'admin', 'hr_manager');
$$;

-- Helper: roles that can manage reconciliation
create or replace function public.can_manage_reconciliation()
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'operations_manager', 'branch_manager');
$$;

-- BankOne import batches — read for authorized roles, write for managers
create policy "bankone_batches read" on public.bankone_import_batches
  for select using (
    auth.role() = 'authenticated'
    and public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'operations_manager', 'branch_manager', 'head_of_business', 'area_manager')
  );
create policy "bankone_batches insert" on public.bankone_import_batches
  for insert with check (public.can_manage_bankone());
create policy "bankone_batches update" on public.bankone_import_batches
  for update using (public.can_manage_bankone());

-- BankOne import rows — same access pattern
create policy "bankone_rows read" on public.bankone_import_rows
  for select using (
    auth.role() = 'authenticated'
    and public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'operations_manager', 'branch_manager', 'head_of_business', 'area_manager')
  );
create policy "bankone_rows insert" on public.bankone_import_rows
  for insert with check (public.can_manage_bankone());
create policy "bankone_rows update" on public.bankone_import_rows
  for update using (public.can_manage_bankone());
create policy "bankone_rows delete" on public.bankone_import_rows
  for delete using (public.can_manage_bankone());

-- BankOne transactions — read for authorized roles, write for import managers
create policy "bankone_txn read" on public.bankone_transactions
  for select using (
    auth.role() = 'authenticated'
    and public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'operations_manager', 'branch_manager', 'head_of_business', 'area_manager', 'loan_officer', 'relationship_manager')
  );
create policy "bankone_txn insert" on public.bankone_transactions
  for insert with check (public.can_manage_bankone());
create policy "bankone_txn update" on public.bankone_transactions
  for update using (public.can_manage_bankone());

-- Transaction status history — read for authorized, insert for import
create policy "txn_history read" on public.transaction_status_history
  for select using (
    auth.role() = 'authenticated'
    and public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'operations_manager', 'branch_manager')
  );
create policy "txn_history insert" on public.transaction_status_history
  for insert with check (public.can_manage_bankone());

-- Transaction relationships
create policy "txn_rel read" on public.transaction_relationships
  for select using (
    auth.role() = 'authenticated'
    and public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'operations_manager', 'branch_manager')
  );
create policy "txn_rel insert" on public.transaction_relationships
  for insert with check (public.can_manage_bankone());
create policy "txn_rel delete" on public.transaction_relationships
  for delete using (public.can_manage_bankone());

-- Column mappings — read for all authenticated, write for HR config managers
create policy "bankone_mapping read" on public.bankone_column_mappings
  for select using (auth.role() = 'authenticated');
create policy "bankone_mapping insert" on public.bankone_column_mappings
  for insert with check (public.can_manage_hr_config());
create policy "bankone_mapping update" on public.bankone_column_mappings
  for update using (public.can_manage_hr_config());
create policy "bankone_mapping delete" on public.bankone_column_mappings
  for delete using (public.can_manage_hr_config());

-- Employee BankOne identifiers
create policy "emp_bankone read" on public.employee_bankone_identifiers
  for select using (
    auth.role() = 'authenticated'
    and public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
  );
create policy "emp_bankone insert" on public.employee_bankone_identifiers
  for insert with check (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));
create policy "emp_bankone update" on public.employee_bankone_identifiers
  for update using (public.current_role() in ('super_admin', 'admin', 'hr_manager'));
create policy "emp_bankone delete" on public.employee_bankone_identifiers
  for delete using (public.current_role() in ('super_admin', 'admin', 'hr_manager'));

-- Performance metrics — read for authorized, write for HR config
create policy "perf_metrics read" on public.performance_metrics
  for select using (
    auth.role() = 'authenticated'
    and public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'operations_manager', 'branch_manager', 'head_of_business', 'area_manager')
  );
create policy "perf_metrics insert" on public.performance_metrics
  for insert with check (public.can_manage_hr_config());
create policy "perf_metrics update" on public.performance_metrics
  for update using (public.can_manage_hr_config());
create policy "perf_metrics delete" on public.performance_metrics
  for delete using (public.can_manage_hr_config());

-- Performance results — read for authorized, write for system/import
create policy "perf_results read" on public.performance_results
  for select using (
    auth.role() = 'authenticated'
    and public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'operations_manager', 'branch_manager', 'head_of_business', 'area_manager')
  );
create policy "perf_results insert" on public.performance_results
  for insert with check (public.can_manage_bankone() or public.can_manage_hr_config());
create policy "perf_results update" on public.performance_results
  for update using (public.can_manage_bankone() or public.can_manage_hr_config());
create policy "perf_results delete" on public.performance_results
  for delete using (public.can_manage_hr_config());

-- Appraisal periods
create policy "appraisal_periods read" on public.appraisal_periods
  for select using (
    auth.role() = 'authenticated'
    and public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'operations_manager', 'branch_manager', 'head_of_business')
  );
create policy "appraisal_periods insert" on public.appraisal_periods
  for insert with check (public.can_manage_hr_config());
create policy "appraisal_periods update" on public.appraisal_periods
  for update using (public.can_manage_hr_config());

-- Appraisal results
create policy "appraisal_results read" on public.appraisal_results
  for select using (
    auth.role() = 'authenticated'
    and public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'operations_manager', 'branch_manager', 'head_of_business')
  );
create policy "appraisal_results insert" on public.appraisal_results
  for insert with check (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));
create policy "appraisal_results update" on public.appraisal_results
  for update using (public.current_role() in ('super_admin', 'admin', 'hr_manager'));
create policy "appraisal_results delete" on public.appraisal_results
  for delete using (public.current_role() in ('super_admin', 'admin', 'hr_manager'));

-- Reconciliation cases
create policy "recon_cases read" on public.reconciliation_cases
  for select using (
    auth.role() = 'authenticated'
    and public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'operations_manager', 'branch_manager', 'head_of_business', 'area_manager')
  );
create policy "recon_cases insert" on public.reconciliation_cases
  for insert with check (public.can_manage_reconciliation());
create policy "recon_cases update" on public.reconciliation_cases
  for update using (public.can_manage_reconciliation());

-- Reconciliation case events
create policy "recon_events read" on public.reconciliation_case_events
  for select using (
    auth.role() = 'authenticated'
    and public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'operations_manager', 'branch_manager')
  );
create policy "recon_events insert" on public.reconciliation_case_events
  for insert with check (public.can_manage_reconciliation());

-- Leave rules — read for all authenticated, write for HR config
create policy "leave_rules read" on public.leave_rules
  for select using (auth.role() = 'authenticated');
create policy "leave_rules insert" on public.leave_rules
  for insert with check (public.can_manage_hr_config());
create policy "leave_rules update" on public.leave_rules
  for update using (public.can_manage_hr_config());
create policy "leave_rules delete" on public.leave_rules
  for delete using (public.can_manage_hr_config());

-- Transport allowance config
create policy "transport_allowance read" on public.transport_allowance_config
  for select using (
    auth.role() = 'authenticated'
    and public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
  );
create policy "transport_allowance insert" on public.transport_allowance_config
  for insert with check (public.can_manage_hr_config());
create policy "transport_allowance update" on public.transport_allowance_config
  for update using (public.can_manage_hr_config());
create policy "transport_allowance delete" on public.transport_allowance_config
  for delete using (public.can_manage_hr_config());

-- Performance adjustments
create policy "perf_adj read" on public.performance_adjustments
  for select using (
    auth.role() = 'authenticated'
    and public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
  );
create policy "perf_adj insert" on public.performance_adjustments
  for insert with check (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));
create policy "perf_adj update" on public.performance_adjustments
  for update using (public.current_role() in ('super_admin', 'admin', 'hr_manager'));

-- ============================================================
-- LEAVE TYPE EXTENSION — add 'examination' to leave_balances
-- ============================================================
alter table public.leave_balances drop constraint if exists leave_balances_leave_type_check;
alter table public.leave_balances add constraint leave_balances_leave_type_check
  check (leave_type in ('annual','sick','maternity','paternity','examination','personal','unpaid'));

-- ============================================================
-- TRIGGERS — auto-generate case references
-- ============================================================
create or replace function public.generate_case_reference()
returns trigger language plpgsql as $$
begin
  if new.case_reference is null then
    new.case_reference = 'REC-' || extract(year from now())::text || '-' || lpad(
      (coalesce(
        (select max(seq) from (
          select (regexp_match(case_reference, 'REC-\d{4}-(\d+)'))[1]::int as seq
          from public.reconciliation_cases
          where case_reference ~ 'REC-\d{4}-\d+'
        ) t), 0
      ) + 1)
    )::text, 4, '0');
  end if;
  return new;
end; $$;

drop trigger if exists trg_generate_case_ref on public.reconciliation_cases;
create trigger trg_generate_case_ref
  before insert on public.reconciliation_cases
  for each row execute function public.generate_case_reference();

-- Auto-update last_updated_at on bankone_transactions
create or replace function public.touch_bankone_transaction()
returns trigger language plpgsql as $$
begin
  new.last_updated_at = now();
  return new;
end; $$;

drop trigger if exists trg_touch_bankone_txn on public.bankone_transactions;
create trigger trg_touch_bankone_txn
  before update on public.bankone_transactions
  for each row execute function public.touch_bankone_transaction();
