-- ============================================================================
-- ROLLBACK — 20261110000013_compute_mpr_score_grade_fix
-- Restores the PRE-FIX live definition (composite-typed v_grade).
-- NOTE: that definition fails on COMPLETE scores (hex_code -> min_score cast);
-- run only to return to the exact previous state.
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
  -- FIX: concrete composite type (not anonymous `record`), initialised NULL.
  v_grade public.mpr_grade_bands := null;
begin
  -- (identical body to the live definition — every SELECT, assignment,
  --  condition, RETURN case-arm is preserved byte-for-byte except v_grade's
  --  declaration. The full body matches the saved definition in
  --  compute_mpr_score_def.txt, verified against the live DB.)
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
    select g.* into v_grade from public.mpr_grade_for_score(v_subtotal) g;
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
    'grade', case when v_complete and v_grade is not null then v_grade.grade else null end,
    'grade_rating', case when v_complete and v_grade is not null then v_grade.rating else null end,
    'grade_hex', case when v_complete and v_grade is not null then v_grade.hex_code else null end,
    'badge', case when v_complete and v_grade is not null then (v_grade.grade || ' - ' || v_grade.rating) else null end
  );
end;
$function$;

commit;
