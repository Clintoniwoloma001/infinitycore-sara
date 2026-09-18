-- ============================================================================
-- Attendance Management completion and integrity repair
-- ============================================================================
-- Idempotent. Run after the existing attendance/platform migrations.
--
-- This migration does not add a second attendance model. It keeps:
--   * hr_platform_settings as the canonical global attendance policy;
--   * attendance_records as the daily attendance record;
--   * attendance_events as the per-action/location ledger;
--   * attendance_devices as the existing terminal registry.
-- ============================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- --------------------------------------------------------------------------
-- 1. Audit contract repair
--
-- audit_logs has action, entity_type, entity_id, user_name, details, severity,
-- and created_at. It does not have user_id. Keep configuration mutations
-- auditable without changing that established contract.
-- --------------------------------------------------------------------------
create or replace function public.log_attendance_config_change()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor text;
begin
  select coalesce(nullif(trim(p.full_name), ''), nullif(trim(p.email), ''))
    into v_actor
    from public.profiles p
   where p.id = auth.uid();

  insert into public.audit_logs (
    action, entity_type, entity_id, user_name, details, severity
  )
  values (
    'ATTENDANCE_CONFIG_CHANGE',
    'AttendanceConfig',
    new.id::text,
    coalesce(v_actor, auth.uid()::text, 'system'),
    jsonb_build_object(
      'module', 'attendance',
      'entity', 'attendance_config',
      'previous_value', to_jsonb(old),
      'new_value', to_jsonb(new),
      'changed_at', clock_timestamp(),
      'success', true
    )::text,
    'info'
  );

  return new;
end;
$$;

drop trigger if exists attendance_config_audit on public.attendance_config;
create trigger attendance_config_audit
  after update on public.attendance_config
  for each row execute function public.log_attendance_config_change();

-- --------------------------------------------------------------------------
-- 2. Platform Settings is the single global attendance policy source
-- --------------------------------------------------------------------------
create or replace function public.sync_attendance_config_from_platform()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.attendance_config
     set expected_start_time = to_char(new.default_work_start_time, 'HH24:MI'),
         expected_end_time = to_char(new.default_work_end_time, 'HH24:MI'),
         grace_period_minutes = new.default_grace_period_minutes,
         late_threshold_time = to_char(
           new.default_work_start_time
             + make_interval(mins => new.default_grace_period_minutes),
           'HH24:MI'
         ),
         working_days = new.default_working_days,
         geofence_enabled = new.geofence_enabled,
         early_departure_threshold_minutes = new.early_departure_threshold_minutes,
         break_duration_minutes = new.default_break_duration_minutes,
         overtime_threshold_hours = round(new.overtime_threshold_minutes::numeric / 60.0, 2),
         updated_at = now()
   where id = 1
     and (
       expected_start_time is distinct from to_char(new.default_work_start_time, 'HH24:MI')
       or expected_end_time is distinct from to_char(new.default_work_end_time, 'HH24:MI')
       or grace_period_minutes is distinct from new.default_grace_period_minutes
       or late_threshold_time is distinct from to_char(
         new.default_work_start_time + make_interval(mins => new.default_grace_period_minutes),
         'HH24:MI'
       )
       or working_days is distinct from new.default_working_days
       or geofence_enabled is distinct from new.geofence_enabled
       or early_departure_threshold_minutes is distinct from new.early_departure_threshold_minutes
       or break_duration_minutes is distinct from new.default_break_duration_minutes
       or overtime_threshold_hours is distinct from round(new.overtime_threshold_minutes::numeric / 60.0, 2)
     );

  return new;
end;
$$;

drop trigger if exists hr_platform_settings_attendance_sync on public.hr_platform_settings;
create trigger hr_platform_settings_attendance_sync
  after update on public.hr_platform_settings
  for each row execute function public.sync_attendance_config_from_platform();

-- Ensure an existing deployment converges after the corrected trigger exists.
update public.hr_platform_settings
   set default_work_start_time = default_work_start_time
 where id = 1;

