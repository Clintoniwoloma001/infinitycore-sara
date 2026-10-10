-- ============================================================================
-- PHASE 2 RECONCILIATION TEST — RPC numbers vs direct SQL on source tables.
-- ============================================================================
-- Inserts SYNTHETIC director_metric_values + mpr_targets for the 5 authorized
-- employees inside a ROLLED-BACK transaction, then asserts:
--   1. WHOLE BANK: scorecards.portfolio == sum(portfolio values); breakdown branch
--      totals == sum of their staff rows.
--   2. ONE BRANCH: director_branch_staff portfolio sum == breakdown branch portfolio.
--   3. ONE DEPARTMENT: scorecards(department filter) portfolio == direct sum.
-- Also proves a score computes (complete=true) once disbursement+PAR+caseload
-- targets exist, so director_top_staff can rank.
-- ============================================================================

\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claim.sub', 'bb5e24b0-e3e3-4f5e-9cf9-d0d94394803d', true);

-- Metric values (as-of 2026-09-30) for 5 employees.
insert into public.director_metric_values (employee_id, as_of_date, metric_key, value) values
  ('7fd5aae5-dc51-4778-82db-463eecc1c6b5','2026-09-30','portfolio',600000000),
  ('7fd5aae5-dc51-4778-82db-463eecc1c6b5','2026-09-30','pass_watch',10000000),
  ('7fd5aae5-dc51-4778-82db-463eecc1c6b5','2026-09-30','substandard',2000000),
  ('7fd5aae5-dc51-4778-82db-463eecc1c6b5','2026-09-30','doubtful',1000000),
  ('7fd5aae5-dc51-4778-82db-463eecc1c6b5','2026-09-30','lost',500000),
  ('7fd5aae5-dc51-4778-82db-463eecc1c6b5','2026-09-30','caseload_count',23),
  ('7fd5aae5-dc51-4778-82db-463eecc1c6b5','2026-09-15','disbursement_amount',5000000),
  ('06ba4faf-98a3-4ea1-828b-75d111f64a95','2026-09-30','portfolio',400000000),
  ('06ba4faf-98a3-4ea1-828b-75d111f64a95','2026-09-30','caseload_count',46),
  ('088a4fe5-83c3-4333-82cf-ce815a6c5b8f','2026-09-30','portfolio',300000000),
  ('088a4fe5-83c3-4333-82cf-ce815a6c5b8f','2026-09-30','caseload_count',19),
  ('959b68e1-6475-44c3-8ef5-38829f2b10b5','2026-09-30','portfolio',200000000),
  ('959b68e1-6475-44c3-8ef5-38829f2b10b5','2026-09-30','caseload_count',34),
  ('c4f1965c-7960-47c5-ad93-2c6f595a262f','2026-09-30','portfolio',100000000),
  ('c4f1965c-7960-47c5-ad93-2c6f595a262f','2026-09-30','caseload_count',80);

-- mpr_targets so the engine can produce a COMPLETE score for Ajisegbede.
-- disbursement_value target+actual, portfolio target, caseload target+actual.
insert into public.mpr_targets (employee_id, metric_code, period_label, target_value, actual_value, status) values
  ('7fd5aae5-dc51-4778-82db-463eecc1c6b5','disbursement_value','2026-09',6000000,5000000,'approved'),
  -- actual_value MUST be populated: compute_mpr_score reads target then
  -- OVERWRITES v_portfolio with actual_value, so a NULL actual leaves the PAR
  -- denominator NULL -> par score missing -> complete=false forever.
  ('7fd5aae5-dc51-4778-82db-463eecc1c6b5','total_outstanding_principal','2026-09',600000000,600000000,'approved'),
  ('7fd5aae5-dc51-4778-82db-463eecc1c6b5','pass_watch','2026-09',0,10000000,'approved'),
  ('7fd5aae5-dc51-4778-82db-463eecc1c6b5','substandard','2026-09',0,2000000,'approved'),
  ('7fd5aae5-dc51-4778-82db-463eecc1c6b5','doubtful','2026-09',0,1000000,'approved'),
  ('7fd5aae5-dc51-4778-82db-463eecc1c6b5','lost','2026-09',0,500000,'approved'),
  ('7fd5aae5-dc51-4778-82db-463eecc1c6b5','case_load','2026-09',30,23,'approved');

\echo '=== RECON 1 (WHOLE BANK): scorecards.portfolio vs direct SQL sum ==='
select
  (public.director_scorecards('2026-09-01','2026-09-30')->'portfolio'->>'value')::numeric as rpc_portfolio,
  (select sum(value) from public.director_metric_values
     where as_of_date='2026-09-30' and metric_key='portfolio') as sql_portfolio,
  (public.director_scorecards('2026-09-01','2026-09-30')->'portfolio'->>'value')::numeric
    = (select sum(value) from public.director_metric_values where as_of_date='2026-09-30' and metric_key='portfolio') as match;

