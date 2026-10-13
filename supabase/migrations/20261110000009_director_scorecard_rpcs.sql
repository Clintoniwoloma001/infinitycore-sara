-- ============================================================================
-- 20261110000009_director_scorecard_rpcs.sql  (PHASE 2)
-- ============================================================================
-- WHY: Phases 3-6 (web Director Intelligence, web Performance Power BI, MPR)
-- all need the SAME server-computed numbers, so that a figure can never
-- disagree between screens. These four RPCs are that single source of truth.
--
-- SINGLE SOURCE OF TRUTH
--   * Scores and grades are produced by the EXISTING engine only:
--     compute_mpr_score() / mpr_par_score() / mpr_ratio_score() /
--     mpr_grade_for_score(). This file never re-derives a weight, target or
--     band; it reads them from mpr_par_bands / mpr_grade_bands /
--     director_metric_settings at score time.
--   * Metric VALUES come from director_metric_values (the Phase 1 store).
--   * Attendance rate reuses the SAME definition as the executive snapshot:
--     present = attendance_records with clock_in not null in range; rate =
--     100 * present / expected_days. expected_days is read from the existing
--     director behaviour (20). No new attendance formula is invented.
--
-- ACCESS (rule 5)
--   Every RPC gates on current_role() in ('md_ceo','chairman','director',
--   'super_admin') AND has_permission('director.executive.read') — the exact
--   gate get_director_executive_snapshot already uses. Non-allowed callers get
--   an exception, not data. Branch managers keep their existing narrower access;
--   nothing here widens anyone's scope. SECURITY DEFINER + SET search_path.
--
-- DATES
--   p_start / p_end are plain YYYY-MM-DD (Africa/Lagos semantics; no UTC
--   round-trip). PAR/portfolio/buckets/caseload are point-in-time (latest as-of
--   on or before p_end); disbursement is a flow summed over [p_start, p_end].
--
-- Additive. Run AFTER 20261110000008.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- Helper: the as-of date to use for point-in-time metrics = the latest as_of
-- <= p_end that actually has data for the scope. Returns null when none.
-- ----------------------------------------------------------------------------
create or replace function public.director_latest_asof(p_end date)
returns date
language sql
stable
security definer
set search_path = public
as $$
  select max(as_of_date) from public.director_metric_values where as_of_date <= p_end;
$$;

revoke all on function public.director_latest_asof(date) from public, anon;
grant execute on function public.director_latest_asof(date) to authenticated;

-- ----------------------------------------------------------------------------
-- RPC 1: director_filter_options — branches, area managers, departments,
-- positions within the caller's scope. The caller is always a Director-level
-- role (gated), so scope = the whole bank minus nothing; branch managers never
-- reach here. Returns the distinct values present so the UI filters are real.
-- ----------------------------------------------------------------------------
create or replace function public.director_filter_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if public.current_role() not in ('md_ceo','chairman','director','super_admin')
     or not public.has_permission('director.executive.read') then
    raise exception 'insufficient_permissions: director.executive.read';
  end if;

  return jsonb_build_object(
    'branches', (
      select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'name', b.branch_name)
                               order by b.branch_name), '[]'::jsonb)
      from public.branches b where b.status = 'active'
    ),
    'areas', (
      select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', coalesce(a.area_name, a.area_code))
                               order by 2), '[]'::jsonb)
      from public.areas a where a.is_active
    ),
    'departments', (
      select coalesce(jsonb_agg(distinct_label order by distinct_label), '[]'::jsonb)
      from (select distinct public.department_label(e.department) as distinct_label
              from public.employees e
             where coalesce(e.department,'') <> '') t
    ),
    'positions', (
      select coalesce(jsonb_agg(distinct_pos order by distinct_pos), '[]'::jsonb)
      from (select distinct e."position" as distinct_pos
              from public.employees e
             where coalesce(e."position",'') <> '') t
    )
  );
end;
$$;

revoke all on function public.director_filter_options() from public, anon;
grant execute on function public.director_filter_options() to authenticated;

-- Shared scope predicate (identical in every RPC): arrays are null=all, OR
-- within one dimension, AND across dimensions. Area resolves through
-- branch_area_assignments (is_current). Branch managers never reach these RPCs.