-- Keep the existing RPC, but add working days and preserve the established
-- hr_settings_audit trail. The trigger above mirrors attendance fields in the
-- same database transaction; the browser no longer performs a best-effort
-- second write.
create or replace function public.update_hr_settings(p_settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current record;
  v_key text;
  v_old_val text;
  v_new_val text;
begin
  if public.current_role() not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to update HR settings.';
  end if;

  select * into v_current
    from public.hr_platform_settings
   where id = 1;

  if not found then
    raise exception 'Platform Settings are not initialized.';
  end if;

  for v_key in select jsonb_object_keys(coalesce(p_settings, '{}'::jsonb)) loop
    v_old_val := case v_key
      when 'require_gps_clock_in' then v_current.require_gps_clock_in::text
      when 'require_gps_clock_out' then v_current.require_gps_clock_out::text
      when 'geofence_enabled' then v_current.geofence_enabled::text
      when 'default_geofence_radius' then v_current.default_geofence_radius::text
      when 'allow_manual_correction' then v_current.allow_manual_correction::text
      when 'late_threshold_minutes' then v_current.late_threshold_minutes::text
      when 'early_departure_threshold_minutes' then v_current.early_departure_threshold_minutes::text
      when 'default_work_start_time' then v_current.default_work_start_time::text
      when 'default_work_end_time' then v_current.default_work_end_time::text
      when 'default_grace_period_minutes' then v_current.default_grace_period_minutes::text
      when 'default_break_duration_minutes' then v_current.default_break_duration_minutes::text
      when 'overtime_threshold_minutes' then v_current.overtime_threshold_minutes::text
      when 'default_working_days' then to_jsonb(v_current.default_working_days)::text
      when 'app_timezone' then v_current.app_timezone
      when 'leave_annual_days' then v_current.leave_annual_days::text
      when 'leave_sick_days' then v_current.leave_sick_days::text
      when 'leave_casual_days' then v_current.leave_casual_days::text
      when 'leave_maternity_days' then v_current.leave_maternity_days::text
      when 'leave_paternity_days' then v_current.leave_paternity_days::text
      when 'leave_compassionate_days' then v_current.leave_compassionate_days::text
      when 'leave_study_days' then v_current.leave_study_days::text
      when 'leave_unpaid_days' then v_current.leave_unpaid_days::text
      when 'leave_approval_required' then v_current.leave_approval_required::text
      when 'leave_attachment_required' then v_current.leave_attachment_required::text
      when 'leave_carry_forward' then v_current.leave_carry_forward::text
      else null
    end;
    v_new_val := case
      when jsonb_typeof(p_settings -> v_key) = 'array' then (p_settings -> v_key)::text
      else p_settings ->> v_key
    end;
    if v_old_val is distinct from v_new_val then
      insert into public.hr_settings_audit (
        setting_key, previous_value, new_value, changed_by
      ) values (v_key, v_old_val, v_new_val, auth.uid());
    end if;
  end loop;

  update public.hr_platform_settings
     set require_gps_clock_in = coalesce((p_settings->>'require_gps_clock_in')::boolean, require_gps_clock_in),
         require_gps_clock_out = coalesce((p_settings->>'require_gps_clock_out')::boolean, require_gps_clock_out),
         geofence_enabled = coalesce((p_settings->>'geofence_enabled')::boolean, geofence_enabled),
         default_geofence_radius = coalesce((p_settings->>'default_geofence_radius')::int, default_geofence_radius),
         allow_manual_correction = coalesce((p_settings->>'allow_manual_correction')::boolean, allow_manual_correction),
         late_threshold_minutes = coalesce((p_settings->>'late_threshold_minutes')::int, late_threshold_minutes),
         early_departure_threshold_minutes = coalesce((p_settings->>'early_departure_threshold_minutes')::int, early_departure_threshold_minutes),
         default_work_start_time = coalesce((p_settings->>'default_work_start_time')::time, default_work_start_time),
         default_work_end_time = coalesce((p_settings->>'default_work_end_time')::time, default_work_end_time),
         default_grace_period_minutes = coalesce((p_settings->>'default_grace_period_minutes')::int, default_grace_period_minutes),
         default_break_duration_minutes = coalesce((p_settings->>'default_break_duration_minutes')::int, default_break_duration_minutes),
         overtime_threshold_minutes = coalesce((p_settings->>'overtime_threshold_minutes')::int, overtime_threshold_minutes),
         default_working_days = case
           when p_settings ? 'default_working_days'
             then array(select jsonb_array_elements_text(p_settings->'default_working_days'))
           else default_working_days
         end,
         app_timezone = coalesce(nullif(p_settings->>'app_timezone', ''), app_timezone),
         leave_annual_days = coalesce((p_settings->>'leave_annual_days')::int, leave_annual_days),
         leave_sick_days = coalesce((p_settings->>'leave_sick_days')::int, leave_sick_days),
         leave_casual_days = coalesce((p_settings->>'leave_casual_days')::int, leave_casual_days),
         leave_maternity_days = coalesce((p_settings->>'leave_maternity_days')::int, leave_maternity_days),
         leave_paternity_days = coalesce((p_settings->>'leave_paternity_days')::int, leave_paternity_days),
         leave_compassionate_days = coalesce((p_settings->>'leave_compassionate_days')::int, leave_compassionate_days),
         leave_study_days = coalesce((p_settings->>'leave_study_days')::int, leave_study_days),
         leave_unpaid_days = coalesce((p_settings->>'leave_unpaid_days')::int, leave_unpaid_days),
         leave_approval_required = coalesce((p_settings->>'leave_approval_required')::boolean, leave_approval_required),
         leave_attachment_required = coalesce((p_settings->>'leave_attachment_required')::boolean, leave_attachment_required),
         leave_carry_forward = coalesce((p_settings->>'leave_carry_forward')::boolean, leave_carry_forward),
         updated_at = now(),
         updated_by = auth.uid()
   where id = 1;

  return jsonb_build_object('ok', true, 'updated_at', now());
end;
$$;

revoke all on function public.update_hr_settings(jsonb) from public;
grant execute on function public.update_hr_settings(jsonb) to authenticated;

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
    'default_work_start_time', v_settings.default_work_start_time::text,
    'default_work_end_time', v_settings.default_work_end_time::text,
    'default_grace_period_minutes', v_settings.default_grace_period_minutes,
    'default_working_days', coalesce(to_jsonb(v_settings.default_working_days), '[]'::jsonb),
    'app_timezone', coalesce(v_settings.app_timezone, 'Africa/Lagos')
  );
end;
$$;

revoke all on function public.get_attendance_requirements() from public;
grant execute on function public.get_attendance_requirements() to authenticated, anon;

create or replace function public.get_attendance_network_time()
returns timestamptz
language sql
security definer
set search_path = public
as $$
  select clock_timestamp();
$$;

