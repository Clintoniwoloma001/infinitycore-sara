-- Attendance — GPS persistence + server-enforced device binding for the
-- authenticated web clock-in/out path.
--
-- Two related defects are closed here.
--
-- BUG 1 — captured GPS not guaranteed stored/rendered. The web entry points
-- (clock_in_secure / clock_out_secure) could run legacy bodies that skipped
-- the clock_*_lat/lng columns and the attendance_events ledger, while every
-- UI read of "Clocking Location" consumes ONLY the attendance_events metadata
-- (record.clock_in_event.metadata.actual_location_name). This migration
-- re-points both web RPCs at the canonical per-channel contract
-- (attendance_clock_in_for_employee / attendance_clock_out_for_employee),
-- which ALWAYS writes clock_*_lat/lng/accuracy/distance onto the record AND an
-- attendance_events row carrying latitude/longitude + metadata
-- (actual_location_name). A fresh web clock-in therefore persists GPS in
-- both places regardless of what the deployed clock_in_secure/clock_out_secure
-- did before.
--
-- BUG 2 — buddy-punching device binding not server-enforced on the WEB path.
-- The 20260920000000 binding guards only the public QR terminal RPCs. The
-- authenticated web clock-in path accepted any authenticated employee on any
-- browser, and a crafted/direct API request that dropped the fingerprint
-- bypassed the guard entirely. The web RPCs now REQUIRE the persisted browser
-- fingerprint (random localStorage UUID + userAgent/platform composite, client
-- SHA-256 hashed via src/utils/deviceFingerprint.js), bind the device to the
-- employee for the app day on CLOCK_IN, allow the same employee to re-use it
-- (rescan), and REJECT a different employee with a clear message. The
-- un-fingerprinted signatures are DROPPED (not overloaded) so no unguarded
-- web entry point can ever be reached.
--
-- Policy matches 20260920000000's terminal model exactly:
--   * fingerprint required (missing/empty -> blocked, storage guidance given)
--   * CLOCK_IN  binds device -> employee for the app day
--   * CLOCK_OUT requires the fingerprint; blocked only when the device is
--     bound today to a different employee (no binding is created on clock-out)
--   * same employee -> always allowed (attendance_insert_rules still guards
--     the session)
--   * HR/admin override: clear_attendance_device_binding() from
--     20260920000000, unchanged.
--
-- The binding store + policy helpers from 20260920000000 are redeclared here
-- (idempotent) so this migration is self-sufficient regardless of deployment
-- order. Apply via the Supabase SQL Editor after 20260920000000.

-- ---------------------------------------------------------------------------
-- 1. BINDING STORE (server-written only; no anon/auth RLS path)
-- ---------------------------------------------------------------------------
create table if not exists public.attendance_device_bindings (
  device_fingerprint_hash text not null,
  binding_date date not null,
  employee_id uuid not null references public.employees(id) on delete cascade,
  terminal_id uuid references public.attendance_devices(id) on delete cascade,
  first_used_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  primary key (device_fingerprint_hash, binding_date)
);

create index if not exists idx_attendance_device_bindings_date_employee
  on public.attendance_device_bindings(binding_date, employee_id);

create index if not exists idx_attendance_device_bindings_terminal
  on public.attendance_device_bindings(terminal_id);

alter table public.attendance_device_bindings enable row level security;
revoke all on public.attendance_device_bindings from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. INTERNAL POLICY HELPERS (server-only; never granted to anon/authenticated)
-- ---------------------------------------------------------------------------
create or replace function public.attendance_device_binding_hash(p_fingerprint text)
returns text
language sql immutable security definer
set search_path = public, extensions
as $$
  select encode(extensions.digest(convert_to(coalesce(nullif(p_fingerprint, ''), ''), 'UTF8'), 'sha256'), 'hex');
$$;

create or replace function public.attendance_device_binding_check(
  p_fingerprint text, p_employee_id uuid, p_event_type text
) returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
  v_today date;
  v_binding public.attendance_device_bindings%rowtype;
