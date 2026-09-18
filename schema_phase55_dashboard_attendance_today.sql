-- ============================================================
-- PHASE 55: SCOPED DASHBOARD ATTENDANCE TODAY
-- ------------------------------------------------------------
-- The dashboard must calculate today's attendance from the same
-- authorized employee scope used by get_dashboard_snapshot. This prevents
-- a valid clock-in being hidden when the viewer is an MD/CEO, branch
-- manager, or area manager (roles not covered by the old global summary).
-- ============================================================

create or replace function public.get_dashboard_attendance_today(
  p_branch_id uuid default null,
  p_department text default null,
  p_employee_id uuid default null,
  p_area text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.current_role();
  v_me public.employees%rowtype;
  v_org_scope boolean := false;
  v_branch_scope uuid;
  v_area_scope text;
  v_employee_id uuid := p_employee_id;
  v_ids uuid[] := '{}'::uuid[];
  v_today date := (clock_timestamp() at time zone public.att_app_timezone())::date;
  v_dow text := lower(to_char(clock_timestamp() at time zone public.att_app_timezone(), 'Dy'));
  v_working_days text[];
  v_working_day boolean := false;
  v_total integer := 0;
  v_present integer := 0;
  v_late integer := 0;
  v_on_leave integer := 0;
  v_avg numeric := 0;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;

  select * into v_me
  from public.employees
  where user_id = auth.uid()
  order by created_at desc
  limit 1;

  v_org_scope := v_role in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'head_of_business')
    or upper(trim(coalesce(v_me."position", ''))) in ('MD', 'MD/CEO');

  if v_role = 'branch_manager' then
    v_branch_scope := v_me.branch_id;
    if p_branch_id is not null and p_branch_id is distinct from v_branch_scope then
      raise exception 'Not authorized for this branch';
    end if;
    if v_branch_scope is null then v_employee_id := v_me.id; end if;
  elsif v_role = 'area_manager' then
    v_area_scope := v_me.area;
    if p_area is not null and lower(p_area) <> lower(coalesce(v_area_scope, '')) then
      raise exception 'Not authorized for this area';
    end if;
    if v_area_scope is null then v_employee_id := v_me.id; end if;
  elsif not v_org_scope then
    v_employee_id := v_me.id;
  end if;

  select coalesce(array_agg(e.id), '{}'::uuid[]) into v_ids
  from public.employees e
  where e.employment_status = 'active'
    and coalesce(e.is_archived, false) = false
    and (v_org_scope or v_me.id is not null)
    and (v_employee_id is null or e.id = v_employee_id)
    and (v_branch_scope is null or e.branch_id = v_branch_scope)
    and (p_branch_id is null or e.branch_id = p_branch_id)
    and (v_area_scope is null or lower(coalesce(e.area, '')) = lower(v_area_scope)
      or exists (
        select 1
        from public.branch_area_assignments baa
        join public.areas a on a.id = baa.area_id
        where baa.branch_id = e.branch_id and baa.is_current
          and lower(a.area_code) = lower(v_area_scope)
      ))
    and (p_area is null or lower(coalesce(e.area, '')) = lower(p_area))
    and (p_department is null or lower(coalesce(e.department, '')) = lower(p_department));

  select default_working_days into v_working_days
  from public.hr_platform_settings
  where id = 1;
  select exists (
    select 1 from unnest(coalesce(v_working_days, '{}'::text[])) day_name
    where lower(left(day_name, 3)) = v_dow
  ) into v_working_day;

  v_total := cardinality(v_ids);
  select count(distinct ar.employee_id) into v_present
  from public.attendance_records ar
  where ar.employee_id = any(v_ids)
    and ar.attendance_date = v_today
    and ar.clock_in is not null;
  select count(distinct ar.employee_id) into v_late
  from public.attendance_records ar
  where ar.employee_id = any(v_ids)
    and ar.attendance_date = v_today
    and ar.clock_in is not null
    and (coalesce(ar.late_minutes, 0) > 0 or ar.status = 'late');
  select count(distinct e.id) into v_on_leave
  from public.employees e
  join public.leave_requests lr on lr.created_by = e.user_id
  where e.id = any(v_ids)
    and lr.status = 'approved'
    and lr.start_date <= v_today
    and lr.end_date >= v_today;
  select coalesce(round(avg(coalesce(ar.work_hours, extract(epoch from (ar.clock_out - ar.clock_in)) / 3600.0))::numeric, 1), 0)
    into v_avg
  from public.attendance_records ar
  where ar.employee_id = any(v_ids)
    and ar.attendance_date = v_today
    and ar.clock_in is not null
    and ar.clock_out is not null;

  return jsonb_build_object(
    'date', v_today,
    'timezone', public.att_app_timezone(),
    'working_day', v_working_day,
    'working_days', coalesce(v_working_days, '{}'::text[]),
    'total_employees', v_total,
    'present_today', v_present,
    'absent_today', case when v_working_day then greatest(0, v_total - v_on_leave - v_present) else 0 end,
    'on_leave_today', v_on_leave,
    'late_today', v_late,
    'attendance_percent', case when v_total > 0 then round((v_present::numeric / v_total) * 100, 1) else 0 end,
    'average_hours', v_avg
  );
end;
$$;

revoke all on function public.get_dashboard_attendance_today(uuid, text, uuid, text) from public;
grant execute on function public.get_dashboard_attendance_today(uuid, text, uuid, text) to authenticated;
