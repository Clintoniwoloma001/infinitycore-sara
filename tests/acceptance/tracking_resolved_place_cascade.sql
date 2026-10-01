-- ============================================================================
-- Employee Tracking — resolved place + label cascade
--
-- Verifies the migration against a real PostgreSQL with the exact geometry that
-- produced the reported bug:
--
--   HEAD OFFICE  6.605829, 3.392538  radius 20 m
--   Ogudu GRA    6.579477, 3.381569   -> ~9.2 km away, therefore OUTSIDE
--
-- The two cases that must never be confused:
--   * an observation genuinely inside the head office geofence, and
--   * an observation ~9.2 km away that was previously labelled "HEAD OFFICE".
--
-- Run: docker exec -i <pg> psql -U postgres -d postgres < this file
-- ============================================================================
begin;

-- Minimal prerequisites: only what the functions under test touch.
create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  name text not null
);

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  full_name text,
  timezone text default 'Africa/Lagos'
);

-- profiles exists without timezone in this database; employee_location_history
-- reads p.timezone, so the column must exist for the read path to work.
alter table public.profiles add column if not exists timezone text;

-- profiles.id references auth.users in the real schema. auth is not available
-- here, so the same constraint is satisfied by this stand-in table. Without it
-- the profile fixture is rejected by the foreign key.
create table if not exists public.users (
  id uuid primary key default gen_random_uuid()
);

create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  full_name text not null,
  employee_number text,
  position text,
  department text,
  branch_id uuid references public.branches(id) on delete set null
);

create table if not exists public.attendance_geofences (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  location_name text,
  latitude numeric(10, 7) not null,
  longitude numeric(10, 7) not null,
  radius_meters integer not null default 150,
  active boolean not null default true
);

alter table public.attendance_geofences
  add column if not exists name text,
  add column if not exists active boolean not null default true;

create table if not exists public.employee_location_events (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  latitude numeric(10, 7) not null,
  longitude numeric(10, 7) not null,
  accuracy numeric(10, 2),
  recorded_at timestamptz not null default now(),
  uploaded_at timestamptz not null default now(),
  source text not null default 'mobile',
  device_id text,
  detected_branch_id uuid references public.branches(id) on delete set null,
  location_label text,
  inside_geofence boolean not null default false,
  distance_meters numeric(12, 2),
  -- Added by migration 20260929000003; the cascade reads and writes these.
  nearest_location_name text,
  nearest_distance numeric(12, 2),
  nearest_radius numeric(12, 2),
  created_at timestamptz not null default now()
);

-- The table may already exist from an earlier run or migration, in which case
-- `create table if not exists` is a no-op and these adds supply the columns.
alter table public.employee_location_events
  add column if not exists nearest_location_name text,
  add column if not exists nearest_distance numeric(12, 2),
  add column if not exists nearest_radius numeric(12, 2),
  add column if not exists resolved_place text;

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  action text, entity_type text, entity_id text, user_name text,
  details text, severity text, created_at timestamptz not null default now()
);

-- The geofence authority, copied verbatim from the real migration so this test
-- exercises the same maths rather than a simplification of it.
create or replace function public.resolve_employee_location(
  p_latitude float,
  p_longitude float,
  p_source text default null,
  p_employee_id uuid default null
) returns jsonb
language plpgsql
immutable
as $$
declare
  v_best_id uuid;
  v_best_name text;
  v_best_distance float;
  v_nearest_id uuid;
  v_nearest_name text;
  v_nearest_distance float;
  v_nearest_radius float;
  v_inside boolean := false;
begin
  -- One place for the haversine so the maths is stated once and the two
  -- selects below cannot drift apart.
  with d as (
    select g.id, g.location_name, g.radius_meters::float as radius,
           6371000 * 2 * asin(sqrt(
             power(sin(radians(g.latitude::float - p_latitude) / 2), 2)
             + cos(radians(p_latitude)) * cos(radians(g.latitude::float))
             * power(sin(radians(g.longitude::float - p_longitude) / 2), 2)
           )) as dist
      from public.attendance_geofences g
     where g.active
  ),
  inside_hit as (
    select * from d where dist <= radius order by dist asc limit 1
  ),
  nearest_hit as (
    select * from d order by dist asc limit 1
  )
  select inside_hit.id, inside_hit.location_name, inside_hit.dist,
         nearest_hit.id, nearest_hit.location_name, nearest_hit.dist,
         nearest_hit.radius
    into v_best_id, v_best_name, v_best_distance,
         v_nearest_id, v_nearest_name, v_nearest_distance, v_nearest_radius
    from nearest_hit
    left join inside_hit on true;

  -- A point is inside only when a fence was actually matched.
  v_inside := v_best_id is not null;

  return jsonb_build_object(
    'inside', v_inside,
    'geofence_id', v_best_id,
    'location_name', v_best_name,
    'distance_meters', round(coalesce(v_best_distance, v_nearest_distance)::numeric, 2),
    'radius_meters', v_nearest_radius,
    -- These three keys are what the cascade migration reads back out, so the
    -- stub must expose exactly the names the real function uses.
    'nearest_location_name', v_nearest_name,
    'nearest_distance', round(v_nearest_distance::numeric, 2),
    'nearest_radius', v_nearest_radius,
    'human_label', case
      when v_best_name is not null then v_best_name
      when v_nearest_name is not null then v_nearest_name
      else 'Outside registered locations'
    end,
    'outside_label', case
      when v_best_name is not null then v_best_name
      when v_nearest_name is null then 'Outside registered locations'
      when v_nearest_distance >= 1000 then
        'Outside ' || v_nearest_name || ' ('
        || trim(trailing '.' from trim(trailing '0' from
             round(v_nearest_distance / 1000.0)::text)) || ' km away)'
      else 'Outside ' || v_nearest_name || ' ('
        || round(v_nearest_distance)::text || ' m away)'
    end);