begin
  if p_event_type not in ('CLOCK_IN', 'CLOCK_OUT') then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_event', 'error', 'Choose Clock In or Clock Out.');
  end if;
  if coalesce(p_fingerprint, '') = '' then
    return jsonb_build_object(
      'allowed', false, 'reason', 'missing_fingerprint',
      'error', 'DEVICE_BINDING:This device could not be associated with an employee today. Enable browser storage and camera access, then try again.'
    );
  end if;
  v_hash := public.attendance_device_binding_hash(p_fingerprint);
  v_today := (clock_timestamp() at time zone public.att_app_timezone())::date;

  select * into v_binding
    from public.attendance_device_bindings
   where device_fingerprint_hash = v_hash
     and binding_date = v_today
   limit 1;

  if not found then
    return jsonb_build_object(
      'allowed', true, 'reason', 'unbound',
      'bind_required', p_event_type = 'CLOCK_IN',
      'hash', v_hash, 'date', v_today
    );
  end if;

  if v_binding.employee_id = p_employee_id then
    update public.attendance_device_bindings
       set last_seen_at = clock_timestamp()
     where device_fingerprint_hash = v_hash
       and binding_date = v_today;
    return jsonb_build_object(
      'allowed', true, 'reason', 'same_employee', 'bound', true,
      'hash', v_hash, 'date', v_today
    );
  end if;

  return jsonb_build_object(
    'allowed', false, 'reason', 'conflict',
    'bound_to', v_binding.employee_id, 'hash', v_hash, 'date', v_today
  );
end;
$$;

create or replace function public.attendance_device_bind(
  p_fingerprint text, p_employee_id uuid, p_terminal_id uuid
) returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
  v_today date;
begin
  v_hash := public.attendance_device_binding_hash(p_fingerprint);
  v_today := (clock_timestamp() at time zone public.att_app_timezone())::date;
  insert into public.attendance_device_bindings (
    device_fingerprint_hash, binding_date, employee_id, terminal_id
  ) values (v_hash, v_today, p_employee_id, p_terminal_id)
  on conflict (device_fingerprint_hash, binding_date)
  do update set
    employee_id = excluded.employee_id,
    terminal_id = coalesce(excluded.terminal_id, attendance_device_bindings.terminal_id),
    last_seen_at = clock_timestamp();
  return jsonb_build_object('ok', true, 'hash', v_hash, 'date', v_today);
end;
$$;

