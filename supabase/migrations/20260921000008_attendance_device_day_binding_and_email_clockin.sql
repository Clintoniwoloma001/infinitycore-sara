-- ============================================================================
-- Attendance — device + calendar-day binding, email clock-in, location display
--
-- Run AFTER 20260921000007. Idempotent / additive — re-runs safely even if a
-- previous attempt was interrupted mid-batch (rename done / listing not rebuilt).
--
-- PART A — device binding keyed by (device_fingerprint_hash, attendance_date)
--   * The Phase 66/66a TERMINAL-scoped hold (`attendance_terminal_day_binding_
--     check` + unique index `uid_attendance_device_bindings_terminal_day`) is
--     REMOVED. A terminal is informational only; the enforcement key is the
--     browser composite fingerprint + the Africa/Lagos CALENDAR day — exactly
--     `attendance_device_bindings`'s primary key (device_fingerprint_hash,
--     binding_date). One employee per device per calendar day holds globally,
--     regardless of which terminal the employee scans.
--   * `attendance_device_bindings.terminal_id` is renamed `last_terminal_id`
--     (+ informational `last_terminal_name`) and is NEVER consulted by the
--     gates. It survives as provenance for HR only.
--   * Every public gate now returns the canonical, least-privilege copy
--     "This device is already bound to another employee for today." and never
--     leaks the bound employee id in a public response (audit still logs it).
--   * Blocked-attempt audit `scope` becomes 'device_day' everywhere.
--
-- PART B — work-email clock-in
--   * `resolve_attendance_terminal_employee` (public QR gates) and
--     `lookup_employee_by_identifier` (platform kiosk) resolve by Employee ID
--     OR work email (employees.email / employees.work_email), case/trim
--     insensitive, requiring EXACTLY ONE unambiguous active match.
--   * The device ingest path forwards a resolved employee id so an email
--     identifier works end-to-end even without a browser fingerprint.
--   * Not-found copy is standardized to the exact public message
--     "Employee not found. Check the Employee ID or work email and try again."
--
-- PART C — location display (frontend-only; no SQL here)
--   Location Distance/Status come from the record's persisted server verdict
--   (clock_in_distance / geofence_status / clock_in_lat/lng), so the Admin
--   Records table + Location Audit modal never render "--"/"unknown" when real
--   data exists.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PART A.1 — drop the terminal-scoped hard guarantee (the fingerprint+date PK
-- is the one and only enforcement key). Column rename is guarded so this
-- migration re-runs cleanly even if a previous attempt was interrupted after
-- the rename but before the listing function was rebuilt.
-- ---------------------------------------------------------------------------
drop index if exists public.uid_attendance_device_bindings_terminal_day;
drop index if exists public.idx_attendance_device_bindings_terminal;

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'attendance_device_bindings'
       and column_name = 'terminal_id'
  ) then
    alter table public.attendance_device_bindings rename column terminal_id to last_terminal_id;
  end if;
end
$$;

alter table public.attendance_device_bindings
  add column if not exists last_terminal_name text;

update public.attendance_device_bindings b
   set last_terminal_name = d.device_name
  from public.attendance_devices d
 where d.id = b.last_terminal_id
   and b.last_terminal_name is null;

-- ---------------------------------------------------------------------------
-- PART A.2 — bind: keyed ONLY by (fingerprint, calendar day). The terminal is
-- informational provenance, never a conflict axis.
-- ---------------------------------------------------------------------------
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
    device_fingerprint_hash, binding_date, employee_id, last_terminal_id, last_terminal_name
  ) values (
    v_hash, v_today, p_employee_id, p_terminal_id,
    (select device_name from public.attendance_devices where id = p_terminal_id)
  )
  on conflict (device_fingerprint_hash, binding_date)
  do update set
    last_terminal_id = coalesce(excluded.last_terminal_id, attendance_device_bindings.last_terminal_id),
    last_terminal_name = coalesce(excluded.last_terminal_name, attendance_device_bindings.last_terminal_name),
    last_seen_at = clock_timestamp();
  return jsonb_build_object('ok', true, 'hash', v_hash, 'date', v_today);
