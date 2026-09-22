-- ---------------------------------------------------------------------------
-- InfinityCore Mobile — phase 3: hardened device-binding + attendance
-- security metadata, admin filtering, and management summary.
--
-- Assumes phase 1 (mobile_device_sessions + mobile_clock_*) and phase 2
-- (device binding + biometric enforcement RPCs) are already applied. Every
-- change is additive/idempotent.
--
-- What changes:
--   * mobile_device_sessions gains last_attendance_at (drives the admin
--     "Last Used" column and the employee's "Last attendance" row).
--   * mobile_device_register() now also records the platform (iOS/Android)
--     so the server holds accurate device metadata without needing any
--     biometric information.
--   * attendance_records gains mobile security metadata columns
--     (session/device/platform/app version/biometric result). Only the
--     biometric assertion *result* is stored — never a template or image.
--   * mobile_clock_in / mobile_clock_out stamp that metadata onto the
--     attendance record and refresh the session's last_attendance_at.
--   * mobile_list_authorized_devices() gets Super Admin / Head of HR
--     filtering by employee/branch/department/platform/status/biometric
--     status, and returns branch + department for display.
--   * NEW mobile_device_management_summary() returns the summary stats shown
--     on the Bound App Devices screen (Super Admin / Head of HR only).
--
-- Web access is untouched: every enforcement point is inside the mobile RPC
-- layer; nothing here changes web auth, HR dashboards, or ordinary logins.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. SESSIONS TABLE — last attendance action
-- ---------------------------------------------------------------------------
alter table public.mobile_device_sessions
  add column if not exists last_attendance_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. ATTENDANCE RECORDS — mobile security metadata (result only, never
--    biometric data)
-- ---------------------------------------------------------------------------
alter table public.attendance_records
  add column if not exists mobile_session_id uuid,
  add column if not exists mobile_device_id text,
  add column if not exists mobile_platform text,
  add column if not exists mobile_app_version text,
  add column if not exists mobile_biometric_verified boolean not null default false;

create index if not exists ix_attendance_records_mobile_session
  on public.attendance_records (mobile_session_id)
  where mobile_session_id is not null;

-- ---------------------------------------------------------------------------
-- 3. REGISTER NOW RECORDS PLATFORM (new argument; old overloads dropped) — we
--    drop every legacy register signature so a stale client can never trigger
--    the phase-1 "silently supersede the other device" path again.
-- ---------------------------------------------------------------------------
drop function if exists public.mobile_device_register(text);
drop function if exists public.mobile_device_register(text,text,text,text,text);

create or replace function public.mobile_device_register(
  p_device_id text,
  p_device_model text default null,
  p_os_version text default null,
  p_app_version text default null,
  p_biometric_capability text default 'none',
  p_platform text default 'mobile'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_session_id uuid;
  v_employee_id uuid;
  v_existing record;
begin
  if auth.uid() is null then raise exception 'Not authenticated.'; end if;
  if coalesce(p_device_id, '') = '' then
    raise exception 'MOBILE_SESSION:Missing device identity.';
  end if;

  select id into v_employee_id
    from public.employees
   where user_id = auth.uid()
     and coalesce(is_archived, false) = false
   order by created_at desc
   limit 1;

  -- Enforce one active mobile device per user. Do not silently replace.
  select * into v_existing
    from public.mobile_device_sessions
   where user_id = auth.uid()
     and is_active = true
     and device_id is distinct from p_device_id
   limit 1;

  if found then
    perform public.mobile_audit_log(
      'MOBILE_UNAUTHORIZED_DEVICE',
      'MobileDeviceSession',
      v_existing.id::text,
      format('Attempt to register device %s while %s is already active for user %s',
             p_device_id, v_existing.device_id, auth.uid()),
      'warning'
    );
    raise exception 'MOBILE_UNAUTHORIZED_DEVICE:This account is already linked to another mobile device. Please contact HR or Super Admin to authorize this device.';
  end if;

  insert into public.mobile_device_sessions (
    user_id, employee_id, device_id, device_model, os_version,
    app_version, platform, biometric_capability, status, is_active
  )
  values (
    auth.uid(), v_employee_id, p_device_id, p_device_model, p_os_version,
    p_app_version, coalesce(nullif(p_platform, ''), 'mobile'),
    p_biometric_capability, 'active', true
  )
  on conflict (user_id) where is_active is true
  do update set
    employee_id = excluded.employee_id,
    device_model = coalesce(excluded.device_model, public.mobile_device_sessions.device_model),
    os_version = coalesce(excluded.os_version, public.mobile_device_sessions.os_version),
    app_version = coalesce(excluded.app_version, public.mobile_device_sessions.app_version),
    platform = coalesce(excluded.platform, public.mobile_device_sessions.platform),
    biometric_capability = coalesce(excluded.biometric_capability, public.mobile_device_sessions.biometric_capability),
    last_seen_at = clock_timestamp(),
    status = 'active'
  returning id into v_session_id;

  perform public.mobile_audit_log(
    'MOBILE_DEVICE_LINKED',
    'MobileDeviceSession',
    v_session_id::text,
    format('Device %s registered for user %s (platform %s)', p_device_id, auth.uid(), coalesce(p_platform, 'mobile')),
    'info'
  );

  return jsonb_build_object(
    'ok', true,
    'session_id', v_session_id,
    'employee_id', v_employee_id,
    'device_id', p_device_id,
    'reason', 'registered'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. VALIDATE REFRESHES LAST_ATTENDANCE_SOURCE (additive return fields)
-- ---------------------------------------------------------------------------
create or replace function public.mobile_device_validate(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_session record;
begin
  if auth.uid() is null then raise exception 'Not authenticated.'; end if;

  select * into v_session
    from public.mobile_device_sessions
   where user_id = auth.uid()
     and is_active = true
   order by created_at desc
   limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_session', 'code', 'NO_SESSION');
  end if;

  if v_session.device_id is distinct from p_device_id then
    perform public.mobile_audit_log(
      'MOBILE_UNAUTHORIZED_DEVICE',
      'MobileDeviceSession',
      v_session.id::text,
      format('Validation mismatch: expected %s, got %s', v_session.device_id, p_device_id),
      'warning'
    );
    return jsonb_build_object(
      'ok', false,
      'reason', 'device_mismatch',
      'code', 'WRONG_DEVICE',
      'message', 'MOBILE_SESSION:Signed in on another device. Re-authenticate here to continue.'
    );
  end if;

  update public.mobile_device_sessions
     set last_seen_at = clock_timestamp(), last_verified_at = clock_timestamp()
   where id = v_session.id;

  return jsonb_build_object(
    'ok', true,
    'session_id', v_session.id,
    'employee_id', v_session.employee_id,
    'device_id', v_session.device_id,
    'device_model', v_session.device_model,
    'platform', v_session.platform,
    'os_version', v_session.os_version,
    'app_version', v_session.app_version,
    'biometric_enabled', v_session.biometric_enabled,
    'biometric_capability', v_session.biometric_capability,
    'linked_at', v_session.linked_at,
    'last_authenticated_at', v_session.last_authenticated_at,
    'last_attendance_at', v_session.last_attendance_at
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. ATTENDANCE ACTIONS — stamp mobile security metadata. Only the assertion
--    result (biometric_verified bool) and device/session metadata are stored.
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
  p_app_build text default null
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

  v_result := public.attendance_clock_in_for_employee(
    v_employee_id, p_lat, p_lng, p_accuracy,
    'mobile', null, 'BIOMETRIC+GPS', 'MOBILE', null, false
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
    format('Clock-in authorized for employee %s on device %s', v_employee_id, p_device_id),
    'info'
  );

  return v_result || jsonb_build_object(
    'server_time', v_result ->> 'clock_in_at',
    'verification_method', 'BIOMETRIC+GPS',
    'session_id', v_session_id
  );
end;
$$;

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
  p_app_build text default null
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

  v_result := public.attendance_clock_out_for_employee(
    v_employee_id, p_attendance_id, p_lat, p_lng, p_accuracy,
    'mobile', null, 'BIOMETRIC+GPS', 'MOBILE', null, false
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
    format('Clock-out authorized for employee %s on device %s', v_employee_id, p_device_id),
    'info'
  );

  return v_result || jsonb_build_object(
    'server_time', v_result ->> 'clock_out_at',
    'verification_method', 'BIOMETRIC+GPS',
    'session_id', v_session_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. ADMIN DEVICE MANAGEMENT (Super Admin / Head of HR only) — filtering and
--    summary. Device identifiers remain hidden from ordinary users; these
--    RPCs enforce the role server-side.
-- ---------------------------------------------------------------------------

drop function if exists public.mobile_list_authorized_devices(text);

create or replace function public.mobile_list_authorized_devices(
  p_search text default null,
  p_branch_id uuid default null,
  p_department text default null,
  p_platform text default null,
  p_status text default null,
  p_biometric_status text default null
)
returns table (
  session_id uuid,
  user_id uuid,
  employee_id uuid,
  employee_name text,
  employee_number text,
  email text,
  department text,
  branch_id uuid,
  branch_name text,
  device_id text,
  device_model text,
  platform text,
  os_version text,
  app_version text,
  biometric_capability text,
  biometric_enabled boolean,
  linked_at timestamptz,
  last_authenticated_at timestamptz,
  last_seen_at timestamptz,
  last_attendance_at timestamptz,
  created_at timestamptz,
  status text,
  revoked_at timestamptz,
  revoked_by uuid,
  revoked_reason text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if public.current_role() not in ('super_admin', 'head_of_human_resources') then
    raise exception 'Not authorized to manage mobile device bindings.';
  end if;

  return query
  select
    s.id,
    s.user_id,
    s.employee_id,
    e.full_name,
    coalesce(e.employee_number, e.staff_id, e.employee_code),
    u.email,
    e.department,
    e.branch_id,
    b.branch_name,
    s.device_id,
    s.device_model,
    s.platform,
    s.os_version,
    s.app_version,
    s.biometric_capability,
    s.biometric_enabled,
    s.linked_at,
    s.last_authenticated_at,
    s.last_seen_at,
    s.last_attendance_at,
    s.created_at,
    s.status,
    s.revoked_at,
    s.revoked_by,
    s.revoked_reason
  from public.mobile_device_sessions s
  left join public.employees e on e.id = s.employee_id
  left join auth.users u on u.id = s.user_id
  left join public.branches b on b.id = e.branch_id
  where (p_search is null or p_search = ''
         or e.full_name ilike '%' || p_search || '%'
         or u.email ilike '%' || p_search || '%'
         or coalesce(e.employee_number, e.staff_id, e.employee_code) ilike '%' || p_search || '%'
         or s.device_id ilike '%' || p_search || '%')
    and (p_branch_id is null or e.branch_id = p_branch_id)
    and (p_department is null or p_department = '' or e.department ilike p_department)
    and (p_platform is null or p_platform = ''
         or (lower(p_platform) = 'other' and s.platform is not distinct from 'mobile')
         or s.platform = lower(p_platform))
    and (p_status is null or p_status = '' or s.status = lower(p_status))
    and (p_biometric_status is null or p_biometric_status = ''
         or (lower(p_biometric_status) = 'enabled' and s.biometric_enabled is true)
         or (lower(p_biometric_status) = 'disabled' and s.biometric_enabled is false))
  order by s.created_at desc
  limit 1000;
end;
$$;

create or replace function public.mobile_device_management_summary()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_employees bigint;
  v_bound bigint;
  v_biometric bigint;
  v_awaiting bigint;
  v_revoked bigint;
begin
  if public.current_role() not in ('super_admin', 'head_of_human_resources') then
    raise exception 'Not authorized to manage mobile device bindings.';
  end if;

  select count(distinct employee_id) into v_employees
    from public.mobile_device_sessions
   where employee_id is not null;

  select count(*) into v_bound
    from public.mobile_device_sessions
   where is_active is true;

  select count(*) into v_biometric
    from public.mobile_device_sessions
   where is_active is true
     and biometric_enabled is true;

  select count(*) into v_awaiting
    from public.mobile_device_sessions
   where is_active is true
     and biometric_enabled is false;

  select count(*) into v_revoked
    from public.mobile_device_sessions
   where status = 'revoked';

  return jsonb_build_object(
    'employees_linked', coalesce(v_employees, 0),
    'bound_devices', coalesce(v_bound, 0),
    'biometric_enabled', coalesce(v_biometric, 0),
    'awaiting_biometric_setup', coalesce(v_awaiting, 0),
    'revoked_devices', coalesce(v_revoked, 0)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. PERMISSIONS
-- ---------------------------------------------------------------------------
grant execute on function public.mobile_device_register(text,text,text,text,text,text) to authenticated;
grant execute on function public.mobile_device_validate(text) to authenticated;
grant execute on function public.mobile_device_revoke(text,text) to authenticated;
grant execute on function public.mobile_device_link_biometric(text) to authenticated;
grant execute on function public.mobile_device_authenticate_biometric(text,boolean) to authenticated;
grant execute on function public.mobile_clock_in(float, float, float, text, uuid, text, text, boolean, text) to authenticated;
grant execute on function public.mobile_clock_out(uuid, float, float, float, text, uuid, text, text, boolean, text) to authenticated;
grant execute on function public.mobile_attendance_summary(date, date, uuid, text) to authenticated;
grant execute on function public.mobile_list_authorized_devices(text, uuid, text, text, text, text) to authenticated;
grant execute on function public.mobile_admin_revoke_device(uuid, text) to authenticated;
grant execute on function public.mobile_device_management_summary() to authenticated;

revoke execute on function public.mobile_device_register(text,text,text,text,text,text) from anon, public;
revoke execute on function public.mobile_device_validate(text) from anon, public;
revoke execute on function public.mobile_device_revoke(text,text) from anon, public;
revoke execute on function public.mobile_device_link_biometric(text) from anon, public;
revoke execute on function public.mobile_device_authenticate_biometric(text,boolean) from anon, public;
revoke execute on function public.mobile_clock_in(float, float, float, text, uuid, text, text, boolean, text) from anon, public;
revoke execute on function public.mobile_clock_out(uuid, float, float, float, text, uuid, text, text, boolean, text) from anon, public;
revoke execute on function public.mobile_attendance_summary(date, date, uuid, text) from anon, public;
revoke execute on function public.mobile_list_authorized_devices(text, uuid, text, text, text, text) from anon, public;
revoke execute on function public.mobile_admin_revoke_device(uuid, text) from anon, public;
revoke execute on function public.mobile_device_management_summary() from anon, public;