-- ============================================================
-- PHASE 31 — ATTENDANCE CANONICAL CONTRACT + HR ORG ACTIONS
--
--  Attendance correctness
--    • Re-creates attendance_records_status_check EXPLICITLY with the
--      canonical vocabulary so any stale/narrower deployed definition
--      converges: present|absent|late|early_exit|on_leave|incomplete|corrected.
--      The constraint is NEVER dropped-and-forgotten — it is re-added as-is.
--    • Adds configurable app_timezone (default Africa/Lagos); every
--      attendance date/late/early computation uses LOCAL time, never
--      UTC-stamped-as-local. Branches carry their own schedule.
--    • get_attendance_requirements() RPC lets clients distinguish
--      "policy requires GPS" from "GPS unavailable" — geo is demanded
--      ONLY when the platform setting says so (server-enforced too).
--    • clock_in_secure / clock_out_secure redefined: nullable geo,
--      config-gated GPS requirement, branch schedule honoured even when a
--      geofence is inactive, idempotent clock-out (UPDATE of the open
--      session only — never an INSERT, so the row CHECK can't fire).
--    • ingest_attendance_event hardened: local-time date, canonical
--      status guard, ALREADY_CLOCKED_OUT handled without inserts.
--    • Trigger guards normalize/validate status so a bad writer gets a
--      clear error while the DB constraint stays authoritative.
--
--  HR Organisation (interactive scorecards)
--    • confirm_employees(p_ids, p_reason) — SECURITY DEFINER; converts
--      UNCONFIRMED → CONFIRMED with per-employee before/after audit
--      (previous value, new value, actor, timestamp) in audit_logs.
--    • list_org_population(p_card) — one server-side query per scorecard,
--      so UI detail counts always match the summary cards.
--
-- ALL ADDITIVE / IDEMPOTENT / OR REPLACE. Safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. CONFIGURABLE APP TIMEZONE
-- ------------------------------------------------------------
alter table public.hr_platform_settings add column if not exists app_timezone text default 'Africa/Lagos';

create or replace function public.att_app_timezone()
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select app_timezone from public.hr_platform_settings where id = 1 limit 1), 'Africa/Lagos');
$$;

-- ------------------------------------------------------------
-- 2. CANONICAL STATUS CONSTRAINT (recreated explicitly)
-- ------------------------------------------------------------
alter table public.attendance_records drop constraint if exists attendance_records_status_check;
alter table public.attendance_records add constraint attendance_records_status_check
  check (status in ('present', 'absent', 'late', 'early_exit', 'on_leave', 'incomplete', 'corrected'));

-- ------------------------------------------------------------
-- 3. ATTENDANCE REQUIREMENTS RPC (policy for clients)
-- ------------------------------------------------------------
create or replace function public.get_attendance_requirements()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_s record;
begin
  select * into v_s from public.hr_platform_settings where id = 1 limit 1;
  return jsonb_build_object(
    'require_gps_clock_in',  coalesce(v_s.require_gps_clock_in, true),
    'require_gps_clock_out', coalesce(v_s.require_gps_clock_out, true),
    'geofence_enabled',      coalesce(v_s.geofence_enabled, true),
    'late_threshold_minutes', coalesce(v_s.late_threshold_minutes, 15),
    'early_departure_threshold_minutes', coalesce(v_s.early_departure_threshold_minutes, 30),
    'default_work_start_time', coalesce(v_s.default_work_start_time, '08:00')::text,
    'default_work_end_time',   coalesce(v_s.default_work_end_time, '17:00')::text,
    'default_grace_period_minutes', coalesce(v_s.default_grace_period_minutes, 15),
    'app_timezone', coalesce(v_s.app_timezone, 'Africa/Lagos')
  );
end; $$;
grant execute on function public.get_attendance_requirements() to authenticated, anon;

