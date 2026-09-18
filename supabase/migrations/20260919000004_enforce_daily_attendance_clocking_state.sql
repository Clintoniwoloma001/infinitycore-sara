-- One attendance session per employee per local business day.
-- This is enforced at the table boundary so web, QR terminal, biometric and
-- device ingestion paths cannot create or close a second session.

create or replace function public.attendance_insert_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (clock_timestamp() at time zone public.att_app_timezone())::date;
  v_correcting boolean := coalesce(current_setting('app.correcting_attendance', true), 'off') = 'on';
begin
  if not v_correcting then
    -- A client/device timestamp or date must never create a second day state.
    new.clock_in := clock_timestamp();
    new.attendance_date := v_today;

    if new.clock_out is not null then
      raise exception 'Clock-out must be performed after a clock-in on the existing attendance record.';
    end if;

    if exists (
      select 1
        from public.attendance_records
       where employee_id = new.employee_id
         and attendance_date = new.attendance_date
    ) then
      raise exception 'Attendance has already been recorded for this employee today. You can only clock out if that session is still open.';
    end if;
  end if;

  new.status := coalesce(nullif(new.status, ''), 'present');
  if new.status not in ('present', 'absent', 'late', 'early_exit', 'on_leave', 'incomplete', 'corrected') then
    raise exception 'Invalid attendance status "%".', new.status;
  end if;
  new.source := coalesce(new.source, 'web');
  return new;
end;
$$;

drop trigger if exists attendance_before_insert on public.attendance_records;
create trigger attendance_before_insert
  before insert on public.attendance_records
  for each row execute function public.attendance_insert_rules();

create or replace function public.attendance_update_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_correcting boolean := coalesce(current_setting('app.correcting_attendance', true), 'off') = 'on';
  v_today date := (clock_timestamp() at time zone public.att_app_timezone())::date;
begin
  if not v_correcting then
    if new.clock_in is distinct from old.clock_in then
      raise exception 'Clock-in time cannot be edited directly.';
    end if;

    if old.clock_out is not null and new.clock_out is distinct from old.clock_out then
      raise exception 'You have already clocked out for this attendance day.';
    end if;

    if new.clock_out is not null and old.clock_out is null then
      if old.clock_in is null then
        raise exception 'You cannot clock out before clocking in.';
      end if;
      if old.attendance_date <> v_today then
        raise exception 'You can only clock out of today''s open attendance session.';
      end if;
      new.clock_out := clock_timestamp();
      if new.clock_out <= old.clock_in then
        raise exception 'Invalid clock-out time.';
      end if;
      new.is_corrected := false;
    end if;
  end if;

  if new.clock_in is not null and new.clock_out is not null then
    new.total_minutes := greatest(0, round(extract(epoch from (new.clock_out - new.clock_in)) / 60.0))::integer;
    new.work_hours := round(new.total_minutes::numeric / 60.0, 2);
    if not v_correcting and new.clock_out is distinct from old.clock_out then
      new.status := case when coalesce(old.late_minutes, 0) > 0 then 'late' else 'present' end;
    end if;
  end if;

  if new.status not in ('present', 'absent', 'late', 'early_exit', 'on_leave', 'incomplete', 'corrected') then
    raise exception 'Invalid attendance status "%".', new.status;
  end if;
  return new;
end;
$$;

drop trigger if exists attendance_before_update on public.attendance_records;
create trigger attendance_before_update
  before update on public.attendance_records
  for each row execute function public.attendance_update_rules();

-- Make the authenticated web RPC reject repeat/invalid clock-outs before it
-- reaches a legacy idempotent path. QR terminal and device writes are covered
-- by the table trigger above.
do $$
begin
  if to_regprocedure('public.clock_out_secure_internal(uuid,double precision,double precision,double precision)') is null then
    alter function public.clock_out_secure(uuid, float, float, float)
      rename to clock_out_secure_internal;
  end if;
end;
$$;