revoke all on function public.get_attendance_network_time() from public;
grant execute on function public.get_attendance_network_time() to authenticated, anon;

-- --------------------------------------------------------------------------
-- 3. Shared location resolution: assigned branch is expected, every active
-- branch/geofence is an approved alternative location.
-- --------------------------------------------------------------------------
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
  v_geofence_enabled boolean;
  v_distance float;
  v_nearest_distance float;
  v_best_distance float;
  v_nearest_name text;
  v_nearest_branch_id uuid;
  v_nearest_geofence_id uuid;
  v_nearest_type text;
  v_best_name text;
  v_best_branch_id uuid;
  v_best_geofence_id uuid;
  v_best_type text;
  v_best_branch_key text;
  v_assigned_name text;
  v_assigned_id uuid;
  v_radius numeric;
  v_best_radius numeric;
  v_nearest_radius numeric;
  v_has_registered_location boolean := false;
  v_location_status text := 'unknown';
  v_geofence_status text := 'no_geofence';
  v_location_difference boolean;
begin
  select * into v_employee
    from public.employees
   where id = p_employee_id
   limit 1;
  if not found then raise exception 'Employee record not found.'; end if;

  select * into v_settings
    from public.hr_platform_settings
   where id = 1
   limit 1;
  v_geofence_enabled := coalesce(v_settings.geofence_enabled, true);

  if p_lat is null or p_lng is null then
    raise exception 'LOCATION_REQUIRED:Location is required to clock in or out. Please enable location access.';
  end if;
  if p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
    raise exception 'LOCATION_INVALID:Your device returned an invalid location. Please try again.';
  end if;

  if p_branch_id is not null then
    select * into v_assigned from public.branches where id = p_branch_id limit 1;
  elsif v_employee.branch_id is not null then
    select * into v_assigned from public.branches where id = v_employee.branch_id limit 1;
  elsif nullif(trim(v_employee.branch), '') is not null then
    select * into v_assigned
      from public.branches
     where lower(branch_name) = lower(trim(v_employee.branch))
        or lower(coalesce(branch_code, '')) = lower(trim(v_employee.branch))
     order by case when lower(branch_name) = lower(trim(v_employee.branch)) then 0 else 1 end
     limit 1;
  end if;
  v_assigned_id := v_assigned.id;
  v_assigned_name := coalesce(v_assigned.branch_name, nullif(trim(v_employee.branch), ''));

  for v_candidate in
    select b.id as candidate_branch_id,
           null::uuid as candidate_geofence_id,
           b.id::text as candidate_branch_key,
           b.branch_name as candidate_name,
           'branch'::text as candidate_type,
           b.latitude::float as candidate_latitude,
           b.longitude::float as candidate_longitude,
           greatest(1, coalesce(b.geofence_radius, v_settings.default_geofence_radius, 150))::numeric as candidate_radius
      from public.branches b
     where coalesce(b.geofence_active, false)
       and b.latitude is not null
       and b.longitude is not null
    union all
    select gb.id as candidate_branch_id,
           g.id as candidate_geofence_id,
           coalesce(gb.id::text, g.branch_id) as candidate_branch_key,
           coalesce(nullif(g.location_name, ''), g.name) as candidate_name,
           'geofence'::text as candidate_type,
           g.latitude::float as candidate_latitude,
           g.longitude::float as candidate_longitude,
           greatest(1, coalesce(g.radius_meters, v_settings.default_geofence_radius, 150))::numeric as candidate_radius
      from public.attendance_geofences g
      left join public.branches gb on gb.id::text = g.branch_id
     where coalesce(g.active, false)
       and g.latitude is not null
       and g.longitude is not null
       and case when lower(p_action) = 'clock_out' then coalesce(g.clock_out_allowed, true)
                else coalesce(g.clock_in_allowed, true) end
  loop
    v_has_registered_location := true;
    v_distance := public.geo_distance(p_lat, p_lng, v_candidate.candidate_latitude, v_candidate.candidate_longitude);

    if v_nearest_distance is null or v_distance < v_nearest_distance then
      v_nearest_distance := v_distance;
      v_nearest_name := v_candidate.candidate_name;
      v_nearest_branch_id := v_candidate.candidate_branch_id;
      v_nearest_geofence_id := v_candidate.candidate_geofence_id;
      v_nearest_type := v_candidate.candidate_type;
      v_nearest_radius := v_candidate.candidate_radius;
    end if;

    if v_distance <= v_candidate.candidate_radius
       and (v_best_distance is null or v_distance < v_best_distance) then
      v_best_distance := v_distance;
      v_best_name := v_candidate.candidate_name;
      v_best_branch_id := v_candidate.candidate_branch_id;
      v_best_geofence_id := v_candidate.candidate_geofence_id;
      v_best_type := v_candidate.candidate_type;
      v_best_branch_key := v_candidate.candidate_branch_key;
      v_best_radius := v_candidate.candidate_radius;
    end if;
  end loop;

  if v_geofence_enabled and not v_has_registered_location then
    raise exception 'GEOFENCE_NOT_CONFIGURED:No approved attendance location is configured. Contact HR before clocking in or out.';
  end if;
  if v_geofence_enabled and v_best_distance is null then
    raise exception 'OUTSIDE_GEOFENCE:You are outside all registered InfinityCore attendance locations.';
  end if;

  if v_best_distance is not null then
    v_geofence_status := 'inside';
    v_location_status := 'inside';
    v_location_difference := not (
      (v_assigned_id is not null and v_best_branch_id = v_assigned_id)
      or (v_assigned_id is not null and v_best_branch_key = v_assigned_id::text)
      or (v_assigned_name is not null and lower(v_best_name) = lower(v_assigned_name))
    );
  elsif v_has_registered_location then
    v_geofence_status := 'outside';
    v_location_status := 'outside';
    v_location_difference := null;
  else
    v_geofence_status := 'no_geofence';
    v_location_status := 'unknown';
    v_location_difference := null;
  end if;

  return jsonb_build_object(
    'assigned_branch_id', v_assigned_id,
    'assigned_branch_name', v_assigned_name,
    'actual_branch_id', v_best_branch_id,
    'actual_geofence_id', v_best_geofence_id,
    'actual_location_name', v_best_name,
    'actual_location_type', v_best_type,
    'location_difference', v_location_difference,
    'nearest_location_name', v_nearest_name,
    'nearest_distance', v_nearest_distance,
    'nearest_radius', v_nearest_radius,
    'distance', v_best_distance,
    'radius', v_best_radius,
    'geofence_status', v_geofence_status,
    'location_status', v_location_status,
    'work_start_time', v_settings.default_work_start_time::text,
    'work_end_time', v_settings.default_work_end_time::text,
    'grace_period_minutes', v_settings.default_grace_period_minutes
  );
