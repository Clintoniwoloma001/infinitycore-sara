-- Phase 66 — Attendance Terminal: per-day single-employee enforcement + QR token
-- history (never destroyed). Idempotent / additive — safe to re-run.
--
-- Run AFTER (in order): 20260920000000_attendance_device_daily_binding.sql,
-- 20260920000001_attendance_fix_qr_view_link_status.sql and
-- 20260921000000_attendance_web_gps_and_device_binding.sql.
--
-- Why this migration exists:
--   1. CRITICAL: a QR attendance terminal could clock in multiple employees on
--      the same day.  The fingerprint-based gate only binds ONE BROWSER
--      fingerprint to one employee — three different employees scanning the
--      same printed QR from three phones each carry a distinct fingerprint, so
--      the same physical terminal was used to record attendance for three
--      people.  This migration binds the ATTENDANCE DEVICE (attendance_devices
--      row) to a single employee per app day, independent of the scanning
--      browser.  It is enforced in the public scan gates BEFORE any record is
--      created, and by a partial unique index at the DB level.
--   2. QR token durability: every generated token is now written to a durable
--      row-per-token history table (attendance_terminal_token_history).  Rows
--      are NEVER hard-deleted: regenerating supersedes the previous token
--      (status 'revoked'), revoking flips the active token to 'revoked', and
--      deleting a terminal soft-deletes it (status 'deleted') while preserving
--      its whole history.  'Deleted' is therefore a status VALUE and never an
--      actual DELETE, so the audit trail is never destroyed.
--
-- Assumption flagged (per the task): tokens have NO TTL in current config —
-- a generated token stays status='active' until it is superseded by a
-- regeneration or revoked manually.  No expiry is silently invented; if a
-- lifetime policy is added later the (already reserved) expires_at column and
-- an 'expired' status make it a pure additive change.  Full raw tokens are
-- never stored in the history table — only the SHA-256 hash and a masked
-- preview — so a listing can never leak a live token.

-- ---------------------------------------------------------------------------
-- 1. STATUS MODEL — admit 'deleted' (soft-delete keeps the device row so its
--    token history stays queryable).
-- ---------------------------------------------------------------------------
alter table public.attendance_devices
  drop constraint if exists attendance_devices_status_check;

alter table public.attendance_devices
  add constraint attendance_devices_status_check
  check (status in ('active', 'inactive', 'suspended', 'offline', 'revoked', 'deleted'));

-- ---------------------------------------------------------------------------
-- 2. ONE EMPLOYEE PER TERMINAL PER APP DAY — hard DB guarantee.
-- ---------------------------------------------------------------------------
-- Belt+braces behind the gate checks below: a terminal may never be bound to
-- two different employees on the same app day, regardless of how many browser
-- fingerprints scan it.
create unique index if not exists uid_attendance_device_bindings_terminal_day
  on public.attendance_device_bindings (terminal_id, binding_date)
  where terminal_id is not null;

-- Terminal-scoped policy check (read-only): may p_employee_id use this
-- attendance DEVICE for the current app day?  Unlike the fingerprint check,
-- this is keyed by the attendance_devices row itself, so it holds across all
-- scanning browsers.
create or replace function public.attendance_terminal_day_binding_check(
  p_terminal_id uuid, p_employee_id uuid, p_event_type text
) returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_today date;
  v_employee_id uuid;
begin
  if p_event_type not in ('CLOCK_IN', 'CLOCK_OUT') then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_event', 'error', 'Choose Clock In or Clock Out.');
  end if;
  v_today := (clock_timestamp() at time zone public.att_app_timezone())::date;
  select b.employee_id into v_employee_id
    from public.attendance_device_bindings b
   where b.terminal_id = p_terminal_id
     and b.binding_date = v_today
   limit 1;
  if v_employee_id is null then
    return jsonb_build_object('allowed', true, 'reason', 'unbound',
      'terminal_id', p_terminal_id, 'date', v_today);
  end if;
  if v_employee_id = p_employee_id then
    return jsonb_build_object('allowed', true, 'reason', 'same_employee',
      'terminal_id', p_terminal_id, 'date', v_today, 'bound', true);
  end if;
  return jsonb_build_object(
    'allowed', false, 'reason', 'terminal_taken',
    'bound_to', v_employee_id, 'terminal_id', p_terminal_id, 'date', v_today,
    'error', 'DEVICE_BINDING:This attendance terminal has already been clocked-in by a different employee today. Contact your supervisor or HR if this is an error.'
  );
