-- Attendance Terminal — one device, one employee per day.
--
-- Buddy-punching fix for the public QR terminal flow. A browser-side
-- composite fingerprint (stable signals + first-party storage identity) is
-- hashed on the client and sent with every public-terminal request. The
-- server double-hashes it (so the stored value is never the raw client
-- value) and records a per-(device, app day) binding on CLOCK_IN. Any
-- later CLOCK_IN as a different employee on the same device/day is
-- rejected, including crafted/spoofed requests that drop the fingerprint.
--
-- Day boundary matches the rest of the attendance engine:
-- (clock_timestamp() at time zone public.att_app_timezone())::date.
-- The app has NO shift-window model — a session clocked in at 23:30 keeps
-- the calendar day of its clock-in, so the binding uses that same day.
-- A clock-out crossing midnight stays on the employee's open session and
-- is unaffected by the new day's binding lookup.
--
-- Policy:
--   * CLOCK_IN  — fingerprint required; binds the device to the employee
--                 for the day. Bound to a different employee -> blocked.
--   * CLOCK_OUT — fingerprint required; if the device is bound to a
--                 different employee -> blocked (device belongs to its
--                 day-bound employee). Otherwise allowed.
--   * Same employee re-scan -> always allowed (no duplicate record; the
--     existing attendance_insert_rules trigger guards the session).
--   * HR/admin override -> clear_attendance_device_binding() for a
--     specific (device, date). Role-gated like attendance_exceptions
--     review (super_admin/admin/hr_manager/hr_officer/branch_manager).
--
-- All additive/idempotent. Deployed via Supabase SQL Editor or the
-- standard migration runner.

-- ----------------------------------------------------------------------
-- 1. BINDINGS TABLE (server-written only; no anon/auth RLS path)
-- ----------------------------------------------------------------------
create table if not exists public.attendance_device_bindings (
  device_fingerprint_hash text not null,
  binding_date date not null,
  employee_id uuid not null references public.employees(id) on delete cascade,
  terminal_id uuid references public.attendance_devices(id) on delete cascade,
  first_used_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  primary key (device_fingerprint_hash, binding_date)
);

create index if not exists idx_attendance_device_bindings_date_employee
  on public.attendance_device_bindings(binding_date, employee_id);

create index if not exists idx_attendance_device_bindings_terminal
  on public.attendance_device_bindings(terminal_id);

alter table public.attendance_device_bindings enable row level security;
revoke all on public.attendance_device_bindings from anon, authenticated;

-- ----------------------------------------------------------------------
-- 2. INTERNAL HELPERS
-- ----------------------------------------------------------------------

-- Server-side hash of the client-supplied fingerprint. The browser already
-- hashes its composite; we hash again so the stored value is one-way from
-- anything a client ever sends, and a DB dump cannot be replayed directly.
create or replace function public.attendance_device_binding_hash(p_fingerprint text)
returns text
language sql immutable security definer
set search_path = public, extensions
as $$
  select encode(extensions.digest(convert_to(coalesce(nullif(p_fingerprint, ''), ''), 'UTF8'), 'sha256'), 'hex');
$$;

-- Read-only policy check: may p_employee_id use this device fingerprint
-- for this event on the current app day? Never mutates; the clock RPC
-- performs the bind afterwards on CLOCK_IN.
create or replace function public.attendance_device_binding_check(
  p_fingerprint text, p_employee_id uuid, p_event_type text
) returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
  v_today date;
  v_binding public.attendance_device_bindings%rowtype;
