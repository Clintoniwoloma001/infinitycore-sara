-- ============================================================
-- Phase — Terminal geofence linking + cross-branch HR review
-- Run in Supabase SQL Editor after 20260921000019. Idempotent/additive.
--
-- WHAT THIS ADDS
--   1. attendance_devices can pin an explicit attendance geofence
--      (geofence_id, FK -> attendance_geofences), OR define a standalone
--      custom centre (custom_lat / custom_lng / radius_meters). The old
--      location_id column is kept as legacy (reading helpers coalesce).
--      attendance_devices.branch_id (text) now conventionally stores the
--      branch uuid of the physical terminal.
--   2. The public terminal gate enforces the terminal's own geofence range
--      BEFORE any record is written: out-of-range scans fail with
--      OUT_OF_BOUNDS and no attendance row is created.
--   3. Cross-branch clock-ins: when the terminal's branch differs from the
--      employee's assigned branch (and the employee is NOT an area manager),
--      the clock-in is recorded + an attendance_records row is flagged
--      hr_review_status='PENDING_REVIEW', clocked_in_branch_id captured, and
--      a terminal_review_message is returned on success.
--   4. New RPCs: list_attendance_hr_reviews (read-only) and
--      review_attendance_hr_record (approve / flag_query -> employee query +
--      notification). Both role-gated.
-- ============================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. COLUMNS
-- ---------------------------------------------------------------------------
alter table public.attendance_devices
  add column if not exists geofence_id uuid references public.attendance_geofences(id) on delete set null,
  add column if not exists custom_lat numeric(10, 7),
  add column if not exists custom_lng numeric(10, 7),
  add column if not exists radius_meters integer default 150;

comment on column public.attendance_devices.branch_id is
  'Text column. Convention: a branch UUID (as text) of the physical terminal branch.';

alter table public.attendance_records
  add column if not exists hr_review_status text not null default 'NONE',
  add column if not exists hr_reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists hr_reviewed_at timestamptz,
  add column if not exists hr_review_comment text,
  add column if not exists hr_query_note text,
  add column if not exists clocked_in_branch_id uuid references public.branches(id) on delete set null,
  add column if not exists terminal_geofence_distance float;

alter table public.attendance_records
  drop constraint if exists attendance_records_hr_review_status_check;
alter table public.attendance_records
  add constraint attendance_records_hr_review_status_check
  check (hr_review_status in ('NONE', 'PENDING_REVIEW', 'APPROVED', 'FLAGGED_QUERY_ISSUED'));

create index if not exists ix_attendance_records_hr_review_status
  on public.attendance_records (hr_review_status, clock_in desc);

-- ---------------------------------------------------------------------------
-- 2. HELPER: resolve a terminal's effective geofence
--    Custom centre wins; otherwise the linked geofence (new geofence_id or
--    legacy location_id). Returns NULL coords when nothing is configured so
--    the caller can skip enforcement. SECURITY DEFINER so anon/authenticated
--    callers (via the public gates) can read device + geofence rows.
-- ---------------------------------------------------------------------------
create or replace function public._terminal_geofence(p_device_id uuid)
returns table (
  geofence_id uuid,
  lat double precision,
  lng double precision,
  radius integer,
  label text,
  branch_id text
)
language sql stable security definer
set search_path = public, extensions
as $$
  select
    coalesce(d.geofence_id, d.location_id)::uuid as geofence_id,
    coalesce(d.custom_lat, g.latitude)::double precision as lat,
    coalesce(d.custom_lng, g.longitude)::double precision as lng,
    coalesce(d.radius_meters, g.radius_meters, 150)::integer as radius,
    coalesce(nullif(g.location_name, ''), nullif(g.name, ''), d.device_name) as label,
    g.branch_id::text as branch_id
  from public.attendance_devices d
  left join public.attendance_geofences g on g.id = coalesce(d.geofence_id, d.location_id)
  where d.id = p_device_id;
$$;

revoke all on function public._terminal_geofence(uuid) from public;

-- ---------------------------------------------------------------------------
-- 3. attendance_validate_location: add override + soft-outside support
--    Two NEW trailing params (backward compatible, positional callers
--    unaffected):
--      p_geofence_override uuid  — when set, only THAT geofence is evaluated
--                                  (used by terminal-gated scans; the
--                                  terminal geofence is authority).
--      p_allow_outside boolean   — when true, being inside nothing does NOT
--                                  raise OUTSIDE_GEOFENCE / GEOFENCE_NOT_CONFIGURED;
--                                  the caller (terminal gate) has already
--                                  satisfied its own range check.
-- ---------------------------------------------------------------------------
drop function if exists public.attendance_validate_location(uuid, float, float, text, uuid, uuid, boolean);