revoke all on function public.attendance_device_binding_hash(text) from public, anon, authenticated;
revoke all on function public.attendance_device_binding_check(text, uuid, text) from public, anon, authenticated;
revoke all on function public.attendance_device_bind(text, uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. CANONICAL PER-CHANNEL CLOCK RPCs (record GPS + attendance_events ledger)
--    Verbatim from schema_migration_attendance_management_completion.sql so a
--    web/terminal/device clock-in always writes both the record columns and an
--    event carrying metadata.actual_location_name — the only source the UI
--    reads for "Clocking Location".
-- ---------------------------------------------------------------------------
create or replace function public.attendance_clock_in_for_employee(
  p_employee_id uuid,
  p_lat float,
  p_lng float,
  p_accuracy float,
  p_source text default 'web',
  p_device_id uuid default null,
  p_verification_method text default 'GPS',
  p_source_detail text default 'WEB'
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

  v_location := public.attendance_validate_location(p_employee_id, p_lat, p_lng, 'clock_in', null);
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
  p_source_detail text default 'WEB'
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
  v_location := public.attendance_validate_location(p_employee_id, p_lat, p_lng, 'clock_out', v_record.branch_id);
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
-- 4. GUARDED WEB RPCs (device binding enforced server-side)
--    The un-fingerprinted signatures are DROPPED so a crafted request that
--    drops the fingerprint cannot reach an unguarded function.
-- ---------------------------------------------------------------------------

drop function if exists public.clock_in_secure(float, float, float);

create or replace function public.clock_in_secure(
  p_lat float,
  p_lng float,
  p_accuracy float default null,
  p_device_fingerprint text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee_id uuid;
  v_bind jsonb;
  v_result jsonb;
  v_bound_name text;
begin
  select id into v_employee_id from public.employees where user_id = auth.uid() limit 1;
  if v_employee_id is null then raise exception 'No employee profile is linked to your account.'; end if;

  -- Server-enforced web device binding. Empty/missing fingerprint -> blocked.
  v_bind := public.attendance_device_binding_check(p_device_fingerprint, v_employee_id, 'CLOCK_IN');
  if (v_bind ->> 'allowed')::boolean = false then
    select e.full_name into v_bound_name from public.employees e where e.id = (v_bind ->> 'bound_to')::uuid;
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'ATTENDANCE_DEVICE_BINDING_BLOCKED', 'AttendanceDeviceBinding',
      coalesce(v_bind ->> 'hash', ''),
      coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
      jsonb_build_object(
        'module', 'attendance', 'channel', 'web', 'event_type', 'CLOCK_IN',
        'attempted_employee', (select full_name from public.employees where id = v_employee_id),
        'bound_employee', v_bound_name,
        'binding_date', v_bind ->> 'date',
        'reason', v_bind ->> 'reason'
      )::text,
      'warning'
    );
    raise exception '%', coalesce(
      nullif(v_bind ->> 'error', ''),
      'DEVICE_BINDING:This device is already registered to another employee. Contact HR/Admin to reassign it.'
    );
  end if;

  v_result := public.attendance_clock_in_for_employee(v_employee_id, p_lat, p_lng, p_accuracy, 'web', null, 'GPS', 'WEB');

  -- Persist the day's device->employee binding only after the clock-in record
  -- exists. Same-employee re-use already refreshed last_seen in the check.
  if (v_bind ->> 'reason') is distinct from 'same_employee' then
    perform public.attendance_device_bind(p_device_fingerprint, v_employee_id, null);
  end if;
  return v_result;
end;
$$;

drop function if exists public.clock_out_secure(uuid, float, float, float);

create or replace function public.clock_out_secure(
  p_attendance_id uuid,
  p_lat float,
  p_lng float,
  p_accuracy float default null,
  p_device_fingerprint text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee_id uuid;
  v_record public.attendance_records%rowtype;
  v_today date := (clock_timestamp() at time zone public.att_app_timezone())::date;
  v_bind jsonb;
  v_bound_name text;
begin
  select id into v_employee_id
    from public.employees
   where user_id = auth.uid()
   limit 1;
  if v_employee_id is null then
    raise exception 'No employee profile is linked to your account.';
  end if;

  -- Server-enforced web device binding on clock-out: the same employee may
  -- clock out of the day's session; a device bound today to a different
  -- employee is blocked (the device belongs to its day-bound employee).
  v_bind := public.attendance_device_binding_check(p_device_fingerprint, v_employee_id, 'CLOCK_OUT');
  if (v_bind ->> 'allowed')::boolean = false then
    select e.full_name into v_bound_name from public.employees e where e.id = (v_bind ->> 'bound_to')::uuid;
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'ATTENDANCE_DEVICE_BINDING_BLOCKED', 'AttendanceDeviceBinding',
      coalesce(v_bind ->> 'hash', ''),
      coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
      jsonb_build_object(
        'module', 'attendance', 'channel', 'web', 'event_type', 'CLOCK_OUT',
        'attempted_employee', (select full_name from public.employees where id = v_employee_id),
        'bound_employee', v_bound_name,
        'binding_date', v_bind ->> 'date',
        'reason', v_bind ->> 'reason'
      )::text,
      'warning'
    );
    raise exception '%', coalesce(
      nullif(v_bind ->> 'error', ''),
      'DEVICE_BINDING:This device is already registered to another employee. Contact HR/Admin to reassign it.'
    );
  end if;

  select * into v_record
    from public.attendance_records
   where id = p_attendance_id
   for update;
  if not found or v_record.employee_id <> v_employee_id then
    raise exception 'No open attendance session was found for your account.';
  end if;
  if v_record.attendance_date <> v_today then
    raise exception 'You can only clock out of today''s open attendance session.';
  end if;
  if v_record.clock_in is null then
    raise exception 'You cannot clock out before clocking in.';
  end if;
  if v_record.clock_out is not null then
    raise exception 'You have already clocked out today.';
  end if;

  return public.attendance_clock_out_for_employee(v_employee_id, p_attendance_id, p_lat, p_lng, p_accuracy, 'web', null, 'GPS', 'WEB');
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. GRAANTS — only the guarded web RPCs are callable by authenticated.
--    The arbitrary-UUID helpers, the legacy internal clock-out, and the
--    unguarded web signatures are locked down.
-- ---------------------------------------------------------------------------
revoke all on function public.attendance_clock_in_for_employee(uuid, float, float, float, text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.attendance_clock_out_for_employee(uuid, uuid, float, float, float, text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.clock_out_secure_internal(uuid, float, float, float) from public, anon, authenticated;

revoke all on function public.clock_in_secure(float, float, float, text) from public;
revoke all on function public.clock_out_secure(uuid, float, float, float, text) from public;
grant execute on function public.clock_in_secure(float, float, float, text) to authenticated;
grant execute on function public.clock_out_secure(uuid, float, float, float, text) to authenticated;