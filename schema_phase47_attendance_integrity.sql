-- ============================================================
-- PHASE 47 - ATTENDANCE TIME + BRANCH GEOFENCE INTEGRITY
--
-- Adds server time for the live clock and makes the branch geofence in
-- Platform Settings the only authoritative location policy for attendance.
-- Web and terminal clocking both pass through the same server validation.
--
-- Idempotent / safe to re-run.
-- ============================================================

-- Phase 31 normally supplies these two objects. Keep this migration safe on
-- environments that have the attendance tables but missed that additive step.
-- Attendance is fixed to Africa/Lagos (GMT+1), with no daylight-saving shift.
alter table public.hr_platform_settings
  add column if not exists app_timezone text default 'Africa/Lagos';

create or replace function public.att_app_timezone()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select 'Africa/Lagos';
$$;

-- ------------------------------------------------------------
-- 1. Server time for client clocks
-- ------------------------------------------------------------
create or replace function public.get_attendance_network_time()
returns timestamptz
language sql
security definer
set search_path = public
as $$
  select clock_timestamp();
$$;

revoke all on function public.get_attendance_network_time() from public;
grant execute on function public.get_attendance_network_time() to authenticated;

-- Include the Platform Settings default radius in the client policy payload.
create or replace function public.get_attendance_requirements()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_settings record;
begin
  select * into v_settings from public.hr_platform_settings where id = 1 limit 1;
  return jsonb_build_object(
    'require_gps_clock_in', coalesce(v_settings.require_gps_clock_in, true),
    'require_gps_clock_out', coalesce(v_settings.require_gps_clock_out, true),
    'geofence_enabled', coalesce(v_settings.geofence_enabled, true),
    'default_geofence_radius', coalesce(v_settings.default_geofence_radius, 150),
    'late_threshold_minutes', coalesce(v_settings.late_threshold_minutes, 15),
    'early_departure_threshold_minutes', coalesce(v_settings.early_departure_threshold_minutes, 30),
    'default_work_start_time', coalesce(v_settings.default_work_start_time, '08:00')::text,
    'default_work_end_time', coalesce(v_settings.default_work_end_time, '17:00')::text,
    'default_grace_period_minutes', coalesce(v_settings.default_grace_period_minutes, 15),
    'app_timezone', 'Africa/Lagos'
  );
end;
$$;

grant execute on function public.get_attendance_requirements() to authenticated;

