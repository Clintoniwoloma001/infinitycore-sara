-- ============================================================================
-- ROLLBACK for 20261110000006/07/08 — Director multi-metric import (PHASE 1)
-- ============================================================================
-- Restores the pre-Phase-1 state for the tables this phase ALTERED or CREATED.
-- Run this ONLY to undo the Phase 1 schema; it does NOT touch any other feature.
--
-- SAFETY
--   * The three new tables (director_metric_definitions, director_metric_values,
--     director_metric_values_history, director_metric_settings,
--     director_import_mapping_templates) are dropped. They hold ONLY data written
--     by the Phase 1 import; no pre-existing table depends on them.
--   * bankone_import_batches loses ONLY the additive file_sha256 column that this
--     phase added. No other column is dropped. The _bak_20261010 snapshot taken
--     before the phase still has every original column if a full restore is ever
--     needed.
--   * The two RPCs/functions added by this phase are dropped.
--
-- Idempotent: every statement is "if exists".
-- ============================================================================

begin;

-- Functions added by Phase 1.
drop function if exists public.director_upsert_metric_values(jsonb, uuid, boolean);
drop function if exists public.director_metric_values_sync_unit();

-- Tables added by Phase 1 (children first).
drop table if exists public.director_metric_values_history;
drop table if exists public.director_metric_values;
drop table if exists public.director_metric_settings;
drop table if exists public.director_import_mapping_templates;
drop table if exists public.director_metric_definitions;

-- The ONLY change to a pre-existing table: the additive sha256 column.
drop index if exists uq_bankone_import_batches_sha256;
alter table public.bankone_import_batches drop column if exists file_sha256;

commit;
