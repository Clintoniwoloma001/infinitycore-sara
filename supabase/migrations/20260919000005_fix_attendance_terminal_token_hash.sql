-- Fix the QR-terminal token digest mismatch introduced by the prior repair.
--
-- The terminal URL contains the hexadecimal representation of random bytes.
-- Validators correctly hash that URL text, but the prior generator stored a
-- digest of the underlying bytes instead.  Thus a newly generated token could
-- never match its stored digest.  Keep the original raw-byte form accepted so
-- links issued before this migration recover without being regenerated.

create or replace function public.attendance_terminal_token_matches(
  p_stored_hash text,
  p_token text
) returns boolean
language plpgsql
immutable
set search_path = public, extensions
as $$
begin
  if p_stored_hash = encode(
    extensions.digest(convert_to(coalesce(p_token, ''), 'UTF8'), 'sha256'),
    'hex'
  ) then
    return true;
  end if;

  -- Compatibility for tokens created by 20260919000002, which hashed the
  -- decoded random bytes rather than the hexadecimal URL token text.
  if coalesce(p_token, '') ~ '^[0-9A-Fa-f]{64}$' then
    return p_stored_hash = encode(extensions.digest(decode(p_token, 'hex'), 'sha256'), 'hex');
  end if;

  return false;
end;
$$;

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
      values (coalesce(nullif(trim(p_device_name), ''), 'QR Attendance Terminal'),
              'attendance_terminal', 'active', true, auth.uid())
      returning * into v_device;
    end if;
  else
    select * into v_device from public.attendance_devices where id = p_device_id for update;
    if not found or v_device.device_type <> 'attendance_terminal' then
      raise exception 'Attendance terminal not found.';
    end if;
  end if;

  -- Hash the exact string carried by the QR URL.  This matches all public
  -- terminal validation and clocking functions.
  update public.attendance_devices
     set device_token = encode(
           extensions.digest(convert_to(v_raw, 'UTF8'), 'sha256'), 'hex'
         ),
         status = 'active',
         active = true,
         updated_at = now()
   where id = v_device.id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_TERMINAL_TOKEN_REGENERATED', 'AttendanceDevice', v_device.id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    jsonb_build_object('module', 'attendance', 'device_name', v_device.device_name, 'success', true)::text,
    'warning'
  );

  return jsonb_build_object(
    'ok', true, 'device_id', v_device.id, 'device_name', v_device.device_name,
    'token', v_raw, 'generated_at', clock_timestamp()
  );
end;
$$;

-- Route every public terminal gate through the compatibility-aware matcher.
create or replace function public.validate_attendance_terminal_location(
  p_token text, p_employee_identifier text, p_lat float, p_lng float, p_event_type text
) returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare v_employee_id uuid; v_location jsonb;
begin
  if p_event_type not in ('CLOCK_IN', 'CLOCK_OUT') then
    return jsonb_build_object('valid', false, 'error', 'Choose Clock In or Clock Out.');
  end if;
  if not exists (
    select 1 from public.attendance_devices d
     where d.device_type = 'attendance_terminal' and d.status = 'active' and d.active = true
       and public.attendance_terminal_token_matches(d.device_token, p_token)
  ) then
    return jsonb_build_object('valid', false, 'error', 'This attendance terminal link is invalid or revoked.');
  end if;
  v_employee_id := public.resolve_attendance_terminal_employee(p_employee_identifier);
  if v_employee_id is null then return jsonb_build_object('valid', false, 'error', 'Employee number or email could not be verified.'); end if;
  v_location := public.attendance_validate_location(v_employee_id, p_lat, p_lng,
    case when p_event_type = 'CLOCK_OUT' then 'clock_out' else 'clock_in' end, null);
  return jsonb_build_object('valid', true) || v_location;
end;
$$;

create or replace function public.validate_attendance_terminal_employee(
  p_token text, p_employee_identifier text
) returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_employee_id uuid; v_employee public.employees%rowtype; v_record public.attendance_records%rowtype;
  v_today date := (clock_timestamp() at time zone public.att_app_timezone())::date; v_next_action text;
