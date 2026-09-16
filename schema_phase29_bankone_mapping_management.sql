-- ============================================================
-- PHASE 29 — BANKONE MAPPING MANAGEMENT (additive, idempotent)
--
-- Enables dynamic HR/Admin management of BankOne field mappings:
--   * field_metadata  — per-destination-field { type, required,
--                       unique, matching, performance, reconciliation }
--   * version         — optional template/format version label so
--                       old mappings are never silently replaced.
--
-- Historical BankOne records/import batches are NOT touched.
-- Writes remain guarded by the existing policy set in
-- schema_phase8_9_recovery.sql (super_admin/admin/hr_manager/
-- hr_officer/operations_manager). Safe to re-run.
-- ============================================================

alter table public.bankone_column_mappings
  add column if not exists field_metadata jsonb not null default '{}'::jsonb;

alter table public.bankone_column_mappings
  add column if not exists version text;

comment on column public.bankone_column_mappings.field_metadata is
  'Per-destination-field metadata: { type, required, unique, matching, performance, reconciliation }.';
comment on column public.bankone_column_mappings.version is
  'Optional BankOne template/format version so mappings can be versioned safely.';
