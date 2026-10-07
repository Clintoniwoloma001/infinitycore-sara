-- ============================================================================
-- PHASE 70 (part 4) - TRACKING GEOFENCE CONTEXT + MAP SUPPORT
-- Run in Supabase SQL Editor AFTER 20260926000002. Idempotent, additive,
-- transaction-wrapped.
--
-- WHY THIS PART EXISTS
--   Employee Tracking reported "Outside any registered location" for an
--   observation that simultaneously carried the LABEL of a real branch. The
--   label came from resolve_employee_location() falling back to the NEAREST
--   registered location name while inside = false, so one row could read
--   "HEAD OFFICE / Outside" at once. Coordinates stayed authoritative, but the
--   label contradicted the verdict and the screen became impossible to audit.
--
--   The coordinates themselves were fine: the reported point and HEAD OFFICE
--   are ~9174 m apart, so "Outside" was correct. What was broken was that the
--   UI could not SHOW why, and the stored label named a fence the employee was
--   nowhere near.
--
-- WHAT THIS PART DOES
--   1. resolve_employee_location() gains `outside_label`: an honest label that
--      carries the real separation. The existing `human_label` is unchanged so
--      no current caller (clock-in, clock-out, audit) changes behaviour.
--   2. employee_location_events persists the NEAREST registered location, its
--      distance and its radius. Previously an outside point stored a NULL
--      distance and nothing at all about how far out it was, so the UI could
--      not tell "20 m out" from "9 km out".
--   3. record_employee_location() stores that context and labels the row with
--      outside_label whenever inside = false.
--   4. list_tracked_employees() and employee_location_history() return it.
--   5. list_tracking_geofences() returns the ACTIVE registered locations so the
--      web map draws the real circles. Identical candidate set, filters and
--      radius defaults as the ONE resolver, so the map can never show a fence
--      the engine does not honour.
--   6. Existing rows are backfilled by re-resolving each stored coordinate
--      through the SAME function. No distance is ever invented.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. PERSISTED NEAREST-LOCATION CONTEXT
-- ---------------------------------------------------------------------------
alter table public.employee_location_events
  add column if not exists nearest_location_name text,
  add column if not exists nearest_distance numeric(12, 2),
  add column if not exists nearest_radius numeric(12, 2);

comment on column public.employee_location_events.nearest_location_name is
  'Registered location NEAREST to this observation. Recorded even when inside_geofence is false, which is what makes an outside verdict checkable.';
comment on column public.employee_location_events.nearest_distance is
  'Distance in meters from this observation to nearest_location_name. The true separation, inside or outside - never rounded or assumed.';
comment on column public.employee_location_events.nearest_radius is
  'Radius of nearest_location_name when observed. Compared with nearest_distance it explains exactly why the point was inside or outside.';

create index if not exists idx_location_events_nearest
  on public.employee_location_events (nearest_location_name)
  where inside_geofence = false;