end;
$$;

-- Only employee_tracking_access() is needed by the history function under test.
-- The real gate is asserted separately by employeeTrackingGeofenceAndMap.
create or replace function public.employee_tracking_access(p_employee_id uuid)
returns jsonb language sql stable as $$
  select jsonb_build_object('allowed', true, 'reason', 'test');
$$;

\echo '--- applying the migration under test ---'
\i supabase/migrations/20261101000003_tracking_resolved_place_and_label_cascade.sql

-- ============================================================================
-- FIXTURE: one head-office fence, one employee, three observations
--   INSIDE   - a few metres from the fence centre  -> must stay "HEAD OFFICE"
--   OUTSIDE  - the reported Ogudu GRA coordinates  -> must NOT read HEAD OFFICE
--   ALREADY  - an honest label from 20260929000003 -> must not be touched
--
-- The delete makes this file safely re-runnable: everything runs inside the
-- transaction opened at the top, which is rolled back at the end, so a failed
-- earlier run can never poison the next one.
-- ============================================================================
\echo '--- seeding ---'

delete from public.employee_location_events
 where id in (
   '55555555-0000-0000-0000-000000000001',
   '55555555-0000-0000-0000-000000000002',
   '55555555-0000-0000-0000-000000000003'
 );
delete from public.employees
 where id = '44444444-4444-4444-4444-444444444444';
delete from public.profiles
 where id in ('33333333-3333-3333-3333-333333333333',
              '66666666-6666-6666-6666-666666666666');
delete from public.attendance_geofences
 where id = '22222222-2222-2222-2222-222222222222';
delete from public.branches
 where id = '11111111-1111-1111-1111-111111111111';

-- Satisfy the profiles -> users foreign key before inserting the profiles.
insert into public.users (id) values
  ('33333333-3333-3333-3333-333333333333'),
  ('66666666-6666-6666-6666-666666666666')
on conflict (id) do nothing;

insert into public.branches (id, branch_name)
values ('11111111-1111-1111-1111-111111111111', 'Head Office');

insert into public.attendance_geofences
  (id, name, location_name, latitude, longitude, radius_meters, active)
values
  ('22222222-2222-2222-2222-222222222222', 'HEAD OFFICE', 'HEAD OFFICE',
   6.605829, 3.392538, 20, true);

insert into public.profiles (id, full_name, timezone)
values ('33333333-3333-3333-3333-333333333333', 'Test Officer', 'Africa/Lagos');

insert into public.employees
  (id, user_id, full_name, employee_number, position, department, branch_id)
values (
  '44444444-4444-4444-4444-444444444444',
  '33333333-3333-3333-3333-333333333333',
  'Adebayo Test', 'INF/HR/001', 'HR Officer', 'Human Resources',
  '11111111-1111-1111-1111-111111111111'
);

insert into public.employee_location_events
  (id, employee_id, latitude, longitude, recorded_at, location_label, inside_geofence)
values
  -- genuinely inside the 20 m fence
  ('55555555-0000-0000-0000-000000000001', '44444444-4444-4444-4444-444444444444',
   6.605829, 3.392538, now() - interval '3 hours', 'HEAD OFFICE', true),
  -- THE REPORTED ROW: ~9.2 km away but labelled HEAD OFFICE
  ('55555555-0000-0000-0000-000000000002', '44444444-4444-4444-4444-444444444444',
   6.579477, 3.381569, now() - interval '2 hours', 'HEAD OFFICE', false),
  -- already honest, from the previous migration
  ('55555555-0000-0000-0000-000000000003', '44444444-4444-4444-4444-444444444444',
   6.579000, 3.381000, now() - interval '1 hour',
   'Outside HEAD OFFICE (9 km away)', false);

