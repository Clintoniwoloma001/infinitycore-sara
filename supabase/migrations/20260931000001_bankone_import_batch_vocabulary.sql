-- ============================================================================
-- BankOne portfolio import: make the batch vocabulary match the importer.
-- ============================================================================
-- Run in Supabase SQL Editor after 20260930000002. Idempotent and additive.
--
-- THE REPORTED FAILURE
--   "new row for relation bankone_import_batches violates check constraint
--    bankone_import_batches_operation_type_check"
--
-- Root cause: bankonePortfolioService.createImport() writes
--   operation_type: 'portfolio'
-- but the CHECK allow-list (from schema_phase9) only admits payroll/customer
-- reconciliation values and ends at 'generic'. 'portfolio' was never added, so
-- EVERY Portfolio At Risk and Disbursement upload failed on the batch insert and
-- nothing was persisted.
--
-- THREE LATENT FAILURES BEHIND IT
-- Fixing only operation_type would move the error to the next line, because the
-- same insert also violates two more constraints:
--
--   1. status: 'pending_review'
--      The CHECK admits only preview|importing|completed|completed_with_warnings|
--      failed. The importer's review workflow has no valid value at all.
--
--   2. bankone_unresolved_officers has NO INSERT policy
--      It has a SELECT policy only, so the unresolved-officer insert that runs
--      immediately after would be rejected by RLS. Unresolved officers are the
--      exact rows HR most needs to see, so silently losing them is the worst
--      possible failure.
--
--   3. setImportStatus() writes status 'approved' / 'rejected'
--      Also outside the CHECK, so the approve/reject buttons could never work.
--
-- THE FIX
-- Extend the vocabulary rather than rewrite the importer. operation_type gains
-- the real BankOne portfolio values; status gains the three review states the
-- importer already models. Existing rows are untouched: the new values are
-- additive, and anything outside the allow-list is backfilled so the constraint
-- can be validated safely.
begin;

-- ---------------------------------------------------------------------------
-- 1. operation_type: add the BankOne portfolio vocabulary.
--    'portfolio' is kept because it is what the importer writes; 'par' and
--    'disbursement' are added so a batch can be told apart by report type.
-- ---------------------------------------------------------------------------
alter table public.bankone_import_batches
  drop constraint if exists bankone_import_batches_operation_type_check;

-- Backfill anything already stored outside the allow-list so the new CHECK
-- cannot fail on a pre-existing row.
update public.bankone_import_batches
   set operation_type = 'generic'
 where operation_type is null
    or operation_type not in (
      'hr_mpr','staff_performance','target_achievement','appraisal_data',
      'payroll_import','salary_data','allowances','deductions',
      'transport_allowance','other_allowance','customer_reconciliation',
      'failed_transactions','pending_transactions','incomplete_transactions',
      'reversed_transactions','resolution_data',
      -- NEW
      'generic','portfolio','par','disbursement');

alter table public.bankone_import_batches
  add constraint bankone_import_batches_operation_type_check
  check (operation_type in (
      'hr_mpr','staff_performance','target_achievement','appraisal_data',
      'payroll_import','salary_data','allowances','deductions',
      'transport_allowance','other_allowance','customer_reconciliation',
      'failed_transactions','pending_transactions','incomplete_transactions',
      'reversed_transactions','resolution_data',
      -- NEW: the BankOne portfolio importer
      'generic','portfolio','par','disbursement'));

-- ---------------------------------------------------------------------------
-- 2. status: the importer models a REVIEW gate the legacy vocabulary has no
--    name for. pending_review / approved / rejected are added; the legacy
--    preview|importing|completed|completed_with_warnings|failed all stay valid.
-- ---------------------------------------------------------------------------
alter table public.bankone_import_batches
  drop constraint if exists bankone_import_batches_status_check;

update public.bankone_import_batches
   set status = 'completed'
 where status is null
    or status not in (
      'preview','importing','completed','completed_with_warnings','failed',
      -- NEW: the BankOne review workflow
      'pending_review','approved','rejected');

alter table public.bankone_import_batches
  add constraint bankone_import_batches_status_check
  check (status in (
      'preview','importing','completed','completed_with_warnings','failed',
      -- NEW
      'pending_review','approved','rejected'));

-- A published snapshot must say WHO published it and WHEN. The importer already
-- writes these two columns, so they are asserted rather than assumed present.
alter table public.bankone_import_batches
  add column if not exists confirmed_by  uuid references auth.users(id) on delete set null,
  add column if not exists confirmed_at  timestamptz;

-- ---------------------------------------------------------------------------
-- 3. bankone_unresolved_officers had a SELECT policy but NO INSERT policy, so
--    the importer's unresolved rows were dropped by RLS. Unresolved officers
--    are precisely what HR must resolve, so this is a correctness fix, not a
--    convenience one.
-- ---------------------------------------------------------------------------
drop policy if exists "bankone_unresolved_officers_insert" on public.bankone_unresolved_officers;
create policy "bankone_unresolved_officers_insert" on public.bankone_unresolved_officers
  for insert to authenticated
  with check (public.can_manage_bankone());

-- Writing an import is an accountable action, so the same gate is applied to
-- the batch insert the UI performs directly.
drop policy if exists "bankone_batches insert" on public.bankone_import_batches;
create policy "bankone_batches insert" on public.bankone_import_batches
  for insert to authenticated
  with check (public.can_manage_bankone());

comment on column public.bankone_import_batches.operation_type is
  'What kind of import this batch is. BankOne portfolio uploads use par/disbursement (or the historical portfolio value); the remaining values are the legacy payroll and customer-reconciliation imports.';
comment on column public.bankone_import_batches.status is
  'Import lifecycle. A BankOne snapshot is created as pending_review and becomes approved or rejected once the officer and branch identities are resolved - nothing is published before then.';

commit;