end;
$$;

revoke all on function public.attendance_validate_location(uuid, float, float, text, uuid) from public;

-- --------------------------------------------------------------------------
-- 4. One server-side calculation path for all clocking channels
-- --------------------------------------------------------------------------
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
  v_employee_id uuid;
begin
  select id into v_employee_id from public.employees where user_id = auth.uid() limit 1;
  if v_employee_id is null then raise exception 'No employee profile is linked to your account.'; end if;
  return public.attendance_clock_in_for_employee(v_employee_id, p_lat, p_lng, p_accuracy, 'web', null, 'GPS', 'WEB');
end;
$$;

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
  v_employee_id uuid;
begin
  select id into v_employee_id from public.employees where user_id = auth.uid() limit 1;
  if v_employee_id is null then raise exception 'No employee profile is linked to your account.'; end if;
  return public.attendance_clock_out_for_employee(v_employee_id, p_attendance_id, p_lat, p_lng, p_accuracy, 'web', null, 'GPS', 'WEB');
end;
$$;

revoke all on function public.clock_in_secure(float, float, float) from public;
revoke all on function public.clock_out_secure(uuid, float, float, float) from public;
-- These helpers accept an arbitrary employee UUID and are intentionally only
-- callable by the authenticated wrappers, terminal RPC, and device ingest
-- functions above. SECURITY DEFINER functions otherwise receive EXECUTE by
-- PUBLIC by default.
revoke all on function public.attendance_clock_in_for_employee(uuid, float, float, float, text, uuid, text, text) from public;
revoke all on function public.attendance_clock_out_for_employee(uuid, uuid, float, float, float, text, uuid, text, text) from public;
grant execute on function public.clock_in_secure(float, float, float) to authenticated;
grant execute on function public.clock_out_secure(uuid, float, float, float) to authenticated;

-- Recalculate every completed historical row once, and keep future edits
-- canonical at the database boundary.
create or replace function public.attendance_update_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_correcting boolean := current_setting('app.correcting_attendance', true) = 'on';
begin
  if not v_correcting and (new.clock_out is distinct from old.clock_out or new.clock_in is distinct from old.clock_in) then
    if old.clock_in is null then raise exception 'Cannot clock out without clocking in.'; end if;
    if new.clock_in is distinct from old.clock_in then raise exception 'Clock-in time cannot be edited directly.'; end if;
    if new.clock_out is not null then new.clock_out := clock_timestamp(); end if;
    if new.clock_out is not null and new.clock_out <= old.clock_in then raise exception 'Invalid clock-out time.'; end if;
    new.is_corrected := false;
  end if;

  if new.clock_in is not null and new.clock_out is not null then
    new.total_minutes := greatest(0, round(extract(epoch from (new.clock_out - new.clock_in)) / 60.0))::integer;
    new.work_hours := round(new.total_minutes::numeric / 60.0, 2);
    if not v_correcting and (new.clock_out is distinct from old.clock_out or new.clock_in is distinct from old.clock_in) then
      new.status := case when coalesce(old.late_minutes, 0) > 0 then 'late' else 'present' end;
    end if;
  elsif new.clock_out is null and (new.clock_out is distinct from old.clock_out or new.clock_in is distinct from old.clock_in) then
    new.total_minutes := null;
    new.work_hours := null;
  end if;

  if new.status not in ('present', 'absent', 'late', 'early_exit', 'on_leave', 'incomplete', 'corrected') then
    raise exception 'Invalid attendance status "%".', new.status;
  end if;
  return new;
end;
$$;

drop trigger if exists attendance_before_update on public.attendance_records;
create trigger attendance_before_update
  before update on public.attendance_records
  for each row execute function public.attendance_update_rules();

update public.attendance_records
   set total_minutes = greatest(0, round(extract(epoch from (clock_out - clock_in)) / 60.0))::integer,
       work_hours = round((greatest(0, round(extract(epoch from (clock_out - clock_in)) / 60.0)) / 60.0)::numeric, 2)
 where clock_in is not null
   and clock_out is not null
   and (work_hours is null or total_minutes is null);