-- ------------------------------------------------------------
-- 4. INSERT TRIGGER — local date + canonical status guard
-- ------------------------------------------------------------
create or replace function public.attendance_insert_rules()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  open_sessions int;
begin
  new.clock_in := now();
  if new.attendance_date is null then
    new.attendance_date := (new.clock_in at time zone public.att_app_timezone())::date;
  end if;
  if new.clock_out is not null then
    raise exception 'Clock-out must be performed through an update on this record.';
  end if;
  new.status := coalesce(nullif(new.status, ''), 'present');
  if new.status not in ('present', 'absent', 'late', 'early_exit', 'on_leave', 'incomplete', 'corrected') then
    raise exception 'Invalid attendance status "%". Allowed: present, absent, late, early_exit, on_leave, incomplete, corrected.', new.status;
  end if;
  select count(*) into open_sessions
  from public.attendance_records
  where employee_id = new.employee_id
    and attendance_date = new.attendance_date
    and clock_out is null;
  if open_sessions > 0 then
    raise exception 'An open attendance session already exists for this employee today.';
  end if;
  new.source := coalesce(new.source, 'web');
  return new;
end; $$;

drop trigger if exists attendance_before_insert on public.attendance_records;
create trigger attendance_before_insert
  before insert on public.attendance_records
  for each row execute function public.attendance_insert_rules();

-- ------------------------------------------------------------
-- 5. UPDATE TRIGGER — stamps clock-out, preserves lateness,
--    rejects unknown statuses outside the canonical vocabulary.
-- ------------------------------------------------------------
create or replace function public.attendance_update_rules()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_setting('app.correcting_attendance', true) = 'on' then
    return new;
  end if;
  if new.clock_out is distinct from old.clock_out or new.clock_in is distinct from old.clock_in then
    if old.clock_in is null then
      raise exception 'Cannot clock out without clocking in.';
    end if;
    if new.clock_in is distinct from old.clock_in then
      raise exception 'Clock-in time cannot be edited directly.';
    end if;
    if new.clock_out is not null then
      new.clock_out := now();
    end if;
    if new.clock_out is not null and new.clock_out <= old.clock_in then
      raise exception 'Invalid clock-out time.';
    end if;
    new.work_hours := round(extract(epoch from (coalesce(new.clock_out, now()) - old.clock_in)) / 3600.0, 2);
    if coalesce(old.late_minutes, 0) > 0 then
      new.status := 'late';
    else
      new.status := 'present';
    end if;
    new.is_corrected := false;
  end if;
  if new.status not in ('present', 'absent', 'late', 'early_exit', 'on_leave', 'incomplete', 'corrected') then
    raise exception 'Invalid attendance status "%". A corrected record must go through correct_attendance().', new.status;
  end if;
  return new;
end; $$;

drop trigger if exists attendance_before_update on public.attendance_records;
create trigger attendance_before_update
  before update on public.attendance_records
  for each row execute function public.attendance_update_rules();