create or replace function public.attendance_validate_location(
  p_employee_id uuid,
  p_lat float,
  p_lng float,
  p_action text,
  p_branch_id uuid default null,
  p_geofence_override uuid default null,
  p_allow_outside boolean default false
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

  if not v_has_location and not p_allow_outside then
    raise exception 'GEOFENCE_NOT_CONFIGURED:No approved attendance location is configured. Contact HR before clocking in or out.';
  end if;
  if v_best_distance is null and not p_allow_outside then
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

-- ---------------------------------------------------------------------------
-- 4. Clock in / out: thread the new override params through.
--    Signature extension is trailing-only (existing callers unaffected).
-- ---------------------------------------------------------------------------
create or replace function public.attendance_clock_in_for_employee(
  p_employee_id uuid,
  p_lat float,
  p_lng float,
  p_accuracy float,
  p_source text default 'web',
  p_device_id uuid default null,
  p_verification_method text default 'GPS',
  p_source_detail text default 'WEB',
  p_geofence_override uuid default null,
  p_allow_outside boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee record;
  v_settings record;
  v_location jsonb;
  v_now timestamptz := clock_timestamp();
  v_today date;
  v_work_start time;
  v_grace integer;
  v_late integer;
  v_record record;
  v_event_id uuid;
  v_actual_geofence_id uuid;
  v_distance float;
begin
  select * into v_employee from public.employees where id = p_employee_id limit 1;
  if not found then raise exception 'Employee record not found.'; end if;
  if v_employee.employment_status is distinct from 'active' then
    raise exception '%', format('Employee is %s and cannot clock in or out.', coalesce(v_employee.employment_status, 'inactive'));
  end if;

  select * into v_settings from public.hr_platform_settings where id = 1 limit 1;
  v_today := (v_now at time zone public.att_app_timezone())::date;
  if exists (
    select 1 from public.attendance_records
     where employee_id = p_employee_id and attendance_date = v_today
  ) then
    raise exception 'Attendance has already been recorded for this employee today.';
  end if;

  v_location := public.attendance_validate_location(p_employee_id, p_lat, p_lng, 'clock_in', null, p_geofence_override, p_allow_outside);
  v_work_start := (v_location ->> 'work_start_time')::time;
  v_grace := (v_location ->> 'grace_period_minutes')::integer;
  v_late := greatest(0, round(extract(epoch from ((v_now at time zone public.att_app_timezone())::time - v_work_start)) / 60.0 - v_grace))::integer;
  v_distance := nullif(v_location ->> 'distance', '')::float;
  v_actual_geofence_id := nullif(v_location ->> 'actual_geofence_id', '')::uuid;

  insert into public.attendance_records (
    employee_id, attendance_date, source, source_detail, status,
    clock_in_lat, clock_in_lng, clock_in_accuracy, clock_in_distance,
    geofence_id, geofence_distance, geofence_status, location_status,
    verification_method, late_status, late_minutes, branch_id, device_id
  ) values (
    p_employee_id, v_today, lower(coalesce(p_source, 'web')), upper(coalesce(p_source_detail, 'WEB')),
    case when v_late > 0 then 'late' else 'present' end,
    p_lat, p_lng, p_accuracy, v_distance,
    v_actual_geofence_id, v_distance, v_location ->> 'geofence_status', v_location ->> 'location_status',
    coalesce(nullif(p_verification_method, ''), 'GPS'), v_late > 0, v_late,
    nullif(v_location ->> 'assigned_branch_id', '')::uuid, p_device_id
  ) returning * into v_record;

  insert into public.attendance_events (
    employee_id, user_id, attendance_record_id, event_type, event_time,
    source, device_id, geofence_id, geofence_distance, location_status,
    verification_method, verification_status, latitude, longitude,
    late_status, late_minutes, metadata
  ) values (
    p_employee_id, v_employee.user_id, v_record.id, 'CLOCK_IN', v_record.clock_in,
    upper(coalesce(p_source_detail, 'WEB')), p_device_id, v_actual_geofence_id, v_distance,
    v_location ->> 'location_status', coalesce(nullif(p_verification_method, ''), 'GPS'),
    case when v_location ->> 'geofence_status' = 'inside' then 'verified' else 'unverified' end,
    p_lat, p_lng, v_late > 0, v_late,
    jsonb_build_object(
      'assigned_branch_id', v_location ->> 'assigned_branch_id',
      'assigned_branch_name', v_location ->> 'assigned_branch_name',
      'actual_branch_id', v_location ->> 'actual_branch_id',
      'actual_geofence_id', v_location ->> 'actual_geofence_id',
      'actual_location_name', v_location ->> 'actual_location_name',
      'actual_location_type', v_location ->> 'actual_location_type',
      'location_difference', (v_location ->> 'location_difference')::boolean,
      'nearest_location_name', v_location ->> 'nearest_location_name',
      'captured_at', v_record.clock_in,
      'success', true
    )
  ) returning id into v_event_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_CLOCK_IN', 'AttendanceRecord', v_record.id::text,
    coalesce((select full_name from public.profiles where id = v_employee.user_id), v_employee.full_name, 'Attendance Terminal'),
    jsonb_build_object('module', 'attendance', 'event_id', v_event_id, 'actual_location', v_location, 'success', true)::text,
    'info'
  );

  return jsonb_build_object(
    'ok', true, 'success', true, 'attendance_id', v_record.id,
    'clock_in_at', v_record.clock_in, 'server_time', v_record.clock_in,
    'late_minutes', v_late, 'status', v_record.status,
    'assigned_branch_name', v_location ->> 'assigned_branch_name',
    'actual_location_name', v_location ->> 'actual_location_name',
    'actual_geofence_id', v_location ->> 'actual_geofence_id',
    'location_difference', (v_location ->> 'location_difference')::boolean,
    'geofence_status', v_location ->> 'geofence_status',
    'location_status', v_location ->> 'location_status', 'event_id', v_event_id
  );
end;
$$;

create or replace function public.attendance_clock_out_for_employee(
  p_employee_id uuid,
  p_attendance_id uuid,
  p_lat float,
  p_lng float,
  p_accuracy float,
  p_source text default 'web',
  p_device_id uuid default null,
  p_verification_method text default 'GPS',
  p_source_detail text default 'WEB',
  p_geofence_override uuid default null,
  p_allow_outside boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee record;
  v_settings record;
  v_record record;
  v_location jsonb;
  v_clock_out timestamptz;
  v_work_end time;
  v_total integer;
  v_early integer;
  v_event_id uuid;
  v_actual_geofence_id uuid;
  v_distance float;
begin
  select * into v_employee from public.employees where id = p_employee_id limit 1;
  if not found then raise exception 'Employee record not found.'; end if;
  select * into v_record from public.attendance_records where id = p_attendance_id for update;
  if not found then raise exception 'Attendance record not found.'; end if;
  if v_record.employee_id <> p_employee_id then raise exception 'You can only clock out of your own attendance session.'; end if;
  if v_record.clock_out is not null then
    return jsonb_build_object(
      'ok', true, 'success', true, 'attendance_id', v_record.id,
      'already_clocked_out', true, 'clock_out_at', v_record.clock_out,
      'work_hours', v_record.work_hours, 'total_minutes', v_record.total_minutes
    );
  end if;

  select * into v_settings from public.hr_platform_settings where id = 1 limit 1;
  v_location := public.attendance_validate_location(p_employee_id, p_lat, p_lng, 'clock_out', v_record.branch_id, p_geofence_override, p_allow_outside);
  v_distance := nullif(v_location ->> 'distance', '')::float;
  v_actual_geofence_id := nullif(v_location ->> 'actual_geofence_id', '')::uuid;

  perform set_config('app.correcting_attendance', 'on', true);
  update public.attendance_records
     set clock_out = clock_timestamp(),
         clock_out_lat = p_lat,
         clock_out_lng = p_lng,
         clock_out_accuracy = p_accuracy,
         clock_out_distance = v_distance,
         geofence_id = v_actual_geofence_id,
         geofence_distance = v_distance,
         geofence_status = v_location ->> 'geofence_status',
         location_status = v_location ->> 'location_status',
         verification_method = coalesce(nullif(p_verification_method, ''), 'GPS'),
         device_id = coalesce(p_device_id, device_id)
   where id = p_attendance_id;
  perform set_config('app.correcting_attendance', 'off', true);

  select * into v_record from public.attendance_records where id = p_attendance_id;
  v_clock_out := v_record.clock_out;
  v_total := greatest(0, round(extract(epoch from (v_clock_out - v_record.clock_in)) / 60.0))::integer;
  v_work_end := (v_location ->> 'work_end_time')::time;
  v_early := greatest(0, round(extract(epoch from (v_work_end - (v_clock_out at time zone public.att_app_timezone())::time)) / 60.0))::integer;

  update public.attendance_records
     set total_minutes = v_total,
         work_hours = round(v_total::numeric / 60.0, 2),
         early_departure_minutes = v_early,
         status = case
           when coalesce(v_record.late_minutes, 0) > 0 then 'late'
           when v_early > coalesce(v_settings.early_departure_threshold_minutes, 0) then 'early_exit'
           else 'present'
         end
   where id = p_attendance_id;

  insert into public.attendance_events (
    employee_id, user_id, attendance_record_id, event_type, event_time,
    source, device_id, geofence_id, geofence_distance, location_status,
    verification_method, verification_status, latitude, longitude,
    late_minutes, early_departure_minutes, metadata
  ) values (
    p_employee_id, v_employee.user_id, p_attendance_id, 'CLOCK_OUT', v_clock_out,
    upper(coalesce(p_source_detail, 'WEB')), p_device_id, v_actual_geofence_id, v_distance,
    v_location ->> 'location_status', coalesce(nullif(p_verification_method, ''), 'GPS'),
    case when v_location ->> 'geofence_status' = 'inside' then 'verified' else 'unverified' end,
    p_lat, p_lng, v_record.late_minutes, v_early,
    jsonb_build_object(
      'assigned_branch_id', v_location ->> 'assigned_branch_id',
      'assigned_branch_name', v_location ->> 'assigned_branch_name',
      'actual_branch_id', v_location ->> 'actual_branch_id',
      'actual_geofence_id', v_location ->> 'actual_geofence_id',
      'actual_location_name', v_location ->> 'actual_location_name',
      'actual_location_type', v_location ->> 'actual_location_type',
      'location_difference', (v_location ->> 'location_difference')::boolean,
      'nearest_location_name', v_location ->> 'nearest_location_name',
      'captured_at', v_clock_out,
      'success', true
    )
  ) returning id into v_event_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_CLOCK_OUT', 'AttendanceRecord', p_attendance_id::text,
    coalesce((select full_name from public.profiles where id = v_employee.user_id), v_employee.full_name, 'Attendance Terminal'),
    jsonb_build_object(
      'module', 'attendance', 'event_id', v_event_id, 'work_minutes', v_total,
      'work_hours', round(v_total::numeric / 60.0, 2), 'actual_location', v_location,
      'success', true
    )::text,
    'info'
  );

  return jsonb_build_object(
    'ok', true, 'success', true, 'attendance_id', p_attendance_id,
    'clock_out_at', v_clock_out, 'server_time', v_clock_out,
    'total_minutes', v_total, 'work_hours', round(v_total::numeric / 60.0, 2),
    'early_departure_minutes', v_early,
    'assigned_branch_name', v_location ->> 'assigned_branch_name',
    'actual_location_name', v_location ->> 'actual_location_name',
    'location_difference', (v_location ->> 'location_difference')::boolean,
    'geofence_status', v_location ->> 'geofence_status',
    'location_status', v_location ->> 'location_status', 'event_id', v_event_id
  );
exception
  when others then
    perform set_config('app.correcting_attendance', 'off', true);
    raise;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. PUBLIC TERMINAL GATE: validate_attendance_terminal_location
--    Enforces the terminal's own geofence range (OUT_OF_BOUNDS) and feeds the
--    override through so a scan inside the terminal geofence never hard-fails
--    against unrelated branch geofences.
-- ---------------------------------------------------------------------------
create or replace function public.validate_attendance_terminal_location(
  p_token text, p_employee_identifier text, p_lat float, p_lng float, p_event_type text
) returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_terminal record; v_employee_id uuid; v_location jsonb;
  v_gf record; v_terminal_distance float;
  v_override uuid; v_allow_outside boolean := false;
begin
  if p_event_type not in ('CLOCK_IN', 'CLOCK_OUT') then
    return jsonb_build_object('valid', false, 'error', 'Choose Clock In or Clock Out.');
  end if;
  select * into v_terminal from public.attendance_terminal_for_token(p_token);
  if not found or v_terminal.status is distinct from 'active' or coalesce(v_terminal.active, false) = false then
    return jsonb_build_object('valid', false, 'error', case
      when not found then 'This attendance terminal link is invalid or revoked.'
      when v_terminal.status = 'suspended' then 'This terminal is temporarily suspended. Contact HR if you believe this is a mistake.'
      else 'This attendance terminal link is invalid or revoked.'
    end);
  end if;
  v_employee_id := public.resolve_attendance_terminal_employee(p_employee_identifier);
  if v_employee_id is null then return jsonb_build_object('valid', false, 'error', 'Employee number or email could not be verified.'); end if;

  select * into v_gf from public._terminal_geofence(v_terminal.id);
  if p_event_type = 'CLOCK_IN' and v_gf.lat is not null and v_gf.lng is not null then
    v_terminal_distance := public.geo_distance(p_lat, p_lng, v_gf.lat, v_gf.lng);
    if v_terminal_distance is null or v_terminal_distance > v_gf.radius then
      return jsonb_build_object(
        'valid', false,
        'error', 'OUT_OF_BOUNDS:Out of bounds error: You must be within range of the terminal to clock in.',
        'terminal_geofence_distance', v_terminal_distance,
        'terminal_geofence_radius', v_gf.radius,
        'terminal_location_name', v_gf.label
      );
    end if;
    v_override := v_gf.geofence_id;
    v_allow_outside := v_gf.geofence_id is not null;
  end if;

  v_location := public.attendance_validate_location(v_employee_id, p_lat, p_lng,
    case when p_event_type = 'CLOCK_OUT' then 'clock_out' else 'clock_in' end, null,
    v_override, v_allow_outside);
  return jsonb_build_object('valid', true) || v_location
    || jsonb_build_object('terminal_geofence_distance', v_terminal_distance);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. PUBLIC TERMINAL GATE: clock_attendance_terminal
--    Re-issued from 20260921000016 with the geofence + cross-branch review
--    engine. Out-of-range scans never create an attendance record.
-- ---------------------------------------------------------------------------
create or replace function public.clock_attendance_terminal(
  p_token text, p_employee_identifier text, p_event_type text,
  p_lat float, p_lng float, p_accuracy float, p_device_fingerprint text
) returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_device public.attendance_devices%rowtype; v_employee_id uuid; v_open_attendance_id uuid;
  v_result jsonb; v_identifier_hash text; v_attempts integer;
  v_bind jsonb; v_bound_employee public.employees%rowtype; v_bound_name text; v_bound_code text;
  v_hr_user record;
  v_gf record; v_terminal_distance float; v_override uuid; v_allow_outside boolean := false;
  v_re_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_terminal_branch_id uuid; v_terminal_branch_name text; v_assigned_branch_id uuid; v_assigned_branch_name text;
  v_emp record; v_is_area_manager boolean := false; v_review_note text;
  v_attendance_id uuid;
begin
  if p_event_type not in ('CLOCK_IN', 'CLOCK_OUT') then return jsonb_build_object('success', false, 'error', 'Choose Clock In or Clock Out.'); end if;
  if trim(coalesce(p_employee_identifier, '')) = '' then return jsonb_build_object('success', false, 'error', 'Enter your employee number or email.'); end if;
  if p_lat is null or p_lng is null then return jsonb_build_object('success', false, 'error', 'LOCATION_REQUIRED:Location is required to record attendance. Please enable location access.'); end if;

  select * into v_device from public.attendance_devices
   where device_type = 'attendance_terminal'
     and public.attendance_terminal_token_matches(device_token, p_token)
   limit 1;
  if not found then return jsonb_build_object('success', false, 'error', 'This attendance terminal link is invalid or revoked.'); end if;
  if v_device.status = 'suspended' then
    return jsonb_build_object('success', false, 'error', 'This terminal is temporarily suspended. Contact HR if you believe this is a mistake.');
  end if;
  if v_device.status is distinct from 'active' or v_device.active is not true then
    return jsonb_build_object('success', false, 'error', 'This attendance terminal link is invalid or revoked.');
  end if;

  v_identifier_hash := encode(extensions.digest(convert_to(upper(trim(p_employee_identifier)), 'UTF8'), 'sha256'), 'hex');
  select count(*) into v_attempts from public.attendance_terminal_attempts
   where terminal_id = v_device.id and identifier_hash = v_identifier_hash
     and attempted_at > clock_timestamp() - interval '5 minutes';
  if v_attempts >= 10 then return jsonb_build_object('success', false, 'error', 'Too many attempts. Please wait and try again.'); end if;
  insert into public.attendance_terminal_attempts (terminal_id, identifier_hash) values (v_device.id, v_identifier_hash);
  v_employee_id := public.resolve_attendance_terminal_employee(p_employee_identifier);
  if v_employee_id is null then return jsonb_build_object('success', false, 'error', 'Employee not found. Check the Employee ID or work email and try again.'); end if;

  v_bind := public.attendance_device_binding_check(p_device_fingerprint, v_employee_id, p_event_type);
  if (v_bind ->> 'allowed')::boolean = false then
    select * into v_bound_employee from public.employees where id = (v_bind ->> 'bound_to')::uuid;
    v_bound_name := coalesce(v_bound_employee.full_name, v_bind ->> 'bound_to', 'another employee');
    v_bound_code := coalesce(v_bound_employee.employee_code, v_bound_employee.employee_number, v_bound_employee.staff_id, '—');

    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'ATTENDANCE_DEVICE_BINDING_BLOCKED', 'AttendanceDevice', v_device.id::text,
      'attendance-terminal',
      jsonb_build_object(
        'module', 'attendance', 'terminal_id', v_device.id,
        'event_type', p_event_type,
        'attempted_employee', coalesce(
          (select e.full_name from public.employees e where e.id = v_employee_id),
          p_employee_identifier
        ),
        'bound_employee', v_bound_name,
        'bound_employee_code', v_bound_code,
        'binding_date', v_bind ->> 'date',
        'scope', 'device_day'
      )::text,
      'warning'
    );

    for v_hr_user in
      select p.id as user_id
        from public.profiles p
       where p.role in ('head_of_human_resources', 'hr_officer')
    loop
      insert into public.notifications (user_id, title, message, link, type, read)
      values (
        v_hr_user.user_id,
        'Attendance Integrity Violation',
        format('Device at terminal %s was used to attempt %s for %s while bound to %s (%s).',
               coalesce(v_device.device_name, v_device.id::text),
               p_event_type,
               coalesce((select e.full_name from public.employees e where e.id = v_employee_id), 'an unknown employee'),
               v_bound_name, v_bound_code),
        '#/attendance-management',
        'attendance_integrity',
        false
      );
    end loop;

    return jsonb_build_object(
      'success', false,
      'error', format(
        'DEVICE_BINDING:Integrity issue — this device is registered to %s, Employee Code %s. You attempted to clock in for someone else. Your action has been logged and sent to HR for review. You may be contacted. No staff is permitted to clock in on behalf of another employee — the system is designed to detect this.',
        v_bound_name, v_bound_code
      ),
      'device_binding_blocked', true,
      'bound_employee_name', v_bound_name,
      'bound_employee_code', v_bound_code
    );
  end if;

  -- Terminal geofence + cross-branch review engine (clock-in path).
  if p_event_type = 'CLOCK_IN' then
    select * into v_gf from public._terminal_geofence(v_device.id);
    if v_gf.lat is not null and v_gf.lng is not null then
      v_terminal_distance := public.geo_distance(p_lat, p_lng, v_gf.lat, v_gf.lng);
      if v_terminal_distance is null or v_terminal_distance > v_gf.radius then
        return jsonb_build_object(
          'success', false,
          'error', 'OUT_OF_BOUNDS:Out of bounds error: You must be within range of the terminal to clock in.',
          'terminal_geofence_distance', v_terminal_distance,
          'terminal_geofence_radius', v_gf.radius,
          'terminal_location_name', v_gf.label
        );
      end if;
      v_override := v_gf.geofence_id;
      v_allow_outside := v_gf.geofence_id is not null;
    end if;
  end if;

  if p_event_type = 'CLOCK_IN' then
    v_result := public.attendance_clock_in_for_employee(v_employee_id, p_lat, p_lng, p_accuracy, 'terminal', v_device.id, 'GPS', 'ATTENDANCE_TERMINAL', v_override, v_allow_outside);
    v_attendance_id := (v_result ->> 'attendance_id')::uuid;
    if v_attendance_id is not null then
      perform public.attendance_device_bind(p_device_fingerprint, v_employee_id, v_device.id);

      if v_terminal_distance is not null then
        update public.attendance_records
           set terminal_geofence_distance = v_terminal_distance
         where id = v_attendance_id;
      end if;

      -- Resolve the terminal's physical branch, then the employee's assigned branch.
      if v_device.branch_id ~ v_re_uuid then
        select b.id, b.branch_name into v_terminal_branch_id, v_terminal_branch_name
          from public.branches b
         where b.id = v_device.branch_id::uuid
         limit 1;
      end if;
      if v_terminal_branch_id is null and v_gf.branch_id ~ v_re_uuid then
        select b.id, b.branch_name into v_terminal_branch_id, v_terminal_branch_name
          from public.branches b
         where b.id = v_gf.branch_id::uuid
         limit 1;
      end if;

      select e.id, e.full_name, e.user_id, e.branch as employee_branch, e.branch_id into v_emp
        from public.employees e where e.id = v_employee_id limit 1;

      select b.id, b.branch_name into v_assigned_branch_id, v_assigned_branch_name
        from public.branches b
       where b.id = v_emp.branch_id
          or (v_emp.branch_id is null and nullif(trim(v_emp.employee_branch), '') is not null
              and (lower(b.branch_name) = lower(trim(v_emp.employee_branch))
                   or lower(coalesce(b.branch_code, '')) = lower(trim(v_emp.employee_branch))))
       order by case when b.id = v_emp.branch_id then 0 else 1 end
       limit 1;

      if v_terminal_branch_id is not null
         and v_assigned_branch_id is not null
         and v_terminal_branch_id <> v_assigned_branch_id then
        select count(*) > 0 into v_is_area_manager from public.get_area_manager_area_branches(v_employee_id) b;
        if not v_is_area_manager then
          update public.attendance_records
             set hr_review_status = 'PENDING_REVIEW',
                 clocked_in_branch_id = v_terminal_branch_id
           where id = v_attendance_id;
          v_review_note := format(
            'Clock-In Allowed. You are clocking in from %s, but your original branch is %s. This entry has been sent for HR review.',
            coalesce(v_terminal_branch_name, 'another Infinity Bank location'),
            coalesce(v_assigned_branch_name, 'your assigned branch'));
        end if;
      end if;
    end if;
  else
    select id into v_open_attendance_id from public.attendance_records
     where employee_id = v_employee_id and attendance_date = (clock_timestamp() at time zone public.att_app_timezone())::date
       and clock_out is null order by clock_in desc limit 1;
    if v_open_attendance_id is null then return jsonb_build_object('success', false, 'error', 'You cannot clock out before clocking in today.'); end if;
    v_result := public.attendance_clock_out_for_employee(v_employee_id, v_open_attendance_id, p_lat, p_lng, p_accuracy, 'terminal', v_device.id, 'GPS', 'ATTENDANCE_TERMINAL');
  end if;
  update public.attendance_devices set last_seen_at = clock_timestamp() where id = v_device.id;
  v_result := v_result || jsonb_build_object('success', true, 'terminal_id', v_device.id, 'public_terminal', true);
  if v_review_note is not null then
    v_result := v_result || jsonb_build_object(
      'terminal_review_message', v_review_note,
      'hr_review_status', 'PENDING_REVIEW',
      'clocked_in_branch', v_terminal_branch_name);
  end if;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. HR REVIEW RPCs