-- RPC 2: director_scorecards — bank-level (or filter-scope) KPI values with
-- previous-period comparison and a per-metric "no data imported" flag.
create or replace function public.director_scorecards(
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
  v_asof date;
  v_prev_asof date;
  v_result jsonb;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if public.current_role() not in ('md_ceo','chairman','director','super_admin')
     or not public.has_permission('director.executive.read') then
    raise exception 'insufficient_permissions: director.executive.read';
  end if;

  v_asof := public.director_latest_asof(v_end);
  v_prev_asof := public.director_latest_asof(v_prev_end);

  with scoped as (
    select e.id as employee_id
      from public.employees e
     where (p_branch_ids is null or e.branch_id = any(p_branch_ids))
       and (p_department_ids is null or public.department_label(e.department) = any(p_department_ids))
       and (p_positions is null or e."position" = any(p_positions))
       and (p_area_ids is null or exists (
             select 1 from public.branch_area_assignments baa
              where baa.branch_id = e.branch_id and baa.is_current and baa.area_id = any(p_area_ids)))
  ),
  snap as (
    select v.metric_key, sum(v.value) as total
      from public.director_metric_values v join scoped s on s.employee_id = v.employee_id
     where v.as_of_date = v_asof group by v.metric_key
  ),
  prev_snap as (
    select v.metric_key, sum(v.value) as total
      from public.director_metric_values v join scoped s on s.employee_id = v.employee_id
     where v.as_of_date = v_prev_asof group by v.metric_key
  ),
  flow as (
    select v.metric_key, sum(v.value) as total
      from public.director_metric_values v join scoped s on s.employee_id = v.employee_id
     where v.as_of_date between v_start and v_end
       and v.metric_key in ('disbursement_amount','disbursement_count') group by v.metric_key
  ),
  prev_flow as (
    select v.metric_key, sum(v.value) as total
      from public.director_metric_values v join scoped s on s.employee_id = v.employee_id
     where v.as_of_date between v_prev_start and v_prev_end
       and v.metric_key in ('disbursement_amount','disbursement_count') group by v.metric_key
  )

  select jsonb_build_object(
    'ok', true, 'start', v_start, 'end', v_end, 'as_of', v_asof, 'previous_as_of', v_prev_asof,
    'has_data', v_asof is not null,
    'portfolio', jsonb_build_object('value',(select total from snap where metric_key='portfolio'),'previous',(select total from prev_snap where metric_key='portfolio'),'imported',exists(select 1 from snap where metric_key='portfolio')),
    'par_amount', jsonb_build_object('value',(select total from snap where metric_key='par_amount'),'previous',(select total from prev_snap where metric_key='par_amount'),'imported',exists(select 1 from snap where metric_key='par_amount')),
    'par_pct', jsonb_build_object('value',(select total from snap where metric_key='par_pct'),'previous',(select total from prev_snap where metric_key='par_pct'),'imported',exists(select 1 from snap where metric_key='par_pct')),
    'pass_watch', jsonb_build_object('value',(select total from snap where metric_key='pass_watch'),'previous',(select total from prev_snap where metric_key='pass_watch'),'imported',exists(select 1 from snap where metric_key='pass_watch')),
    'substandard', jsonb_build_object('value',(select total from snap where metric_key='substandard'),'previous',(select total from prev_snap where metric_key='substandard'),'imported',exists(select 1 from snap where metric_key='substandard')),
    'doubtful', jsonb_build_object('value',(select total from snap where metric_key='doubtful'),'previous',(select total from prev_snap where metric_key='doubtful'),'imported',exists(select 1 from snap where metric_key='doubtful')),
    'lost', jsonb_build_object('value',(select total from snap where metric_key='lost'),'previous',(select total from prev_snap where metric_key='lost'),'imported',exists(select 1 from snap where metric_key='lost')),
    'caseload', jsonb_build_object('value',(select total from snap where metric_key='caseload_count'),'previous',(select total from prev_snap where metric_key='caseload_count'),'imported',exists(select 1 from snap where metric_key='caseload_count')),
    'disbursement', jsonb_build_object('value',(select total from flow where metric_key='disbursement_amount'),'count',(select total from flow where metric_key='disbursement_count'),'previous',(select total from prev_flow where metric_key='disbursement_amount'),'imported',exists(select 1 from flow where metric_key='disbursement_amount'))
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.director_scorecards(date, date, uuid[], uuid[], text[], text[]) from public, anon;
grant execute on function public.director_scorecards(date, date, uuid[], uuid[], text[], text[]) to authenticated;

commit;