begin
  if p_event_type not in ('CLOCK_IN', 'CLOCK_OUT') then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_event', 'error', 'Choose Clock In or Clock Out.');
  end if;
  if coalesce(p_fingerprint, '') = '' then
    return jsonb_build_object(
      'allowed', false, 'reason', 'missing_fingerprint',
      'error', 'DEVICE_BINDING:This device could not be associated with an employee today. Enable browser storage and camera access, then try again.'
    );
  end if;
  v_hash := public.attendance_device_binding_hash(p_fingerprint);
  v_today := (clock_timestamp() at time zone public.att_app_timezone())::date;

  select * into v_binding
    from public.attendance_device_bindings
   where device_fingerprint_hash = v_hash
     and binding_date = v_today
   limit 1;

  if not found then
    return jsonb_build_object(
      'allowed', true, 'reason', 'unbound',
      'bind_required', p_event_type = 'CLOCK_IN',
      'hash', v_hash, 'date', v_today
    );
  end if;

  if v_binding.employee_id = p_employee_id then
    update public.attendance_device_bindings
       set last_seen_at = clock_timestamp()
     where device_fingerprint_hash = v_hash
       and binding_date = v_today;
    return jsonb_build_object(
      'allowed', true, 'reason', 'same_employee', 'bound', true,
      'hash', v_hash, 'date', v_today
    );
  end if;

  return jsonb_build_object(
    'allowed', false, 'reason', 'conflict',
    'bound_to', v_binding.employee_id, 'hash', v_hash, 'date', v_today
  );
end;
$$;

-- Bind a device fingerprint to an employee for the current app day.
-- Only called after the policy check passes (CLOCK_IN path).
create or replace function public.attendance_device_bind(
  p_fingerprint text, p_employee_id uuid, p_terminal_id uuid
) returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
  v_today date;
begin
  v_hash := public.attendance_device_binding_hash(p_fingerprint);
  v_today := (clock_timestamp() at time zone public.att_app_timezone())::date;
  insert into public.attendance_device_bindings (
    device_fingerprint_hash, binding_date, employee_id, terminal_id
  ) values (v_hash, v_today, p_employee_id, p_terminal_id)
  on conflict (device_fingerprint_hash, binding_date)
  do update set
    employee_id = excluded.employee_id,
    terminal_id = coalesce(excluded.terminal_id, attendance_device_bindings.terminal_id),
    last_seen_at = clock_timestamp();
  return jsonb_build_object('ok', true, 'hash', v_hash, 'date', v_today);
end;
$$;

-- ----------------------------------------------------------------------
-- 3. ADMIN OVERRIDE + LISTINGS (role-gated, server-side)
-- ----------------------------------------------------------------------

create or replace function public.list_attendance_device_bindings(
  p_date date default null
) returns table (
  device_fingerprint_hash text,
  binding_date date,
  employee_full_name text,
  employee_number text,
  terminal_name text,
  first_used_at timestamptz,
  last_seen_at timestamptz
)
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_date date := coalesce(p_date, (clock_timestamp() at time zone public.att_app_timezone())::date);
begin
  if public.current_role() not in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager') then
    raise exception 'Not authorized to manage attendance device bindings.';
  end if;
  return query
  select b.device_fingerprint_hash, b.binding_date,
         e.full_name,
         coalesce(e.employee_number, e.staff_id, e.employee_code),
         d.device_name,
         b.first_used_at, b.last_seen_at
    from public.attendance_device_bindings b
    left join public.employees e on e.id = b.employee_id
    left join public.attendance_devices d on d.id = b.terminal_id
   where b.binding_date = v_date
   order by b.last_seen_at desc;
end;
$$;

create or replace function public.list_attendance_device_binding_blocks(
  p_date date default null,
  p_limit int default 20
) returns table (
  created_at timestamptz,
  details text,
  severity text
)
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_date date := coalesce(p_date, (clock_timestamp() at time zone public.att_app_timezone())::date);
begin
  if public.current_role() not in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager') then
    raise exception 'Not authorized to view attendance device binding events.';
  end if;
  return query
  select a.created_at, a.details, a.severity
    from public.audit_logs a
   where a.action = 'ATTENDANCE_DEVICE_BINDING_BLOCKED'
     and a.created_at::date = v_date
   order by a.created_at desc
   limit greatest(1, p_limit);
end;
$$;

