-- Phase 4 — Area Manager multi-branch clock-in exception and weekly location KPI.
-- Idempotent/additive.

-- Helper: return the set of branches assigned to an employee's area when that
-- employee is the Area Manager. Empty set if the employee is not an area manager.
create or replace function public.get_area_manager_area_branches(p_employee_id uuid)
returns table (
  branch_id uuid,
  branch_name text,
  latitude numeric,
  longitude numeric,
  geofence_radius numeric,
  geofence_active boolean,
  work_start_time text,
  work_end_time text,
  grace_period_minutes int
)
language sql
stable
security definer
set search_path = public
as $$
  select b.id, b.branch_name, b.latitude, b.longitude, b.geofence_radius,
         b.geofence_active, b.work_start_time, b.work_end_time, b.grace_period_minutes
    from public.areas a
    join public.branch_area_assignments baa on baa.area_id = a.id and baa.is_current = true
    join public.branches b on b.id = baa.branch_id
   where a.manager_employee_id = p_employee_id;
$$;

-- Patch attendance_validate_location so Area Managers are validated against ANY
-- branch in their assigned area, not only their primary branch_id.
create or replace function public.attendance_validate_location(
  p_employee_id uuid,
  p_lat float,
  p_lng float,
  p_action text,
  p_branch_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee record;
  v_assigned record;
  v_settings record;
  v_candidate record;
  v_assigned_id uuid;
  v_assigned_name text;
  v_best_branch_id uuid;
  v_best_geofence_id uuid;
  v_best_name text;
  v_best_type text;
  v_best_distance float;
  v_best_radius numeric;
  v_nearest_name text;
  v_nearest_distance float;
  v_nearest_radius numeric;
  v_has_location boolean := false;
  v_action text := lower(coalesce(p_action, 'clock_in'));
  v_location_difference boolean;
  v_is_area_manager boolean := false;
  v_area_branch_ids uuid[];
  v_area_branch_names text[];
  v_primary_branch record;
begin
  select * into v_employee
    from public.employees
   where id = p_employee_id
   limit 1;
  if not found then
    raise exception 'Employee record not found.';
  end if;

  select * into v_settings
    from public.hr_platform_settings
   where id = 1
   limit 1;

  if p_lat is null or p_lng is null then
    raise exception 'LOCATION_REQUIRED:Location is required to clock in or out. Please enable location access.';
  end if;
  if p_lat <> p_lat or p_lng <> p_lng
     or p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
    raise exception 'LOCATION_INVALID:Your device returned an invalid location. Please try again.';
  end if;

  -- Is this employee an Area Manager?
  select array_agg(b.branch_id), count(*) > 0
    into v_area_branch_ids, v_is_area_manager
    from public.get_area_manager_area_branches(p_employee_id) b;

  -- Resolve the primary assigned branch (for work-time defaults and display).
  if p_branch_id is not null then
    select * into v_primary_branch from public.branches where id = p_branch_id limit 1;
  elsif v_employee.branch_id is not null then
    select * into v_primary_branch from public.branches where id = v_employee.branch_id limit 1;
  elsif nullif(trim(v_employee.branch), '') is not null then
    select * into v_primary_branch
      from public.branches
     where lower(branch_name) = lower(trim(v_employee.branch))
        or lower(coalesce(branch_code, '')) = lower(trim(v_employee.branch))
     order by case when lower(branch_name) = lower(trim(v_employee.branch)) then 0 else 1 end
     limit 1;
  end if;

  v_assigned_id := v_primary_branch.id;
  v_assigned_name := coalesce(v_primary_branch.branch_name, nullif(trim(v_employee.branch), ''));

  if v_is_area_manager then
    select array_agg(b.branch_name) into v_area_branch_names
      from public.branches b
     where b.id = any(v_area_branch_ids);
  end if;

  for v_candidate in
    select b.id as branch_id,
           null::uuid as geofence_id,
           b.branch_name as location_name,
           'branch'::text as location_type,
           b.latitude::float as latitude,
           b.longitude::float as longitude,
           greatest(1, coalesce(b.geofence_radius, v_settings.default_geofence_radius, 150))::numeric as radius
      from public.branches b
     where coalesce(b.geofence_active, false)
       and b.latitude is not null
       and b.longitude is not null
    union all
    select gb.id as branch_id,
           g.id as geofence_id,
           coalesce(gb.branch_name, nullif(g.location_name, ''), g.name) as location_name,
           case
             when lower(coalesce(g.location_name, '') || ' ' || coalesce(g.name, '')) like '%head office%'
               then 'head_office'
             else 'geofence'
           end as location_type,
           g.latitude::float as latitude,
           g.longitude::float as longitude,
           greatest(1, coalesce(g.radius_meters, v_settings.default_geofence_radius, 150))::numeric as radius
      from public.attendance_geofences g
      left join public.branches gb on gb.id::text = g.branch_id
     where coalesce(g.active, false)
       and g.latitude is not null
       and g.longitude is not null
       and case when v_action = 'clock_out'
                then coalesce(g.clock_out_allowed, true)
                else coalesce(g.clock_in_allowed, true)
           end
  loop
    v_has_location := true;
    declare
      v_distance float := public.geo_distance(p_lat, p_lng, v_candidate.latitude, v_candidate.longitude);
    begin
      if v_nearest_distance is null or v_distance < v_nearest_distance then
        v_nearest_distance := v_distance;
        v_nearest_name := v_candidate.location_name;
        v_nearest_radius := v_candidate.radius;
      end if;

      if v_distance <= v_candidate.radius
         and (v_best_distance is null or v_distance < v_best_distance) then
        v_best_distance := v_distance;
        v_best_branch_id := v_candidate.branch_id;
        v_best_geofence_id := v_candidate.geofence_id;
        v_best_name := v_candidate.location_name;
        v_best_type := v_candidate.location_type;
        v_best_radius := v_candidate.radius;
      end if;
    end;
  end loop;

  if not v_has_location then
    raise exception 'GEOFENCE_NOT_CONFIGURED:No approved attendance location is configured. Contact HR before clocking in or out.';
  end if;
  if v_best_distance is null then
    raise exception 'OUTSIDE_GEOFENCE:You are outside all approved Infinity Bank attendance locations.';
  end if;

  if v_best_distance is not null then
    if v_is_area_manager then
      -- Area Manager: inside any assigned-area branch = no difference.
      v_location_difference := not (v_best_branch_id = any(v_area_branch_ids));
    else
      v_location_difference := not (
        (v_assigned_id is not null and v_best_branch_id = v_assigned_id)
        or (v_assigned_name is not null and lower(v_best_name) = lower(v_assigned_name))
      );
    end if;
  end if;

  return jsonb_build_object(
    'assigned_branch_id', v_assigned_id,
    'assigned_branch_name', v_assigned_name,
    'actual_branch_id', v_best_branch_id,
    'actual_geofence_id', v_best_geofence_id,
    'actual_location_name', v_best_name,
    'actual_location_type', v_best_type,
    'location_difference', v_location_difference,
    'distance', v_best_distance,
    'radius', v_best_radius,
    'nearest_location_name', v_nearest_name,
    'nearest_distance', v_nearest_distance,
    'nearest_radius', v_nearest_radius,
    'geofence_status', case when v_best_distance is null then 'outside' else 'inside' end,
    'location_status', case when v_best_distance is null then 'outside' else 'inside' end,
    'is_area_manager', v_is_area_manager,
    'area_branch_count', coalesce(array_length(v_area_branch_ids, 1), 0),
    'work_start_time', coalesce(v_primary_branch.work_start_time, v_settings.default_work_start_time, '08:00')::text,
    'work_end_time', coalesce(v_primary_branch.work_end_time, v_settings.default_work_end_time, '17:00')::text,
    'grace_period_minutes', coalesce(v_primary_branch.grace_period_minutes, v_settings.default_grace_period_minutes, 15)
  );
end;
$$;

-- RPC: assign branches to an area (used by HR Organisation to define Area Manager territory).
create or replace function public.set_area_branches(
  p_area_id uuid,
  p_branch_ids uuid[],
  p_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.current_role();
  v_actor text := coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text);
  v_area record;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to edit area branches';
  end if;

  select * into v_area from public.areas where id = p_area_id;
  if v_area is null then raise exception 'Area not found'; end if;

  -- Mark current assignments as not current.
  update public.branch_area_assignments
     set is_current = false,
         assigned_to = now()
   where area_id = p_area_id and is_current = true;

  -- Insert new current assignments.
  if p_branch_ids is not null and array_length(p_branch_ids, 1) > 0 then
    insert into public.branch_area_assignments (area_id, branch_id, is_current, assigned_from, assigned_to, assigned_by, reason)
    select p_area_id, b.id, true, now(), null, auth.uid(), p_reason
      from public.branches b
     where b.id = any(p_branch_ids)
    on conflict (branch_id, area_id)
    do update set is_current = true, assigned_from = now(), assigned_to = null, assigned_by = auth.uid(), reason = p_reason;
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'AREA_BRANCHES_UPDATED',
    'Area',
    p_area_id::text,
    v_actor,
    jsonb_build_object(
      'area_code', v_area.area_code,
      'branch_ids', p_branch_ids,
      'reason', p_reason,
      'actor_role', v_role
    )::text,
    'info'
  );

  return jsonb_build_object('ok', true, 'area_id', p_area_id);
