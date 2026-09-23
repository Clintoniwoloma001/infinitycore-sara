-- ---------------------------------------------------------------------------
-- Phase 04 — In-app QR attendance-terminal flow.
--
-- Recreates mobile_clock_in / mobile_clock_out so the mobile app can anchor a
-- clock action to a scanned attendance terminal. The scanned terminal token
-- is validated by the server BEFORE any attendance write, and the terminal is
-- threaded through the canonical clock functions (device_id + verification
-- method) so existing geofence / device-day / one-record-per-day semantics are
-- untouched. The phone's own device binding (attendance_device_bind + the
-- mobile session guard) continues to apply exactly as it does for a normal
-- mobile clock.
--
-- Mirrored as sara: 20260922000013_mobile_qr_terminal.sql
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. DROP old signatures (avoid overload ambiguity for named-arg RPC calls).
-- ---------------------------------------------------------------------------
drop function if exists public.mobile_clock_in(float, float, float, text, uuid, text, text, boolean, text);
drop function if exists public.mobile_clock_out(uuid, float, float, float, text, uuid, text, text, boolean, text);

-- ---------------------------------------------------------------------------
-- 2. mobile_clock_in — appended p_terminal_id / p_entry_point.
--    Existing named parameters are unchanged so current clients keep working.
-- ---------------------------------------------------------------------------
create or replace function public.mobile_clock_in(
  p_lat float,
  p_lng float,
  p_accuracy float default 0,
  p_device_fingerprint text default '',
  p_employee_id uuid default null,
  p_device_id text default 'app',
  p_app_version text default null,
  p_biometric_used boolean default false,
  p_app_build text default null,
  p_terminal_id uuid default null,
  p_entry_point text default 'mobile'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_employee_id uuid;
  v_result jsonb;
  v_session_id uuid;
  v_session record;
  v_entry_point text := 'MOBILE';
  v_verification text := 'BIOMETRIC+GPS';
  v_terminal_device_id uuid;
begin
  if p_biometric_used is not true then
    raise exception 'BIOMETRIC_REQUIRED:Attendance requires a successful biometric assertion on this device.';
  end if;

  v_employee_id := public.mobile_session_guard(
    p_employee_id, p_device_id, p_device_fingerprint, 'CLOCK_IN'
  );

  select * into v_session
    from public.mobile_device_sessions
   where user_id = auth.uid()
     and is_active = true
     and device_id = p_device_id
   limit 1;

  if not found then
    raise exception 'MOBILE_SESSION:Cannot verify this device. Re-authenticate to continue.';
  end if;
  v_session_id := v_session.id;

  if p_terminal_id is not null then
    select id into v_terminal_device_id
      from public.attendance_devices
     where id = p_terminal_id
       and device_type = 'attendance_terminal'
       and active = true
       and status = 'active';
    if not found then
      raise exception 'TERMINAL_INACTIVE:This attendance terminal is not active. Contact HR.';
    end if;
    v_entry_point := coalesce(nullif(lower(p_entry_point), ''), 'mobile_qr_terminal');
    if v_entry_point <> 'mobile_qr_terminal' then
      v_entry_point := 'MOBILE_QR_TERMINAL';
    end if;
    v_entry_point := upper(v_entry_point);
    v_verification := 'BIOMETRIC+GPS+QR';
  end if;

  v_result := public.attendance_clock_in_for_employee(
    v_employee_id, p_lat, p_lng, p_accuracy,
    'mobile', v_terminal_device_id, v_verification, v_entry_point, null, false
  );

  update public.attendance_records
     set mobile_session_id = v_session_id,
         mobile_device_id = p_device_id,
         mobile_platform = coalesce(nullif(v_session.platform, ''), 'mobile'),
         mobile_app_version = coalesce(p_app_version, v_session.app_version),
         mobile_biometric_verified = true
   where id = (v_result ->> 'id')::uuid;

  update public.mobile_device_sessions
     set last_attendance_at = clock_timestamp()
   where id = v_session_id;

  perform public.attendance_device_bind(p_device_fingerprint, v_employee_id, null);

  perform public.mobile_audit_log(
    'MOBILE_ATTENDANCE_AUTHORIZED',
    'AttendanceRecord',
    (v_result ->> 'id')::text,
    format('Clock-in authorized for employee %s on device %s %s', v_employee_id, p_device_id,
           case when p_terminal_id is not null then format('via terminal %s', p_terminal_id) else '' end),
    'info'
  );

  return v_result || jsonb_build_object(
    'server_time', v_result ->> 'clock_in_at',
    'verification_method', v_verification,
    'source_detail', v_entry_point,
    'session_id', v_session_id,
    'terminal_id', case when p_terminal_id is not null then p_terminal_id else null end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. mobile_clock_out — appended p_terminal_id / p_entry_point.
-- ---------------------------------------------------------------------------
create or replace function public.mobile_clock_out(
  p_attendance_id uuid,
  p_lat float,
  p_lng float,
  p_accuracy float default 0,
  p_device_fingerprint text default '',
  p_employee_id uuid default null,
  p_device_id text default 'app',
  p_app_version text default null,
  p_biometric_used boolean default false,
  p_app_build text default null,
  p_terminal_id uuid default null,
  p_entry_point text default 'mobile'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_employee_id uuid;
  v_result jsonb;
  v_session_id uuid;
  v_session record;
  v_entry_point text := 'MOBILE';
  v_verification text := 'BIOMETRIC+GPS';
  v_terminal_device_id uuid;
begin
  if p_biometric_used is not true then
    raise exception 'BIOMETRIC_REQUIRED:Attendance requires a successful biometric assertion on this device.';
  end if;

  v_employee_id := public.mobile_session_guard(
    p_employee_id, p_device_id, p_device_fingerprint, 'CLOCK_OUT'
  );

  select * into v_session
    from public.mobile_device_sessions
   where user_id = auth.uid()
     and is_active = true
     and device_id = p_device_id
   limit 1;

  if not found then
    raise exception 'MOBILE_SESSION:Cannot verify this device. Re-authenticate to continue.';
  end if;
  v_session_id := v_session.id;

  if p_terminal_id is not null then
    select id into v_terminal_device_id
      from public.attendance_devices
     where id = p_terminal_id
       and device_type = 'attendance_terminal'
       and active = true
       and status = 'active';
    if not found then
      raise exception 'TERMINAL_INACTIVE:This attendance terminal is not active. Contact HR.';
    end if;
    v_entry_point := upper(coalesce(nullif(lower(p_entry_point), ''), 'mobile_qr_terminal'));
    v_verification := 'BIOMETRIC+GPS+QR';
  end if;

  v_result := public.attendance_clock_out_for_employee(
    v_employee_id, p_attendance_id, p_lat, p_lng, p_accuracy,
    'mobile', v_terminal_device_id, v_verification, v_entry_point, null, false
  );

  update public.attendance_records
     set mobile_session_id = v_session_id,
         mobile_device_id = p_device_id,
         mobile_platform = coalesce(nullif(v_session.platform, ''), 'mobile'),
         mobile_app_version = coalesce(p_app_version, v_session.app_version),
         mobile_biometric_verified = true
   where id = p_attendance_id;

  update public.mobile_device_sessions
     set last_attendance_at = clock_timestamp()
   where id = v_session_id;

  perform public.attendance_device_bind(p_device_fingerprint, v_employee_id, null);

  perform public.mobile_audit_log(
    'MOBILE_ATTENDANCE_AUTHORIZED',
    'AttendanceRecord',
    p_attendance_id::text,
    format('Clock-out authorized for employee %s on device %s %s', v_employee_id, p_device_id,
           case when p_terminal_id is not null then format('via terminal %s', p_terminal_id) else '' end),
    'info'
  );

  return v_result || jsonb_build_object(
    'server_time', v_result ->> 'clock_out_at',
    'verification_method', v_verification,
    'source_detail', v_entry_point,
    'session_id', v_session_id,
    'terminal_id', case when p_terminal_id is not null then p_terminal_id else null end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. mobile_qr_terminal_inspect — validate a scanned token BEFORE any write.
--    Token resolution uses attendance_terminal_view_links (the raw token the
--    QR encodes, one current token per terminal) with belt-and-braces checks
--    against attendance_devices state.
-- ---------------------------------------------------------------------------
create or replace function public.mobile_qr_terminal_inspect(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_link record;
  v_device record;
  v_valid boolean := false;
  v_message text;
  v_id uuid;
  v_name text;
  v_status text;
  v_active boolean := false;
begin
  if p_token is null or trim(p_token) = '' then
    return jsonb_build_object('valid', false, 'message', 'Missing terminal token.');
  end if;

  select vl.* into v_link
    from public.attendance_terminal_view_links vl
   where vl.token_hex = trim(p_token)
   limit 1;

  if not found then
    return jsonb_build_object('valid', false, 'message', 'This terminal code is not valid. Ask the organizer to refresh the terminal QR code.');
  end if;

  select d.* into v_device
    from public.attendance_devices d
   where d.id = v_link.device_id
     and d.device_type = 'attendance_terminal'
   limit 1;

  if not found then
    return jsonb_build_object('valid', false, 'message', 'This terminal code is not valid. Ask the organizer to refresh the terminal QR code.');
  end if;

  if v_device.status = 'active' and v_device.active is true then
    v_valid := true;
    v_message := 'OK';
    v_id := v_device.id;
    v_name := coalesce(v_device.device_name, 'Attendance Terminal');
    v_status := v_device.status;
    v_active := true;
  elsif v_device.status in ('suspended', 'disabled') then
    v_message := 'This attendance terminal is temporarily suspended. Contact HR.';
  else
    v_message := 'This attendance terminal is not active. Contact HR.';
  end if;

  return jsonb_build_object(
    'valid', v_valid,
    'message', v_message,
    'terminal_id', v_id,
    'terminal_name', v_name,
    'status', v_status,
    'active', v_active,
    'area', null,
    'latitude', null,
    'longitude', null,
    'geofence_status', null
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. PERMISSIONS
-- ---------------------------------------------------------------------------
grant execute on function public.mobile_clock_in(float, float, float, text, uuid, text, text, boolean, text, uuid, text) to authenticated;
grant execute on function public.mobile_clock_out(uuid, float, float, float, text, uuid, text, text, boolean, text, uuid, text) to authenticated;
grant execute on function public.mobile_qr_terminal_inspect(text) to authenticated;

revoke execute on function public.mobile_clock_in(float, float, float, text, uuid, text, text, boolean, text, uuid, text) from anon, public;
revoke execute on function public.mobile_clock_out(uuid, float, float, float, text, uuid, text, text, boolean, text, uuid, text) from anon, public;
revoke execute on function public.mobile_qr_terminal_inspect(text) from anon, public;