-- ------------------------------------------------------------
-- 6. CLOCK IN — GPS only when policy requires; local-time lateness;
--    branch schedule always honoured (not only when geofenced).
-- ------------------------------------------------------------
create or replace function public.clock_in_secure(
  p_lat float,
  p_lng float,
  p_accuracy float default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_employee  record;
  v_branch    record;
  v_distance  float;
  v_geofence  text := 'no_geofence';
  v_late_min  int := 0;
  v_work_start time;
  v_grace     int;
  v_settings  record;
  v_tz        text := public.att_app_timezone();
  v_today     date;
  v_attendance_id uuid;
  v_clock_in_at timestamptz;
begin
  select * into v_employee from public.employees where user_id = auth.uid() limit 1;
  if not found then
    raise exception 'No employee profile is linked to your account.';
  end if;

  -- Local business date (Africa/Lagos by default), never UTC-as-local.
  v_today := (now() at time zone v_tz)::date;

  if exists (
    select 1 from public.attendance_records
    where employee_id = v_employee.id and attendance_date = v_today and clock_out is null
  ) then
    raise exception 'You have already clocked in today.';
  end if;

  select * into v_settings from public.hr_platform_settings where id = 1 limit 1;
  v_work_start := coalesce(v_settings.default_work_start_time, '08:00');
  v_grace     := coalesce(v_settings.default_grace_period_minutes, 15);

  -- Policy: is GPS actually required for clock-in?
  if coalesce(v_settings.require_gps_clock_in, true)
     and (p_lat is null or p_lng is null) then
    raise exception 'LOCATION_REQUIRED:Location is required to clock in. Please enable location access.';
  end if;

  if v_employee.branch_id is not null then
    select * into v_branch from public.branches where id = v_employee.branch_id limit 1;
  elsif v_employee.branch is not null then
    select * into v_branch from public.branches
      where lower(branch_name) = lower(v_employee.branch) limit 1;
  end if;

  -- Branch schedule is the source of truth whether or not a geofence is set.
  if v_branch.id is not null then
    v_work_start := coalesce(v_branch.work_start_time, v_work_start);
    v_grace     := coalesce(v_branch.grace_period_minutes, v_grace);
  end if;

  -- Geofence validation (only when the branch has an active geofence).
  if v_branch.id is not null and v_branch.geofence_active
     and v_branch.latitude is not null and v_branch.longitude is not null
     and p_lat is not null and p_lng is not null then
    v_distance := public.geo_distance(p_lat, p_lng, v_branch.latitude, v_branch.longitude);
    if v_distance <= v_branch.geofence_radius then
      v_geofence := 'inside';
    else
      raise exception
        'OUTSIDE_GEOFENCE:You are %.0fm from your branch geofence (permitted radius: %m). Please move closer to your workplace and try again.',
        v_distance, v_branch.geofence_radius;
    end if;
  elsif v_branch.id is not null and coalesce(v_settings.geofence_enabled, true)
        and v_branch.latitude is not null then
    v_geofence := 'disabled';
  end if;

  -- Lateness in LOCAL time against the branch schedule + grace.
  v_late_min := greatest(0,
    round(extract(epoch from ((now() at time zone v_tz)::time - v_work_start)) / 60.0 - v_grace)
  )::int;

  v_clock_in_at := now();
  insert into public.attendance_records (
    employee_id, attendance_date, source, status,
    clock_in_lat, clock_in_lng, clock_in_accuracy,
    clock_in_distance, geofence_status, late_minutes, branch_id
  ) values (
    v_employee.id, v_today, 'web', case when v_late_min > 0 then 'late' else 'present' end,
    p_lat, p_lng, p_accuracy,
    v_distance, v_geofence, v_late_min, v_branch.id
  )
  returning id into v_attendance_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_CLOCK_IN', 'AttendanceRecord', v_attendance_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    format('Clock-in. Geofence: %s. Late by %s min. Timezone: %s.', v_geofence, v_late_min, v_tz),
    'info'
  );

  return jsonb_build_object(
    'ok', true,
    'attendance_id', v_attendance_id,
    'clock_in_at', v_clock_in_at,
    'geofence_status', v_geofence,
    'distance', v_distance,
    'late_minutes', v_late_min,
    'status', case when v_late_min > 0 then 'late' else 'present' end
  );
end; $$;

grant execute on function public.clock_in_secure(float, float, float) to authenticated;

