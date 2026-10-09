-- ============================================================================
-- employee_live_positions_v3
-- ============================================================================
-- WHY v3 (v2 is left untouched and still works)
--   P0-A root cause: the web reads fields named inside_geofence,
--   nearest_location_name, nearest_distance, nearest_radius, location_label —
--   but employee_live_positions_v2 returns geofence_status (text), nearest_name,
--   distance_to_center_m, meters_outside and NO inside_geofence/nearest_* at
--   all. So the web's `point.inside_geofence` was always undefined (falsy) and
--   EVERY row rendered "Outside" even when classify_geofence() correctly said
--   inside. v3 returns the field names the client already consumes, so the
--   Location and Geofence columns can never contradict the server verdict.
--
--   P0-B: v3 also adds today's clocked_in_at / clocked_out_at (from
--   attendance_events), the latest tracking_unavailable reason, and a
--   fix_since_clock_in flag, so the web can show "Clocked in, no location
--   since HH:mm" instead of silently showing a days-old fix.
--
-- ADDITIVE ONLY. v2 is not modified. No table/column/route renames.
-- ============================================================================
drop function if exists public.employee_live_positions_v3(integer, text, uuid);

create or replace function public.employee_live_positions_v3(
  p_within_minutes integer default 60,
  p_department text default null,
  p_branch_id uuid default null
) returns table (
  employee_id uuid,
  full_name text,
  employee_number text,
  "position" text,
  department text,
  branch_id uuid,
  branch_name text,
  latitude numeric,
  longitude numeric,
  accuracy numeric,
  recorded_at timestamptz,
  uploaded_at timestamptz,
  age_seconds integer,
  server_now timestamptz,
  freshness text,
  inside_geofence boolean,
  geofence_name text,
  nearest_location_name text,
  nearest_distance float,
  nearest_radius numeric,
  distance_to_center_m float,
  meters_outside numeric,
  confidence text,
  location_label text,
  sync_status text,
  tracking_unavailable_reason text,
  has_fix boolean,
  clocked_in_at timestamptz,
  clocked_out_at timestamptz,
  is_clocked_in boolean,
  fix_since_clock_in boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_access jsonb;
  v_emulator_lat numeric := 37.4219983;
  v_emulator_lng numeric := -122.0840000;
begin
  v_access := public.employee_tracking_access();
  if not coalesce((v_access ->> 'can_view')::boolean, false) then
    raise exception 'TRACKING_FORBIDDEN:%', coalesce(v_access ->> 'reason', 'Not authorized.');
  end if;
  return query
  with latest_fix as (
    select distinct on (l.employee_id)
           l.employee_id, l.id, l.latitude, l.longitude, l.accuracy,
           l.recorded_at, l.uploaded_at, l.sync_status
      from public.employee_location_events l
     where not (l.latitude = v_emulator_lat and l.longitude = v_emulator_lng)
     order by l.employee_id, l.recorded_at desc nulls last, l.id desc
  ),
  today_attendance as (
    select a.employee_id,
           max(a.event_time) filter (where a.event_type = 'CLOCK_IN')  as clocked_in_at,
           max(a.event_time) filter (where a.event_type = 'CLOCK_OUT') as clocked_out_at
      from public.attendance_events a
     where a.event_type in ('CLOCK_IN','CLOCK_OUT')
       and (a.event_time at time zone 'Africa/Lagos')::date
           = (now() at time zone 'Africa/Lagos')::date
     group by a.employee_id
  )
  select
    e.id, e.full_name, e.employee_number, e.position, e.department,
    e.branch_id, b.branch_name,
    le.latitude, le.longitude, le.accuracy,
    le.recorded_at, le.uploaded_at,
    case when le.recorded_at is null then null
         else extract(epoch from (now() - le.recorded_at))::int end as age_seconds,
    now() as server_now,
    case
      when le.recorded_at is null then 'no_data'
      when le.recorded_at > now() - interval '6 minutes' then 'live'
      when le.recorded_at > now() - interval '30 minutes' then 'delayed'
      else 'stale'
    end as freshness,
    coalesce(cls.inside, false) as inside_geofence,
    cls.registered_name as geofence_name,
    cls.nearest_registered_name as nearest_location_name,
    cls.nearest_distance as nearest_distance,
    cls.nearest_radius as nearest_radius,
    cls.distance_to_center_m,
    case when cls.inside then null
         else round(cls.nearest_distance)::numeric end as meters_outside,
    cls.confidence,
    case
      when cls.inside then
        coalesce(cls.registered_name, 'Registered location')
        || case when cls.distance_to_center_m is not null
                then ' (' || round(cls.distance_to_center_m)::text || ' m from centre)'
                else '' end
      when cls.nearest_registered_name is null then 'Outside registered locations'
      when cls.nearest_distance >= 1000
        then 'Outside ' || cls.nearest_registered_name || ' ('
             || trim(trailing '.' from trim(trailing '0' from round(cls.nearest_distance / 1000.0)::text)) || ' km away)'
      else 'Outside ' || cls.nearest_registered_name || ' ('
           || round(cls.nearest_distance)::text || ' m away)'
    end as location_label,
    le.sync_status,
    (select tu.reason from public.employee_tracking_unavailable tu
      where tu.employee_id = e.id
        and (tu.occurred_at > le.recorded_at or le.recorded_at is null)
      order by tu.occurred_at desc limit 1) as tracking_unavailable_reason,
    le.recorded_at is not null as has_fix,
    ta.clocked_in_at, ta.clocked_out_at,
    (ta.clocked_in_at is not null
       and (ta.clocked_out_at is null or ta.clocked_out_at < ta.clocked_in_at)) as is_clocked_in,
    (le.recorded_at is not null
       and ta.clocked_in_at is not null
       and le.recorded_at >= ta.clocked_in_at) as fix_since_clock_in
  from public.employees e
  left join latest_fix le on le.employee_id = e.id
  left join public.branches b on b.id = e.branch_id
  left join today_attendance ta on ta.employee_id = e.id
  left join lateral (
    select * from public.classify_geofence(
      le.latitude::float, le.longitude::float, le.accuracy::float) cls
    limit 1
  ) cls on true
  where (p_department is null or lower(e.department) = lower(p_department))
    and (p_branch_id is null or e.branch_id = p_branch_id);
end;
$$;

revoke all on function public.employee_live_positions_v3(integer, text, uuid) from public;
grant execute on function public.employee_live_positions_v3(integer, text, uuid) to authenticated;

comment on function public.employee_live_positions_v3(integer, text, uuid) is
  'Live positions v3. Same security + freshness + emulator exclusion as v2, but returns the field names the client reads (inside_geofence, nearest_location_name, nearest_distance, nearest_radius) so Location/Geofence cannot contradict the server verdict (P0-A). Adds today clocked_in_at/clocked_out_at, is_clocked_in, fix_since_clock_in and latest tracking_unavailable reason (P0-B).';