create or replace function public.clock_out_secure(
  p_attendance_id uuid,
  p_lat float,
  p_lng float,
  p_accuracy float default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee_id uuid;
  v_record public.attendance_records%rowtype;
  v_today date := (clock_timestamp() at time zone public.att_app_timezone())::date;
begin
  select id into v_employee_id
    from public.employees
   where user_id = auth.uid()
   limit 1;
  if v_employee_id is null then
    raise exception 'No employee profile is linked to your account.';
  end if;

  select * into v_record
    from public.attendance_records
   where id = p_attendance_id
   for update;
  if not found or v_record.employee_id <> v_employee_id then
    raise exception 'No open attendance session was found for your account.';
  end if;
  if v_record.attendance_date <> v_today then
    raise exception 'You can only clock out of today''s open attendance session.';
  end if;
  if v_record.clock_in is null then
    raise exception 'You cannot clock out before clocking in.';
  end if;
  if v_record.clock_out is not null then
    raise exception 'You have already clocked out today.';
  end if;

  return public.clock_out_secure_internal(p_attendance_id, p_lat, p_lng, p_accuracy);
end;
$$;

revoke all on function public.clock_out_secure_internal(uuid, float, float, float) from public;
revoke all on function public.clock_out_secure(uuid, float, float, float) from public;
grant execute on function public.clock_out_secure(uuid, float, float, float) to authenticated;

-- Give the public QR terminal a read-only state hint for its UI. The clocking
-- RPC and triggers above remain authoritative if the UI is stale or bypassed.
create or replace function public.validate_attendance_terminal_employee(
  p_token text,
  p_employee_identifier text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_normalized text := upper(trim(regexp_replace(coalesce(p_employee_identifier, ''), '\s*/\s*', '/', 'g')));
  v_employee public.employees%rowtype;
  v_record public.attendance_records%rowtype;
  v_today date := (clock_timestamp() at time zone public.att_app_timezone())::date;
  v_next_action text;
begin
  if v_normalized = '' then
    return jsonb_build_object('valid', false, 'error', 'Enter your employee number.');
  end if;

  select e.* into v_employee
    from public.attendance_devices d
    join public.employees e
      on e.employment_status = 'active'
     and (
       upper(trim(coalesce(e.employee_number, ''))) = v_normalized
       or upper(trim(coalesce(e.staff_id, ''))) = v_normalized
       or upper(trim(coalesce(e.employee_code, ''))) = v_normalized
     )
   where d.device_type = 'attendance_terminal'
     and d.status = 'active'
     and d.active = true
     and d.device_token = encode(
       extensions.digest(convert_to(coalesce(p_token, '')::text, 'UTF8'), 'sha256'::text),
       'hex'
     )
   limit 1;

  if not found then
    return jsonb_build_object('valid', false, 'error', 'Employee number could not be verified.');
  end if;

  select * into v_record
    from public.attendance_records
   where employee_id = v_employee.id
     and attendance_date = v_today
   limit 1;

  v_next_action := case
    when not found then 'CLOCK_IN'
    when v_record.clock_out is null then 'CLOCK_OUT'
    else 'COMPLETE'
  end;

  return jsonb_build_object(
    'valid', true,
    'employee_name', v_employee.full_name,
    'employee_number', coalesce(v_employee.employee_number, v_employee.staff_id, v_employee.employee_code),
    'next_action', v_next_action
  );
end;
$$;

revoke all on function public.validate_attendance_terminal_employee(text, text) from public;
grant execute on function public.validate_attendance_terminal_employee(text, text) to anon, authenticated;

-- The legacy device RPC used to report a no-op clock-out as successful. Keep
-- its validated implementation intact, but expose a strict wrapper that
-- turns a missing attendance_id into a failed clock-out response.
do $$
begin
  if to_regprocedure('public.ingest_attendance_event_internal(uuid,text,text,timestamp with time zone,text,jsonb,uuid)') is null then
    alter function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb, uuid)
      rename to ingest_attendance_event_internal;
  end if;
end;
$$;

create or replace function public.ingest_attendance_event(
  p_device_id uuid,
  p_external_user_id text,
  p_event_type text,
  p_event_time timestamptz default now(),
  p_verification_method text default 'FINGERPRINT',
  p_metadata jsonb default '{}'::jsonb,
  p_employee_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  v_result := public.ingest_attendance_event_internal(
    p_device_id, p_external_user_id, p_event_type, p_event_time,
    p_verification_method, p_metadata, p_employee_id
  );

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

create or replace function public.ingest_attendance_event(
  p_device_id uuid,
  p_external_user_id text,
  p_event_type text,
  p_event_time timestamptz default now(),
  p_verification_method text default 'FINGERPRINT',
  p_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.ingest_attendance_event(
    p_device_id, p_external_user_id, p_event_type, p_event_time,
    p_verification_method, p_metadata, null
  );
end;
$$;

revoke all on function public.ingest_attendance_event_internal(uuid, text, text, timestamptz, text, jsonb, uuid) from public;
revoke all on function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb, uuid) from public;
revoke all on function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb) from public;
grant execute on function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb, uuid) to authenticated;
grant execute on function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb) to authenticated;