-- ------------------------------------------------------------
-- 7. CLOCK OUT — config-gated GPS, local-time early-exit calc,
--    strictly an UPDATE of the open session (never an INSERT).
-- ------------------------------------------------------------
create or replace function public.clock_out_secure(
  p_attendance_id uuid,
  p_lat float,
  p_lng float,
  p_accuracy float default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_record   record;
  v_employee record;
  v_branch   record;
  v_distance float;
  v_geofence text := 'no_geofence';
  v_settings record;
  v_tz       text := public.att_app_timezone();
  v_work_end time;
  v_early_min int := 0;
  v_total_min int;
  v_clock_out_at timestamptz;
begin
  select * into v_employee from public.employees where user_id = auth.uid() limit 1;
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
    return jsonb_build_object('ok', true, 'attendance_id', p_attendance_id, 'already_clocked_out', true,
      'clock_out_at', v_record.clock_out,
      'work_hours', v_record.work_hours,
      'total_minutes', v_record.total_minutes,
      'early_departure_minutes', v_record.early_departure_minutes);
  end if;

  select * into v_settings from public.hr_platform_settings where id = 1 limit 1;
  v_work_end := coalesce(v_settings.default_work_end_time, '17:00');

  -- Policy: is GPS actually required for clock-out?
  if coalesce(v_settings.require_gps_clock_out, true)
     and (p_lat is null or p_lng is null) then
    raise exception 'LOCATION_REQUIRED:Location is required to clock out. Please enable location access.';
  end if;

  if v_record.branch_id is not null then
    select * into v_branch from public.branches where id = v_record.branch_id limit 1;
  end if;

  -- Branch schedule is the source of truth regardless of geofence state.
  if v_branch.id is not null then
    v_work_end := coalesce(v_branch.work_end_time, v_work_end);
  end if;

  if v_branch.id is not null and v_branch.geofence_active
     and v_branch.latitude is not null and v_branch.longitude is not null
     and p_lat is not null and p_lng is not null then
    v_distance := public.geo_distance(p_lat, p_lng, v_branch.latitude, v_branch.longitude);
    if v_distance <= v_branch.geofence_radius then
      v_geofence := 'inside';
    else
      raise exception
        'OUTSIDE_GEOFENCE:You are %.0fm from your branch geofence (permitted radius: %m). Please move closer to your workplace and try again.',
        v_distance, v_branch.geofence_radius;
    end if;
  end if;

  v_clock_out_at := now();
  update public.attendance_records
    set clock_out = v_clock_out_at,
        clock_out_lat = p_lat,
        clock_out_lng = p_lng,
        clock_out_accuracy = p_accuracy,
        clock_out_distance = v_distance
    where id = p_attendance_id;

  v_total_min := round(extract(epoch from (v_clock_out_at - v_record.clock_in)) / 60.0)::int;
  -- Early departure computed in the app's LOCAL time against work_end.
  v_early_min := greatest(0,
    round(extract(epoch from (v_work_end - (v_clock_out_at at time zone v_tz)::time)) / 60.0)
  )::int;

  update public.attendance_records
    set total_minutes = v_total_min,
        early_departure_minutes = v_early_min,
        geofence_status = coalesce(v_geofence, geofence_status)
    where id = p_attendance_id;

  if v_early_min > coalesce(v_settings.early_departure_threshold_minutes, 30)
     and coalesce((select late_minutes from public.attendance_records where id = p_attendance_id), 0) = 0 then
    update public.attendance_records set status = 'early_exit' where id = p_attendance_id;
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_CLOCK_OUT', 'AttendanceRecord', p_attendance_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    format('Clock-out. Worked %s min. Early departure: %s min. Timezone: %s.', v_total_min, v_early_min, v_tz),
    'info'
  );

  return jsonb_build_object(
    'ok', true,
    'attendance_id', p_attendance_id,
    'clock_out_at', v_clock_out_at,
    'geofence_status', v_geofence,
    'distance', v_distance,
    'total_minutes', v_total_min,
    'early_departure_minutes', v_early_min,
    'work_hours', round(v_total_min / 60.0, 2)
  );
end; $$;

grant execute on function public.clock_out_secure(uuid, float, float, float) to authenticated;

-- ------------------------------------------------------------
-- 8. TERMINAL EVENT INGEST — local date, canonical status guard,
--    idempotent clock-out (update of the open session only).
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
language plpgsql security definer set search_path = public as $$
declare
  v_device      public.attendance_devices%ROWTYPE;
  v_biometric   public.employee_biometric_identifiers%ROWTYPE;
  v_employee    public.employees%ROWTYPE;
  v_normalized  text;
  v_existing_count int;
  v_attendance_id uuid;
  v_event_id    uuid;
  v_tz          text := public.att_app_timezone();
  v_event_date  date := (coalesce(p_event_time, now()) at time zone v_tz)::date;
