-- Public QR attendance hardening.
--
-- This migration is intentionally limited to the public attendance terminal
-- and the shared server-authoritative attendance path. It is additive and
-- safe to re-run.

create schema if not exists extensions;

do $$
declare
  v_schema text;
begin
  select n.nspname into v_schema
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

alter table public.attendance_records
  add column if not exists actual_branch_id uuid references public.branches(id) on delete set null,
  add column if not exists actual_location_name text,
  add column if not exists actual_location_type text,
  add column if not exists location_different_from_assigned boolean;

create index if not exists idx_attendance_actual_branch
  on public.attendance_records(actual_branch_id);

grant execute on function public.get_attendance_requirements() to anon;
grant execute on function public.get_attendance_network_time() to anon;

-- Haversine distance in metres. This is the existing attendance geofence
-- approach; no second geospatial dependency is introduced.
create or replace function public.geo_distance(lat1 float, lng1 float, lat2 float, lng2 float)
returns float
language sql
immutable
set search_path = public
as $$
  select 6371000.0 * 2 * asin(sqrt(
    power(sin(radians((lat2 - lat1) / 2.0)), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) *
    power(sin(radians((lng2 - lng1) / 2.0)), 2)
  ));
$$;

-- Resolve the employee's assigned branch, then compare the submitted
-- coordinates with every active branch and attendance geofence. The assigned
-- branch is context only; every configured Infinity Bank location is valid.
create or replace function public.attendance_validate_location(
  p_employee_id uuid,
  p_lat float,
  p_lng float,
  p_action text,
  p_branch_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee record;
  v_assigned record;
  v_settings record;
  v_candidate record;
  v_assigned_id uuid;
  v_assigned_name text;
  v_best_branch_id uuid;
  v_best_geofence_id uuid;
  v_best_name text;
  v_best_type text;
  v_best_distance float;
  v_best_radius numeric;
  v_nearest_name text;
  v_nearest_distance float;
  v_nearest_radius numeric;
  v_has_location boolean := false;
  v_action text := lower(coalesce(p_action, 'clock_in'));
  v_location_difference boolean;
begin
  select * into v_employee
    from public.employees
   where id = p_employee_id
   limit 1;
  if not found then
    raise exception 'Employee record not found.';
  end if;

  select * into v_settings
    from public.hr_platform_settings
   where id = 1
   limit 1;

  if p_lat is null or p_lng is null then
    raise exception 'LOCATION_REQUIRED:Location is required to clock in or out. Please enable location access.';
  end if;
  if p_lat <> p_lat or p_lng <> p_lng
     or p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
    raise exception 'LOCATION_INVALID:Your device returned an invalid location. Please try again.';
  end if;

  if p_branch_id is not null then
    select * into v_assigned from public.branches where id = p_branch_id limit 1;
  elsif v_employee.branch_id is not null then
    select * into v_assigned from public.branches where id = v_employee.branch_id limit 1;
  elsif nullif(trim(v_employee.branch), '') is not null then
    select * into v_assigned
      from public.branches
     where lower(branch_name) = lower(trim(v_employee.branch))
        or lower(coalesce(branch_code, '')) = lower(trim(v_employee.branch))
     order by case when lower(branch_name) = lower(trim(v_employee.branch)) then 0 else 1 end
     limit 1;
  end if;

  v_assigned_id := v_assigned.id;
  v_assigned_name := coalesce(v_assigned.branch_name, nullif(trim(v_employee.branch), ''));

  for v_candidate in
    select b.id as branch_id,
           null::uuid as geofence_id,
           b.branch_name as location_name,
           'branch'::text as location_type,
           b.latitude::float as latitude,
           b.longitude::float as longitude,
           greatest(1, coalesce(b.geofence_radius, v_settings.default_geofence_radius, 150))::numeric as radius
      from public.branches b
     where coalesce(b.geofence_active, false)
       and b.latitude is not null
       and b.longitude is not null
    union all
    select gb.id as branch_id,
           g.id as geofence_id,
           coalesce(gb.branch_name, nullif(g.location_name, ''), g.name) as location_name,
           case
             when lower(coalesce(g.location_name, '') || ' ' || coalesce(g.name, '')) like '%head office%'
               then 'head_office'
             else 'geofence'
           end as location_type,
           g.latitude::float as latitude,
           g.longitude::float as longitude,
           greatest(1, coalesce(g.radius_meters, v_settings.default_geofence_radius, 150))::numeric as radius
      from public.attendance_geofences g
      left join public.branches gb on gb.id::text = g.branch_id
     where coalesce(g.active, false)
       and g.latitude is not null
       and g.longitude is not null
       and case when v_action = 'clock_out'
                then coalesce(g.clock_out_allowed, true)
                else coalesce(g.clock_in_allowed, true)
           end
  loop
    v_has_location := true;
    declare
      v_distance float := public.geo_distance(p_lat, p_lng, v_candidate.latitude, v_candidate.longitude);
    begin
      if v_nearest_distance is null or v_distance < v_nearest_distance then
        v_nearest_distance := v_distance;
        v_nearest_name := v_candidate.location_name;
        v_nearest_radius := v_candidate.radius;
      end if;

      if v_distance <= v_candidate.radius
         and (v_best_distance is null or v_distance < v_best_distance) then
        v_best_distance := v_distance;
        v_best_branch_id := v_candidate.branch_id;
        v_best_geofence_id := v_candidate.geofence_id;
        v_best_name := v_candidate.location_name;
        v_best_type := v_candidate.location_type;
        v_best_radius := v_candidate.radius;
      end if;
    end;
  end loop;

  if not v_has_location then
    raise exception 'GEOFENCE_NOT_CONFIGURED:No approved attendance location is configured. Contact HR before clocking in or out.';
  end if;
  if v_best_distance is null then
    raise exception 'OUTSIDE_GEOFENCE:You are outside all approved Infinity Bank attendance locations.';
  end if;

  if v_best_distance is not null then
    v_location_difference := not (
      (v_assigned_id is not null and v_best_branch_id = v_assigned_id)
      or (v_assigned_name is not null and lower(v_best_name) = lower(v_assigned_name))
    );
  end if;

  return jsonb_build_object(
    'assigned_branch_id', v_assigned_id,
    'assigned_branch_name', v_assigned_name,
    'actual_branch_id', v_best_branch_id,
    'actual_geofence_id', v_best_geofence_id,
    'actual_location_name', v_best_name,
    'actual_location_type', v_best_type,
    'location_difference', v_location_difference,
    'distance', v_best_distance,
    'radius', v_best_radius,
    'nearest_location_name', v_nearest_name,
    'nearest_distance', v_nearest_distance,
    'nearest_radius', v_nearest_radius,
    'geofence_status', case when v_best_distance is null then 'outside' else 'inside' end,
    'location_status', case when v_best_distance is null then 'outside' else 'inside' end,
    'work_start_time', coalesce(v_assigned.work_start_time, v_settings.default_work_start_time, '08:00')::text,
    'work_end_time', coalesce(v_assigned.work_end_time, v_settings.default_work_end_time, '17:00')::text,
    'grace_period_minutes', coalesce(v_assigned.grace_period_minutes, v_settings.default_grace_period_minutes, 15)
  );
end;
$$;

revoke all on function public.attendance_validate_location(uuid, float, float, text, uuid) from public;

-- Anonymous preview used only to show the result of the server check before
-- the employee chooses clock-in or clock-out. The write RPC repeats the check.
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
  v_normalized text := upper(trim(regexp_replace(coalesce(p_employee_identifier, ''), '\s*/\s*', '/', 'g')));
  v_location jsonb;
begin
  if p_event_type not in ('CLOCK_IN', 'CLOCK_OUT') then
    return jsonb_build_object('valid', false, 'error', 'Choose Clock In or Clock Out.');
  end if;

  select e.id into v_employee_id
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

  if v_employee_id is null then
    return jsonb_build_object('valid', false, 'error', 'Employee number could not be verified.');
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
  v_normalized text := upper(trim(regexp_replace(coalesce(p_employee_identifier, ''), '\s*/\s*', '/', 'g')));
  v_employee public.employees%rowtype;
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

  return jsonb_build_object(
    'valid', true,
    'employee_name', v_employee.full_name,
    'employee_number', coalesce(v_employee.employee_number, v_employee.staff_id, v_employee.employee_code)
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
  v_normalized text := upper(trim(regexp_replace(coalesce(p_employee_identifier, ''), '\s*/\s*', '/', 'g')));
  v_employee_id uuid;
  v_open_attendance_id uuid;
  v_result jsonb;
  v_identifier_hash text;
  v_attempts integer;
begin
  if p_event_type not in ('CLOCK_IN', 'CLOCK_OUT') then
    return jsonb_build_object('success', false, 'error', 'Choose Clock In or Clock Out.');
  end if;
  if v_normalized = '' then
    return jsonb_build_object('success', false, 'error', 'Enter your employee number.');
  end if;
  if p_lat is null or p_lng is null then
    return jsonb_build_object('success', false, 'error', 'LOCATION_REQUIRED:Location is required to record attendance. Please enable location access.');
  end if;

  select * into v_device
    from public.attendance_devices
   where device_type = 'attendance_terminal'
     and status = 'active'
     and active = true
     and device_token = encode(
       extensions.digest(convert_to(coalesce(p_token, '')::text, 'UTF8'), 'sha256'::text),
       'hex'
     )
   limit 1;
  if not found then
    return jsonb_build_object('success', false, 'error', 'This attendance terminal link is invalid or revoked.');
  end if;

  v_identifier_hash := encode(
    extensions.digest(convert_to(v_normalized::text, 'UTF8'), 'sha256'::text),
    'hex'
  );
  select count(*) into v_attempts
    from public.attendance_terminal_attempts
   where terminal_id = v_device.id
     and identifier_hash = v_identifier_hash
     and attempted_at > clock_timestamp() - interval '5 minutes';
  if v_attempts >= 10 then
    return jsonb_build_object('success', false, 'error', 'Too many attempts. Please wait and try again.');
  end if;
  insert into public.attendance_terminal_attempts (terminal_id, identifier_hash)
  values (v_device.id, v_identifier_hash);

  select e.id into v_employee_id
    from public.employees e
   where e.employment_status = 'active'
     and (
       upper(trim(coalesce(e.employee_number, ''))) = v_normalized
       or upper(trim(coalesce(e.staff_id, ''))) = v_normalized
       or upper(trim(coalesce(e.employee_code, ''))) = v_normalized
     )
   limit 1;
  if v_employee_id is null then
    return jsonb_build_object('success', false, 'error', 'Employee number could not be verified.');
  end if;

  -- attendance_clock_* re-runs the authoritative all-location geofence check.
  if p_event_type = 'CLOCK_IN' then
    v_result := public.attendance_clock_in_for_employee(
      v_employee_id, p_lat, p_lng, p_accuracy,
      'terminal', v_device.id, 'GPS', 'ATTENDANCE_TERMINAL'
    );
  else
    select id into v_open_attendance_id
      from public.attendance_records
     where employee_id = v_employee_id
       and clock_out is null
     order by clock_in desc
     limit 1;
    if v_open_attendance_id is null then
      return jsonb_build_object('success', false, 'error', 'No open attendance session was found.');
    end if;
    v_result := public.attendance_clock_out_for_employee(
      v_employee_id, v_open_attendance_id, p_lat, p_lng, p_accuracy,
      'terminal', v_device.id, 'GPS', 'ATTENDANCE_TERMINAL'
    );
  end if;

  update public.attendance_devices
     set last_seen_at = clock_timestamp()
   where id = v_device.id;

  return v_result || jsonb_build_object(
    'success', true,
    'terminal_id', v_device.id,
    'public_terminal', true
  );
end;
$$;

revoke all on function public.validate_attendance_terminal_location(text, text, float, float, text) from public;
revoke all on function public.validate_attendance_terminal_employee(text, text) from public;
revoke all on function public.clock_attendance_terminal(text, text, text, float, float, float) from public;
grant execute on function public.validate_attendance_terminal_location(text, text, float, float, text) to anon, authenticated;
grant execute on function public.validate_attendance_terminal_employee(text, text) to anon, authenticated;
grant execute on function public.clock_attendance_terminal(text, text, text, float, float, float) to anon, authenticated;

-- Keep the normalized location context available directly on attendance
-- records as well as in the event metadata used by existing reports.
create or replace function public.sync_attendance_location_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.attendance_record_id is not null
     and new.event_type in ('CLOCK_IN', 'CLOCK_OUT')
     and new.metadata is not null then
    update public.attendance_records
       set actual_branch_id = nullif(new.metadata ->> 'actual_branch_id', '')::uuid,
           actual_location_name = nullif(new.metadata ->> 'actual_location_name', ''),
           actual_location_type = nullif(new.metadata ->> 'actual_location_type', ''),
           location_different_from_assigned = case
             when new.metadata ? 'location_difference'
               then (new.metadata ->> 'location_difference')::boolean
             else null
           end
     where id = new.attendance_record_id;
  end if;
  return new;
end;
$$;

drop trigger if exists attendance_event_location_columns on public.attendance_events;
create trigger attendance_event_location_columns
after insert on public.attendance_events
for each row execute function public.sync_attendance_location_columns();

revoke all on function public.sync_attendance_location_columns() from public;
