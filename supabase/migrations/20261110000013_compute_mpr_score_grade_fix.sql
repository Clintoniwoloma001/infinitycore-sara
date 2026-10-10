-- ============================================================================
-- PHASE 0 DISCOVERY FIX — compute_mpr_score grade lookup
-- ============================================================================
-- WHY (two stacked regressions on the live database, neither tracked in git)
--   1. Live compute_mpr_score() declared `v_grade public.mpr_grade_bands` but
--      assigned it with `select g.* into v_grade from mpr_grade_for_score(...)`
--      which returns TABLE(grade text, rating text, hex_code text,
--      range_label text). plpgsql assigns COMPOSITE targets POSITIONALLY, so
--      hex_code was cast into min_score(numeric) and every COMPLETE score
--      raised:  invalid input syntax for type numeric: "#059669"
--      This broke director_top_staff / director_branch_staff /
--      director_scorecards for any employee with disbursement + PAR +
--      caseload all measured.
--   2. Reverting to the canonical `v_grade record`
--      (20261101000007_performance_grading_matrix.sql) fails differently: the
--      RETURN arms evaluate `v_grade is not null`, and IS NOT NULL on an
--      UNASSIGNED record raises  record "v_grade" is not assigned yet
--      (verified live: IS NULL is safe, IS NOT NULL errors, and SQL does not
--      short-circuit `false AND <expr>`).
--
-- FIX
--   The grade lookup now selects into three SCALAR text variables
--   (v_grade, v_rating, v_hex). Scalars are NULL until assigned — safe on the
--   complete path, the incomplete path, and a 0-row grade-band lookup.
--   Everything else is byte-identical to the canonical body.
--
-- Verified live by supabase/tests/20261110000009_director_rpc_test.sql
-- (director_top_staff returns rows with grades instead of erroring).
-- Rollback: supabase/manual/20261110000013_compute_mpr_score_grade_fix_rollback.sql
-- ============================================================================

begin;

CREATE OR REPLACE FUNCTION public.compute_mpr_score(p_employee_id uuid, p_period_label text, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_vals jsonb;
  v_disb_target numeric; v_disb_actual numeric;
  v_pass_watch numeric := 0; v_substandard numeric := 0;
  v_doubtful numeric := 0;   v_lost numeric := 0;
  v_portfolio numeric;
  v_caseload_target numeric; v_caseload_actual numeric;
  v_at_risk numeric; v_par_pct numeric; v_par_score numeric;
  v_disb_score numeric; v_caseload_score numeric; v_subtotal numeric;
  v_complete boolean; v_missing text[] := '{}';
  -- PHASE 0 FIX: SCALAR grade variables. mpr_grade_for_score() returns
  --  TABLE(grade text, rating text, hex_code text, range_label text).
  --  A composite `v_grade public.mpr_grade_bands` target assigned POSITIONALLY
  --  mapped hex_code onto min_score(numeric):
  --    invalid input syntax for type numeric: "#059669"
  --  and a plain `record` target breaks on `v_grade is not null` in the RETURN
  --  arms (IS NOT NULL errors for an unassigned record). Scalars are NULL
  --  until assigned, so every path is safe. See
  --  docs/director-intelligence-discovery.md (Phase 0 discovery).
  v_grade text := null; v_rating text := null; v_hex text := null;
begin
  -- Body mirrors supabase/migrations/20261101000007_performance_grading_matrix.sql
  -- (canonical), except the grade lookup now selects into scalar variables.
  select
    max(t.target_value) filter (where t.metric_code = 'disbursement_value'),
    max(t.actual_value) filter (where t.metric_code = 'disbursement_value'),
    max(t.target_value) filter (where t.metric_code = 'pass_watch'),
    max(t.actual_value) filter (where t.metric_code = 'pass_watch'),
    max(t.target_value) filter (where t.metric_code = 'substandard'),
    max(t.actual_value) filter (where t.metric_code = 'substandard'),
    max(t.target_value) filter (where t.metric_code = 'doubtful'),
    max(t.actual_value) filter (where t.metric_code = 'doubtful'),
    max(t.target_value) filter (where t.metric_code = 'lost'),
    max(t.actual_value) filter (where t.metric_code = 'lost'),
    max(t.target_value) filter (where t.metric_code = 'total_outstanding_principal'),
    max(t.actual_value) filter (where t.metric_code = 'total_outstanding_principal'),
    max(t.target_value) filter (where t.metric_code = 'case_load'),
    max(t.actual_value) filter (where t.metric_code = 'case_load')
  into
    v_disb_target, v_disb_actual,
    v_pass_watch, v_pass_watch,
    v_substandard, v_substandard,
    v_doubtful, v_doubtful,
    v_lost, v_lost,
    v_portfolio, v_portfolio,
    v_caseload_target, v_caseload_actual
  from public.mpr_targets t
  where t.employee_id = p_employee_id
    and t.period_label = p_period_label
    and (p_branch_id is null or t.branch_id is null or t.branch_id = p_branch_id);

  v_at_risk := coalesce(v_pass_watch, 0) + coalesce(v_substandard, 0)
             + coalesce(v_doubtful, 0) + coalesce(v_lost, 0);

  if v_portfolio is not null and v_portfolio > 0 then
    v_par_pct := round((v_at_risk / v_portfolio) * 100, 4);
  elsif v_at_risk = 0 then
    v_par_pct := 0;
  else
    v_par_pct := null;
  end if;

  v_par_score := public.mpr_par_score(v_par_pct);
  v_disb_score := public.mpr_ratio_score(v_disb_actual, v_disb_target, 35);
  v_caseload_score := public.mpr_ratio_score(v_caseload_actual, v_caseload_target, 30);

  if v_disb_score is null     then v_missing := array_append(v_missing, 'disbursement'); end if;
  if v_par_score is null      then v_missing := array_append(v_missing, 'par'); end if;
  if v_caseload_score is null then v_missing := array_append(v_missing, 'caseload'); end if;
  v_complete := coalesce(array_length(v_missing, 1), 0) = 0;

  v_subtotal := round(coalesce(v_disb_score, 0) + coalesce(v_par_score, 0)
                      + coalesce(v_caseload_score, 0), 2);

  if v_complete then
    -- Concrete composite type: the tuple structure is always known.
    select g.grade, g.rating, g.hex_code
      into v_grade, v_rating, v_hex
      from public.mpr_grade_for_score(v_subtotal) g;
  end if;

  return jsonb_build_object(
    'ok', true,
    'employee_id', p_employee_id,
    'period_label', p_period_label,
    'par_percent', v_par_pct,
    'at_risk_principal', v_at_risk,
    'total_outstanding_principal', v_portfolio,
    'disbursement_score', v_disb_score,
    'par_score', v_par_score,
    'caseload_score', v_caseload_score,
    'subtotal', v_subtotal,
    'complete', v_complete,
    'missing', to_jsonb(v_missing),
    'total', case when v_complete then v_subtotal else null end,
    'grade', case when v_complete and v_grade is not null then v_grade else null end,
    'grade_rating', case when v_complete and v_rating is not null then v_rating else null end,
    'grade_hex', case when v_complete and v_hex is not null then v_hex else null end,
    'badge', case when v_complete and v_grade is not null then (v_grade || ' - ' || v_rating) else null end
  );
end;
$function$;
commit;
