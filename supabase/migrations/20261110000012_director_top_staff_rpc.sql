-- ============================================================================
-- 20261110000012_director_top_staff_rpc.sql  (PHASE 2)
-- ============================================================================
-- RPC 5: director_top_staff — bank-wide overall BEST and WORST staff (N=5),
-- and per-branch top/bottom 5 by overall score. Only staff WITH data in the
-- range and honouring the configurable minimum caseload are ranked, so an
-- unmeasured person never appears. Scores come from compute_mpr_score().
--
-- WHY A SEPARATE RPC: the best/worst lists need a cross-branch ranking gated by
-- min_caseload, which is a different query shape from the branch breakdown. The
-- per-branch top/bottom 5 are returned here too (keyed by branch) so the web
-- deep-dive and mobile can show "top 5 raising / top 5 doing poorly" per branch
-- without a second round-trip.
--
-- Same access gate. Additive. Run AFTER ...011.
-- ============================================================================

begin;

create or replace function public.director_top_staff(
  p_start date,
  p_end date,
  p_branch_ids uuid[] default null,
  p_area_ids uuid[] default null,
  p_department_ids text[] default null,
  p_positions text[] default null,
  p_n integer default 5
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_end date := coalesce(p_end, current_date);
  v_start date := coalesce(p_start, date_trunc('month', current_date)::date);
  v_asof date := public.director_latest_asof(v_end);
  v_period text := to_char(v_end, 'YYYY-MM');
  v_min_caseload int := coalesce((select min_caseload_for_ranking from public.director_metric_settings where id), 0);
  v_best jsonb;
  v_worst jsonb;
  v_per_branch jsonb;
  v_all jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if public.current_role() not in ('md_ceo','chairman','director','super_admin')
     or not public.has_permission('director.executive.read') then
    raise exception 'insufficient_permissions: director.executive.read';
  end if;

  -- Compute every eligible + fully-measured staff member ONCE into v_all. The
  -- best / worst / per-branch blocks below all re-derive from this jsonb array
  -- so the function stays STABLE (plpgsql CTEs do not persist across statements).
  with scope_staff as (
    select e.id as employee_id, e.branch_id, e.full_name, e.employee_code,
           e."position", b.branch_name
      from public.employees e
      left join public.branches b on b.id = e.branch_id
     where (p_branch_ids is null or e.branch_id = any(p_branch_ids))
       and (p_department_ids is null or public.department_label(e.department) = any(p_department_ids))
       and (p_positions is null or e."position" = any(p_positions))
       and (p_area_ids is null or exists (
             select 1 from public.branch_area_assignments baa
              where baa.branch_id = e.branch_id and baa.is_current and baa.area_id = any(p_area_ids)))
  ),
  caseload as (
    select v.employee_id, max(v.value) as caseload
      from public.director_metric_values v join scope_staff ss on ss.employee_id = v.employee_id
     where v.as_of_date = v_asof and v.metric_key = 'caseload_count'
     group by v.employee_id
  ),
  eligible as (
    select ss.*, c.caseload
      from scope_staff ss join caseload c on c.employee_id = ss.employee_id
     where (v_min_caseload = 0 or coalesce(c.caseload, 0) >= v_min_caseload)
  ),
  scored as (
    select el.*, public.compute_mpr_score(el.employee_id, v_period, el.branch_id) as engine
    from eligible el
  )
  select coalesce(jsonb_agg(to_jsonb(sc) - 'engine' || jsonb_build_object(
           'overall_score', (sc.engine->>'total')::numeric,
           'grade', sc.engine->>'grade',
           'grade_hex', sc.engine->>'grade_hex',
           'par_pct', (sc.engine->>'par_percent')::numeric
         )), '[]'::jsonb)
    into v_all
  from scored sc
  where (sc.engine->>'complete')::boolean is true;  -- only fully-measured are ranked

  -- Bank-wide best N (highest overall score, tie -> lower PAR %, then name).
  select coalesce(jsonb_agg(x order by x.rn), '[]'::jsonb) into v_best
  from (
    select row_number() over (order by (f->>'overall_score')::numeric desc nulls last,
                                       (f->>'par_pct')::numeric asc nulls last, f->>'full_name') as rn, f
    from jsonb_array_elements(v_all) f
    order by (f->>'overall_score')::numeric desc nulls last, (f->>'par_pct')::numeric asc nulls last, f->>'full_name'
    limit p_n
  ) x;

  -- Bank-wide worst N (lowest overall score, tie -> higher PAR %, then name).
  select coalesce(jsonb_agg(x order by x.rn), '[]'::jsonb) into v_worst
  from (
    select row_number() over (order by (f->>'overall_score')::numeric asc nulls last,
                                       (f->>'par_pct')::numeric desc nulls last, f->>'full_name') as rn, f
    from jsonb_array_elements(v_all) f
    order by (f->>'overall_score')::numeric asc nulls last, (f->>'par_pct')::numeric desc nulls last, f->>'full_name'
    limit p_n
  ) x;

  -- Per-branch top/bottom N, keyed by branch_id.
  select coalesce(jsonb_object_agg(bid, payload), '{}'::jsonb) into v_per_branch
  from (
    select b.bid, jsonb_build_object(
      'top', (select coalesce(jsonb_agg(row_json order by rn), '[]') from (
                select (row_number() over (order by (f2->>'overall_score')::numeric desc nulls last, f2->>'full_name'))::int as rn,
                       f2 as row_json
                  from jsonb_array_elements(v_all) f2 where f2->>'branch_id' = b.bid
                order by (f2->>'overall_score')::numeric desc nulls last, f2->>'full_name' limit p_n) t),
      'bottom', (select coalesce(jsonb_agg(row_json order by rn), '[]') from (
                select (row_number() over (order by (f2->>'overall_score')::numeric asc nulls last, f2->>'full_name'))::int as rn,
                       f2 as row_json
                  from jsonb_array_elements(v_all) f2 where f2->>'branch_id' = b.bid
                order by (f2->>'overall_score')::numeric asc nulls last, f2->>'full_name' limit p_n) t)
    ) as payload
    from (select distinct f->>'branch_id' as bid from jsonb_array_elements(v_all) f) b
  ) b;

  return jsonb_build_object(
    'ok', true, 'start', v_start, 'end', v_end, 'as_of', v_asof, 'period', v_period,
    'n', p_n, 'min_caseload_for_ranking', v_min_caseload,
    'best', v_best, 'worst', v_worst, 'per_branch', v_per_branch
  );
end;
$$;

revoke all on function public.director_top_staff(date, date, uuid[], uuid[], text[], text[], integer) from public, anon;
grant execute on function public.director_top_staff(date, date, uuid[], uuid[], text[], text[], integer) to authenticated;

commit;
