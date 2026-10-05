-- Behavioural verification of compute_mpr_score against the spec's worked
-- example. Wrapped in a transaction and rolled back: no data is persisted.
begin;

create temp table mk(mc text) on commit drop;
insert into mk values
  ('disbursement_value'), ('case_load'),
  ('total_outstanding_principal'), ('pass_watch');

-- Worked example: 32.5 / 35.0 / 27.0 => 94.5 => Grade A
insert into public.mpr_targets
  (employee_id, metric_code, period_label, target_value, actual_value)
select
  (select id from public.employees limit 1),
  mk.mc, 'TEST-JUN',
  case mk.mc
    when 'disbursement_value'           then 1000000
    when 'case_load'                    then 100
    when 'total_outstanding_principal'  then 5000000
    else 0
  end,
  case mk.mc
    when 'disbursement_value'           then 928571
    when 'case_load'                    then 90
    when 'total_outstanding_principal'  then 5000000
    when 'pass_watch'                   then 140000
  end
from mk;

\echo '=== FULLY MEASURED (expect 32.5 / 2.8 / 35 / 27 / 94.5 / A - EXCELLENT) ==='
select r->>'disbursement_score' as disbursement_score,
       r->>'par_percent'         as par_percent,
       r->>'par_score'           as par_score,
       r->>'caseload_score'      as caseload_score,
       r->>'total'               as total,
       r->>'grade'               as grade,
       r->>'badge'               as badge
  from public.compute_mpr_score(
    (select employee_id from public.mpr_targets limit 1), 'TEST-JUN') r;

-- Blank out one actual: total/grade must be withheld, not guessed.
update public.mpr_targets set actual_value = null where metric_code = 'case_load';

\echo '=== PARTIAL (expect subtotal 67.5, complete=f, caseload missing, total/grade NULL) ==='
select r->>'subtotal'  as subtotal,
       r->>'complete'  as complete,
       r->'missing'    as missing,
       coalesce(r->>'total', 'NULL') as total,
       coalesce(r->>'grade', 'NULL') as grade
  from public.compute_mpr_score(
    (select employee_id from public.mpr_targets limit 1), 'TEST-JUN') r;

rollback;