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
alter function public.clock_out_secure(uuid, float, float, float)
  rename to clock_out_secure_internal;

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
alter function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb, uuid)
  rename to ingest_attendance_event_internal;

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
