-- Repairs deployments that still have the legacy digest(text, text) call in
-- create_attendance_terminal_token. pgcrypto.digest accepts bytea, not text.

create schema if not exists extensions;

do $$
declare
  v_schema text;
begin
  select n.nspname
    into v_schema
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pgcrypto';

  if v_schema is null then
    create extension pgcrypto with schema extensions;
  elsif v_schema <> 'extensions' then
    alter extension pgcrypto set schema extensions;
  end if;
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
  v_token_bytes bytea := extensions.gen_random_bytes(32);
  v_raw text := encode(v_token_bytes, 'hex');
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
      values (
        coalesce(nullif(trim(p_device_name), ''), 'QR Attendance Terminal'),
        'attendance_terminal',
        'active',
        true,
        auth.uid()
      )
      returning * into v_device;
    end if;
  else
    select * into v_device
      from public.attendance_devices
     where id = p_device_id
     for update;

    if not found or v_device.device_type <> 'attendance_terminal' then
      raise exception 'Attendance terminal not found.';
    end if;
  end if;

  update public.attendance_devices
     set device_token = encode(extensions.digest(v_token_bytes, 'sha256'::text), 'hex'),
         status = 'active',
         active = true,
         updated_at = now()
   where id = v_device.id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_TERMINAL_TOKEN_REGENERATED',
    'AttendanceDevice',
    v_device.id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    jsonb_build_object(
      'module', 'attendance',
      'device_name', v_device.device_name,
      'success', true
    )::text,
    'warning'
  );

  return jsonb_build_object(
    'ok', true,
    'device_id', v_device.id,
    'device_name', v_device.device_name,
    'token', v_raw,
    'generated_at', clock_timestamp()
  );
end;
$$;

revoke all on function public.create_attendance_terminal_token(uuid, text) from public;
grant execute on function public.create_attendance_terminal_token(uuid, text) to authenticated;
