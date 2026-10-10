-- ============================================================================
-- PHASE 1 IDEMPOTENCY TEST — director_upsert_metric_values
-- ============================================================================
-- Runs the exact sequence the brief requires, INSIDE ONE TRANSACTION THAT IS
-- ROLLED BACK, so it never writes to production:
--   File A (all metrics) -> File B (caseload only, same employees+date)
--   -> File A again -> conflict (unconfirmed) -> conflict (confirmed).
-- Asserts: no duplicate rows; other metrics untouched by B; counts as expected;
-- history rows written for inserts, updates and confirmed conflicts.
--
-- HOW TO RUN (password comes from ~/.pgpass, never typed):
--   PGPASSFILE=~/.pgpass /opt/homebrew/opt/libpq/bin/psql \
--     "postgresql://postgres.atzomqicwjufuxhfexxd@aws-1-eu-west-1.pooler.supabase.com:5432/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/20261110000006_idempotency_test.sql
-- The final ROLLBACK guarantees zero residue.
-- ============================================================================

\set ON_ERROR_STOP on

begin;

-- Simulate an authenticated BankOne manager (super_admin). auth.uid() reads
-- request.jwt.claim.sub (or request.jwt.claims->>'sub'); set is_local=true so it
-- lives for THIS transaction only and vanishes on the final rollback.
select set_config('request.jwt.claim.sub',
  'bb5e24b0-e3e3-4f5e-9cf9-d0d94394803d', true);
select set_config('request.jwt.claims',
  '{"sub":"bb5e24b0-e3e3-4f5e-9cf9-d0d94394803d","role":"authenticated"}', true);

create temp table _pre as
  select
    (select count(*) from public.director_metric_values) as vals,
    (select count(*) from public.director_metric_values_history) as hist;

\echo '=== FILE A: all metrics for 2 employees on 2026-09-30 ==='
select public.director_upsert_metric_values(
  '[
    {"employee_id":"7fd5aae5-dc51-4778-82db-463eecc1c6b5","as_of_date":"2026-09-30","metric_key":"portfolio","value":608042499.39},
    {"employee_id":"7fd5aae5-dc51-4778-82db-463eecc1c6b5","as_of_date":"2026-09-30","metric_key":"pass_watch","value":49725832.32},
    {"employee_id":"7fd5aae5-dc51-4778-82db-463eecc1c6b5","as_of_date":"2026-09-30","metric_key":"substandard","value":1000000},
    {"employee_id":"7fd5aae5-dc51-4778-82db-463eecc1c6b5","as_of_date":"2026-09-30","metric_key":"doubtful","value":500000},
    {"employee_id":"7fd5aae5-dc51-4778-82db-463eecc1c6b5","as_of_date":"2026-09-30","metric_key":"lost","value":250000},
    {"employee_id":"7fd5aae5-dc51-4778-82db-463eecc1c6b5","as_of_date":"2026-09-30","metric_key":"caseload_count","value":23},
    {"employee_id":"06ba4faf-98a3-4ea1-828b-75d111f64a95","as_of_date":"2026-09-30","metric_key":"portfolio","value":457438871.69},
    {"employee_id":"06ba4faf-98a3-4ea1-828b-75d111f64a95","as_of_date":"2026-09-30","metric_key":"caseload_count","value":46}
  ]'::jsonb, null, false) as file_a;

\echo '=== ASSERT after A: 8 new values, 8 insert-history rows ==='
select
  (select count(*) from public.director_metric_values) - (select vals from _pre) as new_values,
  (select count(*) from public.director_metric_values_history) - (select hist from _pre) as new_history,
  (select count(*) from public.director_metric_values_history where action='insert') as inserts;

\echo '=== FILE B: caseload_count ONLY, same employees+date, different values ==='
\echo '    (must UPDATE only caseload_count, leave portfolio/buckets untouched)'
select public.director_upsert_metric_values(
  '[
    {"employee_id":"7fd5aae5-dc51-4778-82db-463eecc1c6b5","as_of_date":"2026-09-30","metric_key":"caseload_count","value":25},
    {"employee_id":"06ba4faf-98a3-4ea1-828b-75d111f64a95","as_of_date":"2026-09-30","metric_key":"caseload_count","value":48}
  ]'::jsonb, null, false) as file_b;