begin
  if not exists (
    select 1 from public.attendance_devices d
     where d.device_type = 'attendance_terminal' and d.status = 'active' and d.active = true
       and public.attendance_terminal_token_matches(d.device_token, p_token)
  ) then return jsonb_build_object('valid', false, 'error', 'This attendance terminal link is invalid or revoked.'); end if;
  v_employee_id := public.resolve_attendance_terminal_employee(p_employee_identifier);
  if v_employee_id is null then return jsonb_build_object('valid', false, 'error', 'Employee number or email could not be verified.'); end if;
  select * into v_employee from public.employees where id = v_employee_id;
  select * into v_record from public.attendance_records where employee_id = v_employee_id and attendance_date = v_today limit 1;
  v_next_action := case when not found then 'CLOCK_IN' when v_record.clock_out is null then 'CLOCK_OUT' else 'COMPLETE' end;
  return jsonb_build_object('valid', true, 'employee_name', v_employee.full_name,
    'employee_number', coalesce(v_employee.employee_number, v_employee.staff_id, v_employee.employee_code),
    'next_action', v_next_action);
end;
$$;

create or replace function public.clock_attendance_terminal(
  p_token text, p_employee_identifier text, p_event_type text, p_lat float, p_lng float, p_accuracy float default null
) returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_device public.attendance_devices%rowtype; v_employee_id uuid; v_open_attendance_id uuid;
  v_result jsonb; v_identifier_hash text; v_attempts integer;
begin
  if p_event_type not in ('CLOCK_IN', 'CLOCK_OUT') then return jsonb_build_object('success', false, 'error', 'Choose Clock In or Clock Out.'); end if;
  if trim(coalesce(p_employee_identifier, '')) = '' then return jsonb_build_object('success', false, 'error', 'Enter your employee number or email.'); end if;
  if p_lat is null or p_lng is null then return jsonb_build_object('success', false, 'error', 'LOCATION_REQUIRED:Location is required to record attendance. Please enable location access.'); end if;
  select * into v_device from public.attendance_devices
   where device_type = 'attendance_terminal' and status = 'active' and active = true
     and public.attendance_terminal_token_matches(device_token, p_token) limit 1;
  if not found then return jsonb_build_object('success', false, 'error', 'This attendance terminal link is invalid or revoked.'); end if;
  v_identifier_hash := encode(extensions.digest(convert_to(upper(trim(p_employee_identifier)), 'UTF8'), 'sha256'), 'hex');
  select count(*) into v_attempts from public.attendance_terminal_attempts
   where terminal_id = v_device.id and identifier_hash = v_identifier_hash
     and attempted_at > clock_timestamp() - interval '5 minutes';
  if v_attempts >= 10 then return jsonb_build_object('success', false, 'error', 'Too many attempts. Please wait and try again.'); end if;
  insert into public.attendance_terminal_attempts (terminal_id, identifier_hash) values (v_device.id, v_identifier_hash);
  v_employee_id := public.resolve_attendance_terminal_employee(p_employee_identifier);
  if v_employee_id is null then return jsonb_build_object('success', false, 'error', 'Employee number or email could not be verified.'); end if;
  if p_event_type = 'CLOCK_IN' then
    v_result := public.attendance_clock_in_for_employee(v_employee_id, p_lat, p_lng, p_accuracy, 'terminal', v_device.id, 'GPS', 'ATTENDANCE_TERMINAL');
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

revoke all on function public.attendance_terminal_token_matches(text, text) from public;
revoke all on function public.create_attendance_terminal_token(uuid, text) from public;
revoke all on function public.validate_attendance_terminal_location(text, text, float, float, text) from public;
revoke all on function public.validate_attendance_terminal_employee(text, text) from public;
revoke all on function public.clock_attendance_terminal(text, text, text, float, float, float) from public;
grant execute on function public.create_attendance_terminal_token(uuid, text) to authenticated;
grant execute on function public.validate_attendance_terminal_location(text, text, float, float, text) to anon, authenticated;
grant execute on function public.validate_attendance_terminal_employee(text, text) to anon, authenticated;
grant execute on function public.clock_attendance_terminal(text, text, text, float, float, float) to anon, authenticated;
