-- ============================================================================
-- employee_live_positions_v3 — name fallback (permanent fix for "Staff Member")
-- ============================================================================
-- ROOT CAUSE (Employee Tracking page rendered "Staff Member" on every row):
--   v3 selected e.full_name straight from public.employees with NO fallback.
--   Any employee row whose full_name is NULL or blank (auto-created rows,
--   BankOne imports, HR-master-pending rows, unreconciled rows) arrived with
--   full_name = null, and the web's `item.full_name || 'Staff Member'`
--   fallback fired on every one of them — while employee_number and position
--   (separate columns) rendered fine, which is exactly the reported symptom.
--
-- PERMANENT FIX, two layers:
--   1. BACKFILL (data, guarded + idempotent): fill NULL/blank employees
--      .full_name from the linked profile (profiles.employee_id -> employees
--      .id), newest profile wins. Only touches rows that are actually blank;
--      guarded by an information_schema check so it is a no-op on DB
--      generations without that column.
--   2. RPC (contract): v3's full_name becomes a COALESCE chain —
--      employees.full_name -> linked profile full_name -> work email ->
--      employee_number -> 'Staff <short-id>'. The server can therefore never
--      return a blank name again, no matter which client reads it (web AND
--      mobile read this same RPC). Scalar subquery is used for the profile
--      lookup so a duplicated link can never multiply rows.
--
-- ADDITIVE ONLY. No signature change, no column renames, no policy change.
-- Run AFTER 20261109000002 (v3) and 20261109000003 (repair pack):
--   1. .../20261110000002_drop_legacy_list_tracked_employees.sql
--   2. .../20261109000001_list_tracked_employees_freshness.sql
--   3. .../20261109000002_live_positions_v3.sql
--   4. .../20261109000003_tracking_geofence_repair_pack.sql
--   5. THIS FILE
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Backfill blank employee names from linked profiles (NULL/blank only).
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'profiles'
       and column_name = 'employee_id'
  ) and exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'employees'
       and column_name = 'full_name'
  ) then
    update public.employees e
       set full_name = src.full_name,
           updated_at = now()
      from (
        select distinct on (pf.employee_id)
               pf.employee_id,
               btrim(pf.full_name) as full_name
          from public.profiles pf
         where pf.employee_id is not null
           and nullif(btrim(pf.full_name), '') is not null
         order by pf.employee_id, pf.full_name
      ) src
     where e.id = src.employee_id
       and nullif(btrim(e.full_name), '') is null;
  end if;
end;
$$;
-- ----------------------------------------------------------------------------
-- 2. Re-issue v3 with the name COALESCE chain. Full body repeated (same as
--    20261109000002) so the file applies cleanly on its own; the ONLY
--    functional change is the full_name expression (COALESCE chain).
-- ----------------------------------------------------------------------------
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
    e.id,
    -- NAME FALLBACK CHAIN (the permanent "Staff Member" fix): employee row
    -- first, then the linked profile, then email, then employee number, then
    -- a stable short-id label. Never NULL, never blank. Scalar subquery so a
    -- duplicated profile link can never multiply rows.
    coalesce(
      nullif(btrim(e.full_name), ''),
      (select nullif(btrim(pf.full_name), '')
         from public.profiles pf
        where pf.employee_id = e.id
          and nullif(btrim(pf.full_name), '') is not null
        limit 1),
      nullif(btrim(e.email), ''),
      nullif(btrim(e.employee_number), ''),
      'Staff ' || left(e.id::text, 8)
    ) as full_name,
    e.employee_number, e.position, e.department,
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
  'Live positions v3 + name fallback: full_name is a COALESCE chain (employees -> linked profile -> email -> employee_number -> short-id) so the server never returns a blank name and no client renders "Staff Member" for a real employee.';
