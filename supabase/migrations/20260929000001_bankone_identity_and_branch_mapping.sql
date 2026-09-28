-- ============================================================================
-- BankOne Import Identity + Branch Resolution Engine
-- ============================================================================
-- EXTENDS the existing BankOne transaction import model
-- (bankone_import_batches / bankone_import_rows / bankone_column_mappings /
-- employee_bankone_identifiers). Nothing here replaces it: batches gain
-- portfolio fields, and the new tables hold the PERMANENT identity and branch
-- resolutions that make repeated imports automatic.
--
-- Design rules enforced by this schema:
--   * an import is an immutable SNAPSHOT, never overwritten
--   * a name match alone is never a unique identity (employees really do share
--     names), so a mapping must name the employee it resolved to
--   * unresolved officers are RETAINED, never silently reassigned
--
-- Idempotent + additive. Safe to re-run.
begin;

-- ---------------------------------------------------------------------------
-- 1. Extend the existing batch with portfolio/validation fields
-- ---------------------------------------------------------------------------
alter table public.bankone_import_batches
  add column if not exists source_type       text default 'transactions'
    check (source_type in ('transactions','par','disbursement')),
  -- The business "as at" date the uploader selects. Keys the snapshot.
  add column if not exists as_at_date        date,
  add column if not exists branch_count      integer,
  add column if not exists employee_match_count integer,
  add column if not exists unresolved_count  integer,
  add column if not exists branch_issue_count integer,
  add column if not exists validation_status text default 'pending'
    check (validation_status in ('pending','passed','failed')),
  add column if not exists validation_errors jsonb,
  -- Bump when the resolver logic changes, so a historical snapshot can be
  -- reproduced with the exact ruleset that produced it.
  add column if not exists mapping_version   integer default 1,
  add column if not exists calculation_version integer default 1,
  add column if not exists source_row_count  integer,
  add column if not exists parsed_row_count  integer;

create index if not exists idx_bankone_batches_as_at
  on public.bankone_import_batches(as_at_date, source_type);

-- Loan-level snapshot rows. A batch of source_type 'par' holds one row per
-- loan. raw_data keeps the untouched source for audit; normalized_data holds
-- the typed values (numeric/date columns are real types, not strings).
alter table public.bankone_import_rows
  add column if not exists account_no        text,
  add column if not exists as_at_date        date,
  add column if not exists branch_name_raw   text,
  add column if not exists officer_name_raw  text,
  add column if not exists officer_employee_id uuid references public.employees(id) on delete set null,
  add column if not exists resolved_branch_id uuid references public.branches(id) on delete set null,
  add column if not exists match_confidence  numeric,
  add column if not exists match_status      text default 'unresolved'
    check (match_status in ('auto_resolved','pending_review','unresolved','ignored'));

create unique index if not exists uq_bankone_row_account_asat
  on public.bankone_import_rows(batch_id, account_no)
  where account_no is not null;
create index if not exists idx_bankone_rows_unresolved
  on public.bankone_import_rows(batch_id) where match_status <> 'auto_resolved';
create index if not exists idx_bankone_rows_officer
  on public.bankone_import_rows(officer_employee_id, as_at_date);

commit;

-- ============================================================================
-- 2. PERMANENT identity + branch mappings
-- ============================================================================
-- These tables are what make the SECOND import of the same name resolve
-- automatically, without asking a human again.
begin;

-- ---------------------------------------------------------------------------
-- BankOne name -> InfinityCore employee.
-- A name is NOT a unique identity: employees genuinely share names, so a row
-- must always name the employee it resolved to, and a UNIQUE index on the
-- normalised name guarantees one authoritative mapping per BankOne name.
-- ---------------------------------------------------------------------------
create table if not exists public.bankone_employee_mappings (
  id                      uuid primary key default gen_random_uuid(),
  bankone_source_name     text not null,
  -- Comma-stripped, whitespace-collapsed, upper-cased. The join key.
  normalized_source_name  text not null,
  employee_id             uuid references public.employees(id) on delete cascade,
  match_type              text not null default 'manual'
    check (match_type in ('exact_normalized','normalized_format','token_reorder',
                          'truncation','high_confidence','manual','created_employee')),
  confidence              numeric,
  status                  text not null default 'active'
    check (status in ('active','pending_review','unresolved','retired')),
  source                  text not null default 'import'
    check (source in ('import','admin','system')),
  branch_name_raw         text,
  first_seen_import_id    uuid references public.bankone_import_batches(id) on delete set null,
  created_by              uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  -- An ACTIVE mapping must point at an employee. A pending/unresolved mapping
  -- may not, which is how an unresolved officer is retained without a match.
  constraint bankone_employee_mappings_resolved check (
    status <> 'active' or employee_id is not null
  )
);

