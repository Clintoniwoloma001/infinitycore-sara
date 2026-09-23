-- ============================================================================
-- INFINITYCORE — FIX: guaranteed crash on every QR terminal scan
-- ============================================================================
--
-- ROOT CAUSE
--   The public terminal gates populate v_terminal via:
--       select * into v_terminal from public.attendance_terminal_for_token(p_token);
--   but attendance_terminal_for_token() returns the device PK as `device_id`
--   (see 20260920000001) — NOT `id`. Two live gates referenced fields that do
--   not exist on that record:
--
--   1. validate_attendance_terminal_location (last defined by
--      20260922000001) called `public._terminal_geofence(v_terminal.id)`.
--      For EVERY valid active terminal scan this throws:
--          record "v_terminal" has no field "id"
--      which blocked clock-in for every employee (e.g. FATUNWASE ABIODUN
--      EBENEZER, IMFB/24/0365) regardless of location services.
--
--   2. validate_attendance_terminal_employee (last defined by
--      20260921000016) referenced `v_terminal.device_name` in the
--      device-binding-blocked HR-notify branch — also not returned by the
--      helper — which would throw:
--          record "v_terminal" has no field "device_name"
--      whenever that integrity branch fires.
--
-- FIX (idempotent / additive)
--   * Explicit defensive guard immediately after the SELECT INTO: if no row
--     is produced (token missing/mismatch), return a clear JSONB error
--     instead of crashing on the empty record.
--   * Reference the real column (`device_id`), never the nonexistent `id`/
--     `device_name`, and resolve the device name via a lookup when needed.
--   * The status/active policy check (suspended vs invalid-or-revoked) is
--     preserved unchanged: only non-active rows are rejected, and the write
--     paths (clock_attendance_terminal, canonical web, mobile) already carry
--     their own `if not found` guards so nothing else changes.
--   * attendance_terminal_for_token() itself is untouched.
--
--   Run in Supabase SQL Editor after 20260923000001.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. validate_attendance_terminal_employee — device_name fix + not-found guard
-- ---------------------------------------------------------------------------
create or replace function public.validate_attendance_terminal_employee(
  p_token text, p_employee_identifier text, p_device_fingerprint text default null
) returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_terminal record;
  v_employee_id uuid; v_employee public.employees%rowtype; v_record public.attendance_records%rowtype;
  v_today date := (clock_timestamp() at time zone public.att_app_timezone())::date; v_next_action text;
  v_bind jsonb; v_bound_employee public.employees%rowtype; v_bound_name text; v_bound_code text;
  v_hr_user record;