begin
  select * into v_device from public.attendance_devices where id = p_device_id;
  if not found then
    return jsonb_build_object('success', false, 'error', 'Unknown device');
  end if;
  if v_device.status != 'active' or not v_device.active then
    return jsonb_build_object('success', false, 'error', 'Device inactive or suspended');
  end if;

  if p_employee_id is not null then
    select * into v_employee from public.employees where id = p_employee_id;
    if not found then
      return jsonb_build_object('success', false, 'error', 'Employee ID not found. Please check the ID and try again.');
    end if;
  else
    select * into v_biometric from public.employee_biometric_identifiers
    where device_id = p_device_id
      and external_user_id = p_external_user_id
      and enrollment_status = 'enrolled'
      and active = true;
    if not found then
      v_normalized := upper(trim(regexp_replace(p_external_user_id, '\s*/\s*', '/', 'g')));
      select * into v_employee from public.employees
      where upper(trim(coalesce(employee_number, ''))) = v_normalized
         or upper(trim(coalesce(staff_id, ''))) = v_normalized
         or upper(trim(coalesce(employee_code, ''))) = v_normalized
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
    return jsonb_build_object(
      'success', false,
      'error', format('Employee is %s and cannot clock in or out.', coalesce(v_employee.employment_status, 'inactive'))
    );
  end if;

  select count(*) into v_existing_count from public.attendance_events
  where employee_id = v_employee.id
    and event_type = p_event_type
    and event_time > p_event_time - interval '5 minutes';
  if v_existing_count > 0 then
    return jsonb_build_object('success', false, 'error', 'Duplicate event within 5 minutes');
  end if;

  if p_event_type in ('CLOCK_IN', 'DEVICE_CLOCK_IN') then
    select count(*) into v_existing_count from public.attendance_records
    where employee_id = v_employee.id
      and attendance_date = v_event_date
      and clock_out is null;
    if v_existing_count > 0 then
      return jsonb_build_object('success', false, 'error', 'Open attendance session already exists');
    end if;
    insert into public.attendance_records (
      employee_id, attendance_date, source, status, source_detail, verification_method, device_id
    ) values (
      v_employee.id, v_event_date, 'fingerprint', 'present', 'FINGERPRINT', p_verification_method, p_device_id
    )
    returning id into v_attendance_id;
  end if;

  if p_event_type in ('CLOCK_OUT', 'DEVICE_CLOCK_OUT') then
    select id into v_attendance_id from public.attendance_records
    where employee_id = v_employee.id
      and clock_out is null
    order by clock_in desc limit 1;
    if v_attendance_id is null then
      return jsonb_build_object('success', true, 'event_id', null, 'attendance_id', null,
        'employee_name', v_employee.full_name, 'already_clocked_out', true,
        'message', 'No open attendance session to close.');
    end if;
    update public.attendance_records
    set clock_out = p_event_time,
        work_hours = round(extract(epoch from (p_event_time - clock_in)) / 3600.0, 2),
        status = 'present',
        verification_method = p_verification_method,
        device_id = p_device_id
    where id = v_attendance_id;
  end if;

  insert into public.attendance_events (
    employee_id, user_id, attendance_record_id, event_type, event_time,
    source, device_id, verification_method, verification_status, metadata
  ) values (
    v_employee.id, v_employee.user_id, v_attendance_id, p_event_type, coalesce(p_event_time, now()),
    'FINGERPRINT', p_device_id, p_verification_method, 'verified', p_metadata
  ) returning id into v_event_id;

  update public.attendance_devices set last_seen_at = now() where id = p_device_id;

  return jsonb_build_object(
    'success', true,
    'event_id', v_event_id,
    'attendance_id', v_attendance_id,
    'employee_name', v_employee.full_name,
    'employee_id', v_employee.id,
    'employee_number', coalesce(v_employee.employee_number, v_employee.staff_id, v_employee.employee_code),
    'department', v_employee.department,
    'position', v_employee.position
  );
end; $$;

grant execute on function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb, uuid) to anon, authenticated;