create unique index if not exists uq_bankone_employee_mappings_name
  on public.bankone_employee_mappings(normalized_source_name);
create index if not exists idx_bankone_employee_mappings_employee
  on public.bankone_employee_mappings(employee_id)
  where employee_id is not null;

-- ---------------------------------------------------------------------------
-- BankOne branch -> canonical InfinityCore branch.
-- The 23 verified BankOne branch names are the canonical BankOne vocabulary;
-- this table records which InfinityCore branch each one resolves to.
-- ---------------------------------------------------------------------------
create table if not exists public.bankone_branch_mappings (
  id                          uuid primary key default gen_random_uuid(),
  bankone_branch_name         text not null,
  normalized_bankone_branch_name text not null,
  canonical_branch_id         uuid references public.branches(id) on delete set null,
  mapping_type                text not null default 'manual'
    check (mapping_type in ('exact','normalized','merged','split','created','manual')),
  status                      text not null default 'active'
    check (status in ('active','pending_review','unresolved','retired')),
  source                      text not null default 'import'
    check (source in ('import','admin','system')),
  -- Set when one InfinityCore branch was SPLIT into several BankOne branches,
  -- so the split is recorded and reversible rather than destructive.
  split_from_branch_id        uuid references public.branches(id) on delete set null,
  created_by                  uuid,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint bankone_branch_mappings_resolved check (
    status <> 'active' or canonical_branch_id is not null
  )
);

create unique index if not exists uq_bankone_branch_mappings_name
  on public.bankone_branch_mappings(normalized_bankone_branch_name);
create index if not exists idx_bankone_branch_mappings_canonical
  on public.bankone_branch_mappings(canonical_branch_id)
  where canonical_branch_id is not null;

-- ---------------------------------------------------------------------------
-- Officers seen in a BankOne import that are not yet attached to an employee.
-- Retained (never discarded) so the unresolved portfolio is always reportable.
-- ---------------------------------------------------------------------------
create table if not exists public.bankone_unresolved_officers (
  id                     uuid primary key default gen_random_uuid(),
  batch_id               uuid not null references public.bankone_import_batches(id) on delete cascade,
  as_at_date             date,
  bankone_source_name    text not null,
  normalized_source_name text not null,
  branch_name_raw        text,
  loan_count             integer not null default 0,
  outstanding_total      numeric not null default 0,
  first_seen_import_id   uuid references public.bankone_import_batches(id) on delete set null,
  status                 text not null default 'unresolved'
    check (status in ('unresolved','mapped','created_employee','ignored')),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create unique index if not exists uq_bankone_unresolved_batch_name
  on public.bankone_unresolved_officers(batch_id, normalized_source_name);

-- ---------------------------------------------------------------------------
-- Employees created FROM a BankOne import. Records provenance and keeps HR in
-- control: pending verification, no auth account, nothing invented.
-- ---------------------------------------------------------------------------
create table if not exists public.bankone_created_employees (
  id                  uuid primary key default gen_random_uuid(),
  employee_id         uuid not null references public.employees(id) on delete cascade,
  source_import_id    uuid references public.bankone_import_batches(id) on delete set null,
  bankone_source_name text not null,
  branch_name_raw     text,
  verification_status text not null default 'pending'
    check (verification_status in ('pending','verified','rejected')),
  created_by          uuid,
  created_at          timestamptz not null default now()
);

create unique index if not exists uq_bankone_created_employee
  on public.bankone_created_employees(employee_id);

commit;
