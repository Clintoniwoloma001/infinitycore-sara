-- ---------------------------------------------------------------------------
-- InfinityCore Mobile — phase 2: device binding + native biometric security.
--
-- Hardens the mobile attendance flow without touching normal web access.
-- Assumes phase 1 (mobile_device_sessions + mobile_clock_*) has already been
-- applied. Every change is additive/idempotent.
--
-- What changes:
--   * mobile_device_sessions gains explicit device-model, OS, biometric
--     capability, linked_at, last_authenticated_at, status, revoked_by.
--   * mobile_device_register() now BLOCKS a second active device instead of
--     silently superseding it. HR/Super Admin must unbind the old device first.
--   * New RPCs:
--       - mobile_device_link_biometric()
--       - mobile_device_authenticate_biometric()
--       - mobile_list_authorized_devices() (Super Admin / Head of HR only)
--       - mobile_admin_revoke_device()       (Super Admin / Head of HR only)
--   * mobile_clock_in / mobile_clock_out now require an active device session
--     whose biometric flag is enabled and whose last_authenticated_at is within
--     the last 5 minutes.
--   * Audit events are written for device/biometric/security actions.
--
-- No biometric template, image, or raw biometric data is ever stored.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. ENSURE THE BASE SESSIONS TABLE EXISTS (created by 20260922000006, but
--    the biometric migration must be safe to run standalone in any order).
-- ---------------------------------------------------------------------------
create table if not exists public.mobile_device_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  employee_id uuid references public.employees(id) on delete set null,
  device_id text not null,
  device_name text,
  platform text default 'mobile',
  app_version text,
  app_build text,
  fingerprint text,
  biometric_enabled boolean not null default false,
  is_active boolean not null default true,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz,
  last_verified_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text
);

create unique index if not exists uq_mobile_device_sessions_one_active
  on public.mobile_device_sessions (user_id) where is_active is true;

alter table public.mobile_device_sessions enable row level security;
revoke all on public.mobile_device_sessions from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- 2. EXTEND THE SESSIONS TABLE
-- ---------------------------------------------------------------------------
alter table public.mobile_device_sessions
  add column if not exists device_model text,
  add column if not exists os_version text,
  add column if not exists biometric_capability text default 'none',
  add column if not exists linked_at timestamptz,
  add column if not exists last_authenticated_at timestamptz,
  add column if not exists revoked_by uuid references auth.users(id) on delete set null,
  add column if not exists status text not null default 'active';

-- Back-fill status for rows created before this migration.
update public.mobile_device_sessions
   set status = case when is_active then 'active' else 'revoked' end
 where status is null;