end;
$$;

-- RPC: weekly location-visit KPI for an Area Manager (distinct assigned branches visited).
create or replace function public.get_area_manager_location_kpi(
  p_employee_id uuid,
  p_week_start date default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_week_start date := coalesce(p_week_start, date_trunc('week', now() at time zone public.att_app_timezone())::date);
  v_week_end date := v_week_start + interval '6 days';
  v_area_branches uuid[];
  v_total_assigned int;
  v_visited int;
  v_employee record;
begin
  select * into v_employee from public.employees where id = p_employee_id;
  if v_employee is null then raise exception 'Employee not found'; end if;

  select array_agg(b.branch_id), count(*)
    into v_area_branches, v_total_assigned
    from public.get_area_manager_area_branches(p_employee_id) b;

  if v_total_assigned = 0 then
    return jsonb_build_object(
      'employee_id', p_employee_id,
      'week_start', v_week_start,
      'week_end', v_week_end,
      'total_assigned_branches', 0,
      'visited_branches', 0,
      'target_met', false,
      'message', 'This employee is not an Area Manager or has no assigned area branches.'
    );
  end if;

  select count(distinct r.branch_id)
    into v_visited
    from public.attendance_records r
   where r.employee_id = p_employee_id
     and r.attendance_date between v_week_start and v_week_end
     and r.clock_in is not null
     and r.branch_id = any(v_area_branches);

  return jsonb_build_object(
    'employee_id', p_employee_id,
    'week_start', v_week_start,
    'week_end', v_week_end,
    'total_assigned_branches', v_total_assigned,
    'visited_branches', v_visited,
    'target_met', v_visited >= 5,
    'target', 5,
    'message', format('%s visited %s of %s assigned branch(es) this week.', v_employee.full_name, v_visited, v_total_assigned)
  );
end;
$$;

 grant execute on function public.get_area_manager_area_branches(uuid) to authenticated;
 grant execute on function public.set_area_branches(uuid, uuid[], text) to authenticated;
 grant execute on function public.get_area_manager_location_kpi(uuid, date) to authenticated;