end;
$$;

-- ---------------------------------------------------------------------------
-- PART A.3 — HR listing: expose the calendar-day view + informational terminal.
-- create-or-replace cannot change the OUT row type of the existing function
-- (it returned terminal_name), so it must be dropped first.
-- ---------------------------------------------------------------------------
drop function if exists public.list_attendance_device_bindings(date);

create or replace function public.list_attendance_device_bindings(
  p_date date default null
) returns table (
  device_fingerprint_hash text,
  binding_date date,
  attendance_date date,
  employee_full_name text,
  employee_number text,
  last_terminal_name text,
  status text,
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
  select b.device_fingerprint_hash, b.binding_date, b.binding_date,
         e.full_name,
         coalesce(e.employee_number, e.staff_id, e.employee_code),
         b.last_terminal_name,
         'Active'::text,
         b.first_used_at, b.last_seen_at
    from public.attendance_device_bindings b
    left join public.employees e on e.id = b.employee_id
   where b.binding_date = v_date
   order by b.last_seen_at desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- PART A.4 — public gates: device+calendar-day only, no bound-employee leak.
-- Terminal state is still validated (active/suspended), but the day-binding is
-- keyed by the fingerprint+date PK. Audit scope becomes 'device_day'.
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
  v_bind jsonb;
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

  -- Device/calendar-day policy: one employee per device fingerprint per day.
  v_bind := public.attendance_device_binding_check(p_device_fingerprint, v_employee_id, v_next_action);
  if (v_bind ->> 'allowed')::boolean = false then
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'ATTENDANCE_DEVICE_BINDING_BLOCKED', 'AttendanceDevice', v_terminal.device_id::text,
      'attendance-terminal',
      jsonb_build_object(
        'module', 'attendance', 'terminal_id', v_terminal.device_id,
        'channel', 'terminal', 'event_type', v_next_action,
        'attempted_employee', (select e.full_name from public.employees e where e.id = v_employee_id),
        'bound_employee', coalesce((select e.full_name from public.employees e where e.id = (v_bind ->> 'bound_to')::uuid), v_bind ->> 'bound_to'),
        'binding_date', v_bind ->> 'date',
        'scope', 'device_day'
      )::text,
      'warning'
    );
    return jsonb_build_object(
      'valid', false,
      'device_binding_blocked', true,
      'device_binding_error', 'DEVICE_BINDING:This device is already bound to another employee for today. Contact HR/Admin if this is an error.',
      'error', 'DEVICE_BINDING:This device is already bound to another employee for today.'
    );
  end if;

  -- The bound employee id never leaves the server (privacy).
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
  v_bind jsonb; v_bound_employee public.employees%rowtype;
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

  -- Device/calendar-day policy gate (authoritative): fingerprint + calendar day.
  v_bind := public.attendance_device_binding_check(p_device_fingerprint, v_employee_id, p_event_type);
  if (v_bind ->> 'allowed')::boolean = false then
    select * into v_bound_employee from public.employees where id = (v_bind ->> 'bound_to')::uuid;
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
        'bound_employee', coalesce(v_bound_employee.full_name, v_bind ->> 'bound_to'),
        'binding_date', v_bind ->> 'date',
        'scope', 'device_day'
      )::text,
      'warning'
    );
    return jsonb_build_object(
      'success', false,
      'error', coalesce(
        nullif(v_bind ->> 'error', ''),
        'DEVICE_BINDING:This device is already bound to another employee for today. Contact HR/Admin if this is an error.'
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

-- ---------------------------------------------------------------------------
-- PART A.5 — platform kiosk ingest: same device+calendar-day policy, terminal
-- removed from the conflict axis, scope 'device_day', canonical copy. Also
-- forwards a resolved employee id into the legacy ingest path so an EMAIL
-- identifier works end-to-end even without a browser fingerprint (PART B).
-- ---------------------------------------------------------------------------
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
  v_bind jsonb;
  v_bound_employee public.employees%rowtype;
begin
  v_fingerprint := coalesce(nullif(p_metadata ->> 'device_fingerprint', ''), null);
  v_event := case
    when upper(coalesce(p_event_type, '')) like '%CLOCK_IN%' then 'CLOCK_IN'
    else 'CLOCK_OUT'
  end;

  v_employee_id := p_employee_id;
  if v_employee_id is null then
    v_employee_id := public.resolve_attendance_terminal_employee(p_external_user_id);
  end if;

  if v_fingerprint is not null and p_device_id is not null and v_employee_id is not null then
    select * into v_device from public.attendance_devices where id = p_device_id limit 1;
    if v_device.id is not null then
      -- Device/calendar-day policy: one employee per device fingerprint per day.
      v_bind := public.attendance_device_binding_check(v_fingerprint, v_employee_id, v_event);
      if (v_bind ->> 'allowed')::boolean = false then
        select * into v_bound_employee from public.employees where id = (v_bind ->> 'bound_to')::uuid;
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
            'bound_employee', coalesce(v_bound_employee.full_name, v_bind ->> 'bound_to'),
            'binding_date', v_bind ->> 'date',
            'scope', 'device_day'
          )::text,
          'warning'
        );
        return jsonb_build_object(
          'success', false,
          'error', coalesce(
            nullif(v_bind ->> 'error', ''),
            'DEVICE_BINDING:This device is already bound to another employee for today. Contact HR/Admin if this is an error.'
          ),
          'device_binding_blocked', true
        );
      end if;
    end if;
  end if;

  v_result := public.ingest_attendance_event_internal(
    p_device_id, p_external_user_id, p_event_type, p_event_time,
    p_verification_method, p_metadata, v_employee_id
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

-- ---------------------------------------------------------------------------
-- PART B.1 — resolve_attendance_terminal_employee (public QR gates): Employee
-- ID OR work email (employees.email / employees.work_email). Exactly ONE
-- unambiguous active match wins; ambiguous/missing -> null.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_attendance_terminal_employee(p_identifier text)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_normalized text := upper(trim(regexp_replace(coalesce(p_identifier, ''), '\s*/\s*', '/', 'g')));
  v_lookup text := lower(trim(coalesce(p_identifier, '')));
  v_employee_id uuid;
  v_matches integer;
begin
  if v_normalized = '' or v_lookup = '' then return null; end if;
  select count(*) into v_matches
    from public.employees e
   where e.employment_status = 'active'
     and (
       upper(trim(coalesce(e.employee_number, ''))) = v_normalized
       or upper(trim(coalesce(e.staff_id, ''))) = v_normalized
       or upper(trim(coalesce(e.employee_code, ''))) = v_normalized
       or lower(trim(coalesce(e.email, ''))) = v_lookup
       or lower(trim(coalesce(e.work_email, ''))) = v_lookup
     );
  if v_matches <> 1 then return null; end if;
  select e.id into v_employee_id
    from public.employees e
   where e.employment_status = 'active'
     and (
       upper(trim(coalesce(e.employee_number, ''))) = v_normalized
       or upper(trim(coalesce(e.staff_id, ''))) = v_normalized
       or upper(trim(coalesce(e.employee_code, ''))) = v_normalized
       or lower(trim(coalesce(e.email, ''))) = v_lookup
       or lower(trim(coalesce(e.work_email, ''))) = v_lookup
     )
   limit 1;
  return v_employee_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- PART B.2 — lookup_employee_by_identifier (platform kiosk / private terminal):
-- Employee ID OR work email, exactly-one match guard, standardized copy.
-- ---------------------------------------------------------------------------
create or replace function public.lookup_employee_by_identifier(
  p_identifier text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_normalized text := upper(trim(regexp_replace(coalesce(p_identifier, ''), '\s*/\s*', '/', 'g')));
  v_lookup text := lower(trim(coalesce(p_identifier, '')));
  v_employee public.employees%rowtype;
  v_matches integer;
begin
  if v_normalized = '' then
    return jsonb_build_object('found', false, 'error', 'Enter an employee ID or work email.');
  end if;

  if v_normalized ~ '^\d{1,9}$' then
    select e.* into v_employee
      from public.employee_biometric_identifiers b
      join public.employees e on e.id = b.employee_id
     where b.external_user_id = p_identifier
       and b.enrollment_status = 'enrolled'
       and b.active = true
     limit 1;
  else
    select count(*) into v_matches
      from public.employees e
     where upper(trim(coalesce(e.employee_number, ''))) = v_normalized
        or upper(trim(coalesce(e.staff_id, ''))) = v_normalized
        or upper(trim(coalesce(e.employee_code, ''))) = v_normalized
        or lower(trim(coalesce(e.email, ''))) = v_lookup
        or lower(trim(coalesce(e.work_email, ''))) = v_lookup;
    if v_matches <> 1 then
      return jsonb_build_object('found', false, 'error', 'Employee not found. Check the Employee ID or work email and try again.');
    end if;
    select e.* into v_employee
      from public.employees e
     where upper(trim(coalesce(e.employee_number, ''))) = v_normalized
        or upper(trim(coalesce(e.staff_id, ''))) = v_normalized
        or upper(trim(coalesce(e.employee_code, ''))) = v_normalized
        or lower(trim(coalesce(e.email, ''))) = v_lookup
        or lower(trim(coalesce(e.work_email, ''))) = v_lookup
     limit 1;
  end if;

  if not found then
    return jsonb_build_object('found', false, 'error', 'Employee not found. Check the Employee ID or work email and try again.');
  end if;

  if v_employee.employment_status is distinct from 'active' then
    return jsonb_build_object(
      'found', false,
      'error', format('Employee is %s and cannot clock in or out.', coalesce(v_employee.employment_status, 'inactive'))
    );
  end if;

  return jsonb_build_object(
    'found', true,
    'employee', jsonb_build_object(
      'id', v_employee.id,
      'full_name', v_employee.full_name,
      'employee_number', coalesce(v_employee.employee_number, v_employee.staff_id, v_employee.employee_code),
      'department', v_employee.department,
      'position', v_employee.position,
      'employment_status', v_employee.employment_status,
      'branch', coalesce(v_employee.branch, ''),
      'photo_url', null
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants — preserved explicitly so the strengthened resolution + gates keep the
-- same surface (public QR anon+authenticated; kiosk lookup anon+authenticated;
-- internal helpers stay server-only).
-- ---------------------------------------------------------------------------
revoke all on function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb, uuid) from public;
revoke all on function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb) from public;
grant execute on function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb, uuid) to authenticated;
grant execute on function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb) to authenticated;

revoke all on function public.lookup_employee_by_identifier(text) from public;
grant execute on function public.lookup_employee_by_identifier(text) to anon, authenticated;

revoke all on function public.resolve_attendance_terminal_employee(text) from public;
revoke all on function public.attendance_device_bind(text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.list_attendance_device_bindings(date) from public;
grant execute on function public.list_attendance_device_bindings(date) to authenticated;

revoke all on function public.validate_attendance_terminal_employee(text, text, text) from public;
revoke all on function public.clock_attendance_terminal(text, text, text, float, float, float, text) from public;
grant execute on function public.validate_attendance_terminal_employee(text, text, text) to anon, authenticated;
grant execute on function public.clock_attendance_terminal(text, text, text, float, float, float, text) to anon, authenticated;