\echo '=== ASSERT after B: still 8 values (no new rows), 2 updates, others intact ==='
select
  (select count(*) from public.director_metric_values) - (select vals from _pre) as total_values_should_be_8,
  (select count(*) from public.director_metric_values_history where action='update') as updates_should_be_2,
  (select value from public.director_metric_values
     where employee_id='7fd5aae5-dc51-4778-82db-463eecc1c6b5' and as_of_date='2026-09-30'
       and metric_key='caseload_count') as caseload_should_be_25,
  (select value from public.director_metric_values
     where employee_id='7fd5aae5-dc51-4778-82db-463eecc1c6b5' and as_of_date='2026-09-30'
       and metric_key='portfolio') as portfolio_untouched_608042499_39,
  (select value from public.director_metric_values
     where employee_id='7fd5aae5-dc51-4778-82db-463eecc1c6b5' and as_of_date='2026-09-30'
       and metric_key='pass_watch') as pass_watch_untouched_49725832_32;

\echo '=== FILE A AGAIN (identical to first A, caseload now 25): 0 inserts/updates ==='
select public.director_upsert_metric_values(
  '[
    {"employee_id":"7fd5aae5-dc51-4778-82db-463eecc1c6b5","as_of_date":"2026-09-30","metric_key":"portfolio","value":608042499.39},
    {"employee_id":"7fd5aae5-dc51-4778-82db-463eecc1c6b5","as_of_date":"2026-09-30","metric_key":"pass_watch","value":49725832.32},
    {"employee_id":"7fd5aae5-dc51-4778-82db-463eecc1c6b5","as_of_date":"2026-09-30","metric_key":"substandard","value":1000000},
    {"employee_id":"7fd5aae5-dc51-4778-82db-463eecc1c6b5","as_of_date":"2026-09-30","metric_key":"doubtful","value":500000},
    {"employee_id":"7fd5aae5-dc51-4778-82db-463eecc1c6b5","as_of_date":"2026-09-30","metric_key":"lost","value":250000},
    {"employee_id":"7fd5aae5-dc51-4778-82db-463eecc1c6b5","as_of_date":"2026-09-30","metric_key":"caseload_count","value":25},
    {"employee_id":"06ba4faf-98a3-4ea1-828b-75d111f64a95","as_of_date":"2026-09-30","metric_key":"portfolio","value":457438871.69},
    {"employee_id":"06ba4faf-98a3-4ea1-828b-75d111f64a95","as_of_date":"2026-09-30","metric_key":"caseload_count","value":48}
  ]'::jsonb, null, false) as file_a_again;

\echo '=== FINAL ASSERT: 8 values, 8 insert + 2 update = 10 history rows ==='
select
  (select count(*) from public.director_metric_values) - (select vals from _pre) as values_should_be_8,
  (select count(*) from public.director_metric_values_history) - (select hist from _pre) as history_should_be_10,
  (select count(*) from public.director_metric_values_history where action='insert') as inserts_should_be_8,
  (select count(*) from public.director_metric_values_history where action='update') as updates_should_be_2;

\echo '=== CONFLICT unconfirmed: new pass_watch value -> reported, stored value unchanged ==='
select public.director_upsert_metric_values(
  '[{"employee_id":"7fd5aae5-dc51-4778-82db-463eecc1c6b5","as_of_date":"2026-09-30","metric_key":"pass_watch","value":99999999}]'::jsonb,
  null, false) as conflict_unconfirmed;

select value as pass_watch_still_49725832_32 from public.director_metric_values
  where employee_id='7fd5aae5-dc51-4778-82db-463eecc1c6b5' and as_of_date='2026-09-30' and metric_key='pass_watch';

\echo '=== CONFLICT confirmed: newer wins, history action=conflict_confirmed ==='
select public.director_upsert_metric_values(
  '[{"employee_id":"7fd5aae5-dc51-4778-82db-463eecc1c6b5","as_of_date":"2026-09-30","metric_key":"pass_watch","value":99999999}]'::jsonb,
  null, true) as conflict_confirmed;

select
  value as pass_watch_now_99999999,
  (select count(*) from public.director_metric_values_history where action='conflict_confirmed') as conflict_confirmed_history
from public.director_metric_values
  where employee_id='7fd5aae5-dc51-4778-82db-463eecc1c6b5' and as_of_date='2026-09-30' and metric_key='pass_watch';

-- GUARANTEE: nothing above survives.
rollback;

\echo '=== ROLLED BACK — production director_metric_values is untouched ==='
select count(*) as production_values_unchanged from public.director_metric_values;

