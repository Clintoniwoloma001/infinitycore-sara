-- Phase 2 — SARA voice-of-integrity on attendance device-binding violations.
-- Updates the public terminal gates to expose the bound employee's name/code
-- in the block response and to notify HR users via the existing notifications
-- table. Idempotent/additive.

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
  if not found or v_terminal.status is distinct from 'active' or coalesce(v_terminal.active, false) = false then
    return jsonb_build_object('valid', false, 'error', case
      when not found then 'This attendance terminal link is invalid or revoked.'
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
               coalesce(v_terminal.device_name, v_terminal.device_id::text),
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

  if p_event_type = 'CLOCK_IN' then
    v_result := public.attendance_clock_in_for_employee(v_employee_id, p_lat, p_lng, p_accuracy, 'terminal', v_device.id, 'GPS', 'ATTENDANCE_TERMINAL');
    if (v_result ->> 'attendance_id') is not null then
      perform public.attendance_device_bind(p_device_fingerprint, v_employee_id, v_device.id);
    end if;
  else
    select id into v_open_attendance_id from public.attendance_records
     where employee_id = v_employee_id and attendance_date = (clock_timestamp() at time zone public.att_app_timezone())::date
       and clock_out is null order by clock_in desc limit 1;
    if v_open_attendance_id is null then return jsonb_build_object('success', false, 'error', 'You cannot clock out before clocking in today.'); end if;
    v_result := public.attendance_clock_out_for_employee(v_employee_id, v_open_attendance_id, p_lat, p_lng, p_accuracy, 'terminal', v_device.id, 'GPS', 'ATTENDANCE_TERMINAL');
  end if;
  update public.attendance_devices set last_seen_at = clock_timestamp() where id = v_device.id;
  return v_result || jsonb_build_object('success', true, 'terminal_id', v_device.id, 'public_terminal', true);
end;
$$;

 grant execute on function public.validate_attendance_terminal_employee(text, text, text) to anon, authenticated;
 grant execute on function public.clock_attendance_terminal(text, text, text, float, float, float, text) to anon, authenticated;
