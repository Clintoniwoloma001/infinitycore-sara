-- ============================================================================
-- Phase 66b — Attendance Terminal (platform kiosk) carries the browser
-- fingerprint and is held to the same one-terminal-per-employee-per-day rule
-- as the public QR scan page.
--
-- Run AFTER 20260921000001. Idempotent / additive.
--
-- Root cause this fixes:
--   The public QR terminal (token flow) sends the FingerprintJS-style browser
--   composite on every call, so it is protected by `attendance_device_binding
--   _check` + `attendance_terminal_day_binding_check`. The platform "Attendance
--   Terminal" kiosk (the menu route /attendance-terminal, PIN / WebAuthn flows)
--   NEVER captured a browser fingerprint, so its device-identity path
--   (`ingest_attendance_event`) was outside every buddy-punching guard — the
--   same terminal could record multiple employees on the same day there.
--
-- What this migration does:
--   * No signature changes: `ingest_attendance_event` still takes the same
--     arguments. The frontend now includes `p_metadata -> 'device_fingerprint'`
--     when it can compute the browser composite.
--   * When a fingerprint is present in the metadata, the 7-arg wrapper runs the
--     SAME gates as `clock_attendance_terminal` BEFORE any record is written:
--       1. `attendance_terminal_day_binding_check(device, employee, event)` —
--          one employee per ATTENDANCE DEVICE per app day (holds across every
--          browser even with different fingerprints).
--       2. `attendance_device_binding_check(fingerprint, employee, event)` —
--          complementary browser-scoped hold.
--     and binds on a successful CLOCK_IN.
--   * No fingerprint in metadata (server-token badge readers, legacy hardware
--     ingesters that have no browser) -> behaviour is unchanged: no guard, no
--     binding. The kiosk always sends one, so it is always guarded.
--   * Blocks are audited as ATTENDANCE_DEVICE_BINDING_BLOCKED with the same
--     HR-facing copy, `device_binding_blocked=true` in the response, and
--     `scope: 'browser_fingerprint' | 'terminal_device_day'`.
-- ============================================================================

create or replace function public.ingest_attendance_event(
  p_device_id uuid,
  p_external_user_id text,
  p_event_type text,
  p_event_time timestamptz default now(),
  p_verification_method text default 'FINGERPRINT',
  p_metadata jsonb default '{}'::jsonb,
  p_employee_id uuid default null
) returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_result jsonb;
  v_fingerprint text;
  v_event text;
  v_employee_id uuid;
  v_device public.attendance_devices%rowtype;
  v_tbind jsonb;
  v_bind jsonb;
  v_bound_employee public.employees%rowtype;
begin
  -- The platform terminal now forwards the browser composite fingerprint in
  -- p_metadata.device_fingerprint. Only enforce the device/browser binding when
  -- a fingerprint was actually supplied (hardware ingesters without a browser
  -- must keep working unchanged).
  v_fingerprint := coalesce(nullif(p_metadata ->> 'device_fingerprint', ''), null);
  v_event := case
    when upper(coalesce(p_event_type, '')) like '%CLOCK_IN%' then 'CLOCK_IN'
    else 'CLOCK_OUT'
  end;

  if v_fingerprint is not null and p_device_id is not null then
    v_employee_id := p_employee_id;
    if v_employee_id is null then
      v_employee_id := public.resolve_attendance_terminal_employee(p_external_user_id);
    end if;

    if v_employee_id is not null then
      select * into v_device from public.attendance_devices where id = p_device_id limit 1;
      if v_device.id is not null then
        -- Authoritative per-terminal/day policy (mirrors clock_attendance_terminal).
        v_tbind := public.attendance_terminal_day_binding_check(v_device.id, v_employee_id, v_event);
        if (v_tbind ->> 'allowed')::boolean = false then
          select * into v_bound_employee from public.employees where id = (v_tbind ->> 'bound_to')::uuid;
          insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
          values (
            'ATTENDANCE_DEVICE_BINDING_BLOCKED', 'AttendanceDevice', v_device.id::text,
            'attendance-terminal',
            jsonb_build_object(
              'module', 'attendance', 'terminal_id', v_device.id,
              'channel', 'terminal_kiosk', 'event_type', v_event,
              'attempted_employee', coalesce(
                (select e.full_name from public.employees e where e.id = v_employee_id),
                p_external_user_id
              ),
              'bound_employee', coalesce(v_bound_employee.full_name, v_tbind ->> 'bound_to'),
              'binding_date', v_tbind ->> 'date',
              'scope', 'terminal_device_day'
            )::text,
            'warning'
          );
          return jsonb_build_object(
            'success', false,
            'error', coalesce(
              nullif(v_tbind ->> 'error', ''),
              'DEVICE_BINDING:This attendance terminal has already been clocked-in by a different employee today. Contact your supervisor or HR if this is an error.'
            ),
            'device_binding_blocked', true
          );
        end if;

        -- Complementary browser-scoped policy gate (mirrors clock_attendance_terminal).
        v_bind := public.attendance_device_binding_check(v_fingerprint, v_employee_id, v_event);
        if (v_bind ->> 'allowed')::boolean = false then
          select * into v_bound_employee from public.employees where id = (v_bind ->> 'bound_to')::uuid;
          insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
          values (
            'ATTENDANCE_DEVICE_BINDING_BLOCKED', 'AttendanceDevice', v_device.id::text,
            'attendance-terminal',
            jsonb_build_object(
              'module', 'attendance', 'terminal_id', v_device.id,
              'event_type', v_event,
              'attempted_employee', coalesce(
                (select e.full_name from public.employees e where e.id = v_employee_id),
                p_external_user_id
              ),
              'bound_employee', coalesce(v_bound_employee.full_name, v_bind ->> 'bound_to'),
              'binding_date', v_bind ->> 'date',
              'scope', 'browser_fingerprint'
            )::text,
            'warning'
          );
          return jsonb_build_object(
            'success', false,
            'error', coalesce(
              nullif(v_bind ->> 'error', ''),
              'DEVICE_BINDING:This device has already been used to clock in a different employee today. Contact your supervisor or HR if this is an error.'
            ),
            'device_binding_blocked', true
          );
        end if;
      end if;
    end if;
  end if;

  v_result := public.ingest_attendance_event_internal(
    p_device_id, p_external_user_id, p_event_type, p_event_time,
    p_verification_method, p_metadata, p_employee_id
  );

  if v_fingerprint is not null and p_device_id is not null and v_event = 'CLOCK_IN'
     and (v_result ->> 'attendance_id') is not null
     and v_employee_id is not null then
    perform public.attendance_device_bind(v_fingerprint, v_employee_id, p_device_id);
  end if;

  if p_event_type in ('CLOCK_OUT', 'DEVICE_CLOCK_OUT')
     and nullif(v_result ->> 'attendance_id', '') is null then
    return jsonb_build_object(
      'success', false,
      'error', 'You cannot clock out before clocking in today.'
    );
  end if;

  return v_result;
end;
$$;

revoke all on function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb, uuid) from public;
revoke all on function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb) from public;
grant execute on function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb, uuid) to authenticated;
grant execute on function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb) to authenticated;