-- ---------------------------------------------------------------------------
-- 2. AUDIT HELPER
-- ---------------------------------------------------------------------------
create or replace function public.mobile_audit_log(
  p_action text,
  p_entity_type text default 'MobileDeviceSession',
  p_entity_id text default null,
  p_details text default null,
  p_severity text default 'info'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_logs (action, entity_type, entity_id, details, severity, user_name)
  values (
    p_action,
    p_entity_type,
    p_entity_id,
    p_details,
    p_severity,
    coalesce(current_user, 'unknown')
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. SESSION LIFECYCLE (re-create with new signatures / behavior)
-- ---------------------------------------------------------------------------

-- Register the calling user's mobile device. If the user already has an active
-- session on a DIFFERENT device, block registration. HR/Super Admin must
-- unbind the old device first.
drop function if exists public.mobile_device_register(text);
create or replace function public.mobile_device_register(
  p_device_id text,
  p_device_model text default null,
  p_os_version text default null,
  p_app_version text default null,
  p_biometric_capability text default 'none'
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
    app_version, biometric_capability, status, is_active
  )
  values (
    auth.uid(), v_employee_id, p_device_id, p_device_model, p_os_version,
    p_app_version, p_biometric_capability, 'active', true
  )
  on conflict (user_id) where is_active is true
  do update set
    employee_id = excluded.employee_id,
    device_model = coalesce(excluded.device_model, public.mobile_device_sessions.device_model),
    os_version = coalesce(excluded.os_version, public.mobile_device_sessions.os_version),
    app_version = coalesce(excluded.app_version, public.mobile_device_sessions.app_version),
    biometric_capability = coalesce(excluded.biometric_capability, public.mobile_device_sessions.biometric_capability),
    last_seen_at = clock_timestamp(),
    status = 'active'
  returning id into v_session_id;

  perform public.mobile_audit_log(
    'MOBILE_DEVICE_LINKED',
    'MobileDeviceSession',
    v_session_id::text,
    format('Device %s registered for user %s', p_device_id, auth.uid()),
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

-- Record that the user explicitly linked/verified native biometric auth.
create or replace function public.mobile_device_link_biometric(p_device_id text)
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
     and device_id = p_device_id
   limit 1;

  if not found then
    raise exception 'MOBILE_SESSION:No active device session. Re-authenticate to continue.';
  end if;

  update public.mobile_device_sessions
     set biometric_enabled = true,
         linked_at = coalesce(linked_at, clock_timestamp()),
         last_authenticated_at = clock_timestamp()
   where id = v_session.id;

  perform public.mobile_audit_log(
    'MOBILE_BIOMETRIC_ENABLED',
    'MobileDeviceSession',
    v_session.id::text,
    format('Biometric attendance enabled on device %s for user %s', p_device_id, auth.uid()),
    'info'
  );

  return jsonb_build_object('ok', true, 'session_id', v_session.id);
end;
$$;

-- Record a native biometric assertion result. On success, refresh the
-- last_authenticated_at window used by attendance functions.
create or replace function public.mobile_device_authenticate_biometric(
  p_device_id text,
  p_success boolean
)
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
     and device_id = p_device_id
   limit 1;

  if not found then
    raise exception 'MOBILE_SESSION:No active device session. Re-authenticate to continue.';
  end if;

  if p_success is true then
    update public.mobile_device_sessions
       set biometric_enabled = true,
           last_authenticated_at = clock_timestamp()
     where id = v_session.id;

    perform public.mobile_audit_log(
      'MOBILE_BIOMETRIC_SUCCESS',
      'MobileDeviceSession',
      v_session.id::text,
      format('Successful biometric assertion on device %s for user %s', p_device_id, auth.uid()),
      'info'
    );
    return jsonb_build_object('ok', true, 'session_id', v_session.id);
  else
    perform public.mobile_audit_log(
      'MOBILE_BIOMETRIC_FAILURE',
      'MobileDeviceSession',
      v_session.id::text,
      format('Failed biometric assertion on device %s for user %s', p_device_id, auth.uid()),
      'warning'
    );
    return jsonb_build_object('ok', false, 'reason', 'biometric_failed');
  end if;
end;
$$;

-- Validate the active session belongs to this device and refresh timestamps.
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
    'app_version', v_session.app_version,
    'platform', v_session.platform,
    'biometric_enabled', v_session.biometric_enabled,
    'linked_at', v_session.linked_at,
    'last_authenticated_at', v_session.last_authenticated_at
  );
end;
$$;

-- Revoke the caller's active session (sign-out / remote lockout).
create or replace function public.mobile_device_revoke(
  p_device_id text,
  p_reason text default 'client_sign_out'
)
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
     and (p_device_id is null or p_device_id = '' or device_id = p_device_id)
   limit 1;

  if found then
    update public.mobile_device_sessions
       set is_active = false,
           status = 'revoked',
           revoked_at = clock_timestamp(),
           revoked_reason = p_reason,
           revoked_by = auth.uid()
     where id = v_session.id;

    perform public.mobile_audit_log(
      'MOBILE_DEVICE_UNBOUND',
      'MobileDeviceSession',
      v_session.id::text,
      format('Device %s revoked by user %s: %s', v_session.device_id, auth.uid(), p_reason),
      'info'
    );
  end if;

  return jsonb_build_object('ok', true, 'revoked', found);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. ATTENDANCE ACTIONS — enforce device + biometric
-- ---------------------------------------------------------------------------

-- Shared guard now also asserts biometric readiness.
create or replace function public.mobile_session_guard(
  p_employee_id uuid,
  p_device_id text,
  p_fingerprint text,
  p_event_type text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_employee_id uuid;
  v_session record;
  v_binding jsonb;
  v_window interval := '5 minutes';
begin
  if auth.uid() is null then raise exception 'Not authenticated.'; end if;

  select * into v_session
    from public.mobile_device_sessions
   where user_id = auth.uid()
     and is_active = true
     and device_id = p_device_id
   limit 1;

  if not found then
    raise exception 'MOBILE_SESSION:Cannot verify this device. Re-authenticate to continue.';
  end if;

  if v_session.biometric_enabled is not true then
    raise exception 'BIOMETRIC_REQUIRED:Biometric attendance is not enabled on this device. Go to Profile → Biometric to set it up.';
  end if;

  if v_session.last_authenticated_at is null
     or v_session.last_authenticated_at < (clock_timestamp() - v_window) then
    raise exception 'BIOMETRIC_REQUIRED:Please verify with your device biometric before recording attendance.';
  end if;

  if p_employee_id is not null then
    select id into v_employee_id
      from public.employees
     where id = p_employee_id and user_id = auth.uid()
       and coalesce(is_archived, false) = false;
    if v_employee_id is null then
      raise exception 'MOBILE_SESSION:You can only record attendance for yourself.';
    end if;
  else
    select id into v_employee_id
      from public.employees
     where user_id = auth.uid()
       and coalesce(is_archived, false) = false
     order by created_at desc
     limit 1;
    if v_employee_id is null then
      raise exception 'PROFILE:No employee record linked to this account yet.';
    end if;
  end if;

  v_binding := public.attendance_device_binding_check(p_fingerprint, v_employee_id, p_event_type);
  if (v_binding ->> 'allowed')::boolean is distinct from true then
    raise exception 'DEVICE_BINDING:This device could not be linked to an employee for today.';
  end if;

  return v_employee_id;
end;
$$;

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
begin
  if p_biometric_used is not true then
    raise exception 'BIOMETRIC_REQUIRED:Attendance requires a successful biometric assertion on this device.';
  end if;

  v_employee_id := public.mobile_session_guard(
    p_employee_id, p_device_id, p_device_fingerprint, 'CLOCK_IN'
  );

  select id into v_session_id
    from public.mobile_device_sessions
   where user_id = auth.uid()
     and is_active = true
     and device_id = p_device_id;

  v_result := public.attendance_clock_in_for_employee(
    v_employee_id, p_lat, p_lng, p_accuracy,
    'mobile', null, 'BIOMETRIC+GPS', 'MOBILE', null, false
  );

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
begin
  if p_biometric_used is not true then
    raise exception 'BIOMETRIC_REQUIRED:Attendance requires a successful biometric assertion on this device.';
  end if;

  v_employee_id := public.mobile_session_guard(
    p_employee_id, p_device_id, p_device_fingerprint, 'CLOCK_OUT'
  );

  select id into v_session_id
    from public.mobile_device_sessions
   where user_id = auth.uid()
     and is_active = true
     and device_id = p_device_id;

  v_result := public.attendance_clock_out_for_employee(
    v_employee_id, p_attendance_id, p_lat, p_lng, p_accuracy,
    'mobile', null, 'BIOMETRIC+GPS', 'MOBILE', null, false
  );

  perform public.mobile_audit_log(
    'MOBILE_ATTENDANCE_AUTHORIZED',
    'AttendanceRecord',
    (v_result ->> 'id')::text,
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
-- 5. ADMIN DEVICE MANAGEMENT (Super Admin / Head of HR only)
-- ---------------------------------------------------------------------------

create or replace function public.mobile_list_authorized_devices(p_search text default null)
returns table (
  session_id uuid,
  user_id uuid,
  employee_id uuid,
  employee_name text,
  employee_number text,
  email text,
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
    s.created_at,
    s.status,
    s.revoked_at,
    s.revoked_by,
    s.revoked_reason
  from public.mobile_device_sessions s
  left join public.employees e on e.id = s.employee_id
  left join auth.users u on u.id = s.user_id
  where (p_search is null or p_search = ''
         or e.full_name ilike '%' || p_search || '%'
         or u.email ilike '%' || p_search || '%'
         or coalesce(e.employee_number, e.staff_id, e.employee_code) ilike '%' || p_search || '%'
         or s.device_id ilike '%' || p_search || '%')
  order by s.created_at desc
  limit 1000;
end;
$$;

create or replace function public.mobile_admin_revoke_device(
  p_session_id uuid,
  p_reason text default 'admin_revoke'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_session record;
begin
  if public.current_role() not in ('super_admin', 'head_of_human_resources') then
    raise exception 'Not authorized to manage mobile device bindings.';
  end if;

  select * into v_session
    from public.mobile_device_sessions
   where id = p_session_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Session not found.');
  end if;

  update public.mobile_device_sessions
     set is_active = false,
         status = 'revoked',
         revoked_at = clock_timestamp(),
         revoked_reason = p_reason,
         revoked_by = auth.uid()
   where id = p_session_id;

  perform public.mobile_audit_log(
    'MOBILE_DEVICE_UNBOUND',
    'MobileDeviceSession',
    p_session_id::text,
    format('Session %s revoked by admin %s: %s', p_session_id, auth.uid(), p_reason),
    'info'
  );

  return jsonb_build_object('ok', true, 'session_id', p_session_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. PERMISSIONS
-- ---------------------------------------------------------------------------
grant execute on function public.mobile_device_register(text,text,text,text,text) to authenticated;
grant execute on function public.mobile_device_validate(text) to authenticated;
grant execute on function public.mobile_device_revoke(text,text) to authenticated;
grant execute on function public.mobile_device_link_biometric(text) to authenticated;
grant execute on function public.mobile_device_authenticate_biometric(text,boolean) to authenticated;
grant execute on function public.mobile_clock_in(float, float, float, text, uuid, text, text, boolean, text) to authenticated;
grant execute on function public.mobile_clock_out(uuid, float, float, float, text, uuid, text, text, boolean, text) to authenticated;
grant execute on function public.mobile_attendance_summary(date, date, uuid, text) to authenticated;
grant execute on function public.mobile_list_authorized_devices(text) to authenticated;
grant execute on function public.mobile_admin_revoke_device(uuid, text) to authenticated;

revoke execute on function public.mobile_device_register(text,text,text,text,text) from anon, public;
revoke execute on function public.mobile_device_validate(text) from anon, public;
revoke execute on function public.mobile_device_revoke(text,text) from anon, public;
revoke execute on function public.mobile_device_link_biometric(text) from anon, public;
revoke execute on function public.mobile_device_authenticate_biometric(text,boolean) from anon, public;
revoke execute on function public.mobile_clock_in(float, float, float, text, uuid, text, text, boolean, text) from anon, public;
revoke execute on function public.mobile_clock_out(uuid, float, float, float, text, uuid, text, text, boolean, text) from anon, public;
revoke execute on function public.mobile_attendance_summary(date, date, uuid, text) from anon, public;
revoke execute on function public.mobile_list_authorized_devices(text) from anon, public;
revoke execute on function public.mobile_admin_revoke_device(uuid, text) from anon, public;