-- ------------------------------------------------------------
-- 2. Shared, authoritative branch geofence validation
--
-- Platform Settings stores the branch coordinates, active flag, and radius
-- on public.branches. The global geofence_enabled setting controls whether
-- those branch settings are enforced. When enforcement is enabled, an
-- unconfigured branch is rejected rather than silently bypassing GPS.
-- ------------------------------------------------------------
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
  v_branch public.branches%rowtype;
  v_settings record;
  v_geofence_enabled boolean;
  v_require_gps boolean;
  v_distance float;
  v_radius numeric;
  v_status text := 'no_geofence';
  v_branch_id uuid;
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

  v_geofence_enabled := coalesce(v_settings.geofence_enabled, true);
  v_require_gps := case when p_action = 'clock_out'
    then coalesce(v_settings.require_gps_clock_out, true)
    else coalesce(v_settings.require_gps_clock_in, true)
  end;

  -- Clock-out uses the branch stored on the attendance row. Clock-in uses
  -- the employee's current branch ID, with the legacy branch name as a
  -- fallback for older employee records.
  if p_branch_id is not null then
    select * into v_branch from public.branches where id = p_branch_id limit 1;
  elsif v_employee.branch_id is not null then
    select * into v_branch from public.branches where id = v_employee.branch_id limit 1;
  elsif nullif(trim(v_employee.branch), '') is not null then
    select * into v_branch
      from public.branches
     where lower(branch_name) = lower(trim(v_employee.branch))
        or lower(coalesce(branch_code, '')) = lower(trim(v_employee.branch))
     order by case when lower(branch_name) = lower(trim(v_employee.branch)) then 0 else 1 end
     limit 1;
  end if;

  if v_geofence_enabled then
    if v_branch.id is null
       or coalesce(v_branch.geofence_active, false) is not true
       or v_branch.latitude is null
       or v_branch.longitude is null then
      raise exception 'GEOFENCE_NOT_CONFIGURED:Your branch geofence is not configured. Contact HR before clocking in or out.';
    end if;

    if p_lat is null or p_lng is null then
      raise exception 'LOCATION_REQUIRED:Location is required to verify your bank or branch attendance location. Please enable location access.';
    end if;
  elsif v_require_gps and (p_lat is null or p_lng is null) then
    raise exception 'LOCATION_REQUIRED:Location is required to clock in or out. Please enable location access.';
  end if;

  if p_lat is not null and (p_lat < -90 or p_lat > 90) then
    raise exception 'LOCATION_INVALID:Your device returned an invalid location. Please try again.';
  end if;
  if p_lng is not null and (p_lng < -180 or p_lng > 180) then
    raise exception 'LOCATION_INVALID:Your device returned an invalid location. Please try again.';
  end if;

  if v_geofence_enabled then
    v_radius := greatest(1, coalesce(v_branch.geofence_radius, v_settings.default_geofence_radius, 150));
    v_distance := public.geo_distance(p_lat, p_lng, v_branch.latitude, v_branch.longitude);
    if v_distance > v_radius then
      raise exception 'OUTSIDE_GEOFENCE:Not within bank or branch allowed clocking radius.';
    end if;
    v_status := 'inside';
    v_branch_id := v_branch.id;
  elsif v_branch.id is not null and coalesce(v_branch.geofence_active, false)
        and v_branch.latitude is not null and v_branch.longitude is not null then
    -- Location may still be captured while global enforcement is disabled,
    -- but the disabled Platform Settings policy remains authoritative.
    v_branch_id := v_branch.id;
    v_status := 'disabled';
    if p_lat is not null and p_lng is not null then
      v_radius := greatest(1, coalesce(v_branch.geofence_radius, v_settings.default_geofence_radius, 150));
      v_distance := public.geo_distance(p_lat, p_lng, v_branch.latitude, v_branch.longitude);
    end if;
  end if;

  return jsonb_build_object(
    'branch_id', v_branch_id,
    'distance', v_distance,
    'radius', v_radius,
    'geofence_status', v_status,
    'work_start_time', coalesce(v_branch.work_start_time, v_settings.default_work_start_time, '08:00')::text,
    'work_end_time', coalesce(v_branch.work_end_time, v_settings.default_work_end_time, '17:00')::text,
    'grace_period_minutes', coalesce(v_branch.grace_period_minutes, v_settings.default_grace_period_minutes, 15)
  );
end;
$$;

revoke all on function public.attendance_validate_location(uuid, float, float, text, uuid) from public;