-- Auto-close uses the same Platform Settings end time instead of a second
-- hard-coded schedule.
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
  v_as_of timestamptz := least(coalesce(p_as_of, clock_timestamp()), v_now);
  v_local_today date := (v_as_of at time zone v_tz)::date;
  v_work_end time;
  v_row record;
  v_clock_out timestamptz;
  v_total integer;
  v_closed integer := 0;
  v_updated jsonb := '[]'::jsonb;
begin
  if public.current_role() not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized to reconcile attendance sessions.';
  end if;

  select default_work_end_time into v_work_end from public.hr_platform_settings where id = 1;
  if v_work_end is null then raise exception 'Platform Settings work end time is not configured.'; end if;

  for v_row in
    select r.id, r.employee_id, r.attendance_date, r.clock_in, r.late_minutes
      from public.attendance_records r
     where r.clock_out is null and r.attendance_date < v_local_today
     order by r.attendance_date
     for update skip locked
  loop
    v_clock_out := (v_row.attendance_date + v_work_end) at time zone v_tz;
    v_total := greatest(0, round(extract(epoch from (v_clock_out - v_row.clock_in)) / 60.0))::integer;
    perform set_config('app.correcting_attendance', 'on', true);
    update public.attendance_records
       set clock_out = v_clock_out,
           total_minutes = v_total,
           work_hours = round(v_total::numeric / 60.0, 2),
           early_departure_minutes = 0,
           source = 'admin', source_detail = 'ADMIN', verification_method = 'NONE',
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
      jsonb_build_object('auto', true, 'reason', 'No manual clock-out recorded before reconciliation', 'scheduled_end', v_work_end::text)
    );

    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'ATTENDANCE_AUTO_CLOCK_OUT', 'AttendanceRecord', v_row.id::text,
      'System (auto clock-out)',
      jsonb_build_object('attendance_date', v_row.attendance_date, 'scheduled_end', v_work_end, 'work_minutes', v_total, 'success', true)::text,
      'info'
    );

    v_closed := v_closed + 1;
    v_updated := v_updated || jsonb_build_object('id', v_row.id, 'attendance_date', v_row.attendance_date, 'clock_out', v_clock_out, 'work_hours', round(v_total::numeric / 60.0, 2));
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

-- --------------------------------------------------------------------------
-- 5. QR terminal security on the existing attendance_devices registry
-- --------------------------------------------------------------------------
create table if not exists public.attendance_terminal_attempts (
  id bigint generated always as identity primary key,
  terminal_id uuid not null references public.attendance_devices(id) on delete cascade,
  identifier_hash text not null,
  attempted_at timestamptz not null default clock_timestamp()
);

create index if not exists idx_attendance_terminal_attempts_window
  on public.attendance_terminal_attempts(terminal_id, identifier_hash, attempted_at desc);

alter table public.attendance_terminal_attempts enable row level security;
revoke all on public.attendance_terminal_attempts from anon, authenticated;

create or replace function public.create_attendance_terminal_token(
  p_device_id uuid default null,
  p_device_name text default 'QR Attendance Terminal'
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_device public.attendance_devices%rowtype;
  v_raw text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  if public.current_role() not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to manage attendance terminals.';
  end if;

  if p_device_id is null then
    select * into v_device
      from public.attendance_devices
     where device_type = 'attendance_terminal'
       and status = 'active'
       and active = true
     order by created_at
     limit 1;
    if not found then
      insert into public.attendance_devices (device_name, device_type, status, active, created_by)
      values (coalesce(nullif(trim(p_device_name), ''), 'QR Attendance Terminal'), 'attendance_terminal', 'active', true, auth.uid())
      returning * into v_device;
    end if;
  else
    select * into v_device from public.attendance_devices where id = p_device_id for update;
    if not found or v_device.device_type <> 'attendance_terminal' then
      raise exception 'Attendance terminal not found.';
    end if;
  end if;

  update public.attendance_devices
     set device_token = encode(
       extensions.digest(convert_to(v_raw::text, 'UTF8'), 'sha256'::text),
       'hex'
     ),
         status = 'active', active = true, updated_at = now()
   where id = v_device.id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_TERMINAL_TOKEN_REGENERATED', 'AttendanceDevice', v_device.id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    jsonb_build_object('module', 'attendance', 'device_name', v_device.device_name, 'success', true)::text,
    'warning'
  );

  return jsonb_build_object('ok', true, 'device_id', v_device.id, 'device_name', v_device.device_name, 'token', v_raw, 'generated_at', clock_timestamp());
end;
$$;

create or replace function public.revoke_attendance_terminal(p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  if public.current_role() not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to manage attendance terminals.';
  end if;
  update public.attendance_devices
     set device_token = null, status = 'suspended', active = false, updated_at = now()
   where id = p_device_id and device_type = 'attendance_terminal'
   returning device_name into v_name;
  if v_name is null then raise exception 'Attendance terminal not found.'; end if;
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_TERMINAL_REVOKED', 'AttendanceDevice', p_device_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    jsonb_build_object('module', 'attendance', 'device_name', v_name, 'success', true)::text,
    'warning'
  );
  return jsonb_build_object('ok', true, 'device_id', p_device_id, 'revoked', true);
end;
$$;

revoke all on function public.create_attendance_terminal_token(uuid, text) from public;
revoke all on function public.revoke_attendance_terminal(uuid) from public;
grant execute on function public.create_attendance_terminal_token(uuid, text) to authenticated;
grant execute on function public.revoke_attendance_terminal(uuid) to authenticated;

