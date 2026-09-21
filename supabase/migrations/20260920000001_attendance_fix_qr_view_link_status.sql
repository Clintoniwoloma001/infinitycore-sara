-- Phase 65 — QR terminal "View QR" persistence + coherent status states.
--
-- Background:
--   * create_attendance_terminal_token stores only a SHA-256 of the raw token
--     in attendance_devices.device_token.  The raw token is handed to the
--     browser exactly once, so "View QR" after a page reload could never
--     redisplay the CURRENT QR without minting a brand-new token.
--   * The temporary 20260919000000 repair redefined revoke to write a
--     token-nulling 'suspended' (the pre-Phase 62 legacy behaviour).  A
--     genuinely revoked terminal therefore surfaced as "Suspended" in the UI,
--     and Resume could incorrectly reactivate a token-less terminal as
--     "active".  Suspended must KEEP its token (reversible, no reprint);
--     Revoked is a permanent kill.
--
-- This migration (idempotent/additive — safe to re-run):
--   1. Restores explicit status semantics: widened CHECK admits 'revoked',
--      revoke writes status='revoked', and legacy token-less 'suspended'
--      terminals are re-labelled 'revoked'.  Also (re-)asserts the Phase 62
--      suspend/resume/delete RPCs so the management surface is coherent even
--      if the top-level Phase 62 file was never applied to the live DB.
--   2. Persists the current raw QR token server-side in a locked-down table
--      (RLS enabled, no anon/auth path) readable only through a SECURITY
--      DEFINER RPC restricted to super_admin/admin/hr_manager.  View QR can
--      therefore always re-render the exact QR/link for the live token WITHOUT
--      regenerating.  Raw tokens are never placed in any RLS-visible column
--      and are purged on revoke/delete.
--   3. Re-routes the public scan gates so a suspended terminal is rejected
--      with a clear "temporarily suspended" message instead of a misleading
--      "invalid or revoked", while revoked/missing tokens keep the revoked
--      message.  Server-side enforcement is unchanged (no attendance record is
--      ever created for a non-active terminal).
--   4. Tracks token_generated_at on the device for the "Generated" column.
--
-- Apply after 20260920000000_attendance_device_daily_binding.sql.

-- ----------------------------------------------------------------------
-- 1. STATUS MODEL — admit 'revoked', re-label legacy token-less suspended
-- ----------------------------------------------------------------------
alter table public.attendance_devices
  drop constraint if exists attendance_devices_status_check;

alter table public.attendance_devices
  add constraint attendance_devices_status_check
  check (status in ('active', 'inactive', 'suspended', 'offline', 'revoked'));

-- Rows written by the 20260919000000 revoke (status='suspended' + token null)
-- are permanent kills, not pauses — mark them revoked.
update public.attendance_devices
   set status = 'revoked', active = false, updated_at = now()
 where device_type = 'attendance_terminal'
   and status = 'suspended'
   and device_token is null;

-- ----------------------------------------------------------------------
-- 2. VIEW-LINK STORAGE (locked-down) + generated timestamp
-- ----------------------------------------------------------------------
alter table public.attendance_devices
  add column if not exists token_generated_at timestamptz;

create table if not exists public.attendance_terminal_view_links (
  device_id  uuid primary key references public.attendance_devices(id) on delete cascade,
  token_hex  text not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create index if not exists idx_attendance_terminal_view_links_updated
  on public.attendance_terminal_view_links(updated_at);

alter table public.attendance_terminal_view_links enable row level security;
revoke all on public.attendance_terminal_view_links from anon, authenticated;

-- ----------------------------------------------------------------------
-- 3. MANAGEMENT RPCs (role-gated)
-- ----------------------------------------------------------------------

-- create — unchanged token generation (random 32 bytes, sha256-hashed for the
-- scan gates) but ALSO persists the raw token for the View-QR UI.
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

  -- Hash the exact string carried by the QR URL. Matches every public gate.
  update public.attendance_devices
     set device_token = encode(
           extensions.digest(convert_to(v_raw, 'UTF8'), 'sha256'), 'hex'
         ),
         status = 'active',
         active = true,
         token_generated_at = clock_timestamp(),
         updated_at = now()
   where id = v_device.id;

  -- Keep the raw token so View QR can re-render the CURRENT link without
  -- regenerating. This table has no anon/auth access; only the gated RPC
  -- below can read it. Revoke/delete purge it.
  insert into public.attendance_terminal_view_links (device_id, token_hex, created_at, updated_at)
  values (v_device.id, v_raw, clock_timestamp(), clock_timestamp())
  on conflict (device_id)
  do update set token_hex = excluded.token_hex, updated_at = clock_timestamp();

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

-- revoke — permanent kill: token purged (scan gates reject), status='revoked'.
create or replace function public.revoke_attendance_terminal(p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_name text;
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

  delete from public.attendance_terminal_view_links where device_id = p_device_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_TERMINAL_REVOKED', 'AttendanceDevice', p_device_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    jsonb_build_object('module', 'attendance', 'device_name', v_name, 'success', true)::text,
    'warning'
  );

  return jsonb_build_object('ok', true, 'device_id', p_device_id, 'revoked', true);
end;
$$;

-- suspend — reversible pause; token + view link are preserved so Resume works
-- without printing a fresh QR.
create or replace function public.suspend_attendance_terminal(p_device_id uuid)
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

  if v_dev.status = 'revoked' then
    raise exception 'This terminal is revoked and cannot be suspended.';
  end if;

  update public.attendance_devices
     set status = 'suspended', active = false, updated_at = now()
   where id = p_device_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_TERMINAL_SUSPENDED', 'AttendanceDevice', p_device_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    jsonb_build_object('module', 'attendance', 'device_name', v_dev.device_name, 'success', true)::text,
    'warning'
  );

  return jsonb_build_object('ok', true, 'device_id', p_device_id, 'suspended', true);