-- ---------------------------------------------------------------------------
-- 2. THE SINGLE GEOFENCE AUTHORITY, RE-ISSUED
-- The candidate set, the distance function, the loop and human_label behave
-- exactly as in 20260926000001. ONLY one thing is added: the returned object
-- carries `outside_label`, so a caller that stores a label can store one that
-- agrees with `inside` instead of naming the nearest branch as if the employee
-- were standing in it.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_employee_location(
  p_lat float,
  p_lng float,
  p_action text default 'clock_in',
  p_geofence_override uuid default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_settings record;
  v_candidate record;
  v_action text := lower(coalesce(p_action, 'clock_in'));
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
begin
  if p_lat is null or p_lng is null
     or p_lat <> p_lat or p_lng <> p_lng
     or p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
    return jsonb_build_object(
      'ok', false, 'inside', false, 'has_location', false,
      'location_id', null, 'branch_id', null, 'geofence_id', null,
      'location_name', null, 'location_type', null,
      'distance_meters', null, 'radius_meters', null,
      'nearest_location_name', null, 'nearest_distance', null,
      'nearest_radius', null, 'human_label', 'Unknown location',
      'outside_label', 'Unknown location');
  end if;

  select * into v_settings from public.hr_platform_settings where id = 1 limit 1;

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
       and p_geofence_override is null
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
     where (coalesce(g.active, false) or p_geofence_override is not null)
       and (p_geofence_override is null or g.id = p_geofence_override)
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

  return jsonb_build_object(
    'ok', true,
    'inside', v_best_distance is not null,
    'has_location', v_has_location,
    'location_id', coalesce(v_best_geofence_id, v_best_branch_id),
    'branch_id', v_best_branch_id,
    'geofence_id', v_best_geofence_id,
    'location_name', v_best_name,
    'location_type', v_best_type,
    'distance_meters', v_best_distance,
    'radius_meters', v_best_radius,
    'nearest_location_name', v_nearest_name,
    'nearest_distance', v_nearest_distance,
    'nearest_radius', v_nearest_radius,
    'human_label', case
      when v_best_name is not null then v_best_name
      when v_nearest_name is not null then v_nearest_name
      else 'Outside registered locations'
    end,
    -- Honest label. A location is NEVER named here without the real separation,
    -- so "HEAD OFFICE" can no longer sit beside inside = false without the
    -- reader also being told how far away the fence actually is.
    'outside_label', case
      when v_best_name is not null then v_best_name
      when v_nearest_name is null then 'Outside registered locations'
      when v_nearest_distance >= 1000
        then 'Outside ' || v_nearest_name || ' ('
             || trim(trailing '.' from trim(trailing '0' from round(v_nearest_distance / 1000.0)::text)) || ' km away)'
      else 'Outside ' || v_nearest_name || ' ('
           || round(v_nearest_distance)::text || ' m away)'
    end);
end;
$$;

comment on function public.resolve_employee_location(float, float, text, uuid) is
  'THE single geofence authority. Never raises. Every attendance/location surface on web and mobile must resolve coordinates through this function so Clock-In Verification and Location Audit can never disagree. outside_label never names a location without also stating the real distance to it.';

revoke all on function public.resolve_employee_location(float, float, text, uuid) from public;
grant execute on function public.resolve_employee_location(float, float, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. GEOFENCE REGISTRY FOR THE MAP
-- The web map must draw the fences the ENGINE honours - never a second,
-- separately maintained list that could drift. This reads the same two sources,
-- with the same active filters and the same radius defaults as
-- resolve_employee_location(), so a circle on screen is always a fence that can
-- actually resolve a clock-in.
--
-- Read-only, and gated on employee_tracking_access() exactly like every other
-- tracking RPC: a caller who cannot view tracking cannot enumerate the fences.
-- ---------------------------------------------------------------------------
create or replace function public.list_tracking_geofences()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_access jsonb;
  v_settings record;
  v_rows jsonb;
begin
  v_access := public.employee_tracking_access();
  if not coalesce((v_access ->> 'can_view')::boolean, false) then
    raise exception 'TRACKING_FORBIDDEN:%', coalesce(v_access ->> 'reason', 'Not authorized.');
  end if;

  select * into v_settings from public.hr_platform_settings where id = 1 limit 1;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.location_name), '[]') into v_rows
    from (
      select b.id::text as branch_id,
             null::text as geofence_id,
             b.branch_name as location_name,
             'branch'::text as location_type,
             b.latitude::float as latitude,
             b.longitude::float as longitude,
             greatest(1, coalesce(b.geofence_radius, v_settings.default_geofence_radius, 150))::numeric as radius_meters
        from public.branches b
       where coalesce(b.geofence_active, false)
         and b.latitude is not null
         and b.longitude is not null
      union all
      select gb.id::text as branch_id,
             g.id::text as geofence_id,
             coalesce(gb.branch_name, nullif(g.location_name, ''), g.name) as location_name,
             case
               when lower(coalesce(g.location_name, '') || ' ' || coalesce(g.name, '')) like '%head office%'
                 then 'head_office'
               else 'geofence'
             end as location_type,
             g.latitude::float as latitude,
             g.longitude::float as longitude,
             greatest(1, coalesce(g.radius_meters, v_settings.default_geofence_radius, 150))::numeric as radius_meters
        from public.attendance_geofences g
        left join public.branches gb on gb.id::text = g.branch_id
       where coalesce(g.active, false)
         and g.latitude is not null
         and g.longitude is not null
    ) x;

  return jsonb_build_object('ok', true, 'geofences', v_rows,
                            'default_radius', coalesce(v_settings.default_geofence_radius, 150));
end;
$$;

comment on function public.list_tracking_geofences() is
  'ACTIVE registered locations with the radius the geofence engine actually applies, so the Employee Tracking map draws exactly the fences that can resolve a clock-in.';