-- ---------------------------------------------------------------------------
create or replace function public.list_attendance_hr_reviews(p_status text default 'PENDING_REVIEW')
returns table (
  record_id uuid,
  employee_id uuid,
  employee_name text,
  employee_number text,
  original_branch_name text,
  clocked_in_branch_name text,
  terminal_name text,
  clock_in_at timestamptz,
  hr_review_status text,
  hr_query_note text,
  hr_reviewed_at timestamptz,
  hr_review_comment text,
  terminal_geofence_distance float
)
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_status text := coalesce(p_status, 'PENDING_REVIEW');
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'branch_manager') then
    raise exception 'You are not authorized to view attendance HR reviews.';
  end if;
  if v_status not in ('PENDING_REVIEW', 'APPROVED', 'FLAGGED_QUERY_ISSUED', 'ALL') then
    raise exception 'Invalid review status filter.';
  end if;

  if v_status = 'ALL' then
    return query
      select ar.id, ar.employee_id,
             coalesce(e.full_name, p.full_name, 'Unknown') as employee_name,
             coalesce(e.employee_number, e.employee_code, e.staff_id, e.id::text) as employee_number,
             ob.branch_name as original_branch_name,
             cb.branch_name as clocked_in_branch_name,
             coalesce(d.device_name, '—') as terminal_name,
             ar.clock_in, ar.hr_review_status, ar.hr_query_note, ar.hr_reviewed_at,
             ar.hr_review_comment, ar.terminal_geofence_distance
        from public.attendance_records ar
        left join public.employees e on e.id = ar.employee_id
        left join public.profiles p on p.employee_id = e.id
        left join public.branches ob on ob.id = ar.branch_id
        left join public.branches cb on cb.id = ar.clocked_in_branch_id
        left join public.attendance_devices d on d.id = ar.device_id
       where ar.hr_review_status <> 'NONE'
       order by ar.clock_in desc
       limit 200;
  else
    return query
      select ar.id, ar.employee_id,
             coalesce(e.full_name, p.full_name, 'Unknown') as employee_name,
             coalesce(e.employee_number, e.employee_code, e.staff_id, e.id::text) as employee_number,
             ob.branch_name as original_branch_name,
             cb.branch_name as clocked_in_branch_name,
             coalesce(d.device_name, '—') as terminal_name,
             ar.clock_in, ar.hr_review_status, ar.hr_query_note, ar.hr_reviewed_at,
             ar.hr_review_comment, ar.terminal_geofence_distance
        from public.attendance_records ar
        left join public.employees e on e.id = ar.employee_id
        left join public.profiles p on p.employee_id = e.id
        left join public.branches ob on ob.id = ar.branch_id
        left join public.branches cb on cb.id = ar.clocked_in_branch_id
        left join public.attendance_devices d on d.id = ar.device_id
       where ar.hr_review_status = v_status
       order by ar.clock_in desc
       limit 200;
  end if;
