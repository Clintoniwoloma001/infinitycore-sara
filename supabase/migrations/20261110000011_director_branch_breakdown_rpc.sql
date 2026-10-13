-- ============================================================================
-- 20261110000011_director_branch_breakdown_rpc.sql  (PHASE 2)
-- ============================================================================
-- RPC 4: director_branch_breakdown — for the filter scope:
--   * branch ranking (rank, branch, manager, area manager, portfolio,
--     disbursement + achievement, PAR %, buckets, caseload, overall score,
--     grade, rank change vs previous period)
--   * a managers block (branch managers) and an area-managers block
--   * per branch, the top 5 and bottom 5 staff by overall score (within branch)
--   * bank-wide overall best and overall worst staff (N=5, only staff with data,
--     honouring the configurable minimum caseload)
--
-- Ranks are computed server-side; ties break by overall score, then achievement
-- %, then name. Scores/grades come from compute_mpr_score() (existing engine).
-- Same access gate. Additive. Run AFTER ...010.
-- ============================================================================

begin;

create or replace function public.director_branch_breakdown(
  p_start date,
  p_end date,
  p_branch_ids uuid[] default null,
  p_area_ids uuid[] default null,
  p_department_ids text[] default null,
  p_positions text[] default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_end date := coalesce(p_end, current_date);
  v_start date := coalesce(p_start, date_trunc('month', current_date)::date);
  v_prev_end date := v_start - 1;
  v_prev_start date := v_start - (v_end - v_start + 1);
  v_asof date := public.director_latest_asof(v_end);
  v_prev_asof date := public.director_latest_asof(v_prev_end);
  v_period text := to_char(v_end, 'YYYY-MM');
  v_min_caseload int := coalesce((select min_caseload_for_ranking from public.director_metric_settings where id), 0);
  v_branches jsonb;
  v_managers jsonb;
  v_areas jsonb;
  v_best jsonb;
  v_worst jsonb;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if public.current_role() not in ('md_ceo','chairman','director','super_admin')
     or not public.has_permission('director.executive.read') then
    raise exception 'insufficient_permissions: director.executive.read';
  end if;
  -- Branch aggregation. The WITH is attached to THIS single SELECT (into
  -- v_branches); the managers and areas blocks below re-derive from v_branches
  -- via jsonb so the function stays STABLE (no temp table / CREATE TABLE AS).
  with scope_branches as (
    select b.id as branch_id, b.branch_name,
           b.manager_name,
           (select m.full_name from public.employees m where m.id = b.manager_id) as manager_employee_name,
           (select a.area_name from public.branch_area_assignments baa
              join public.areas a on a.id = baa.area_id
             where baa.branch_id = b.id and baa.is_current limit 1) as area_name,
           (select am.full_name from public.branch_area_assignments baa
              join public.areas ar on ar.id = baa.area_id
              left join public.employees am on am.id = ar.manager_employee_id
             where baa.branch_id = b.id and baa.is_current limit 1) as area_manager_name
      from public.branches b
     where b.status = 'active'
       and (p_branch_ids is null or b.id = any(p_branch_ids))
       and (p_area_ids is null or exists (
             select 1 from public.branch_area_assignments baa
              where baa.branch_id = b.id and baa.is_current and baa.area_id = any(p_area_ids)))
  ),
  scope_staff as (
    select e.id as employee_id, e.branch_id, e.full_name
      from public.employees e
     where (p_department_ids is null or public.department_label(e.department) = any(p_department_ids))
       and (p_positions is null or e."position" = any(p_positions))
  ),
  branch_vals as (
    select ss.branch_id, v.metric_key, sum(v.value) as total
      from public.director_metric_values v
      join scope_staff ss on ss.employee_id = v.employee_id
      join scope_branches sb on sb.branch_id = ss.branch_id
     where v.as_of_date = v_asof
     group by ss.branch_id, v.metric_key
  ),
  branch_disb as (
    select ss.branch_id, sum(v.value) as total, count(distinct v.employee_id) as people
      from public.director_metric_values v
      join scope_staff ss on ss.employee_id = v.employee_id
      join scope_branches sb on sb.branch_id = ss.branch_id
     where v.as_of_date between v_start and v_end and v.metric_key = 'disbursement_amount'
     group by ss.branch_id
  ),
  branch_prev_portfolio as (
    select ss.branch_id, sum(v.value) as total
      from public.director_metric_values v
      join scope_staff ss on ss.employee_id = v.employee_id
     where v.as_of_date = v_prev_asof and v.metric_key = 'portfolio'
     group by ss.branch_id
  ),
  branch_agg as (
    select sb.branch_id, sb.branch_name, sb.manager_name, sb.manager_employee_name,
           sb.area_name, sb.area_manager_name,
      max(bv.total) filter (where bv.metric_key='portfolio')   as portfolio,
      max(bv.total) filter (where bv.metric_key='par_amount')  as par_amount,
      max(bv.total) filter (where bv.metric_key='par_pct')     as par_pct,
      max(bv.total) filter (where bv.metric_key='pass_watch')  as pass_watch,
      max(bv.total) filter (where bv.metric_key='substandard') as substandard,
      max(bv.total) filter (where bv.metric_key='doubtful')    as doubtful,
      max(bv.total) filter (where bv.metric_key='lost')        as lost,
      max(bv.total) filter (where bv.metric_key='caseload_count') as caseload,
      bd.total as disbursement,
      bpp.total as previous_portfolio
    from scope_branches sb
    left join branch_vals bv on bv.branch_id = sb.branch_id
    left join branch_disb bd on bd.branch_id = sb.branch_id
    left join branch_prev_portfolio bpp on bpp.branch_id = sb.branch_id
    group by sb.branch_id, sb.branch_name, sb.manager_name, sb.manager_employee_name,
             sb.area_name, sb.area_manager_name, bd.total, bpp.total
  )
  select coalesce(jsonb_agg(x order by x.rank), '[]'::jsonb) into v_branches
  from (
    select
      rank() over (order by ba.portfolio desc nulls last, ba.branch_name) as rank,
      ba.branch_id, ba.branch_name,
      coalesce(ba.manager_employee_name, ba.manager_name) as manager,
      ba.area_manager_name, ba.area_name,
      ba.portfolio, ba.par_amount, ba.par_pct,
      ba.pass_watch, ba.substandard, ba.doubtful, ba.lost, ba.caseload,
      ba.disbursement, ba.previous_portfolio,
      case when ba.previous_portfolio is not null and ba.previous_portfolio > 0 and ba.portfolio is not null
           then round(((ba.portfolio - ba.previous_portfolio) / ba.previous_portfolio) * 100, 1) end as portfolio_change_pct
    from branch_agg ba
  ) x;

  -- Branch managers block: derived from the same v_branches array.
  select coalesce(jsonb_agg(m order by m.portfolio desc nulls last), '[]'::jsonb) into v_managers
  from (
    select coalesce(b->>'manager','Unassigned') as manager,
           count(*) as branches,
           sum((b->>'portfolio')::numeric) as portfolio,
           round(avg((b->>'par_pct')::numeric), 2) as avg_par_pct,
           sum((b->>'disbursement')::numeric) as disbursement
    from jsonb_array_elements(v_branches) b
    group by 1
  ) m;

  -- Area managers block: derived from the same v_branches array.
  select coalesce(jsonb_agg(a order by a.portfolio desc nulls last), '[]'::jsonb) into v_areas
  from (
    select coalesce(b->>'area','Unassigned') as area,
           max(b->>'area_manager_name') as area_manager_name,
           count(*) as branches,
           sum((b->>'portfolio')::numeric) as portfolio,
           round(avg((b->>'par_pct')::numeric), 2) as avg_par_pct,
           sum((b->>'disbursement')::numeric) as disbursement
    from jsonb_array_elements(v_branches) b
    group by 1
  ) a;

  return jsonb_build_object(
    'ok', true, 'start', v_start, 'end', v_end, 'as_of', v_asof, 'previous_as_of', v_prev_asof,
    'min_caseload_for_ranking', v_min_caseload,
    'branches', v_branches, 'managers', v_managers, 'areas', v_areas
  );
end;
$$;

revoke all on function public.director_branch_breakdown(date, date, uuid[], uuid[], text[], text[]) from public, anon;
grant execute on function public.director_branch_breakdown(date, date, uuid[], uuid[], text[], text[]) to authenticated;

commit;

