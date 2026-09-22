-- ============================================================
-- Phase — Authorize Head of Human Resources on attendance summary
-- Run in Supabase SQL Editor after 20260921000010.
-- Idempotent/additive.
--
-- The HR Manager role was renamed to head_of_human_resources in Phase 7a/10.
-- This restores access to the attendance management summary for that role.
-- ============================================================

begin;

create or replace function public.get_attendance_management_summary()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.current_role();
  v_tz text := public.att_app_timezone();
  v_today date := (clock_timestamp() at time zone public.att_app_timezone())::date;
  v_dow text := lower(to_char(clock_timestamp() at time zone public.att_app_timezone(), 'Dy'));
  v_working_days text[];
  v_is_working_day boolean := false;
  v_total integer := 0;
  v_on_leave integer := 0;
  v_present integer := 0;
  v_late integer := 0;
  v_absent integer := 0;
  v_cross_branch integer := 0;
  v_head_office integer := 0;
  v_other_branch integer := 0;
  v_avg numeric;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_manager', 'hr_officer', 'head_of_business') then
    raise exception 'Not authorized to view organization attendance summary.';
  end if;

  select default_working_days into v_working_days from public.hr_platform_settings where id = 1;
  select exists (
    select 1 from unnest(coalesce(v_working_days, '{}'::text[])) d
     where lower(left(d, 3)) = v_dow
  ) into v_is_working_day;

  select count(*) into v_total
    from public.employees e
   where e.employment_status = 'active' and coalesce(e.is_archived, false) = false;
  select count(distinct e.id) into v_on_leave
    from public.employees e
    join public.leave_requests lr on lr.created_by = e.user_id
   where e.employment_status = 'active'
     and coalesce(e.is_archived, false) = false
     and lr.status = 'approved' and lr.start_date <= v_today and lr.end_date >= v_today;
  select count(distinct ar.employee_id) into v_present
    from public.attendance_records ar
    join public.employees e on e.id = ar.employee_id
   where ar.attendance_date = v_today and ar.clock_in is not null
     and e.employment_status = 'active' and coalesce(e.is_archived, false) = false;
  select count(distinct ar.employee_id) into v_late
    from public.attendance_records ar
    join public.employees e on e.id = ar.employee_id
   where ar.attendance_date = v_today and ar.clock_in is not null
     and (coalesce(ar.late_minutes, 0) > 0 or ar.status = 'late')
     and e.employment_status = 'active' and coalesce(e.is_archived, false) = false;
  select round(avg(coalesce(ar.work_hours, extract(epoch from (ar.clock_out - ar.clock_in)) / 3600.0))::numeric, 1)
    into v_avg
    from public.attendance_records ar
    join public.employees e on e.id = ar.employee_id
   where ar.attendance_date = v_today and ar.clock_in is not null and ar.clock_out is not null
     and e.employment_status = 'active' and coalesce(e.is_archived, false) = false;

  select count(distinct ae.employee_id) into v_cross_branch
    from public.attendance_events ae
    join public.employees e on e.id = ae.employee_id
   where ae.event_type = 'CLOCK_IN' and (ae.event_time at time zone v_tz)::date = v_today
     and ae.metadata ->> 'location_difference' = 'true'
     and e.employment_status = 'active' and coalesce(e.is_archived, false) = false;
  select count(distinct ae.employee_id) into v_head_office
    from public.attendance_events ae
    join public.employees e on e.id = ae.employee_id
   where ae.event_type = 'CLOCK_IN' and (ae.event_time at time zone v_tz)::date = v_today
     and ae.metadata ->> 'location_difference' = 'true'
     and lower(coalesce(ae.metadata ->> 'actual_location_name', '')) like '%head office%'
     and e.employment_status = 'active' and coalesce(e.is_archived, false) = false;
  v_other_branch := greatest(0, v_cross_branch - v_head_office);
  v_absent := case when v_is_working_day then greatest(0, v_total - v_on_leave - v_present) else 0 end;

  return jsonb_build_object(
    'date', v_today,
    'timezone', v_tz,
    'working_day', v_is_working_day,
    'working_days', coalesce(v_working_days, '{}'::text[]),
    'total_employees', v_total,
    'present_today', v_present,
    'absent_today', v_absent,
    'on_leave_today', v_on_leave,
    'late_today', v_late,
    'attendance_percent', case when v_total > 0 then round((v_present::numeric / v_total) * 100, 1) else 0 end,
    'average_hours', coalesce(v_avg, 0),
    'cross_branch_today', v_cross_branch,
    'head_office_today', v_head_office,
    'other_registered_branch_today', v_other_branch
  );
end;
$$;

revoke all on function public.get_attendance_management_summary() from public;
grant execute on function public.get_attendance_management_summary() to authenticated;

commit;