end;
$$;

create or replace function public.review_attendance_hr_record(
  p_record_id uuid,
  p_action text,
  p_comment text default null
) returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_record public.attendance_records%rowtype;
  v_emp public.employees%rowtype;
  v_query_id uuid;
  v_att_date date;
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'branch_manager') then
    raise exception 'You are not authorized to review attendance records.';
  end if;
  select * into v_record from public.attendance_records where id = p_record_id for update;
  if not found then raise exception 'Attendance record not found.'; end if;
  if v_record.hr_review_status not in ('PENDING_REVIEW', 'FLAGGED_QUERY_ISSUED') then
    raise exception 'This attendance record is not awaiting review.';
  end if;
  p_action := lower(trim(coalesce(p_action, '')));
  if p_action not in ('approved', 'flag_query') then
    raise exception 'Invalid review action. Use approved or flag_query.';
  end if;

  v_att_date := (v_record.clock_in at time zone public.att_app_timezone())::date;

  if p_action = 'approved' then
    update public.attendance_records
       set hr_review_status = 'APPROVED',
           hr_reviewed_by = auth.uid(),
           hr_reviewed_at = clock_timestamp(),
           hr_review_comment = coalesce(nullif(trim(coalesce(p_comment, '')), ''), hr_review_comment)
     where id = p_record_id;
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'ATTENDANCE_HR_REVIEW_APPROVED', 'AttendanceRecord', p_record_id::text,
      coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
      jsonb_build_object('module', 'attendance', 'action', 'approved', 'attendance_date', v_att_date)::text,
      'info'
    );
    return jsonb_build_object('ok', true, 'action', 'approved', 'record_id', p_record_id, 'status', 'APPROVED');
  end if;

  -- flag_query
  if nullif(trim(coalesce(p_comment, '')), '') is null or length(trim(p_comment)) < 5 then
    raise exception 'A query note of at least 5 characters is required when flagging an attendance record.';
  end if;
  select * into v_emp from public.employees where id = v_record.employee_id limit 1;
  if v_emp.user_id is null then
    raise exception 'The employee has no linked account, so a query cannot be raised. Approve the record instead or have the employee linked first.';
  end if;

  update public.attendance_records
     set hr_review_status = 'FLAGGED_QUERY_ISSUED',
         hr_query_note = trim(p_comment),
         hr_reviewed_by = auth.uid(),
         hr_reviewed_at = clock_timestamp()
   where id = p_record_id;

  insert into public.employee_queries (employee_id, user_id, subject, category, description, status, priority, assigned_to)
  values (
    v_record.employee_id, v_emp.user_id,
    format('Your %s attendance clock-in requires clarification', v_att_date),
    'attendance', trim(p_comment), 'open', 'normal', v_emp.user_id
  ) returning id into v_query_id;

  insert into public.notifications (user_id, title, message, link, type, read)
  values (
    v_emp.user_id,
    'Action Required: Attendance Query',
    format('HR has raised a query about your %s clock-in. Please review the query and respond.', v_att_date),
    '#/my-queries', 'attendance_review', false
  );

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_HR_REVIEW_QUERY', 'AttendanceRecord', p_record_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    jsonb_build_object(
      'module', 'attendance', 'action', 'flag_query', 'attendance_date', v_att_date,
      'query_id', v_query_id, 'query_note', trim(p_comment)
    )::text,
    'warning'
  );

  return jsonb_build_object(
    'ok', true, 'action', 'flag_query', 'record_id', p_record_id,
    'status', 'FLAGGED_QUERY_ISSUED', 'query_id', v_query_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. GRANTS
-- ---------------------------------------------------------------------------
revoke all on function public.attendance_validate_location(uuid, float, float, text, uuid, uuid, boolean) from public;
grant execute on function public.attendance_validate_location(uuid, float, float, text, uuid, uuid, boolean) to authenticated;

revoke all on function public.attendance_clock_in_for_employee(uuid, float, float, float, text, uuid, text, text, uuid, boolean) from public, anon, authenticated;
revoke all on function public.attendance_clock_out_for_employee(uuid, uuid, float, float, float, text, uuid, text, text, uuid, boolean) from public, anon, authenticated;

grant execute on function public.validate_attendance_terminal_location(text, text, float, float, text) to anon, authenticated;
grant execute on function public.clock_attendance_terminal(text, text, text, float, float, float, text) to anon, authenticated;
grant execute on function public.list_attendance_hr_reviews(text) to authenticated;
grant execute on function public.review_attendance_hr_record(uuid, text, text) to authenticated;

commit;