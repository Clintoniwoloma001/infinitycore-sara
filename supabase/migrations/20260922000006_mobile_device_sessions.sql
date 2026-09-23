-- ---------------------------------------------------------------------------
-- InfinityCore Mobile — trusted device/session layer.
--
-- The mobile app cannot be treated like a browser: it holds a first-party
-- identity, an enrolled biometric, and a live user session, which lets the
-- server enforce stronger attendance rules (no buddy punching) while keeping
-- every decision in the database.
--
-- Adds:
--   * mobile_device_sessions   — one active session per user (partial unique
--                                index). Server-written; no client RLS path.
--   * mobile_get_my_employee() — SECURITY DEFINER accessor returning the
--                                caller's employees row (employees has NO
--                                self-read RLS policy, so the app cannot
--                                resolve its own employee record otherwise)
--                                plus branch + manager names.
--   * mobile_device_register / mobile_device_validate / mobile_device_revoke
--                                — session lifecycle. Register replaces a
--                                stale active session from another device.
--   * mobile_clock_in / mobile_clock_out
--                                — attendance actions that verify the mobile
--                                session, reuse the attendance engine's daily
--                                device-day binding (same device, one
--                                employee/day), then DELEGATE to the canonical
--                                attendance_clock_in_for_employee /
--                                attendance_clock_out_for_employee functions.
--
-- Ownership: every mobile action is scoped to auth.uid(); the attendance
-- functions are only reachable behind that check, so an authenticated user
-- can never clock in/out for another employee through the app.
--
-- Additive and idempotent; safe to run in the Supabase SQL editor or through
-- the standard migration runner. date_via att_app_timezone(): Africa/Lagos.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. SESSIONS TABLE (server-written only; clients use the RPCs below)
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

create index if not exists idx_mobile_device_sessions_user
  on public.mobile_device_sessions (user_id);
create index if not exists idx_mobile_device_sessions_device
  on public.mobile_device_sessions (device_id);
create index if not exists idx_mobile_device_sessions_active_user
  on public.mobile_device_sessions (user_id) where is_active is true;

alter table public.mobile_device_sessions enable row level security;
revoke all on public.mobile_device_sessions from anon, authenticated, public;

-- Revoking all from authenticated means clients cannot INSERT/UPDATE/READ the
-- table directly; they go through the SECURITY DEFINER functions below.

-- One active session per user, enforced at the database level.
create unique index if not exists uq_mobile_device_sessions_one_active
  on public.mobile_device_sessions (user_id) where is_active is true;

-- ---------------------------------------------------------------------------
-- 2. MY EMPLOYEE — resolves the caller's own employees row without exposing
--    the employees table to self-read (RLS only grants HR roles).
-- ---------------------------------------------------------------------------
create or replace function public.mobile_get_my_employee()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_employee record;
  v_role text;
  v_manager_name text;
  v_branch jsonb;
begin
  v_role := public.current_role();
  select * into v_employee
    from public.employees
   where user_id = auth.uid()
     and coalesce(is_archived, false) = false
   order by created_at desc
   limit 1;

  if not found or v_employee.id is null then
    raise exception 'PROFILE:No employee record linked to this account yet.';
  end if;

  select full_name into v_manager_name
    from public.employees
   where id = v_employee.manager_id;

  select coalesce(
    jsonb_build_object(
      'id', b.id, 'branch_name', b.branch_name,
      'latitude', b.latitude, 'longitude', b.longitude,
      'geofence_radius', b.geofence_radius, 'geofence_active', b.geofence_active,
      'work_start_time', b.work_start_time, 'work_end_time', b.work_end_time,
      'grace_period_minutes', b.grace_period_minutes
    ), '{}'::jsonb)
    into v_branch
    from public.branches b
   where b.id = v_employee.branch_id
   limit 1;

  return jsonb_build_object('role', v_role, 'manager_name', v_manager_name)
    || to_jsonb(v_employee)
    || jsonb_build_object(
         'managed_role', v_role in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'branch_manager'),
         'branch', v_branch
       );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. SESSION LIFECYCLE
-- ---------------------------------------------------------------------------