revoke all on function public.list_tracking_geofences() from public;
revoke all on function public.list_tracking_geofences() from anon;
grant execute on function public.list_tracking_geofences() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. HEARTBEAT INGEST, RE-ISSUED
-- Access rules, timestamp sanity, dedupe and the call into the ONE resolver are
-- unchanged. The insert now persists the nearest-location context and uses
-- outside_label for the stored label whenever the point is outside, so a row can
-- no longer say "HEAD OFFICE" while also saying outside.
-- ---------------------------------------------------------------------------
create or replace function public.record_employee_location(
  p_lat float,
  p_lng float,
  p_accuracy float default null,
  p_recorded_at timestamptz default null,
  p_source text default 'mobile',
  p_source_detail text default null,
  p_device_id text default null,
  p_device_fingerprint text default null,
  p_attendance_record_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee record;
  v_resolved jsonb;
  v_id uuid;
  v_recorded timestamptz := coalesce(p_recorded_at, now());
  v_inserted boolean := false;
  v_inside boolean;
begin
  select e.* into v_employee
    from public.employees e
    join public.profiles p on p.id = e.user_id
   where p.id = auth.uid()
   limit 1;

  if not found then
    raise exception 'NO_EMPLOYEE_PROFILE:No employee record is linked to this account.';
  end if;

  if v_recorded > now() + interval '5 minutes' then
    v_recorded := now();
  end if;

  v_resolved := public.resolve_employee_location(p_lat, p_lng, 'track', null);
  v_inside := coalesce((v_resolved ->> 'inside')::boolean, false);

  insert into public.employee_location_events (
    employee_id, latitude, longitude, accuracy, recorded_at, uploaded_at,
    source, source_detail, device_id, device_fingerprint,
    attendance_record_id, detected_geofence_id, detected_branch_id,
    location_label, inside_geofence, distance_meters,
    nearest_location_name, nearest_distance, nearest_radius
  ) values (
    v_employee.id, p_lat, p_lng, p_accuracy, v_recorded, now(),
    lower(coalesce(nullif(p_source, ''), 'mobile')),
    p_source_detail,
    p_device_id,
    p_device_fingerprint,
    p_attendance_record_id,
    nullif(v_resolved ->> 'geofence_id', '')::uuid,
    nullif(v_resolved ->> 'branch_id', '')::uuid,
    -- Inside: the fence name. Outside: the fence name AND the real distance.
    case when v_inside
         then v_resolved ->> 'human_label'
         else coalesce(nullif(v_resolved ->> 'outside_label', ''), v_resolved ->> 'human_label')
    end,
    v_inside,
    nullif(v_resolved ->> 'distance_meters', '')::numeric,
    nullif(v_resolved ->> 'nearest_location_name', ''),
    nullif(v_resolved ->> 'nearest_distance', '')::numeric,
    nullif(v_resolved ->> 'nearest_radius', '')::numeric
  )
  on conflict (employee_id, recorded_at, latitude, longitude) do nothing;

  v_inserted := found;
  if v_inserted then
    select id into v_id
      from public.employee_location_events
     where employee_id = v_employee.id
       and recorded_at = v_recorded
       and latitude = p_lat
       and longitude = p_lng
     limit 1;
  end if;

  return jsonb_build_object(
    'ok', true,
    'stored', v_inserted,
    'id', v_id,
    'recorded_at', v_recorded,
    'uploaded_at', now(),
    'offline_sync', p_recorded_at is not null
                    and p_recorded_at < now() - interval '2 minutes',
    'location', v_resolved);
end;
$$;

revoke all on function public.record_employee_location(float, float, float, timestamptz, text, text, text, text, uuid) from public;
grant execute on function public.record_employee_location(float, float, float, timestamptz, text, text, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. READ SURFACES, RE-ISSUED FOR THE MAP
-- Authorization, staleness, the "latest point per employee" rule, the date and
-- time-window filters and the audit writes are ALL unchanged. The only change is
-- that both reads now also return nearest_location_name / nearest_distance /
-- nearest_radius, so the grid, the map and the summary can state HOW FAR outside
-- a point is instead of only that it was outside.
-- ---------------------------------------------------------------------------
create or replace function public.list_tracked_employees(
  p_within_minutes integer default 60,
  p_department text default null,
  p_branch_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_access jsonb;
  v_rows jsonb;
begin
  v_access := public.employee_tracking_access();
  if not coalesce((v_access ->> 'can_view')::boolean, false) then
    raise exception 'TRACKING_FORBIDDEN:%', coalesce(v_access ->> 'reason', 'Not authorized.');
  end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.last_seen desc), '[]') into v_rows
    from (
      select e.id as employee_id,
             e.full_name,
             e.employee_number,
             e.position,
             e.department,
             e.branch_id,
             b.branch_name,
             le.latitude,
             le.longitude,
             le.accuracy,
             le.recorded_at as last_seen,
             le.uploaded_at,
             le.location_label,
             le.inside_geofence,
             le.distance_meters,
             le.nearest_location_name,
             le.nearest_distance,
             le.nearest_radius,
             round(extract(epoch from (now() - le.recorded_at)) / 60.0)::int as minutes_ago,
             (le.recorded_at < now() - interval '45 minutes') as is_stale,
             (select count(*) from public.employee_location_events c
               where c.employee_id = e.id
                 and c.recorded_at > now() - make_interval(mins => p_within_minutes)) as points_in_window
        from public.employee_location_events le
        join public.employees e on e.id = le.employee_id
        left join public.branches b on b.id = e.branch_id
       where le.id = (select l2.id from public.employee_location_events l2
                        where l2.employee_id = e.id
                        order by l2.recorded_at desc limit 1)
         and (p_department is null or lower(e.department) = lower(p_department))
         and (p_branch_id is null or e.branch_id = p_branch_id)
    ) x;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('TRACKING_HISTORY_VIEWED', 'EmployeeLocationEvent', null,
          (select full_name from public.profiles where id = auth.uid()),
          jsonb_build_object('view', 'live_positions', 'rows',
                             coalesce(jsonb_array_length(v_rows), 0), 'success', true)::text,
          'info');

  return jsonb_build_object('ok', true, 'access', v_access, 'employees', v_rows,
                            'generated_at', now());
end;
$$;

revoke all on function public.list_tracked_employees(integer, text, uuid) from public;
grant execute on function public.list_tracked_employees(integer, text, uuid) to authenticated;

-- The returned points are the ACTUAL recorded observations in time order. The
-- date filter and the from/to time window are applied in the app timezone, so
-- the map polyline, the timeline and the summary are all drawn from exactly this
-- array and no route between two points is ever invented.
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
  v_access := public.employee_tracking_access();
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

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('EMPLOYEE_LOCATION_HISTORY_QUERIED', 'Employee', p_employee_id::text,
          (select full_name from public.profiles where id = auth.uid()),
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

revoke all on function public.employee_location_history(uuid, date, time, time, text) from public;
grant execute on function public.employee_location_history(uuid, date, time, time, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. BACKFILL EXISTING ROWS THROUGH THE SAME ENGINE
-- The rows that produced the confusing screen already exist, so they are
-- re-resolved here with the SAME function and the SAME math - nothing is
-- estimated. Only the nearest-context columns and the stored label are
-- corrected; coordinates, timestamps, accuracy and inside_geofence are left
-- exactly as recorded, because those are the authoritative facts.
--
-- inside = false is NEVER changed. If a device recorded a fix the office
-- disputes, the audit trail keeps what was observed and the screen now explains
-- the distance instead of quietly relabelling the history.
-- ---------------------------------------------------------------------------
update public.employee_location_events le
   set nearest_location_name = r.nearest_location_name,
       nearest_distance      = r.nearest_distance,
       nearest_radius        = r.nearest_radius,
       location_label        = case
                                when le.inside_geofence then le.location_label
                                when r.nearest_location_name is null
                                  then coalesce(le.location_label, 'Outside registered locations')
                                else r.outside_label
                              end
  from (
    select le2.id as id,
           -- resolve_employee_location() returns jsonb, so the lateral alias is
           -- a jsonb value: field access is `x ->> '…'`, not `x.…`. The dotted
           -- form raised "column x.nearest_location_name does not exist" and
           -- aborted this migration after the functions above it were created.
           nullif(x ->> 'nearest_location_name', '') as nearest_location_name,
           nullif(x ->> 'nearest_distance', '')::numeric as nearest_distance,
           nullif(x ->> 'nearest_radius', '')::numeric as nearest_radius,
           x ->> 'outside_label' as outside_label
      from public.employee_location_events le2
      cross join lateral public.resolve_employee_location(
             le2.latitude::float, le2.longitude::float, 'track', null) x
     where not le2.inside_geofence
  ) r
 where le.id = r.id;

commit;