begin
  select * into v_terminal from public.attendance_terminal_for_token(p_token);
  if not found then
    return jsonb_build_object('valid', false, 'error', 'Terminal not found or inactive. This attendance terminal link is invalid or revoked.');
  end if;
  if v_terminal.status is distinct from 'active' or coalesce(v_terminal.active, false) = false then
    return jsonb_build_object('valid', false, 'error', case
      when v_terminal.status = 'suspended' then 'This terminal is temporarily suspended. Contact HR if you believe this is a mistake.'
      else 'This attendance terminal link is invalid or revoked.'
    end);
  end if;
  v_employee_id := public.resolve_attendance_terminal_employee(p_employee_identifier);
  if v_employee_id is null then
    return jsonb_build_object('valid', false, 'error', 'Employee not found. Check the Employee ID or work email and try again.');
  end if;
  select * into v_employee from public.employees where id = v_employee_id;
  select * into v_record from public.attendance_records where employee_id = v_employee_id and attendance_date = v_today limit 1;
  v_next_action := case when not found then 'CLOCK_IN' when v_record.clock_out is null then 'CLOCK_OUT' else 'COMPLETE' end;

  v_bind := public.attendance_device_binding_check(p_device_fingerprint, v_employee_id, v_next_action);
  if (v_bind ->> 'allowed')::boolean = false then
    select * into v_bound_employee from public.employees where id = (v_bind ->> 'bound_to')::uuid;
    v_bound_name := coalesce(v_bound_employee.full_name, v_bind ->> 'bound_to', 'another employee');
    v_bound_code := coalesce(v_bound_employee.employee_code, v_bound_employee.employee_number, v_bound_employee.staff_id, '—');

    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'ATTENDANCE_DEVICE_BINDING_BLOCKED', 'AttendanceDevice', v_terminal.device_id::text,
      'attendance-terminal',
      jsonb_build_object(
        'module', 'attendance', 'terminal_id', v_terminal.device_id,
        'channel', 'terminal', 'event_type', v_next_action,
        'attempted_employee', v_employee.full_name,
        'bound_employee', v_bound_name,
        'bound_employee_code', v_bound_code,
        'binding_date', v_bind ->> 'date',
        'scope', 'device_day'
      )::text,
      'warning'
    );

    -- Notify HR users through the existing notifications system.
    for v_hr_user in
      select p.id as user_id
        from public.profiles p
       where p.role in ('head_of_human_resources', 'hr_officer')
    loop
      insert into public.notifications (user_id, title, message, link, type, read)
      values (
        v_hr_user.user_id,
        'Attendance Integrity Violation',
        format('Device at terminal %s was used to clock in %s while bound to %s (%s).',
               coalesce((select d.device_name from public.attendance_devices d where d.id = v_terminal.device_id), v_terminal.device_id::text),
               coalesce(v_employee.full_name, 'an unknown employee'),
               v_bound_name, v_bound_code),
        '#/attendance-management',
        'attendance_integrity',
        false
      );
    end loop;

    return jsonb_build_object(
      'valid', false,
      'device_binding_blocked', true,
      'device_binding_error', format(
        'DEVICE_BINDING:Integrity issue — this device is registered to %s, Employee Code %s. You attempted to clock in for someone else. Your action has been logged and sent to HR for review. You may be contacted. No staff is permitted to clock in on behalf of another employee — the system is designed to detect this.',
        v_bound_name, v_bound_code
      ),
      'error', format(
        'DEVICE_BINDING:Integrity issue — this device is registered to %s, Employee Code %s. You attempted to clock in for someone else. Your action has been logged and sent to HR for review.',
        v_bound_name, v_bound_code
      ),
      'bound_employee_name', v_bound_name,
      'bound_employee_code', v_bound_code
    );
  end if;

  return jsonb_build_object(
    'valid', true, 'employee_name', v_employee.full_name,
    'employee_number', coalesce(v_employee.employee_number, v_employee.staff_id, v_employee.employee_code),
    'next_action', v_next_action,
    'device_binding', v_bind - 'bound_to',
    'device_binding_blocked', (v_bind ->> 'allowed')::boolean = false,
    'device_binding_error', v_bind ->> 'error'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. validate_attendance_terminal_location — id -> device_id + not-found guard
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
  if not found then
    return jsonb_build_object('valid', false, 'error', 'Terminal not found or inactive. This attendance terminal link is invalid or revoked.');
  end if;
  if v_terminal.status is distinct from 'active' or coalesce(v_terminal.active, false) = false then
    return jsonb_build_object('valid', false, 'error', case
      when v_terminal.status = 'suspended' then 'This terminal is temporarily suspended. Contact HR if you believe this is a mistake.'
      else 'This attendance terminal link is invalid or revoked.'
    end);
  end if;
  v_employee_id := public.resolve_attendance_terminal_employee(p_employee_identifier);
  if v_employee_id is null then return jsonb_build_object('valid', false, 'error', 'Employee number or email could not be verified.'); end if;

  select * into v_gf from public._terminal_geofence(v_terminal.device_id);
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

-- Permissions preserved: public scan gates stay callable by anon/authenticated;
-- the token helper stays server-only (no direct anon/authenticated access).
grant execute on function public.validate_attendance_terminal_employee(text, text, text) to anon, authenticated;
grant execute on function public.validate_attendance_terminal_location(text, text, float, float, text) to anon, authenticated;