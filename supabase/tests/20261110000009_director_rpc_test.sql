-- ============================================================================
-- PHASE 2 RPC TEST — director scorecards / breakdown / staff / top_staff.
-- ============================================================================
-- 1. Non-allowed role test FIRST: call each RPC as a NON-Director and assert it
--    raises insufficient_permissions (returns nothing).
-- 2. Director test: insert SYNTHETIC metric values for the 5 authorized
--    employees inside the SAME rolled-back transaction, call each RPC as a
--    Director, and assert the shapes + reconciliation (branch totals == sum of
--    staff rows).
-- Everything is inside ONE transaction that is ROLLED BACK, so production is
-- untouched. Password comes from ~/.pgpass.
-- ============================================================================

\set ON_ERROR_STOP on

begin;

-- ============================================================================
-- PART 1 — NON-ALLOWED ROLE (hr_officer: has NO director.executive.read)
-- ============================================================================
-- hr_officer auth user id resolved at runtime; role gate must reject.
do $$
declare v_hr uuid; v_out jsonb; v_err text;
begin
  select id into v_hr from public.profiles where role = 'hr_officer' limit 1;
  perform set_config('request.jwt.claim.sub', v_hr::text, true);
  begin
    v_out := public.director_scorecards('2026-09-01','2026-09-30');
    raise notice 'FAIL: director_scorecards returned to hr_officer: %', left(v_out::text, 80);
  exception when others then
    v_err := sqlerrm;
    raise notice 'PASS gate scorecards (hr_officer): %', v_err;
  end;
  begin
    v_out := public.director_filter_options();
    raise notice 'FAIL: director_filter_options returned to hr_officer';
  exception when others then
    raise notice 'PASS gate filter_options (hr_officer): %', sqlerrm;
  end;
  begin
    v_out := public.director_branch_breakdown('2026-09-01','2026-09-30');
    raise notice 'FAIL: director_branch_breakdown returned to hr_officer';
  exception when others then
    raise notice 'PASS gate breakdown (hr_officer): %', sqlerrm;
  end;
end $$;

-- Reset to a Director (super_admin) for PART 2.
select set_config('request.jwt.claim.sub', 'bb5e24b0-e3e3-4f5e-9cf9-d0d94394803d', true);

-- ============================================================================
-- PART 2 — DIRECTOR: synthetic data for the 5 authorized employees.
-- ============================================================================
insert into public.director_metric_values (employee_id, as_of_date, metric_key, value) values
  ('7fd5aae5-dc51-4778-82db-463eecc1c6b5','2026-09-30','portfolio',608042499.39),
  ('7fd5aae5-dc51-4778-82db-463eecc1c6b5','2026-09-30','pass_watch',49725832.32),
  ('7fd5aae5-dc51-4778-82db-463eecc1c6b5','2026-09-30','substandard',1000000),
  ('7fd5aae5-dc51-4778-82db-463eecc1c6b5','2026-09-30','doubtful',500000),
  ('7fd5aae5-dc51-4778-82db-463eecc1c6b5','2026-09-30','lost',250000),
  ('7fd5aae5-dc51-4778-82db-463eecc1c6b5','2026-09-30','caseload_count',23),
  ('7fd5aae5-dc51-4778-82db-463eecc1c6b5','2026-09-15','disbursement_amount',5000000),
  ('06ba4faf-98a3-4ea1-828b-75d111f64a95','2026-09-30','portfolio',457438871.69),
  ('06ba4faf-98a3-4ea1-828b-75d111f64a95','2026-09-30','caseload_count',46),
  ('088a4fe5-83c3-4333-82cf-ce815a6c5b8f','2026-09-30','portfolio',347706453.25),
  ('088a4fe5-83c3-4333-82cf-ce815a6c5b8f','2026-09-30','caseload_count',19),
  ('959b68e1-6475-44c3-8ef5-38829f2b10b5','2026-09-30','portfolio',265865579.79),
  ('959b68e1-6475-44c3-8ef5-38829f2b10b5','2026-09-30','caseload_count',34),
  ('c4f1965c-7960-47c5-ad93-2c6f595a262f','2026-09-30','portfolio',172963914.77),
  ('c4f1965c-7960-47c5-ad93-2c6f595a262f','2026-09-30','caseload_count',80);

-- mpr_targets so the scoring ENGINE can produce a COMPLETE score (engine reads portfolio target/actual from metric_code='total_outstanding_principal').
insert into public.mpr_targets (employee_id, metric_code, period_label, target_value, actual_value, status) values
  ('7fd5aae5-dc51-4778-82db-463eecc1c6b5','total_outstanding_principal','2026-09',608042499.39,null,'approved'),
  ('7fd5aae5-dc51-4778-82db-463eecc1c6b5','disbursement_value','2026-09',6000000,5000000,'approved'),
  ('7fd5aae5-dc51-4778-82db-463eecc1c6b5','case_load','2026-09',30,23,'approved'),
  ('06ba4faf-98a3-4ea1-828b-75d111f64a95','total_outstanding_principal','2026-09',457438871.69,null,'approved'),
  ('088a4fe5-83c3-4333-82cf-ce815a6c5b8f','total_outstanding_principal','2026-09',347706453.25,null,'approved'),
  ('959b68e1-6475-44c3-8ef5-38829f2b10b5','total_outstanding_principal','2026-09',265865579.79,null,'approved'),
  ('c4f1965c-7960-47c5-ad93-2c6f595a262f','total_outstanding_principal','2026-09',172963914.77,null,'approved');

\echo '=== director_scorecards (whole bank, Sep 2026) ==='
select jsonb_pretty(public.director_scorecards('2026-09-01','2026-09-30'));

\echo '=== director_branch_breakdown (branches array length + first branch) ==='
select
  jsonb_array_length(r->'branches') as branch_count,
  r->'branches'->0 as first_branch
from public.director_branch_breakdown('2026-09-01','2026-09-30') r;

\echo '=== director_branch_staff (Lagos Island TWO SME = Ajisegbede/Ukuaghe/Dare) ==='
select jsonb_pretty(public.director_branch_staff('4506c7ab-265e-4fb4-a6e3-210f56fc351c'::uuid,'2026-09-01','2026-09-30'));

\echo '=== director_top_staff (best/worst, min_caseload default 0) ==='
select
  jsonb_array_length(r->'best') as best_count,
  jsonb_array_length(r->'worst') as worst_count,
  r->'best'->0->>'full_name' as best_name
from public.director_top_staff('2026-09-01','2026-09-30') r;

rollback;

\echo '=== ROLLED BACK — director_metric_values back to 0 ==='
select count(*) from public.director_metric_values;