-- Register (or re-register) the caller's active session for `p_device_id`.
-- If an older device holds the user's active session it is revoked first, so
-- a fresh sign-in on this phone simply works and the old device is locked out.
create or replace function public.mobile_device_register(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_session_id uuid;
  v_employee_id uuid;
  v_replaced uuid;
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

  update public.mobile_device_sessions
     set is_active = false, revoked_at = clock_timestamp(),
         revoked_reason = 'superseded_by_new_device'
   where user_id = auth.uid()
     and is_active = true
     and device_id is distinct from p_device_id
  returning id into v_replaced;

  insert into public.mobile_device_sessions (user_id, employee_id, device_id)
  values (auth.uid(), v_employee_id, p_device_id)
  on conflict (user_id) where is_active is true
  do update set last_seen_at = clock_timestamp()
  returning id into v_session_id;

  return jsonb_build_object(
    'ok', true, 'session_id', v_session_id,
    'employee_id', v_employee_id,
    'replaced_session_id', v_replaced,
    'reason', case when v_replaced is not null then 'new_device' else 'registered' end
  );
end;
$$;

-- Validate the caller's active session belongs to `p_device_id`; refresh
-- last_seen/last_verified. `allow_stale` lets read-only flows check without
-- renewing timestamps.
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
    return jsonb_build_object(
      'ok', false, 'reason', 'device_mismatch', 'code', 'WRONG_DEVICE',
      'message', 'MOBILE_SESSION:Signed in on another device. Re-authenticate here to continue.'
    );
  end if;

  update public.mobile_device_sessions
     set last_seen_at = clock_timestamp(), last_verified_at = clock_timestamp()
   where id = v_session.id;

  return jsonb_build_object(
    'ok', true, 'session_id', v_session.id,
    'employee_id', v_session.employee_id,
    'device_id', v_session.device_id,
    'app_version', v_session.app_version,
    'platform', v_session.platform
  );
end;
$$;

-- Revoke the caller's active session (sign-out / remote lockout).
create or replace function public.mobile_device_revoke(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated.'; end if;
  update public.mobile_device_sessions
     set is_active = false, revoked_at = clock_timestamp(),
         revoked_reason = 'client_sign_out'
   where user_id = auth.uid()
     and is_active = true
     and (p_device_id is null or p_device_id = '' or device_id = p_device_id);
  return jsonb_build_object('ok', true, 'revoked', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. ATTENDANCE ACTIONS (session-gated delegates)
-- ---------------------------------------------------------------------------

-- Shared guard: resolves the caller's employee (or verifies p_employee_id),
-- requires an active session for p_device_id on this device, and enforces the
-- daily device-day binding (same device, one employee per day) via the core
-- attendance engine. Called for both clock in and clock out.
create or replace function public.mobile_session_guard(
  p_employee_id uuid, p_device_id text, p_fingerprint text, p_event_type text
) returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_employee_id uuid;
  v_binding jsonb;
begin
  if auth.uid() is null then raise exception 'Not authenticated.'; end if;

  if not exists (
    select 1 from public.mobile_device_sessions
     where user_id = auth.uid() and is_active = true
       and device_id = p_device_id
  ) then
    raise exception 'MOBILE_SESSION:Cannot verify this device. Re-authenticate to continue.';
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
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_employee_id uuid;
  v_result jsonb;
begin
  v_employee_id := public.mobile_session_guard(
    p_employee_id, p_device_id, p_device_fingerprint, 'CLOCK_IN'
  );
  v_result := public.attendance_clock_in_for_employee(
    v_employee_id, p_lat, p_lng, p_accuracy,
    'mobile', null, case when p_biometric_used then 'BIOMETRIC+GPS' else 'GPS' end,
    'MOBILE', null, false
  );
  perform public.attendance_device_bind(p_device_fingerprint, v_employee_id, null);
  return v_result || jsonb_build_object(
    'server_time', v_result ->> 'clock_in_at', 'verification_method',
    case when p_biometric_used then 'BIOMETRIC+GPS' else 'GPS' end
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
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_employee_id uuid;
  v_result jsonb;
begin
  v_employee_id := public.mobile_session_guard(
    p_employee_id, p_device_id, p_device_fingerprint, 'CLOCK_OUT'
  );
  v_result := public.attendance_clock_out_for_employee(
    v_employee_id, p_attendance_id, p_lat, p_lng, p_accuracy,
    'mobile', null, case when p_biometric_used then 'BIOMETRIC+GPS' else 'GPS' end,
    'MOBILE', null, false
  );
  return v_result || jsonb_build_object(
    'server_time', v_result ->> 'clock_out_at', 'verification_method',
    case when p_biometric_used then 'BIOMETRIC+GPS' else 'GPS' end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. ROLE-GATED LIVE OVERVIEW (HR/Attendance Management)
-- ---------------------------------------------------------------------------
create or replace function public.mobile_attendance_summary(
  p_from date default null,
  p_to date default null,
  p_branch_id uuid default null,
  p_status text default null
) returns table (
  attendance_id uuid,
  employee_id uuid,
  employee_name text,
  employee_number text,
  department text,
  branch_id uuid,
  branch_name text,
  attendance_date date,
  clock_in timestamptz,
  clock_out timestamptz,
  status text,
  work_hours numeric,
  total_minutes integer,
  late_status text,
  late_minutes integer,
  location_status text,
  geofence_status text,
  clock_in_lat float,
  clock_in_lng float,
  clock_in_accuracy float,
  actual_location_name text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'branch_manager') then
    raise exception 'Not authorized to view attendance management.';
  end if;
  return query
  select
    ar.id,
    ar.employee_id,
    e.full_name,
    coalesce(e.employee_number, e.staff_id, e.employee_code),
    e.department,
    ar.branch_id,
    b.branch_name,
    ar.attendance_date,
    ar.clock_in,
    ar.clock_out,
    ar.status,
    ar.work_hours,
    ar.total_minutes,
    -- `attendance_records.late_status` is a boolean flag; the summary contract
    -- is a readable text value. The CASE keeps the declared `text` return
    -- type aligned (previously the raw boolean raised Postgrest Error 42804
    -- "Returned type boolean does not match expected type text in column 14").
    case when ar.late_status then 'late' else 'on_time' end,
    ar.late_minutes,
    ar.location_status,
    ar.geofence_status,
    ar.clock_in_lat,
    ar.clock_in_lng,
    ar.clock_in_accuracy,
    (select (ae.metadata ->> 'actual_location_name')
       from public.attendance_events ae
      where ae.attendance_record_id = ar.id and ae.event_type = 'CLOCK_IN'
      order by ae.event_time asc limit 1)
  from public.attendance_records ar
  join public.employees e on e.id = ar.employee_id
  left join public.branches b on b.id = ar.branch_id
  where (p_from is null or ar.attendance_date >= p_from)
    and (p_to is null or ar.attendance_date <= p_to)
    and (p_branch_id is null or ar.branch_id = p_branch_id)
    and (p_status is null or ar.status = p_status)
  order by ar.attendance_date desc, ar.clock_in desc
  limit 500;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. PERMISSIONS (must be after function definitions)
-- ---------------------------------------------------------------------------
grant execute on function public.mobile_get_my_employee() to authenticated;
grant execute on function public.mobile_device_register(text) to authenticated;
grant execute on function public.mobile_device_validate(text) to authenticated;
grant execute on function public.mobile_device_revoke(text) to authenticated;
grant execute on function public.mobile_clock_in(float, float, float, text, uuid, text, text, boolean, text) to authenticated;
grant execute on function public.mobile_clock_out(uuid, float, float, float, text, uuid, text, text, boolean, text) to authenticated;
grant execute on function public.mobile_attendance_summary(date, date, uuid, text) to authenticated;
revoke execute on function public.mobile_get_my_employee() from anon, public;
revoke execute on function public.mobile_device_register(text) from anon, public;
revoke execute on function public.mobile_device_validate(text) from anon, public;
revoke execute on function public.mobile_device_revoke(text) from anon, public;
revoke execute on function public.mobile_clock_in(float, float, float, text, uuid, text, text, boolean, text) from anon, public;
revoke execute on function public.mobile_clock_out(uuid, float, float, float, text, uuid, text, text, boolean, text) from anon, public;
revoke execute on function public.mobile_attendance_summary(date, date, uuid, text) from anon, public;