-- Existing authenticated devices use the same canonical clock helpers as the
-- web and QR channels. This removes the old branch-only device path while
-- retaining the existing attendance_devices and attendance_events tables.
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
  v_employee_id uuid := p_employee_id;
  v_open_id uuid;
  v_lat float := nullif(coalesce(p_metadata ->> 'latitude', p_metadata ->> 'lat'), '')::float;
  v_lng float := nullif(coalesce(p_metadata ->> 'longitude', p_metadata ->> 'lng'), '')::float;
  v_accuracy float := nullif(coalesce(p_metadata ->> 'accuracy', ''), '')::float;
  v_event text;
  v_source text;
  v_source_detail text;
begin
  if p_event_type not in ('CLOCK_IN', 'CLOCK_OUT', 'DEVICE_CLOCK_IN', 'DEVICE_CLOCK_OUT') then
    return jsonb_build_object('success', false, 'error', 'Unsupported attendance event type.');
  end if;
  select * into v_device from public.attendance_devices where id = p_device_id;
  if not found or v_device.status <> 'active' or not v_device.active then
    return jsonb_build_object('success', false, 'error', 'Device inactive or suspended.');
  end if;

  if v_employee_id is null then
    select e.id into v_employee_id
      from public.employees e
     where e.employment_status = 'active'
       and (
         upper(trim(regexp_replace(coalesce(e.employee_number, ''), '\s*/\s*', '/', 'g'))) = upper(trim(regexp_replace(coalesce(p_external_user_id, ''), '\s*/\s*', '/', 'g')))
         or upper(trim(regexp_replace(coalesce(e.staff_id, ''), '\s*/\s*', '/', 'g'))) = upper(trim(regexp_replace(coalesce(p_external_user_id, ''), '\s*/\s*', '/', 'g')))
         or upper(trim(regexp_replace(coalesce(e.employee_code, ''), '\s*/\s*', '/', 'g'))) = upper(trim(regexp_replace(coalesce(p_external_user_id, ''), '\s*/\s*', '/', 'g')))
       )
     limit 1;
  end if;
  if v_employee_id is null then return jsonb_build_object('success', false, 'error', 'Employee ID not found.'); end if;

  v_event := case when p_event_type in ('CLOCK_OUT', 'DEVICE_CLOCK_OUT') then 'CLOCK_OUT' else 'CLOCK_IN' end;
  v_source := case when p_event_type like 'DEVICE_%' then 'terminal' else 'fingerprint' end;
  v_source_detail := case when p_event_type like 'DEVICE_%' then 'ATTENDANCE_TERMINAL' else 'FINGERPRINT' end;
  if v_event = 'CLOCK_IN' then
    return public.attendance_clock_in_for_employee(v_employee_id, v_lat, v_lng, v_accuracy, v_source, p_device_id, coalesce(nullif(p_verification_method, ''), 'FINGERPRINT'), v_source_detail);
  end if;

  select id into v_open_id from public.attendance_records where employee_id = v_employee_id and clock_out is null order by clock_in desc limit 1;
  if v_open_id is null then return jsonb_build_object('success', false, 'error', 'No open attendance session was found.'); end if;
  return public.attendance_clock_out_for_employee(v_employee_id, v_open_id, v_lat, v_lng, v_accuracy, v_source, p_device_id, coalesce(nullif(p_verification_method, ''), 'FINGERPRINT'), v_source_detail);
end;
$$;

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

revoke all on function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb) from public;
revoke all on function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb, uuid) from public;
grant execute on function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb) to authenticated;
grant execute on function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb, uuid) to authenticated;

