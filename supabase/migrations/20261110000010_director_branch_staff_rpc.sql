-- ============================================================================
-- 20261110000010_director_branch_staff_rpc.sql  (PHASE 2)
-- ============================================================================
-- RPC 3: director_branch_staff — the full staff list for ONE branch with rank,
-- every metric, attendance, target/overall score and grade. Sorting server-side.
-- The overall score + grade come from compute_mpr_score() (the EXISTING engine);
-- they are NULL until the employee's disbursement/PAR/caseload are all measured,
-- so an unmeasured person is never ranked on a partial score.
--
-- Same access gate as the other director RPCs. Additive. Run AFTER ...009.
-- ============================================================================

begin;

create or replace function public.director_branch_staff(
  p_branch_id uuid,
  p_start date default null,
  p_end date default null,
  p_departments text[] default null,
  p_positions text[] default null,
  p_search text default null,
  p_sort_by text default 'overall_score',
  p_sort_dir text default 'desc'
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
  v_branch_name text;
  v_rows jsonb;
  v_filter_opts jsonb;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if public.current_role() not in ('md_ceo','chairman','director','super_admin')
     or not public.has_permission('director.executive.read') then
    raise exception 'insufficient_permissions: director.executive.read';
  end if;

  select b.branch_name into v_branch_name from public.branches b where b.id = p_branch_id;
  with staff as (
    select e.id as employee_id, e.full_name, e.employee_code, e."position",
           public.department_label(e.department) as dept_label
      from public.employees e
     where e.branch_id = p_branch_id
       and (p_departments is null or public.department_label(e.department) = any(p_departments))
       and (p_positions is null or e."position" = any(p_positions))
       and (p_search is null or e.full_name ilike '%'||p_search||'%' or e.employee_code ilike '%'||p_search||'%')
  ),
  vals as (
    select v.employee_id, v.metric_key, v.value
      from public.director_metric_values v join staff s on s.employee_id = v.employee_id
     where v.as_of_date = v_asof
  ),
  piv as (
    select s.employee_id, s.full_name, s.employee_code, s."position", s.dept_label,
      max(v.value) filter (where v.metric_key='portfolio')      as portfolio,
      max(v.value) filter (where v.metric_key='par_amount')     as par_amount,
      max(v.value) filter (where v.metric_key='par_pct')        as par_pct,
      max(v.value) filter (where v.metric_key='pass_watch')     as pass_watch,
      max(v.value) filter (where v.metric_key='substandard')    as substandard,
      max(v.value) filter (where v.metric_key='doubtful')       as doubtful,
      max(v.value) filter (where v.metric_key='lost')           as lost,
      max(v.value) filter (where v.metric_key='caseload_count') as caseload
    from staff s left join vals v on v.employee_id = s.employee_id
    group by s.employee_id, s.full_name, s.employee_code, s."position", s.dept_label
  ),
  disb as (
    select v.employee_id,
      max(v.value) filter (where v.metric_key='disbursement_amount') as disb_amount,
      max(v.value) filter (where v.metric_key='disbursement_count')  as disb_count
    from public.director_metric_values v join staff s on s.employee_id = v.employee_id
    where v.as_of_date between v_start and v_end and v.metric_key like 'disbursement_%'
    group by v.employee_id
  ),
  att as (
    select a.employee_id, count(*) filter (where a.clock_in is not null)::int as present
    from public.attendance_records a join staff s on s.employee_id = a.employee_id
    where a.attendance_date between v_start and v_end group by a.employee_id
  ),
  scored as (
    select p.employee_id,
      (select t.target_value from public.mpr_targets t
        where t.employee_id=p.employee_id and t.period_label=v_period
          and t.metric_code='disbursement_value' limit 1) as disb_target,
      public.compute_mpr_score(p.employee_id, v_period, p_branch_id) as engine
    from piv p
  )

  select coalesce(jsonb_agg(x order by x.rank), '[]'::jsonb) into v_rows
  from (
    select
      row_number() over (
        order by
          case when p_sort_by='overall_score' and p_sort_dir='desc' then (sc.engine->>'total')::numeric end desc nulls last,
          case when p_sort_by='overall_score' and p_sort_dir='asc'  then (sc.engine->>'total')::numeric end asc  nulls last,
          case when p_sort_by='portfolio'     and p_sort_dir='desc' then p.portfolio end desc nulls last,
          case when p_sort_by='portfolio'     and p_sort_dir='asc'  then p.portfolio end asc  nulls last,
          case when p_sort_by='par_pct'       and p_sort_dir='desc' then p.par_pct end desc nulls last,
          case when p_sort_by='par_pct'       and p_sort_dir='asc'  then p.par_pct end asc  nulls last,
          case when p_sort_by='caseload'      and p_sort_dir='desc' then p.caseload end desc nulls last,
          case when p_sort_by='caseload'      and p_sort_dir='asc'  then p.caseload end asc  nulls last,
          p.full_name
      ) as rank,
      p.employee_id, p.full_name, p.employee_code, p."position", p.dept_label as department,
      p.portfolio, p.par_amount, p.par_pct, p.pass_watch, p.substandard, p.doubtful, p.lost, p.caseload,
      d.disb_amount as disbursement_actual, d.disb_count as disbursement_count,
      sc.disb_target as disbursement_target,
      case when sc.disb_target is not null and sc.disb_target > 0 and d.disb_amount is not null
           then round((d.disb_amount / sc.disb_target) * 100, 1) end as disbursement_achievement_pct,
      case when v_min_caseload > 0 and coalesce(p.caseload,0) < v_min_caseload then false else true end as ranking_eligible,
      (sc.engine->>'total')::numeric as overall_score,
      sc.engine->>'grade' as grade,
      sc.engine->>'grade_rating' as grade_rating,
      sc.engine->>'grade_hex' as grade_hex,
      (sc.engine->>'complete')::boolean as score_complete,
      case when att.employee_id is not null then round(100.0 * att.present / 20.0) end as attendance_rate
    from piv p
    left join disb d on d.employee_id = p.employee_id
    left join att  on att.employee_id = p.employee_id
    left join scored sc on sc.employee_id = p.employee_id
  ) x;

  select jsonb_build_object(
    'departments', (select coalesce(jsonb_agg(distinct d order by d),'[]') from (select distinct s->>'department' d from jsonb_array_elements(v_rows) s) t),
    'positions',   (select coalesce(jsonb_agg(distinct p order by p),'[]') from (select distinct s->>'position' p from jsonb_array_elements(v_rows) s) t)
  ) into v_filter_opts;

  return jsonb_build_object(
    'ok', true, 'branch_id', p_branch_id, 'branch_name', v_branch_name,
    'start', v_start, 'end', v_end, 'as_of', v_asof, 'period', v_period,
    'min_caseload_for_ranking', v_min_caseload,
    'filters', v_filter_opts, 'staff', v_rows
  );
end;
$$;

revoke all on function public.director_branch_staff(uuid, date, date, text[], text[], text, text, text) from public, anon;
grant execute on function public.director_branch_staff(uuid, date, date, text[], text[], text, text, text) to authenticated;

commit;