-- ============================================================================
-- 1 & 2. The reported row is repaired AND states the real separation
-- ============================================================================
\echo '--- 1. the outside row no longer claims to be at HEAD OFFICE ---'
select case when location_label like 'Outside HEAD OFFICE%'
              then 'PASS' else 'FAIL: ' || coalesce(location_label, 'NULL') end as outside_row_repaired
  from public.employee_location_events
 where id = '55555555-0000-0000-0000-000000000002';

\echo '--- 2. the repaired label states the distance ---'
select case when location_label ~ '\(\d+(\.\d+)? (m|km) away\)'
              then 'PASS' else 'FAIL: ' || coalesce(location_label, 'NULL') end as distance_stated
  from public.employee_location_events
 where id = '55555555-0000-0000-0000-000000000002';

-- ============================================================================
-- 3. A genuinely inside row is untouched
-- ============================================================================
\echo '--- 3. an inside row keeps its registered location ---'
select case when location_label = 'HEAD OFFICE' and inside_geofence
              then 'PASS' else 'FAIL: ' || coalesce(location_label, 'NULL') end as inside_row_untouched
  from public.employee_location_events
 where id = '55555555-0000-0000-0000-000000000001';

-- ============================================================================
-- 4. Idempotency: a second run must change nothing
-- ============================================================================
\echo '--- 4. the cascade is idempotent ---'
create temporary table before_labels as
  select id, location_label from public.employee_location_events;

\i supabase/migrations/20261101000003_tracking_resolved_place_and_label_cascade.sql

select case when count(*) = 0 then 'PASS'
            else 'FAIL: ' || count(*) || ' row(s) changed on re-run' end as idempotent
  from public.employee_location_events le
  join before_labels b using (id)
 where coalesce(le.location_label, '') is distinct from b.location_label;

-- ============================================================================
-- 5. The write-back stores a place but cannot move a point inside a fence
-- ============================================================================
\echo '--- 5. set_employee_location_resolved_place cannot change the verdict ---'
select set_config('request.jwt.claims',
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);

select case when public.set_employee_location_resolved_place(
                 '55555555-0000-0000-0000-000000000002', 'Ogudu GRA Estate')
       then 'PASS' else 'FAIL: write-back refused for the owner' end as writeback_accepted;

select case
         when resolved_place = 'Ogudu GRA Estate' then 'PASS'
         else 'FAIL: ' || coalesce(resolved_place, 'NULL') end as place_stored
  from public.employee_location_events
 where id = '55555555-0000-0000-0000-000000000002';

select case
         when inside_geofence = false and location_label like 'Outside HEAD OFFICE%'
         then 'PASS'
         else 'FAIL: a display label moved the verdict' end as verdict_unchanged_by_writeback
  from public.employee_location_events
 where id = '55555555-0000-0000-0000-000000000002';

-- ============================================================================
-- 6. A caller who does not own the row is refused
-- ============================================================================
\echo '--- 6. another account cannot write a place on a row it does not own ---'
insert into public.profiles (id, full_name)
values ('66666666-6666-6666-6666-666666666666', 'Someone Else');

select set_config('request.jwt.claims',
  '{"sub":"66666666-6666-6666-6666-666666666666","role":"authenticated"}', true);

select case when public.set_employee_location_resolved_place(
                 '55555555-0000-0000-0000-000000000002', 'Spoofed Place') = false
       then 'PASS' else 'FAIL: a stranger wrote the place' end as stranger_refused;

select case when resolved_place = 'Ogudu GRA Estate'
       then 'PASS' else 'FAIL: the place was overwritten' end as place_not_overwritten
  from public.employee_location_events
 where id = '55555555-0000-0000-0000-000000000002';

-- ============================================================================
-- 7 & 8. Both read surfaces serve the place
-- ============================================================================
\echo '--- 7. history serves resolved_place ---'
select case when exists (
    select 1 from jsonb_array_elements(
      public.employee_location_history(
        '44444444-4444-4444-4444-444444444444',
        (now() at time zone 'Africa/Lagos')::date
      ) -> 'points'
  ) p
    where p ->> 'resolved_place' = 'Ogudu GRA Estate'
) then 'PASS' else 'FAIL: history did not serve resolved_place' end as history_serves_place;

\echo '--- 8. live positions serve resolved_place ---'
select case when exists (
    select 1 from jsonb_array_elements(
      public.employee_current_locations(null, null, 240)
    ) p
    where p ->> 'resolved_place' = 'Ogudu GRA Estate'
) then 'PASS' else 'FAIL: live locations did not serve resolved_place' end as live_serves_place;

rollback;