create or replace function public.validate_attendance_terminal_employee(
  p_token text,
  p_employee_identifier text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.attendance_devices%rowtype;
  v_normalized text := upper(trim(regexp_replace(coalesce(p_employee_identifier, ''), '\s*/\s*', '/', 'g')));
  v_identifier_hash text;
  v_employee_id uuid;
  v_attempts integer;
begin
  select * into v_device
    from public.attendance_devices
   where device_type = 'attendance_terminal'
     and status = 'active' and active = true
     and device_token = encode(
       extensions.digest(convert_to(coalesce(p_token, '')::text, 'UTF8'), 'sha256'::text),
       'hex'
     )
   limit 1;
  if not found then return jsonb_build_object('valid', false, 'error', 'This attendance terminal link is invalid or revoked.'); end if;
  if v_normalized = '' then return jsonb_build_object('valid', false, 'error', 'Enter your employee number.'); end if;

  v_identifier_hash := encode(
    extensions.digest(convert_to(v_normalized::text, 'UTF8'), 'sha256'::text),
    'hex'
  );
  select count(*) into v_attempts
    from public.attendance_terminal_attempts
   where terminal_id = v_device.id and identifier_hash = v_identifier_hash
     and attempted_at > clock_timestamp() - interval '5 minutes';
  if v_attempts >= 5 then return jsonb_build_object('valid', false, 'error', 'Too many attempts. Please wait and try again.'); end if;

  insert into public.attendance_terminal_attempts (terminal_id, identifier_hash) values (v_device.id, v_identifier_hash);
  select e.id into v_employee_id
    from public.employees e
   where e.employment_status = 'active'
     and (
       upper(trim(coalesce(e.employee_number, ''))) = v_normalized
       or upper(trim(coalesce(e.staff_id, ''))) = v_normalized
       or upper(trim(coalesce(e.employee_code, ''))) = v_normalized
     )
   limit 1;
  if v_employee_id is null then return jsonb_build_object('valid', false, 'error', 'Employee number could not be verified.'); end if;
  return jsonb_build_object('valid', true);
end;
$$;

create or replace function public.clock_attendance_terminal(
  p_token text,
  p_employee_identifier text,
  p_event_type text,
  p_lat float,
  p_lng float,
  p_accuracy float default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.attendance_devices%rowtype;
  v_normalized text := upper(trim(regexp_replace(coalesce(p_employee_identifier, ''), '\s*/\s*', '/', 'g')));
  v_identifier_hash text;
  v_employee_id uuid;
  v_attempts integer;
  v_open_attendance_id uuid;
  v_result jsonb;
begin
  if p_event_type not in ('CLOCK_IN', 'CLOCK_OUT') then return jsonb_build_object('success', false, 'error', 'Choose Clock In or Clock Out.'); end if;
  select * into v_device
    from public.attendance_devices
   where device_type = 'attendance_terminal'
     and status = 'active' and active = true
     and device_token = encode(
       extensions.digest(convert_to(coalesce(p_token, '')::text, 'UTF8'), 'sha256'::text),
       'hex'
     )
   limit 1;
  if not found then return jsonb_build_object('success', false, 'error', 'This attendance terminal link is invalid or revoked.'); end if;
  if v_normalized = '' then return jsonb_build_object('success', false, 'error', 'Enter your employee number.'); end if;
  if p_lat is null or p_lng is null then return jsonb_build_object('success', false, 'error', 'Location is required to record attendance.'); end if;

  v_identifier_hash := encode(
    extensions.digest(convert_to(v_normalized::text, 'UTF8'), 'sha256'::text),
    'hex'
  );
  select count(*) into v_attempts
    from public.attendance_terminal_attempts
   where terminal_id = v_device.id and identifier_hash = v_identifier_hash
     and attempted_at > clock_timestamp() - interval '5 minutes';
  if v_attempts >= 10 then return jsonb_build_object('success', false, 'error', 'Too many attempts. Please wait and try again.'); end if;
  insert into public.attendance_terminal_attempts (terminal_id, identifier_hash) values (v_device.id, v_identifier_hash);

  select e.id into v_employee_id
    from public.employees e
   where e.employment_status = 'active'
     and (
       upper(trim(coalesce(e.employee_number, ''))) = v_normalized
       or upper(trim(coalesce(e.staff_id, ''))) = v_normalized
       or upper(trim(coalesce(e.employee_code, ''))) = v_normalized
     )
   limit 1;
  if v_employee_id is null then return jsonb_build_object('success', false, 'error', 'Employee number could not be verified.'); end if;

  if p_event_type = 'CLOCK_IN' then
    v_result := public.attendance_clock_in_for_employee(v_employee_id, p_lat, p_lng, p_accuracy, 'terminal', v_device.id, 'GPS', 'ATTENDANCE_TERMINAL');
  else
    select id into v_open_attendance_id from public.attendance_records where employee_id = v_employee_id and clock_out is null order by clock_in desc limit 1;
    if v_open_attendance_id is null then return jsonb_build_object('success', false, 'error', 'No open attendance session was found.'); end if;
    v_result := public.attendance_clock_out_for_employee(v_employee_id, v_open_attendance_id, p_lat, p_lng, p_accuracy, 'terminal', v_device.id, 'GPS', 'ATTENDANCE_TERMINAL');
  end if;

  update public.attendance_devices set last_seen_at = clock_timestamp() where id = v_device.id;
  return v_result || jsonb_build_object('success', true, 'terminal_id', v_device.id);
end;
$$;

revoke all on function public.validate_attendance_terminal_employee(text, text) from public;
revoke all on function public.clock_attendance_terminal(text, text, text, float, float, float) from public;
grant execute on function public.validate_attendance_terminal_employee(text, text) to anon, authenticated;
grant execute on function public.clock_attendance_terminal(text, text, text, float, float, float) to anon, authenticated;

-- The old identifier lookup returns employee details and is not needed by the
-- public QR terminal. Keep it available to the existing authenticated kiosk,
-- but never expose it anonymously.
revoke execute on function public.lookup_employee_by_identifier(text) from anon;
revoke execute on function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb) from anon;
revoke execute on function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb, uuid) from anon;

