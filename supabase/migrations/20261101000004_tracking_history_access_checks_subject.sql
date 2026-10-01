begin;

-- ===========================================================================
-- Employee Tracking — history access checks the SUBJECT, not the caller
--
-- THE BUG (this is the "Unable to load history" the Super Admin hit)
--
--   employee_location_history() asked employee_tracking_access() for
--   permission with NO ARGUMENT:
--
--       v_access := public.employee_tracking_access();
--
--   Two things go wrong at once:
--
--   1. The no-argument overload resolves to auth.uid(). Under PostgREST the
--      session JWT *is* present, so the caller is found - but only because the
--      function is SECURITY DEFINER. The check therefore silently degrades to
--      "is this caller anybody at all", never "may this caller see THIS
--      employee".
--
--   2. Production's employee_tracking_access(uuid) takes that argument as
--      p_employee_id, not p_user_id. Calling it with no argument leaves the
--      employee unspecified, so the function evaluates the caller's own access
--      as if the caller were the subject. A Super Admin then reaches the grant
--      lookup with target_user_id set to the WRONG id, finds no grant, and
--      returns the refusal message - "Employee tracking requires an explicit
--      grant from the Super Admin" - even though Super Admin needs no grant.
--
--   The page-level gate (EmployeeTracking.jsx) passed because it calls the
--   function through a different path, which is exactly why the list rendered
--   while every history drawer failed.
--
-- THE FIX
--   Pass p_employee_id explicitly, so the decision is made about the employee
--   whose history is being read. The Super Admin branch is checked FIRST and
--   short-circuits, so a Super Admin always gets in regardless of grants - and
--   a delegated viewer is still only ever allowed the employees they were
--   granted. The previous behaviour is not weakened: it is made correct.
--
-- Nothing about the returned points changes. This is purely who may read them.
-- ===========================================================================

-- The issued definition, with the subject passed explicitly.
--
-- SECURITY DEFINER is retained deliberately: the reading tables are not
-- readable by every role, and the access decision is the whole point of this
-- function. `stable` is dropped because the body writes an audit row.
create or replace function public.employee_location_history(
  p_employee_id uuid,
  p_date date,
  p_from_time time default null,
  p_to_time time default null,
  p_inside_only text default 'all'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_access jsonb;
  v_tz text := public.att_app_timezone();
  v_points jsonb;
  v_emp record;
begin
  -- The subject is the employee whose history is being read. Passing it is the
  -- fix: the no-argument call checked the caller and, in production, checked
  -- the caller AS the subject.
  v_access := public.employee_tracking_access(p_employee_id);
  if not coalesce((v_access ->> 'can_view')::boolean, false) then
    raise exception 'TRACKING_FORBIDDEN:%', coalesce(v_access ->> 'reason', 'Not authorized.');
  end if;

  select * into v_emp from public.employees where id = p_employee_id;
  if not found then
    raise exception 'Employee not found.';
  end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.recorded_at), '[]') into v_points
    from (
      select le.id, le.latitude, le.longitude, le.accuracy, le.recorded_at,
             le.uploaded_at, le.source, le.device_id, le.location_label,
             -- The real place when a client has resolved it. Display only.
             le.resolved_place,
             le.inside_geofence, le.distance_meters, le.detected_branch_id,
             le.nearest_location_name, le.nearest_distance, le.nearest_radius,
             b.branch_name
        from public.employee_location_events le
        left join public.branches b on b.id = le.detected_branch_id
       where le.employee_id = p_employee_id
         and (le.recorded_at at time zone v_tz)::date = p_date
         and (p_from_time is null or (le.recorded_at at time zone v_tz)::time >= p_from_time)
         and (p_to_time   is null or (le.recorded_at at time zone v_tz)::time <= p_to_time)
         and (p_inside_only = 'all'
              or (p_inside_only = 'inside' and le.inside_geofence)
              or (p_inside_only = 'outside' and not le.inside_geofence))
    ) x;

  -- The auditor is the CALLER, resolved from the JWT, not the subject. These
  -- two are different people and confusing them would misattribute the audit.
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('EMPLOYEE_LOCATION_HISTORY_QUERIED', 'Employee', p_employee_id::text,
          coalesce(
            (select full_name from public.profiles
              where id = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid),
            (select p2.full_name from public.profiles p2
              where p2.id = (select e.user_id from public.employees e
                              where e.id = p_employee_id))),
          jsonb_build_object('date', p_date, 'points',
                             coalesce(jsonb_array_length(v_points), 0), 'success', true)::text,
          'info');

  return jsonb_build_object(
    'ok', true,
    'employee', jsonb_build_object(
      'id', v_emp.id, 'full_name', v_emp.full_name,
      'employee_number', v_emp.employee_number, 'position', v_emp.position,
      'department', v_emp.department, 'branch_id', v_emp.branch_id),
    'date', p_date,
    'from_time', p_from_time,
    'to_time', p_to_time,
    'points', v_points,
    'point_count', coalesce(jsonb_array_length(v_points), 0),
    'timezone', v_tz);
end;
$$;

comment on function public.employee_location_history(uuid, date, time, time, text) is
  'Audited movement history for ONE employee on ONE local day. Access is decided about the SUBJECT employee, not the caller, so a Super Admin reads any history without a grant and a delegated viewer reads only what they were granted. Filtering happens here, never in the client.';

revoke all on function public.employee_location_history(uuid, date, time, time, text) from public;
grant execute on function public.employee_location_history(uuid, date, time, time, text) to authenticated;

commit;