-- Resolve the terminal identity once and consistently. Some employee records
-- have an email before HR assigns a staff/employee/code value, so allow that
-- email as a terminal identifier too.
create or replace function public.resolve_attendance_terminal_employee(p_identifier text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_normalized text := upper(trim(regexp_replace(coalesce(p_identifier, ''), '\s*/\s*', '/', 'g')));
  v_employee_id uuid;
begin
  if v_normalized = '' then return null; end if;
  select e.id into v_employee_id
    from public.employees e
   where e.employment_status = 'active'
     and (
       upper(trim(coalesce(e.employee_number, ''))) = v_normalized
       or upper(trim(coalesce(e.staff_id, ''))) = v_normalized
       or upper(trim(coalesce(e.employee_code, ''))) = v_normalized
       or lower(trim(coalesce(e.email, ''))) = lower(trim(p_identifier))
     )
   limit 1;
  return v_employee_id;
end;
$$;

create or replace function public.validate_attendance_terminal_location(
  p_token text,
  p_employee_identifier text,
  p_lat float,
  p_lng float,
  p_event_type text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_employee_id uuid;
  v_location jsonb;
begin
  if p_event_type not in ('CLOCK_IN', 'CLOCK_OUT') then
    return jsonb_build_object('valid', false, 'error', 'Choose Clock In or Clock Out.');
  end if;
  if not exists (
    select 1 from public.attendance_devices d
     where d.device_type = 'attendance_terminal'
       and d.status = 'active' and d.active = true
       and d.device_token = encode(extensions.digest(convert_to(coalesce(p_token, '')::text, 'UTF8'), 'sha256'::text), 'hex')
  ) then
    return jsonb_build_object('valid', false, 'error', 'This attendance terminal link is invalid or revoked.');
  end if;

  v_employee_id := public.resolve_attendance_terminal_employee(p_employee_identifier);
  if v_employee_id is null then
    return jsonb_build_object('valid', false, 'error', 'Employee number or email could not be verified.');
  end if;

  v_location := public.attendance_validate_location(
    v_employee_id, p_lat, p_lng,
    case when p_event_type = 'CLOCK_OUT' then 'clock_out' else 'clock_in' end,
    null
  );
  return jsonb_build_object('valid', true) || v_location;
end;
$$;

create or replace function public.validate_attendance_terminal_employee(
  p_token text,
  p_employee_identifier text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_employee_id uuid;
  v_employee public.employees%rowtype;
  v_record public.attendance_records%rowtype;
  v_today date := (clock_timestamp() at time zone public.att_app_timezone())::date;
  v_next_action text;
begin
  if not exists (
    select 1 from public.attendance_devices d
     where d.device_type = 'attendance_terminal'
       and d.status = 'active' and d.active = true
       and d.device_token = encode(extensions.digest(convert_to(coalesce(p_token, '')::text, 'UTF8'), 'sha256'::text), 'hex')
  ) then
    return jsonb_build_object('valid', false, 'error', 'This attendance terminal link is invalid or revoked.');
  end if;

  v_employee_id := public.resolve_attendance_terminal_employee(p_employee_identifier);
  if v_employee_id is null then
    return jsonb_build_object('valid', false, 'error', 'Employee number or email could not be verified.');
  end if;
  select * into v_employee from public.employees where id = v_employee_id;
  select * into v_record from public.attendance_records
   where employee_id = v_employee_id and attendance_date = v_today limit 1;
  v_next_action := case when not found then 'CLOCK_IN' when v_record.clock_out is null then 'CLOCK_OUT' else 'COMPLETE' end;

  return jsonb_build_object(
    'valid', true,
    'employee_name', v_employee.full_name,
    'employee_number', coalesce(v_employee.employee_number, v_employee.staff_id, v_employee.employee_code),
    'next_action', v_next_action
  );
end;
$$;

create or replace function public.clock_attendance_terminal(
  p_token text,
  p_employee_identifier text,
  p_event_type text,
  p_lat float,
  p_lng float,
  p_accuracy float default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_device public.attendance_devices%rowtype;
  v_employee_id uuid;
  v_open_attendance_id uuid;
  v_result jsonb;
  v_identifier_hash text;
  v_attempts integer;
begin
  if p_event_type not in ('CLOCK_IN', 'CLOCK_OUT') then return jsonb_build_object('success', false, 'error', 'Choose Clock In or Clock Out.'); end if;
  if trim(coalesce(p_employee_identifier, '')) = '' then return jsonb_build_object('success', false, 'error', 'Enter your employee number or email.'); end if;
  if p_lat is null or p_lng is null then return jsonb_build_object('success', false, 'error', 'LOCATION_REQUIRED:Location is required to record attendance. Please enable location access.'); end if;

  select * into v_device from public.attendance_devices
   where device_type = 'attendance_terminal' and status = 'active' and active = true
     and device_token = encode(extensions.digest(convert_to(coalesce(p_token, '')::text, 'UTF8'), 'sha256'::text), 'hex')
   limit 1;
  if not found then return jsonb_build_object('success', false, 'error', 'This attendance terminal link is invalid or revoked.'); end if;

  v_identifier_hash := encode(extensions.digest(convert_to(upper(trim(p_employee_identifier))::text, 'UTF8'), 'sha256'::text), 'hex');
  select count(*) into v_attempts from public.attendance_terminal_attempts
   where terminal_id = v_device.id and identifier_hash = v_identifier_hash
     and attempted_at > clock_timestamp() - interval '5 minutes';
  if v_attempts >= 10 then return jsonb_build_object('success', false, 'error', 'Too many attempts. Please wait and try again.'); end if;
  insert into public.attendance_terminal_attempts (terminal_id, identifier_hash) values (v_device.id, v_identifier_hash);

  v_employee_id := public.resolve_attendance_terminal_employee(p_employee_identifier);
  if v_employee_id is null then return jsonb_build_object('success', false, 'error', 'Employee number or email could not be verified.'); end if;

  if p_event_type = 'CLOCK_IN' then
    v_result := public.attendance_clock_in_for_employee(v_employee_id, p_lat, p_lng, p_accuracy, 'terminal', v_device.id, 'GPS', 'ATTENDANCE_TERMINAL');
  else
    select id into v_open_attendance_id from public.attendance_records
     where employee_id = v_employee_id
       and attendance_date = (clock_timestamp() at time zone public.att_app_timezone())::date
       and clock_out is null
     order by clock_in desc limit 1;
    if v_open_attendance_id is null then return jsonb_build_object('success', false, 'error', 'You cannot clock out before clocking in today.'); end if;
    v_result := public.attendance_clock_out_for_employee(v_employee_id, v_open_attendance_id, p_lat, p_lng, p_accuracy, 'terminal', v_device.id, 'GPS', 'ATTENDANCE_TERMINAL');
  end if;

  update public.attendance_devices set last_seen_at = clock_timestamp() where id = v_device.id;
  return v_result || jsonb_build_object('success', true, 'terminal_id', v_device.id, 'public_terminal', true);
end;
$$;

revoke all on function public.resolve_attendance_terminal_employee(text) from public;
revoke all on function public.validate_attendance_terminal_location(text, text, float, float, text) from public;
revoke all on function public.validate_attendance_terminal_employee(text, text) from public;
revoke all on function public.clock_attendance_terminal(text, text, text, float, float, float) from public;
grant execute on function public.validate_attendance_terminal_location(text, text, float, float, text) to anon, authenticated;
grant execute on function public.validate_attendance_terminal_employee(text, text) to anon, authenticated;
grant execute on function public.clock_attendance_terminal(text, text, text, float, float, float) to anon, authenticated;