-- ------------------------------------------------------------
-- 9. HR SETTINGS — accept the new app_timezone key
-- ------------------------------------------------------------
create or replace function public.update_hr_settings(p_settings jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_current record;
  v_key text;
  v_old_val text;
  v_new_val text;
begin
  if public.current_role() not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to update HR settings.';
  end if;

  select * into v_current from public.hr_platform_settings where id = 1;

  for v_key in select jsonb_object_keys(p_settings) loop
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
    v_new_val := p_settings->>v_key;
    if v_old_val is distinct from v_new_val then
      insert into public.hr_settings_audit (setting_key, previous_value, new_value, changed_by)
      values (v_key, v_old_val, v_new_val, auth.uid());
    end if;
  end loop;

  update public.hr_platform_settings set
    require_gps_clock_in = coalesce((p_settings->>'require_gps_clock_in')::boolean, require_gps_clock_in),
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

  return jsonb_build_object('ok', true);
end; $$;

-- ------------------------------------------------------------
-- 10. CONFIRM EMPLOYEES — HR bulk confirmation with audit trail
-- ------------------------------------------------------------
create or replace function public.confirm_employees(
  p_employee_ids uuid[],
  p_reason text default 'HR confirmation'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_actor_name text;
  v_id uuid;
  v_previous text;
  v_confirmed int := 0;
  v_skipped int := 0;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to confirm employees';
  end if;
  select full_name into v_actor_name from public.profiles where id = auth.uid();

  foreach v_id in array p_employee_ids loop
    select confirmation_status into v_previous
    from public.employees where id = v_id;
    if v_previous is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    if v_previous = 'CONFIRMED' then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    update public.employees
      set confirmation_status = 'CONFIRMED', updated_at = now()
      where id = v_id;
    v_confirmed := v_confirmed + 1;
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'EMPLOYEE_CONFIRMED', 'Employee', v_id::text,
      coalesce(v_actor_name, v_role, auth.uid()::text),
      format('Confirmation status %s → CONFIRMED (%s)', coalesce(v_previous, '-'), coalesce(p_reason, 'no reason')),
      'warning'
    );
  end loop;

  return jsonb_build_object(
    'ok', true,
    'confirmed', v_confirmed,
    'skipped', v_skipped,
    'actor', coalesce(v_actor_name, v_role, auth.uid()::text),
    'at', now()
  );
end; $$;
grant execute on function public.confirm_employees(uuid[], text) to authenticated;

-- ------------------------------------------------------------
-- 11. ORG POPULATION — server-side detail query per scorecard.
--      Counts returned here ALWAYS equal the summary cards because
--      the same predicates are used. Returns jsonb arrays.
-- ------------------------------------------------------------
create or replace function public.list_org_population(p_card text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_out jsonb;
begin
  if p_card in ('employees', 'confirmed', 'unconfirmed', 'contract_staff', 'imported', 'uninvited', 'area_managers', 'branch_managers') then
    select jsonb_build_object('card', p_card, 'rows', coalesce(jsonb_agg(to_jsonb(t) order by t.full_name), '[]'::jsonb))
    into v_out
    from (
      select e.id, e.staff_id, e.full_name, e.email, e.phone, e.department, e."position",
             e.branch, b.branch_name, e.area, e.confirmation_status, e.employment_status,
             e.hire_date, e.import_source, e.imported_from_bank_master,
             e.user_id is null as has_no_account, e.manager_id,
             (e.email is null or e.email = '') as missing_email,
             (e.branch_id is null and e.branch is null) as missing_branch,
             (e.employment_status is distinct from 'active') as not_active,
             d.title as designation_title,
             (select es.supervisor_employee_id from public.employee_supervisors es
              where es.employee_id = e.id and es.level = 1 limit 1) as line_manager_id,
             (select es2.supervisor_title from public.employee_supervisors es2
              where es2.employee_id = e.id and es2.level = 1 limit 1) as line_manager_title,
             (select count(*) > 0 from public.employee_onboarding_submissions os
              where os.employee_id = e.id and os.onboarding_status in ('approved', 'completed')) as onboarding_completed,
             (select count(*) > 0 from public.guarantor_verifications gv
              where gv.employee_id = e.id and gv.status in ('approved')) as guarantor_approved,
             (select inv.result from public.employee_account_invites inv
              where inv.employee_id = e.id order by inv.invited_at desc limit 1) as last_invite_result
      from public.employees e
      left join public.branches b on b.id = e.branch_id
      left join public.designations d on d.id = e.designation_id
      where
        case p_card
          when 'employees' then true
          when 'confirmed' then e.confirmation_status = 'CONFIRMED'
          when 'unconfirmed' then e.confirmation_status = 'UNCONFIRMED'
          when 'contract_staff' then e.confirmation_status = 'CONTRACT STAFF'
          when 'imported' then e.imported_from_bank_master
          when 'uninvited' then e.user_id is null
          when 'area_managers' then e."position" like 'AREA MANAGER (%'
          when 'branch_managers' then e."position" = 'BRANCH MANAGER'
          else false
        end
    ) t;
  elsif p_card = 'departments' then
    select jsonb_build_object('card', p_card, 'rows', coalesce(jsonb_agg(to_jsonb(x) order by x.name), '[]'::jsonb))
    into v_out
    from (
      select d.code, d.name, d.is_active,
             (select count(*) from public.employees e where lower(coalesce(e.department, '')) = lower(d.code)
                or coalesce(e.department, '') = d.name) as employee_count,
             (select count(*) from public.employees e
              where (lower(coalesce(e.department, '')) = lower(d.code) or coalesce(e.department, '') = d.name)
                and e.confirmation_status = 'CONFIRMED') as confirmed_count
      from public.departments d
      order by d.sort_order
    ) x;
  elsif p_card = 'designations' then
    select jsonb_build_object('card', p_card, 'rows', coalesce(jsonb_agg(to_jsonb(x) order by x.count desc), '[]'::jsonb))
    into v_out
    from (
      select d.title, d.department as dept, d.category,
             (select count(*) from public.employees e where e.designation_id = d.id) as count,
             (select coalesce(jsonb_agg(em.full_name order by em.full_name), '[]'::jsonb)
              from public.employees em where em.designation_id = d.id) as employees
      from public.designations d
      order by d.title
    ) x;
  elsif p_card = 'branches' then
    select jsonb_build_object('card', p_card, 'rows', coalesce(jsonb_agg(to_jsonb(x) order by x.branch_name), '[]'::jsonb))
    into v_out
    from (
      select br.id, br.branch_code, br.branch_name, br.status,
             br.manager_name, br.latitude, br.longitude, br.geofence_active,
             br.work_start_time, br.work_end_time, br.grace_period_minutes,
             (select a.area_code from public.branch_area_assignments baa
              join public.areas a on a.id = baa.area_id
              where baa.branch_id = br.id and baa.is_current limit 1) as area_code,
             (select count(*) from public.employees e where e.branch_id = br.id) as employee_count
      from public.branches br
    ) x;
  elsif p_card = 'areas' then
    select jsonb_build_object('card', p_card, 'rows', coalesce(jsonb_agg(to_jsonb(x) order by x.area_code), '[]'::jsonb))
    into v_out
    from (
      select a.id, a.area_code, a.area_name, a.is_active,
             man.full_name as manager_name, man.staff_id as manager_staff_id,
             man."position" as manager_position,
             (select count(*) from public.branch_area_assignments baa
              where baa.area_id = a.id and baa.is_current) as branch_count,
             (select count(*) from public.employees e where e.area = a.area_code) as employee_count,
             (select coalesce(jsonb_agg(br.branch_name order by br.branch_name), '[]'::jsonb)
              from public.branch_area_assignments baa2
              join public.branches br on br.id = baa2.branch_id
              where baa2.area_id = a.id and baa2.is_current) as branches
      from public.areas a
      left join public.employees man on man.id = a.manager_employee_id
    ) x;
  elsif p_card = 'open_issues' then
    select jsonb_build_object('card', p_card, 'rows', coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), '[]'::jsonb))
    into v_out
    from (
      select 'hierarchy' as issue_type, he.id, he.employee_id, e.full_name as employee_name,
             he.source_supervisor_name, he.level, he.reason, he.status, he.created_at
      from public.hierarchy_exceptions he
      left join public.employees e on e.id = he.employee_id
      where he.status = 'open'
      union all
      select 'data_quality' as issue_type,
             dq.id, null as employee_id, null as employee_name,
             dq.entity_ref, null as level, dq.message as reason, dq.status, dq.created_at
      from public.data_quality_exceptions dq
      where dq.status = 'open'
    ) x;
  else
    v_out := jsonb_build_object('card', p_card, 'error', 'Unknown card', 'rows', '[]'::jsonb);
  end if;
  return v_out;
end; $$;
grant execute on function public.list_org_population(text) to authenticated;

-- ============================================================
-- END PHASE 31
-- ============================================================