-- ------------------------------------------------------------
-- 3. Web clock-in: server time + Platform Settings branch geofence
-- ------------------------------------------------------------
create or replace function public.clock_in_secure(
  p_lat float,
  p_lng float,
  p_accuracy float default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee record;
  v_settings record;
  v_location jsonb;
  v_tz text := public.att_app_timezone();
  v_clock_in_at timestamptz := clock_timestamp();
  v_today date;
  v_work_start time;
  v_grace int;
  v_late_min int;
  v_attendance_id uuid;
  v_stored_clock_in timestamptz;
  v_branch_id uuid;
  v_distance float;
  v_geofence text;
begin
  select * into v_employee
    from public.employees
   where user_id = auth.uid()
   limit 1;

  if not found then
    raise exception 'No employee profile is linked to your account.';
  end if;
  if v_employee.employment_status is distinct from 'active' then
    raise exception 'Your employee profile is not active and cannot clock in.';
  end if;

  v_today := (v_clock_in_at at time zone v_tz)::date;
  if exists (
    select 1 from public.attendance_records
     where employee_id = v_employee.id
       and attendance_date = v_today
       and clock_out is null
  ) then
    raise exception 'You have already clocked in today.';
  end if;

  select * into v_settings from public.hr_platform_settings where id = 1 limit 1;
  v_location := public.attendance_validate_location(
    v_employee.id, p_lat, p_lng, 'clock_in', v_employee.branch_id
  );
  v_branch_id := nullif(v_location ->> 'branch_id', '')::uuid;
  v_distance := nullif(v_location ->> 'distance', '')::float;
  v_geofence := coalesce(v_location ->> 'geofence_status', 'no_geofence');
  v_work_start := coalesce((v_location ->> 'work_start_time')::time, v_settings.default_work_start_time, '08:00');
  v_grace := coalesce((v_location ->> 'grace_period_minutes')::int, v_settings.default_grace_period_minutes, 15);
  v_late_min := greatest(0,
    round(extract(epoch from ((v_clock_in_at at time zone v_tz)::time - v_work_start)) / 60.0 - v_grace)
  )::int;

  insert into public.attendance_records (
    employee_id, attendance_date, source, source_detail, status,
    clock_in_lat, clock_in_lng, clock_in_accuracy, clock_in_distance,
    geofence_distance, geofence_status, location_status, verification_method,
    late_status, late_minutes, branch_id
  ) values (
    v_employee.id, v_today, 'web', 'WEB', case when v_late_min > 0 then 'late' else 'present' end,
    p_lat, p_lng, p_accuracy, v_distance,
    v_distance, v_geofence, case when v_geofence = 'inside' then 'inside' else 'unknown' end,
    case when p_lat is not null and p_lng is not null then 'GPS' else 'NONE' end,
    v_late_min > 0, v_late_min, v_branch_id
  )
  returning id, clock_in into v_attendance_id, v_stored_clock_in;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_CLOCK_IN', 'AttendanceRecord', v_attendance_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    format('Clock-in. Geofence: %s. Distance: %s m. Late by %s min. Timezone: %s.', v_geofence, coalesce(round(v_distance), 0), v_late_min, v_tz),
    'info'
  );

  return jsonb_build_object(
    'ok', true,
    'attendance_id', v_attendance_id,
    'clock_in_at', v_stored_clock_in,
    'server_time', v_stored_clock_in,
    'branch_id', v_branch_id,
    'geofence_status', v_geofence,
    'distance', v_distance,
    'radius', v_location -> 'radius',
    'late_minutes', v_late_min,
    'status', case when v_late_min > 0 then 'late' else 'present' end
  );
end;
$$;

grant execute on function public.clock_in_secure(float, float, float) to authenticated;