-- --------------------------------------------------------------------------
-- 6. One canonical data source for attendance management cards and SARA
-- --------------------------------------------------------------------------
create or replace function public.get_attendance_management_summary()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.current_role();
  v_tz text := public.att_app_timezone();
  v_today date := (clock_timestamp() at time zone public.att_app_timezone())::date;
  v_dow text := lower(to_char(clock_timestamp() at time zone public.att_app_timezone(), 'Dy'));
  v_working_days text[];
  v_is_working_day boolean := false;
  v_total integer := 0;
  v_on_leave integer := 0;
  v_present integer := 0;
  v_late integer := 0;
  v_absent integer := 0;
  v_cross_branch integer := 0;
  v_head_office integer := 0;
  v_other_branch integer := 0;
  v_avg numeric;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'head_of_business') then
    raise exception 'Not authorized to view organization attendance summary.';
  end if;

  select default_working_days into v_working_days from public.hr_platform_settings where id = 1;
  select exists (
    select 1 from unnest(coalesce(v_working_days, '{}'::text[])) d
     where lower(left(d, 3)) = v_dow
  ) into v_is_working_day;

  select count(*) into v_total
    from public.employees e
   where e.employment_status = 'active' and coalesce(e.is_archived, false) = false;
  select count(distinct e.id) into v_on_leave
    from public.employees e
    join public.leave_requests lr on lr.created_by = e.user_id
   where e.employment_status = 'active'
     and coalesce(e.is_archived, false) = false
     and lr.status = 'approved' and lr.start_date <= v_today and lr.end_date >= v_today;
  select count(distinct ar.employee_id) into v_present
    from public.attendance_records ar
    join public.employees e on e.id = ar.employee_id
   where ar.attendance_date = v_today and ar.clock_in is not null
     and e.employment_status = 'active' and coalesce(e.is_archived, false) = false;
  select count(distinct ar.employee_id) into v_late
    from public.attendance_records ar
    join public.employees e on e.id = ar.employee_id
   where ar.attendance_date = v_today and ar.clock_in is not null
     and (coalesce(ar.late_minutes, 0) > 0 or ar.status = 'late')
     and e.employment_status = 'active' and coalesce(e.is_archived, false) = false;
  select round(avg(coalesce(ar.work_hours, extract(epoch from (ar.clock_out - ar.clock_in)) / 3600.0))::numeric, 1)
    into v_avg
    from public.attendance_records ar
    join public.employees e on e.id = ar.employee_id
   where ar.attendance_date = v_today and ar.clock_in is not null and ar.clock_out is not null
     and e.employment_status = 'active' and coalesce(e.is_archived, false) = false;

  select count(distinct ae.employee_id) into v_cross_branch
    from public.attendance_events ae
    join public.employees e on e.id = ae.employee_id
   where ae.event_type = 'CLOCK_IN' and (ae.event_time at time zone v_tz)::date = v_today
     and ae.metadata ->> 'location_difference' = 'true'
     and e.employment_status = 'active' and coalesce(e.is_archived, false) = false;
  select count(distinct ae.employee_id) into v_head_office
    from public.attendance_events ae
    join public.employees e on e.id = ae.employee_id
   where ae.event_type = 'CLOCK_IN' and (ae.event_time at time zone v_tz)::date = v_today
     and ae.metadata ->> 'location_difference' = 'true'
     and lower(coalesce(ae.metadata ->> 'actual_location_name', '')) like '%head office%'
     and e.employment_status = 'active' and coalesce(e.is_archived, false) = false;
  v_other_branch := greatest(0, v_cross_branch - v_head_office);
  v_absent := case when v_is_working_day then greatest(0, v_total - v_on_leave - v_present) else 0 end;

  return jsonb_build_object(
    'date', v_today,
    'timezone', v_tz,
    'working_day', v_is_working_day,
    'working_days', coalesce(v_working_days, '{}'::text[]),
    'total_employees', v_total,
    'present_today', v_present,
    'absent_today', v_absent,
    'on_leave_today', v_on_leave,
    'late_today', v_late,
    'attendance_percent', case when v_total > 0 then round((v_present::numeric / v_total) * 100, 1) else 0 end,
    'average_hours', coalesce(v_avg, 0),
    'cross_branch_today', v_cross_branch,
    'head_office_today', v_head_office,
    'other_registered_branch_today', v_other_branch
  );
end;
$$;

revoke all on function public.get_attendance_management_summary() from public;
grant execute on function public.get_attendance_management_summary() to authenticated;

-- --------------------------------------------------------------------------
-- 7. Specific annual leave correction, preserving used days and uniqueness
-- --------------------------------------------------------------------------
do $$
declare
  v_user_id uuid;
  v_employee_name text;
  v_year integer := extract(year from current_date)::integer;
  v_previous_entitled numeric;
  v_used numeric;
begin
  select coalesce(e.user_id, p.id), e.full_name
    into v_user_id, v_employee_name
    from public.employees e
    left join public.profiles p on lower(p.email) = lower(e.email)
   where upper(trim(coalesce(e.employee_number, ''))) = 'IMFB/26/0526'
      or upper(trim(coalesce(e.staff_id, ''))) = 'IMFB/26/0526'
      or upper(trim(coalesce(e.employee_code, ''))) = 'IMFB/26/0526'
   order by case when e.staff_id is not null then 0 else 1 end
   limit 1;

  if v_user_id is null then
    raise notice 'Annual leave correction skipped: IMFB/26/0526 has no linked auth user.';
    return;
  end if;

  select entitled_days, used_days into v_previous_entitled, v_used
    from public.leave_balances
   where employee_id = v_user_id and year = v_year and leave_type = 'annual'
   for update;

  insert into public.leave_balances (
    employee_id, employee_name, year, leave_type, entitled_days, used_days
  ) values (
    v_user_id, v_employee_name, v_year, 'annual', 10, coalesce(v_used, 0)
  )
  on conflict (employee_id, year, leave_type) do update
    set employee_name = excluded.employee_name,
        entitled_days = 10,
        updated_at = now();

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'LEAVE_BALANCE_CORRECTED', 'LeaveBalance', v_user_id::text, 'system migration',
    jsonb_build_object(
      'employee_number', 'IMFB/26/0526', 'leave_type', 'annual', 'year', v_year,
      'previous_entitled_days', v_previous_entitled, 'new_entitled_days', 10,
      'used_days_preserved', coalesce(v_used, 0),
      'remaining_days', 10 - coalesce(v_used, 0), 'success', true
    )::text,
    'warning'
  );
end;
$$;

-- END