\echo '=== RECON 1b: breakdown branch totals sum == whole-bank portfolio ==='
select
  (select sum((b->>'portfolio')::numeric) from jsonb_array_elements(public.director_branch_breakdown('2026-09-01','2026-09-30')->'branches') b) as breakdown_sum,
  (select sum(value) from public.director_metric_values where as_of_date='2026-09-30' and metric_key='portfolio') as sql_sum;

\echo '=== RECON 2 (ONE BRANCH): branch_staff portfolio sum == breakdown branch portfolio ==='
with bs as (
  select jsonb_array_elements(public.director_branch_staff('4506c7ab-265e-4fb4-a6e3-210f56fc351c'::uuid,'2026-09-01','2026-09-30')->'staff') s
), bd as (
  select b from jsonb_array_elements(public.director_branch_breakdown('2026-09-01','2026-09-30')->'branches') b
   where b->>'branch_id'='4506c7ab-265e-4fb4-a6e3-210f56fc351c'
)
select
  (select sum((s->>'portfolio')::numeric) from bs) as staff_sum,
  (select (b->>'portfolio')::numeric from bd) as breakdown_branch_portfolio;

\echo '=== RECON 3 (ONE DEPARTMENT): scorecards(dept=CREDIT & MARKETING) vs direct ==='
select
  (public.director_scorecards('2026-09-01','2026-09-30', null, null, array['CREDIT & MARKETING'])->'portfolio'->>'value')::numeric as rpc_dept,
  (select sum(v.value) from public.director_metric_values v join public.employees e on e.id=v.employee_id
     where v.as_of_date='2026-09-30' and v.metric_key='portfolio'
       and public.department_label(e.department)='CREDIT & MARKETING') as sql_dept;

\echo '=== SCORE CHECK: with the CORRECT metric_code total_outstanding_principal, Ajisegbede is complete + graded ==='
select jsonb_pretty(public.compute_mpr_score('7fd5aae5-dc51-4778-82db-463eecc1c6b5','2026-09','4506c7ab-265e-4fb4-a6e3-210f56fc351c'::uuid));

\echo '=== TOP STAFF: now complete, best should have 1 and worst empty ==='
select
  jsonb_array_length(public.director_top_staff('2026-09-01','2026-09-30')->'best') as best_count,
  public.director_top_staff('2026-09-01','2026-09-30')->'best'->0->>'full_name' as best_name,
  public.director_top_staff('2026-09-01','2026-09-30')->'best'->0->>'overall_score' as best_score,
  public.director_top_staff('2026-09-01','2026-09-30')->'best'->0->>'grade' as best_grade;

-- ============================================================================
-- HARD ASSERTIONS — this test must FAIL loudly, not just print numbers.
--   A) score is complete + graded (PAR denominators really load)
--   B) best row is FLAT (s.full_name, not {"f":{...},"rn":n})
--   C) scorecards portfolio == direct SQL sum (recon 1)
-- ============================================================================
do $$
declare
  v_score jsonb;
  v_best jsonb;
  v_rpc numeric; v_sql numeric;
begin
  v_score := public.compute_mpr_score('7fd5aae5-dc51-4778-82db-463eecc1c6b5','2026-09','4506c7ab-265e-4fb4-a6e3-210f56fc351c'::uuid);
  if not coalesce((v_score->>'complete')::boolean, false) then
    raise exception 'FAIL score not complete: %', v_score;
  end if;
  if v_score->>'grade' is null then
    raise exception 'FAIL score has no grade: %', v_score;
  end if;

  v_best := public.director_top_staff('2026-09-01','2026-09-30')->'best';
  if jsonb_array_length(v_best) <> 1 then
    raise exception 'FAIL best_count expected 1: %', v_best;
  end if;
  if v_best->0->>'full_name' is null or v_best->0->>'overall_score' is null then
    raise exception 'FAIL best row is not flat: %', v_best->0;
  end if;

  v_rpc := (public.director_scorecards('2026-09-01','2026-09-30')->'portfolio'->>'value')::numeric;
  select sum(value) into v_sql from public.director_metric_values
    where as_of_date='2026-09-30' and metric_key='portfolio';
  if v_rpc is distinct from v_sql then
    raise exception 'FAIL recon1 portfolio % vs %', v_rpc, v_sql;
  end if;

  raise notice 'PASS recon assertions: score complete+graded, best row flat, portfolio match';
end $$;

rollback;
select count(*) as values_after_rollback from public.director_metric_values;
select count(*) as targets_after_rollback from public.mpr_targets;

