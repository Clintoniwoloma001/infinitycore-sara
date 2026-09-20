-- Phase 62 — QR Terminal Management (list / suspend / resume / revoke / delete)
--
-- Attendance Mgmt → QR Attendance gains a terminal device list with per-device
-- View QR, Suspend, Resume, Revoke and Delete actions.
--
-- Attendance_terminal states on public.attendance_devices after this phase:
--   active    : status='active'    AND active=true  AND device_token NOT NULL
--               → usable at every public scan/validation gate.
--   suspended : status='suspended'  AND active=false AND device_token preserved
--               → reversible pause; token kept so Resume works without printing
--                 a fresh QR.
--   revoked   : status='revoked'    AND active=false AND device_token NULL
--               → permanent kill (the existing Revoke QR behaviour). Delete is
--                 reserved for rows already in this state.
--   inactive / offline : the pre-existing registry states, untouched.
--
-- The public gates validate_attendance_terminal_employee(),
-- validate_attendance_terminal_location() and clock_attendance_terminal() all
-- already require status='active' AND active=true, so suspended and revoked
-- rows are rejected automatically — no scan-path change required.
--
-- Idempotent/additive. Run in the Supabase SQL Editor after Phase 61.

-- 1. Widen attendance_devices.status to admit 'revoked'.
alter table public.attendance_devices
  drop constraint if exists attendance_devices_status_check;

alter table public.attendance_devices
  add constraint attendance_devices_status_check
  check (status in ('active', 'inactive', 'suspended', 'offline', 'revoked'));

-- 2. Re-label legacy revoked rows. Before this phase, revoke_attendance_terminal
--    wrote status='suspended' and nulled device_token (a permanent kill). Those
--    token-less suspended attendance terminals are semantically revoked.
update public.attendance_devices
   set status = 'revoked', active = false
 where device_type = 'attendance_terminal'
   and status = 'suspended'
   and device_token is null;

-- 3. Repoint revoke_attendance_terminal to the explicit 'revoked' state.
create or replace function public.revoke_attendance_terminal(p_device_id uuid)
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
    return jsonb_build_object('ok', true, 'device_id', p_device_id, 'revoked', true);
  end if;

  update public.attendance_devices
     set device_token = null, status = 'revoked', active = false, updated_at = now()
   where id = p_device_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_TERMINAL_REVOKED',
    'AttendanceDevice',
    p_device_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    jsonb_build_object('module', 'attendance', 'device_name', v_dev.device_name, 'success', true)::text,
    'warning'
  );

  return jsonb_build_object('ok', true, 'device_id', p_device_id, 'revoked', true);
end;
$$;

-- 4. Suspend — reversible pause that keeps the token so Resume needs no reprint.
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
    'ATTENDANCE_TERMINAL_SUSPENDED',
    'AttendanceDevice',
    p_device_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    jsonb_build_object('module', 'attendance', 'device_name', v_dev.device_name, 'success', true)::text,
    'warning'
  );

  return jsonb_build_object('ok', true, 'device_id', p_device_id, 'suspended', true);
end;
$$;

-- 5. Resume — reactivate a suspended terminal, preserving its token.
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
    'ATTENDANCE_TERMINAL_RESUMED',
    'AttendanceDevice',
    p_device_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    jsonb_build_object('module', 'attendance', 'device_name', v_dev.device_name, 'success', true)::text,
    'info'
  );

  return jsonb_build_object('ok', true, 'device_id', p_device_id, 'resumed', true);
end;
$$;

-- 6. Delete — only physically removes an already-revoked terminal (history in
--    attendance_terminal_attempts cascades). Live/suspended rows are rejected.
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

  delete from public.attendance_devices where id = p_device_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_TERMINAL_DELETED',
    'AttendanceDevice',
    p_device_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    jsonb_build_object('module', 'attendance', 'device_name', v_dev.device_name, 'success', true)::text,
    'warning'
  );

  return jsonb_build_object('ok', true, 'device_id', p_device_id, 'deleted', true);
end;
$$;

-- 7. Grants. Nothing is exposed to anon/public; attendance_terminal_attempts
--    stays fully revoked from anon/authenticated.
revoke all on function public.revoke_attendance_terminal(uuid) from public;
revoke all on function public.suspend_attendance_terminal(uuid) from public;
revoke all on function public.resume_attendance_terminal(uuid) from public;
revoke all on function public.delete_attendance_terminal(uuid) from public;
grant execute on function public.revoke_attendance_terminal(uuid) to authenticated;
grant execute on function public.suspend_attendance_terminal(uuid) to authenticated;
grant execute on function public.resume_attendance_terminal(uuid) to authenticated;
grant execute on function public.delete_attendance_terminal(uuid) to authenticated;