create or replace function public.clear_attendance_device_binding(
  p_device_fingerprint_hash text,
  p_binding_date date,
  p_reason text default null
) returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_date date := coalesce(p_binding_date, (clock_timestamp() at time zone public.att_app_timezone())::date);
begin
  if public.current_role() not in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager') then
    raise exception 'Not authorized to manage attendance device bindings.';
  end if;
  if coalesce(p_device_fingerprint_hash, '') = '' then
    raise exception 'A device fingerprint reference is required.';
  end if;

  delete from public.attendance_device_bindings
   where device_fingerprint_hash = p_device_fingerprint_hash
     and binding_date = v_date;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_DEVICE_BINDING_OVERRIDE', 'AttendanceDeviceBinding', p_device_fingerprint_hash,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    jsonb_build_object(
      'module', 'attendance',
      'binding_date', v_date,
      'reason', coalesce(p_reason, 'Device re-assigned by HR')
    )::text,
    'critical'
  );

  return jsonb_build_object('ok', true, 'binding_date', v_date);
end;
$$;

-- ----------------------------------------------------------------------
-- 4. PUBLIC TERMINAL GATES — fingerprint-aware
--    The old signatures are DROPPED (not overloaded) so an attacker cannot
--    reach an unguarded function by calling the pre-fingerprint version.
-- ----------------------------------------------------------------------

create or replace function public.validate_attendance_terminal_employee(
  p_token text, p_employee_identifier text, p_device_fingerprint text default null
) returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_employee_id uuid; v_employee public.employees%rowtype; v_record public.attendance_records%rowtype;
  v_today date := (clock_timestamp() at time zone public.att_app_timezone())::date; v_next_action text;
  v_bind jsonb;
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

  -- Device/day policy: reported at submission so the terminal can stop the
  -- flow immediately. It never creates a binding (validate is read-only).
  v_bind := public.attendance_device_binding_check(p_device_fingerprint, v_employee_id, v_next_action);

  return jsonb_build_object(
    'valid', true, 'employee_name', v_employee.full_name,
    'employee_number', coalesce(v_employee.employee_number, v_employee.staff_id, v_employee.employee_code),
    'next_action', v_next_action,
    'device_binding', v_bind,
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
  v_bind jsonb; v_bound_employee public.employees%rowtype;
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

  -- Device/day policy gate (authoritative).
  v_bind := public.attendance_device_binding_check(p_device_fingerprint, v_employee_id, p_event_type);
  if (v_bind ->> 'allowed')::boolean = false then
    select * into v_bound_employee from public.employees where id = (v_bind ->> 'bound_to')::uuid;
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'ATTENDANCE_DEVICE_BINDING_BLOCKED', 'AttendanceDeviceBinding',
      coalesce(v_bind ->> 'hash', ''),
      'attendance-terminal',
      jsonb_build_object(
        'module', 'attendance',
        'terminal_id', v_device.id,
        'event_type', p_event_type,
        'attempted_employee', coalesce(
          (select e.full_name from public.employees e where e.id = v_employee_id),
          p_employee_identifier
        ),
        'bound_employee', coalesce(v_bound_employee.full_name, v_bind ->> 'bound_to'),
        'binding_date', v_bind ->> 'date'
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

-- ----------------------------------------------------------------------
-- 5. GRANTS
-- ----------------------------------------------------------------------

-- Internal helpers are server-only.
revoke all on function public.attendance_device_binding_hash(text) from public;
revoke all on function public.attendance_device_binding_check(text, uuid, text) from public;
revoke all on function public.attendance_device_bind(text, uuid, uuid) from public;

-- The un-fingerprinted public gates no longer exist.
drop function if exists public.validate_attendance_terminal_employee(text, text);
drop function if exists public.clock_attendance_terminal(text, text, text, float, float, float);
revoke all on function public.validate_attendance_terminal_employee(text, text, text) from public;
revoke all on function public.clock_attendance_terminal(text, text, text, float, float, float, text) from public;

grant execute on function public.validate_attendance_terminal_employee(text, text, text) to anon, authenticated;
grant execute on function public.clock_attendance_terminal(text, text, text, float, float, float, text) to anon, authenticated;

grant execute on function public.list_attendance_device_bindings(date) to authenticated;
grant execute on function public.list_attendance_device_binding_blocks(date, int) to authenticated;
grant execute on function public.clear_attendance_device_binding(text, date, text) to authenticated;