-- ------------------------------------------------------------
-- 4. Web clock-out: same branch geofence authority
-- ------------------------------------------------------------
create or replace function public.clock_out_secure(
  p_attendance_id uuid,
  p_lat float,
  p_lng float,
  p_accuracy float default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_record record;
  v_employee record;
  v_settings record;
  v_location jsonb;
  v_tz text := public.att_app_timezone();
  v_clock_out_at timestamptz := clock_timestamp();
  v_work_end time;
  v_early_min int := 0;
  v_total_min int;
  v_distance float;
  v_geofence text;
begin
  select * into v_employee
    from public.employees
   where user_id = auth.uid()
   limit 1;
  if not found then
    raise exception 'No employee profile is linked to your account.';
  end if;

  select * into v_record from public.attendance_records where id = p_attendance_id;
  if not found then
    raise exception 'Attendance record not found.';
  end if;
  if v_record.employee_id <> v_employee.id then
    raise exception 'You can only clock out of your own attendance session.';
  end if;
  if v_record.clock_out is not null then
    return jsonb_build_object(
      'ok', true,
      'attendance_id', p_attendance_id,
      'already_clocked_out', true,
      'clock_out_at', v_record.clock_out,
      'server_time', v_record.clock_out,
      'work_hours', v_record.work_hours,
      'total_minutes', v_record.total_minutes,
      'early_departure_minutes', v_record.early_departure_minutes
    );
  end if;

  select * into v_settings from public.hr_platform_settings where id = 1 limit 1;
  v_location := public.attendance_validate_location(
    v_employee.id, p_lat, p_lng, 'clock_out', v_record.branch_id
  );
  v_distance := nullif(v_location ->> 'distance', '')::float;
  v_geofence := coalesce(v_location ->> 'geofence_status', 'no_geofence');
  v_work_end := coalesce((v_location ->> 'work_end_time')::time, v_settings.default_work_end_time, '17:00');

  update public.attendance_records
     set clock_out = v_clock_out_at,
         clock_out_lat = p_lat,
         clock_out_lng = p_lng,
         clock_out_accuracy = p_accuracy,
         clock_out_distance = v_distance,
         geofence_distance = v_distance,
         geofence_status = v_geofence,
         location_status = case when v_geofence = 'inside' then 'inside' else 'unknown' end,
         verification_method = case when p_lat is not null and p_lng is not null then 'GPS' else 'NONE' end
   where id = p_attendance_id;

  -- The normal trigger is server-authoritative too. Read the stored value so
  -- the response and audit use exactly what the database recorded.
  select clock_out into v_clock_out_at from public.attendance_records where id = p_attendance_id;
  v_total_min := greatest(0, round(extract(epoch from (v_clock_out_at - v_record.clock_in)) / 60.0)::int);
  v_early_min := greatest(0,
    round(extract(epoch from (v_work_end - (v_clock_out_at at time zone v_tz)::time)) / 60.0)
  )::int;

  update public.attendance_records
     set total_minutes = v_total_min,
         work_hours = round(v_total_min::numeric / 60.0, 2),
         early_departure_minutes = v_early_min
   where id = p_attendance_id;

  if v_early_min > coalesce(v_settings.early_departure_threshold_minutes, 30)
     and coalesce(v_record.late_minutes, 0) = 0 then
    update public.attendance_records set status = 'early_exit' where id = p_attendance_id;
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_CLOCK_OUT', 'AttendanceRecord', p_attendance_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    format('Clock-out. Geofence: %s. Worked %s min. Early departure: %s min. Timezone: %s.', v_geofence, v_total_min, v_early_min, v_tz),
    'info'
  );

  return jsonb_build_object(
    'ok', true,
    'attendance_id', p_attendance_id,
    'clock_out_at', v_clock_out_at,
    'server_time', v_clock_out_at,
    'geofence_status', v_geofence,
    'distance', v_distance,
    'total_minutes', v_total_min,
    'early_departure_minutes', v_early_min,
    'work_hours', round(v_total_min / 60.0, 2)
  );
end;
$$;

grant execute on function public.clock_out_secure(uuid, float, float, float) to authenticated;

