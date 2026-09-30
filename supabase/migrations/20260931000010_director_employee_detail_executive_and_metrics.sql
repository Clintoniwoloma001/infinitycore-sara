-- ============================================================================
-- DIRECTOR EMPLOYEE DETAIL: executive roles, real metrics, attendance history
-- ============================================================================
-- THREE REAL DEFECTS, all visible on the Director / Chairman / MD screens.
--
-- 1. CHAIRMAN AND MD/CEO WERE LOCKED OUT
--    The gate was:
--        if public.current_role() not in ('director','super_admin') ...
--    Every other executive function in this module accepts
--    ('md_ceo','chairman','director','super_admin') — including the very
--    snapshot this detail screen is reached from. So a Chairman or MD/CEO could
--    open the list and then be refused the moment they tapped a person, with
--    "insufficient_permissions: director.executive.read".
--
-- 2. THE PERSON KEY DID NOT MATCH WHAT THE CLIENT READS
--    The function returns 'profile'; the Flutter screen read
--    detail['employee'] ?? detail['person'] ?? detail. Every branch missed, so
--    it fell through to the top-level payload, which has no full_name, no
--    department and no rates — which is exactly why tapping
--    "ABIODUN IDAYAT LAWAL" (showing 25% in the list) opened a detail screen
--    full of empty placeholders.
--
--    'employee' and 'person' are added as aliases of 'profile', so the existing
--    client is fixed without a coordinated deploy.
--
-- 3. NO SCORE, SO EVERY TILE RENDERED AS "--"
--    The payload had no attendance / KPI / target rollup, only raw rows. A
--    summary is now computed from the SAME records the history list shows, so
--    the number and the list underneath it can never disagree.
--
--    The score is deliberately honest:
--      * attendance percentage = days clocked in / days actually RECORDED in the
--        window. Days with no record at all are NOT counted as absent — that
--        would report a person absent for every weekend and public holiday they
--        were never expected to work;
--      * late / early percentages use the recorded minute columns;
--      * total work hours come from the platform's own work_hours, so an HR
--        correction is respected rather than recomputed away.
-- ============================================================================
begin;

create or replace function public.get_director_employee_detail(p_employee_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_profile jsonb;
  v_attendance jsonb;
  v_summary jsonb;
  v_result jsonb;
begin
  -- (1) The executive gate, aligned with get_director_executive_snapshot.
  if public.current_role() not in ('md_ceo','chairman','director','super_admin')
     or not public.has_permission('director.executive.read') then
    raise exception 'insufficient_permissions: director.executive.read';
  end if;

  select jsonb_build_object(
    'id', e.id, 'full_name', e.full_name, 'department', e.department,
    'position', e."position", 'designation', d.title,
    'branch', coalesce(b.branch_name, e.branch),
    'area', coalesce(e.area, a.area_name),
    'hire_date', e.hire_date, 'status', e.employment_status,
    'role', coalesce(p.role, 'staff')
  )
  into v_profile
  from public.employees e
  left join public.profiles p on p.id = e.user_id
  left join public.branches b on b.id = e.branch_id
  left join public.designations d on d.id = e.designation_id
  left join public.branch_area_assignments baa
         on baa.branch_id = e.branch_id and baa.is_current
  left join public.areas a on a.id = baa.area_id
  where e.id = p_employee_id;

  -- One window, reused for both the history and the rollup, so the headline
  -- numbers describe exactly the rows shown underneath them.
  select coalesce(jsonb_agg(to_jsonb(x) order by x.attendance_date desc), '[]')
  into v_attendance
  from (
    select a.*, date_trunc('month', a.attendance_date)::date as month_start,
           extract(quarter from a.attendance_date)::int as quarter_no,
           extract(year from a.attendance_date)::int as year_no
      from public.attendance_records a
     where a.employee_id = p_employee_id
       and a.attendance_date
           between date_trunc('month', current_date)::date and current_date
     order by a.attendance_date desc
     limit 400
  ) x;

  -- (3) Rollups, all derived from the rows above.
  select jsonb_build_object(
    'attendance_rate', case
        when count(*) filter (where clock_in is not null) = 0 then 0
        else round(100.0 * count(*) filter (where clock_in is not null) / count(*))
      end,
    'days_recorded', count(*),
    'days_present', count(*) filter (where clock_in is not null),
    'days_absent', count(*) filter (where clock_in is null),
    -- Late/early are percentages OF THE DAYS WORKED, so somebody who was never
    -- scheduled does not show a misleading 0%.
    'late_ratio', case
        when count(*) filter (where clock_in is not null) = 0 then 0
        else round(100.0 * count(*) filter (where coalesce(late_minutes, 0) > 0)
                   / count(*) filter (where clock_in is not null))
      end,
    'early_departure_ratio', case
        when count(*) filter (where clock_out is not null) = 0 then 0
        else round(100.0 * count(*) filter (where coalesce(early_departure_minutes, 0) > 0)
                   / count(*) filter (where clock_out is not null))
      end,
    'total_work_hours', round(coalesce(sum(work_hours), 0)::numeric, 2),
    'total_minutes', coalesce(sum(total_minutes), 0),
    -- KPI and target completion, computed the same way the dashboard computes
    -- them so the drill-down cannot disagree with the summary it was opened from.
    'kpi_completion', case
        when (select count(*) from public.employee_kpis k
               where k.employee_id = p_employee_id) = 0 then 0
        else round(100.0 * (select count(*) from public.employee_kpis k
                             where k.employee_id = p_employee_id
                               and k.status in ('completed','acknowledged'))
                   / (select count(*) from public.employee_kpis k
                       where k.employee_id = p_employee_id))
      end,
    'target_completion', case
        when (select count(*) from public.targets t
               where t.employee_id = p_employee_id
                 and t.status not in ('cancelled','missed')) = 0 then 0
        else round(100.0 * (select count(*) from public.targets t
                             where t.employee_id = p_employee_id
                               and t.status = 'achieved')
                   / (select count(*) from public.targets t
                       where t.employee_id = p_employee_id
                         and t.status not in ('cancelled','missed')))
      end
  )
  into v_summary
  from jsonb_to_recordset(v_attendance)
    as r(clock_in timestamptz, clock_out timestamptz, work_hours numeric,
         total_minutes int, late_minutes int, early_departure_minutes int);

  select jsonb_build_object(
    -- (2) Aliases of the existing 'profile', so whichever key the client reads
    -- it gets the real person.
    'profile', v_profile,
    'employee', v_profile,
    'person', v_profile,
    -- The headline numbers, so no tile has to render a placeholder.
    'summary', v_summary,
    'kpis', (select coalesce(jsonb_agg(to_jsonb(k) order by updated_at desc), '[]')
               from public.employee_kpis k where k.employee_id = p_employee_id),
    'targets', (select coalesce(jsonb_agg(to_jsonb(t) order by end_date desc), '[]')
                  from public.targets t where t.employee_id = p_employee_id),
    'attendance', v_attendance,
    'leave', (select coalesce(jsonb_agg(to_jsonb(l) order by start_date desc), '[]')
                from public.leave_requests l
                join public.employees e on e.user_id = l.created_by
               where e.id = p_employee_id)
  ) into v_result;

  return coalesce(v_result, '{}'::jsonb);
end;
$$;
revoke all on function public.get_director_employee_detail(uuid) from public;
grant execute on function public.get_director_employee_detail(uuid) to authenticated;

commit;