end;
$$;

-- resume — reactivate a suspended terminal, preserving its token/view link.
create or replace function public.resume_attendance_terminal(p_device_id uuid)
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

  if v_dev.status <> 'suspended' then
    raise exception 'Only suspended terminals can be resumed.';
  end if;

  update public.attendance_devices
     set status = 'active', active = true, updated_at = now()
   where id = p_device_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_TERMINAL_RESUMED', 'AttendanceDevice', p_device_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    jsonb_build_object('module', 'attendance', 'device_name', v_dev.device_name, 'success', true)::text,
    'info'
  );

  return jsonb_build_object('ok', true, 'device_id', p_device_id, 'resumed', true);
end;
$$;

-- delete — physically removes an already-revoked terminal only.
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

  delete from public.attendance_terminal_view_links where device_id = p_device_id;
  delete from public.attendance_devices where id = p_device_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_TERMINAL_DELETED', 'AttendanceDevice', p_device_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    jsonb_build_object('module', 'attendance', 'device_name', v_dev.device_name, 'success', true)::text,
    'warning'
  );

  return jsonb_build_object('ok', true, 'device_id', p_device_id, 'deleted', true);
end;
$$;

-- gated QR view — returns the raw token for the CURRENT live QR so the HR UI
-- can re-render the exact link without regenerating. hr roles only.
create or replace function public.get_attendance_terminal_qr_link(p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_dev public.attendance_devices%rowtype;
  v_view public.attendance_terminal_view_links%rowtype;
begin
  if public.current_role() not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to view attendance terminal QR data.';
  end if;

  select * into v_dev from public.attendance_devices where id = p_device_id;
  if not found or v_dev.device_type <> 'attendance_terminal' then
    raise exception 'Attendance terminal not found.';
  end if;

  select * into v_view from public.attendance_terminal_view_links where device_id = p_device_id;
  if not found then
    return jsonb_build_object(
      'ok', true, 'device_id', p_device_id, 'has_qr', false,
      'status', v_dev.status, 'generated_at', v_dev.token_generated_at
    );
  end if;

  return jsonb_build_object(
    'ok', true, 'device_id', p_device_id, 'has_qr', true,
    'token', v_view.token_hex, 'status', v_dev.status, 'generated_at', v_view.updated_at
  );
end;
$$;

-- ----------------------------------------------------------------------
-- 4. PUBLIC SCAN GATES — distinct suspended vs revoked enforcement
-- ----------------------------------------------------------------------

-- Look up a terminal by token INCLUDING non-active states so the gates can
-- answer suspended vs revoked distinctly. Server-only (revoked from public).
create or replace function public.attendance_terminal_for_token(p_token text)
returns table (
  device_id uuid,
  status text,
  active boolean,
  has_token boolean
)
language sql stable security definer
set search_path = public, extensions
as $$
  select d.id, d.status, d.active,
         (d.device_token is not null) as has_token
    from public.attendance_devices d
   where d.device_type = 'attendance_terminal'
     and public.attendance_terminal_token_matches(d.device_token, p_token)
   limit 1;
$$;

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

create or replace function public.validate_attendance_terminal_location(
  p_token text, p_employee_identifier text, p_lat float, p_lng float, p_event_type text
) returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_terminal record; v_employee_id uuid; v_location jsonb;
begin
  if p_event_type not in ('CLOCK_IN', 'CLOCK_OUT') then
    return jsonb_build_object('valid', false, 'error', 'Choose Clock In or Clock Out.');
  end if;
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
  v_location := public.attendance_validate_location(v_employee_id, p_lat, p_lng,
    case when p_event_type = 'CLOCK_OUT' then 'clock_out' else 'clock_in' end, null);
  return jsonb_build_object('valid', true) || v_location;
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

  -- Resolve via the token INCLUDING non-active states so suspended gets a
  -- distinct, clear message. No attendance record is ever created here.
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
-- 5. GRANTS (nothing extra for anon; raw tokens never RLS-visible)
-- ----------------------------------------------------------------------
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

revoke all on function public.validate_attendance_terminal_employee(text, text, text) from public;
revoke all on function public.validate_attendance_terminal_location(text, text, float, float, text) from public;
revoke all on function public.clock_attendance_terminal(text, text, text, float, float, float, text) from public;
grant execute on function public.validate_attendance_terminal_employee(text, text, text) to anon, authenticated;
grant execute on function public.validate_attendance_terminal_location(text, text, float, float, text) to anon, authenticated;
grant execute on function public.clock_attendance_terminal(text, text, text, float, float, float, text) to anon, authenticated;