-- ------------------------------------------------------------
-- 5. Terminal/device events: ignore device timestamps and validate GPS
--
-- Terminal coordinates are supplied in p_metadata as latitude, longitude,
-- and optionally accuracy. p_event_time is deliberately not trusted; the
-- server clock is used for date, duplicate protection, and event time.
-- ------------------------------------------------------------
create or replace function public.ingest_attendance_event(
  p_device_id uuid,
  p_external_user_id text,
  p_event_type text,
  p_event_time timestamptz default now(),
  p_verification_method text default 'FINGERPRINT',
  p_metadata jsonb default '{}'::jsonb,
  p_employee_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.attendance_devices%rowtype;
  v_biometric public.employee_biometric_identifiers%rowtype;
  v_employee public.employees%rowtype;
  v_record record;
  v_settings record;
  v_location jsonb;
  v_event_time timestamptz := clock_timestamp();
  v_event_date date;
  v_lat float;
  v_lng float;
  v_accuracy float;
  v_existing_count int;
  v_attendance_id uuid;
  v_event_id uuid;
  v_late_min int := 0;
  v_work_start time;
  v_branch_id uuid;
  v_distance float;
  v_geofence text := 'no_geofence';
  v_stored_clock_in timestamptz;
  v_stored_clock_out timestamptz;
begin
  if p_event_type not in ('CLOCK_IN', 'CLOCK_OUT', 'DEVICE_CLOCK_IN', 'DEVICE_CLOCK_OUT') then
    return jsonb_build_object('success', false, 'error', 'Unsupported attendance event type.');
  end if;

  select * into v_device from public.attendance_devices where id = p_device_id;
  if not found then
    return jsonb_build_object('success', false, 'error', 'Unknown device');
  end if;
  if v_device.status <> 'active' or not v_device.active then
    return jsonb_build_object('success', false, 'error', 'Device inactive or suspended');
  end if;

  if p_employee_id is not null then
    select * into v_employee from public.employees where id = p_employee_id;
    if not found then
      return jsonb_build_object('success', false, 'error', 'Employee ID not found. Please check the ID and try again.');
    end if;
  else
    select * into v_biometric
      from public.employee_biometric_identifiers
     where device_id = p_device_id
       and external_user_id = p_external_user_id
       and enrollment_status = 'enrolled'
       and active = true;
    if not found then
      select * into v_employee
        from public.employees
       where upper(trim(coalesce(employee_number, ''))) = upper(trim(coalesce(p_external_user_id, '')))
          or upper(trim(coalesce(staff_id, ''))) = upper(trim(coalesce(p_external_user_id, '')))
          or upper(trim(coalesce(employee_code, ''))) = upper(trim(coalesce(p_external_user_id, '')))
       limit 1;
      if not found then
        return jsonb_build_object('success', false, 'error', 'Employee ID not found. Please check the ID and try again.');
      end if;
    else
      select * into v_employee from public.employees where id = v_biometric.employee_id;
      if not found then
        return jsonb_build_object('success', false, 'error', 'Employee ID not found. Please check the ID and try again.');
      end if;
    end if;
  end if;

  if v_employee.employment_status is distinct from 'active' then
    return jsonb_build_object('success', false, 'error', format('Employee is %s and cannot clock in or out.', coalesce(v_employee.employment_status, 'inactive')));
  end if;

  -- Metadata comes from the terminal browser. Do not accept p_event_time as
  -- an attendance timestamp because a device clock can be wrong or forged.
  v_lat := nullif(coalesce(p_metadata ->> 'latitude', p_metadata ->> 'lat'), '')::float;
  v_lng := nullif(coalesce(p_metadata ->> 'longitude', p_metadata ->> 'lng'), '')::float;
  v_accuracy := nullif(coalesce(p_metadata ->> 'accuracy', ''), '')::float;
  v_event_date := (v_event_time at time zone public.att_app_timezone())::date;

  select count(*) into v_existing_count
    from public.attendance_events
   where employee_id = v_employee.id
     and event_type = p_event_type
     and event_time > v_event_time - interval '5 minutes';
  if v_existing_count > 0 then
    return jsonb_build_object('success', false, 'error', 'Duplicate event within 5 minutes');
  end if;

  if p_event_type in ('CLOCK_IN', 'DEVICE_CLOCK_IN') then
    select count(*) into v_existing_count
      from public.attendance_records
     where employee_id = v_employee.id
       and attendance_date = v_event_date
       and clock_out is null;
    if v_existing_count > 0 then
      return jsonb_build_object('success', false, 'error', 'Open attendance session already exists');
    end if;

    v_location := public.attendance_validate_location(v_employee.id, v_lat, v_lng, 'clock_in', v_employee.branch_id);
    v_branch_id := nullif(v_location ->> 'branch_id', '')::uuid;
    v_distance := nullif(v_location ->> 'distance', '')::float;
    v_geofence := coalesce(v_location ->> 'geofence_status', 'no_geofence');
    v_work_start := (v_location ->> 'work_start_time')::time;
    select * into v_settings from public.hr_platform_settings where id = 1 limit 1;
    v_late_min := greatest(0,
      round(extract(epoch from ((v_event_time at time zone public.att_app_timezone())::time - v_work_start)) / 60.0 - coalesce((v_location ->> 'grace_period_minutes')::int, v_settings.default_grace_period_minutes, 15))
    )::int;

    insert into public.attendance_records (
      employee_id, attendance_date, source, source_detail, status,
      clock_in_lat, clock_in_lng, clock_in_accuracy, clock_in_distance,
      geofence_distance, geofence_status, location_status, verification_method,
      late_status, late_minutes, branch_id, device_id
    ) values (
      v_employee.id, v_event_date, 'fingerprint', 'FINGERPRINT', case when v_late_min > 0 then 'late' else 'present' end,
      v_lat, v_lng, v_accuracy, v_distance,
      v_distance, v_geofence, case when v_geofence = 'inside' then 'inside' else 'unknown' end,
      p_verification_method, v_late_min > 0, v_late_min, v_branch_id, p_device_id
    ) returning id, clock_in into v_attendance_id, v_stored_clock_in;
  else
    select * into v_record
      from public.attendance_records
     where employee_id = v_employee.id
       and clock_out is null
     order by clock_in desc
     limit 1;
    if not found then
      return jsonb_build_object('success', true, 'event_id', null, 'attendance_id', null,
        'employee_name', v_employee.full_name, 'already_clocked_out', true,
        'message', 'No open attendance session to close.', 'event_time', v_event_time);
    end if;

    v_location := public.attendance_validate_location(v_employee.id, v_lat, v_lng, 'clock_out', v_record.branch_id);
    v_distance := nullif(v_location ->> 'distance', '')::float;
    v_geofence := coalesce(v_location ->> 'geofence_status', 'no_geofence');
    update public.attendance_records
       set clock_out = v_event_time,
           clock_out_lat = v_lat,
           clock_out_lng = v_lng,
           clock_out_accuracy = v_accuracy,
           clock_out_distance = v_distance,
           geofence_distance = v_distance,
           geofence_status = v_geofence,
           location_status = case when v_geofence = 'inside' then 'inside' else 'unknown' end,
           verification_method = p_verification_method,
           device_id = p_device_id
     where id = v_record.id;
    select clock_out into v_stored_clock_out from public.attendance_records where id = v_record.id;
    v_attendance_id := v_record.id;
  end if;

  insert into public.attendance_events (
    employee_id, user_id, attendance_record_id, event_type, event_time,
    source, device_id, verification_method, verification_status,
    latitude, longitude, geofence_distance, location_status, metadata,
    late_minutes
  ) values (
    v_employee.id, v_employee.user_id, v_attendance_id, p_event_type, v_event_time,
    'FINGERPRINT', p_device_id, p_verification_method,
    case when v_geofence = 'inside' then 'verified' else 'bypassed' end,
    v_lat, v_lng, v_distance, case when v_geofence = 'inside' then 'inside' else 'unknown' end,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('server_time', v_event_time),
    v_late_min
  ) returning id into v_event_id;

  update public.attendance_devices set last_seen_at = v_event_time where id = p_device_id;

  return jsonb_build_object(
    'success', true,
    'event_id', v_event_id,
    'attendance_id', v_attendance_id,
    'employee_name', v_employee.full_name,
    'employee_id', v_employee.id,
    'employee_number', coalesce(v_employee.employee_number, v_employee.staff_id, v_employee.employee_code),
    'event_time', v_event_time,
    'clock_in_at', v_stored_clock_in,
    'clock_out_at', v_stored_clock_out,
    'server_time', v_event_time,
    'geofence_status', v_geofence,
    'distance', v_distance
  );
end;
$$;

grant execute on function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb, uuid) to authenticated;