end;
$$;

-- Bind must NEVER overwrite a different employee's terminal-day hold (the gate
-- above already blocked that path — this is defence-in-depth so a stray call
-- cannot raise a constraint error after a record was written).
create or replace function public.attendance_device_bind(
  p_fingerprint text, p_employee_id uuid, p_terminal_id uuid
) returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
  v_today date;
  v_taker uuid;
begin
  v_hash := public.attendance_device_binding_hash(p_fingerprint);
  v_today := (clock_timestamp() at time zone public.att_app_timezone())::date;
  if p_terminal_id is not null then
    select b.employee_id into v_taker
      from public.attendance_device_bindings b
     where b.terminal_id = p_terminal_id
       and b.binding_date = v_today
     limit 1;
    if v_taker is not null and v_taker <> p_employee_id then
      return jsonb_build_object('ok', false, 'reason', 'terminal_taken', 'hash', v_hash, 'date', v_today);
    end if;
  end if;
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

-- ---------------------------------------------------------------------------
-- 3. QR TOKEN HISTORY — durable, row-per-token, never hard-deleted.
-- ---------------------------------------------------------------------------
create table if not exists public.attendance_terminal_token_history (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.attendance_devices(id) on delete cascade,
  token_hash text not null,
  token_preview text not null,
  status text not null default 'active'
    check (status in ('active', 'revoked', 'expired', 'deleted')),
  expires_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  created_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null
);

create index if not exists idx_attendance_terminal_token_history_device_created
  on public.attendance_terminal_token_history (device_id, created_at desc);

create index if not exists idx_attendance_terminal_token_history_device_status
  on public.attendance_terminal_token_history (device_id, status);

alter table public.attendance_terminal_token_history enable row level security;
revoke all on public.attendance_terminal_token_history from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. GENERATE — archive the superseded token, then mint the new one.
-- ---------------------------------------------------------------------------
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
  v_hash text;
  v_now timestamptz := clock_timestamp();
  v_who uuid := auth.uid();
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
              'attendance_terminal', 'active', true, v_who)
      returning * into v_device;
    end if;
  else
    select * into v_device from public.attendance_devices where id = p_device_id for update;
    if not found or v_device.device_type <> 'attendance_terminal' then
      raise exception 'Attendance terminal not found.';
    end if;
  end if;

  v_hash := encode(extensions.digest(convert_to(v_raw, 'UTF8'), 'sha256'), 'hex');

  -- Archive any currently-active token before issuing the new one.
  update public.attendance_terminal_token_history
     set status = 'revoked',
         revoked_at = v_now,
         revoked_by = v_who
   where device_id = v_device.id
     and status = 'active';

  insert into public.attendance_terminal_token_history (
    device_id, token_hash, token_preview, status, created_at, created_by
  ) values (
    v_device.id, v_hash, left(v_raw, 8) || '…', 'active', v_now, v_who
  );

  update public.attendance_devices
     set device_token = v_hash,
         status = 'active',
         active = true,
         token_generated_at = v_now,
         updated_at = now()
   where id = v_device.id;

  insert into public.attendance_terminal_view_links (device_id, token_hex, created_at, updated_at)
  values (v_device.id, v_raw, v_now, v_now)
  on conflict (device_id)
  do update set token_hex = excluded.token_hex, updated_at = excluded.updated_at;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_TERMINAL_TOKEN_REGENERATED', 'AttendanceDevice', v_device.id::text,
    coalesce((select full_name from public.profiles where id = v_who), v_who::text),
    jsonb_build_object('module', 'attendance', 'device_name', v_device.device_name, 'success', true)::text,
    'warning'
  );

  return jsonb_build_object(
    'ok', true, 'device_id', v_device.id, 'device_name', v_device.device_name,
    'token', v_raw, 'generated_at', v_now
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. REVOKE — flip the active token to 'revoked' (never delete).
-- ---------------------------------------------------------------------------
create or replace function public.revoke_attendance_terminal(p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_name text;
  v_now timestamptz := clock_timestamp();
  v_who uuid := auth.uid();
begin
  if public.current_role() not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to manage attendance terminals.';
  end if;

  update public.attendance_devices
     set device_token = null,
         status = 'revoked',
         active = false,
         token_generated_at = null,
         updated_at = now()
   where id = p_device_id and device_type = 'attendance_terminal'
   returning device_name into v_name;

  if v_name is null then
    raise exception 'Attendance terminal not found.';
  end if;

  update public.attendance_terminal_token_history
     set status = 'revoked',
         revoked_at = v_now,
         revoked_by = v_who
   where device_id = p_device_id
     and status = 'active';

  delete from public.attendance_terminal_view_links where device_id = p_device_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_TERMINAL_REVOKED', 'AttendanceDevice', p_device_id::text,
    coalesce((select full_name from public.profiles where id = v_who), v_who::text),
    jsonb_build_object('module', 'attendance', 'device_name', v_name, 'success', true)::text,
    'warning'
  );

  return jsonb_build_object('ok', true, 'device_id', p_device_id, 'revoked', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. DELETE — SOFT delete: only from revoked, status='deleted', history kept.
-- ---------------------------------------------------------------------------
create or replace function public.delete_attendance_terminal(p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_dev public.attendance_devices%rowtype;
begin
  if public.current_role() not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to manage attendance terminals.';
  end if;

  select * into v_dev from public.attendance_devices where id = p_device_id for update;
  if not found or v_dev.device_type <> 'attendance_terminal' then
    raise exception 'Attendance terminal not found.';
  end if;

  if v_dev.status <> 'revoked' then
    raise exception 'Only revoked terminals can be deleted. Revoke the terminal first.';
  end if;

  update public.attendance_devices
     set status = 'deleted', active = false, updated_at = now()
   where id = p_device_id;

  delete from public.attendance_terminal_view_links where device_id = p_device_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_TERMINAL_DELETED', 'AttendanceDevice', p_device_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    jsonb_build_object(
      'module', 'attendance', 'device_name', v_dev.device_name,
      'soft_delete', true, 'history_preserved', true, 'success', true
    )::text,
    'warning'
  );

  return jsonb_build_object('ok', true, 'device_id', p_device_id, 'deleted', true, 'soft_delete', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. QR HISTORY LIST — masked previews only, newest first, optional filter.
-- ---------------------------------------------------------------------------
create or replace function public.list_attendance_terminal_qr_history(
  p_device_id uuid default null,
  p_status text default null
) returns table (
  id uuid,
  device_id uuid,
  device_name text,
  status text,
  token_preview text,
  created_at timestamptz,
  created_by_name text,
  revoked_at timestamptz,
  revoked_by_name text,
  expires_at timestamptz
)
language plpgsql security definer
set search_path = public, extensions
as $$
begin
  if public.current_role() not in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager') then
    raise exception 'Not authorized to view attendance terminal QR history.';
  end if;
  if p_status is not null and p_status not in ('active', 'revoked', 'expired', 'deleted') then
    raise exception 'Invalid status filter. Use active, revoked, expired or deleted.';
  end if;

  return query
  select h.id, h.device_id,
         d.device_name,
         h.status,
         h.token_preview,
         h.created_at,
         coalesce(pc.full_name, h.created_by::text),
         h.revoked_at,
         coalesce(pr.full_name, h.revoked_by::text),
         h.expires_at
    from public.attendance_terminal_token_history h
    left join public.attendance_devices d on d.id = h.device_id
    left join public.profiles pc on pc.id = h.created_by
    left join public.profiles pr on pr.id = h.revoked_by
   where (p_device_id is null or h.device_id = p_device_id)
     and (p_status is null or h.status = p_status)
   order by h.created_at desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. PUBLIC SCAN GATES — authoritative per-terminal/day enforcement before any
--    attendance record is created.
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
  v_bind jsonb; v_tbind jsonb; v_bound_name text;
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
  if v_employee_id is null then return jsonb_build_object('valid', false, 'error', 'Employee number or email could not be verified.'); end if;
  select * into v_employee from public.employees where id = v_employee_id;
  select * into v_record from public.attendance_records where employee_id = v_employee_id and attendance_date = v_today limit 1;
  v_next_action := case when not found then 'CLOCK_IN' when v_record.clock_out is null then 'CLOCK_OUT' else 'COMPLETE' end;

  -- Authoritative per-terminal/day policy: this DEVICE is already bound to a
  -- different employee today -> stop before the identity is confirmed.
  v_tbind := public.attendance_terminal_day_binding_check(v_terminal.device_id, v_employee_id, v_next_action);
  if (v_tbind ->> 'allowed')::boolean = false then
    select e.full_name into v_bound_name from public.employees e where e.id = (v_tbind ->> 'bound_to')::uuid;
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'ATTENDANCE_DEVICE_BINDING_BLOCKED', 'AttendanceDevice', v_terminal.device_id::text,
      'attendance-terminal',
      jsonb_build_object(
        'module', 'attendance', 'terminal_id', v_terminal.device_id,
        'channel', 'terminal', 'event_type', v_next_action,
        'attempted_employee', (select e.full_name from public.employees e where e.id = v_employee_id),
        'bound_employee', v_bound_name,
        'binding_date', v_tbind ->> 'date',
        'scope', 'terminal_device_day'
      )::text,
      'warning'
    );
    return jsonb_build_object(
      'valid', false,
      'device_binding_blocked', true,
      'device_binding_error', coalesce(nullif(v_tbind ->> 'error', ''), 'DEVICE_BINDING:This attendance terminal is already bound to a different employee today.'),
      'error', coalesce(nullif(v_tbind ->> 'error', ''), 'DEVICE_BINDING:This attendance terminal is already bound to a different employee today.')
    );
  end if;

  -- Browser-scoped policy, reported so the terminal can also stop early.
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
  v_bind jsonb; v_tbind jsonb; v_bound_employee public.employees%rowtype;
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
  if v_employee_id is null then return jsonb_build_object('success', false, 'error', 'Employee number or email could not be verified.'); end if;

  -- Authoritative per-terminal/day policy: ONE employee per attendance device
  -- per app day, independent of the scanning browser. Enforced BEFORE any
  -- attendance record is created.
  v_tbind := public.attendance_terminal_day_binding_check(v_device.id, v_employee_id, p_event_type);
  if (v_tbind ->> 'allowed')::boolean = false then
    select * into v_bound_employee from public.employees where id = (v_tbind ->> 'bound_to')::uuid;
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'ATTENDANCE_DEVICE_BINDING_BLOCKED', 'AttendanceDevice', v_device.id::text,
      'attendance-terminal',
      jsonb_build_object(
        'module', 'attendance', 'terminal_id', v_device.id,
        'channel', 'terminal', 'event_type', p_event_type,
        'attempted_employee', coalesce(
          (select e.full_name from public.employees e where e.id = v_employee_id),
          p_employee_identifier
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
        'DEVICE_BINDING:This attendance terminal is already bound to a different employee today.'
      ),
      'device_binding_blocked', true
    );
  end if;

  -- Browser-scoped policy gate (complementary).
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
-- 9. GRANTS — public scan gates stay anon+authenticated; management + history
--    stay role-gated inside the functions; raw tokens never RLS-visible.
-- ---------------------------------------------------------------------------
revoke all on function public.list_attendance_terminal_qr_history(uuid, text) from public;
revoke all on function public.attendance_terminal_day_binding_check(uuid, uuid, text) from public;
revoke all on function public.attendance_device_bind(text, uuid, uuid) from public, anon, authenticated;

revoke all on function public.create_attendance_terminal_token(uuid, text) from public;
revoke all on function public.revoke_attendance_terminal(uuid) from public;
revoke all on function public.suspend_attendance_terminal(uuid) from public;
revoke all on function public.resume_attendance_terminal(uuid) from public;
revoke all on function public.delete_attendance_terminal(uuid) from public;
revoke all on function public.get_attendance_terminal_qr_link(uuid) from public;
revoke all on function public.attendance_terminal_for_token(text) from public;

grant execute on function public.create_attendance_terminal_token(uuid, text) to authenticated;
grant execute on function public.revoke_attendance_terminal(uuid) to authenticated;
grant execute on function public.suspend_attendance_terminal(uuid) to authenticated;
grant execute on function public.resume_attendance_terminal(uuid) to authenticated;
grant execute on function public.delete_attendance_terminal(uuid) to authenticated;
grant execute on function public.get_attendance_terminal_qr_link(uuid) to authenticated;
grant execute on function public.list_attendance_terminal_qr_history(uuid, text) to authenticated;

revoke all on function public.validate_attendance_terminal_employee(text, text, text) from public;
revoke all on function public.validate_attendance_terminal_location(text, text, float, float, text) from public;
revoke all on function public.clock_attendance_terminal(text, text, text, float, float, float, text) from public;
grant execute on function public.validate_attendance_terminal_employee(text, text, text) to anon, authenticated;
grant execute on function public.validate_attendance_terminal_location(text, text, float, float, text) to anon, authenticated;
grant execute on function public.clock_attendance_terminal(text, text, text, float, float, float, text) to anon, authenticated;