-- Keep the older six-argument device API safe as well. It delegates to the
-- canonical seven-argument implementation instead of retaining a legacy
-- path that could omit the branch geofence checks.
create or replace function public.ingest_attendance_event(
  p_device_id uuid,
  p_external_user_id text,
  p_event_type text,
  p_event_time timestamptz default now(),
  p_verification_method text default 'FINGERPRINT',
  p_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.ingest_attendance_event(
    p_device_id, p_external_user_id, p_event_type, p_event_time,
    p_verification_method, p_metadata, null
  );
end;
$$;

grant execute on function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb) to authenticated;

-- An active device UUID is not an authentication credential. Do not leave the
-- terminal ingestion RPC callable anonymously, or anyone who discovers a UUID
-- could manufacture attendance events.
revoke all on function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb, uuid) from public;
revoke all on function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb) from public;
grant execute on function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb, uuid) to authenticated;
grant execute on function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb) to authenticated;

-- ------------------------------------------------------------
-- 6. Midnight reconciliation: close open sessions at 17:00 local time
-- ------------------------------------------------------------
create or replace function public.attendance_auto_clockout_close_sessions(
  p_as_of timestamptz default clock_timestamp()
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tz text := public.att_app_timezone();
  v_now timestamptz := clock_timestamp();
  v_as_of timestamptz := coalesce(p_as_of, clock_timestamp());
  v_local_today date;
  v_work_end time := time '17:00';
  v_row record;
  v_clock_out timestamptz;
  v_total_min int;
  v_closed int := 0;
  v_updated jsonb := '[]'::jsonb;
begin
  v_as_of := least(v_as_of, v_now);
  v_local_today := (v_as_of at time zone v_tz)::date;

  -- A missing manual clock-out is always recorded as 5:00 PM for that
  -- attendance date, independent of the phone, browser, or device clock.
  for v_row in
    select r.id, r.employee_id, r.attendance_date, r.clock_in, r.late_minutes
      from public.attendance_records r
     where r.clock_out is null
       and r.attendance_date is not null
       and r.attendance_date < v_local_today
     order by r.attendance_date
     for update skip locked
  loop
    v_clock_out := (v_row.attendance_date + v_work_end) at time zone v_tz;
    v_total_min := greatest(0, round(extract(epoch from (v_clock_out - v_row.clock_in)) / 60.0)::int);

    perform set_config('app.correcting_attendance', 'on', true);
    update public.attendance_records
       set clock_out = v_clock_out,
           total_minutes = v_total_min,
           work_hours = round(v_total_min::numeric / 60.0, 2),
           early_departure_minutes = 0,
           source = 'admin',
           source_detail = 'ADMIN',
           verification_method = 'NONE',
           geofence_status = coalesce(geofence_status, 'no_geofence'),
           status = case when coalesce(v_row.late_minutes, 0) > 0 then 'late' else 'present' end
     where id = v_row.id;
    perform set_config('app.correcting_attendance', 'off', true);

    insert into public.attendance_events (
      employee_id, attendance_record_id, event_type, event_time, source,
      verification_method, verification_status, late_minutes,
      early_departure_minutes, metadata
    ) values (
      v_row.employee_id, v_row.id, 'CLOCK_OUT', v_clock_out, 'ADMIN',
      'NONE', 'bypassed', v_row.late_minutes, 0,
      jsonb_build_object('auto', true, 'reason', 'No manual clock-out recorded before midnight', 'scheduled_end', '17:00')
    );

    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'ATTENDANCE_AUTO_CLOCK_OUT', 'AttendanceRecord', v_row.id::text,
      'System (auto clock-out)',
      format('Auto clock-out for attendance date %s at 17:00. Timezone: %s.', v_row.attendance_date, v_tz),
      'info'
    );

    v_closed := v_closed + 1;
    v_updated := v_updated || jsonb_build_object(
      'id', v_row.id,
      'attendance_date', v_row.attendance_date,
      'clock_out', v_clock_out,
      'work_hours', round(v_total_min::numeric / 60.0, 2)
    );
  end loop;

  return jsonb_build_object('ok', true, 'closed', v_closed, 'as_of', v_as_of, 'updated', v_updated);
exception
  when others then
    perform set_config('app.correcting_attendance', 'off', true);
    raise;
end;
$$;

revoke all on function public.attendance_auto_clockout_close_sessions(timestamptz) from public;
grant execute on function public.attendance_auto_clockout_close_sessions(timestamptz) to authenticated;

-- Register the same close operation with pg_cron when the Supabase project
-- has the extension enabled. The SPA reconciliation remains a safe fallback
-- for environments where pg_cron is not available.
do $phase47_cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (
       select 1
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'cron'
          and p.proname = 'schedule'
     ) then
    begin
      perform cron.unschedule('infinitycore-attendance-auto-clockout');
    exception when others then null;
    end;
    perform cron.schedule(
      'infinitycore-attendance-auto-clockout',
      '5 0 * * *',
      $croncmd$ select public.attendance_auto_clockout_close_sessions(); $croncmd$
    );
  end if;
end $phase47_cron$;
