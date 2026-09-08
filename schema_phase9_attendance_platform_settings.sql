-- ============================================================
-- Phase 9: Attendance Geofencing + HR Platform Settings
--
-- Adds:
--   1. Branch geofence columns (lat, lng, radius, work hours, grace)
--   2. Attendance record geofence/location columns
--   3. HR platform settings table (single-row config)
--   4. Settings audit trail
--   5. Attendance correction audit trail
--   6. geo_distance() Haversine helper
--   7. clock_in_secure() / clock_out_secure() server-side RPCs
--   8. Updated attendance trigger (preserves late status)
--   9. RLS policies for all new tables
--
-- Safe to re-run: every statement uses IF NOT EXISTS / OR REPLACE.
-- ============================================================

-- ============================================================
-- 1. BRANCH GEOFENCE COLUMNS
-- ============================================================
alter table public.branches
  add column if not exists latitude numeric(10, 6),
  add column if not exists longitude numeric(10, 6),
  add column if not exists geofence_radius integer default 150,
  add column if not exists geofence_active boolean default false,
  add column if not exists work_start_time time default '08:00',
  add column if not exists work_end_time time default '17:00',
  add column if not exists grace_period_minutes integer default 15,
  add column if not exists working_days text[] default array['mon','tue','wed','thu','fri'];

create index if not exists idx_branches_geofence on public.branches(geofence_active);

-- ============================================================
-- 2. ATTENDANCE RECORD — geofence / location columns
-- ============================================================
alter table public.attendance_records
  add column if not exists clock_in_lat numeric(10, 6),
  add column if not exists clock_in_lng numeric(10, 6),
  add column if not exists clock_out_lat numeric(10, 6),
  add column if not exists clock_out_lng numeric(10, 6),
  add column if not exists clock_in_accuracy numeric(8, 2),
  add column if not exists clock_out_accuracy numeric(8, 2),
  add column if not exists clock_in_distance numeric(10, 2),
  add column if not exists clock_out_distance numeric(10, 2),
  add column if not exists geofence_status text default 'no_geofence'
    check (geofence_status in ('inside', 'outside', 'no_geofence', 'disabled')),
  add column if not exists late_minutes integer default 0,
  add column if not exists early_departure_minutes integer default 0,
  add column if not exists total_minutes integer,
  add column if not exists branch_id uuid references public.branches(id) on delete set null;

create index if not exists idx_attendance_branch on public.attendance_records(branch_id);
create index if not exists idx_attendance_status on public.attendance_records(status);

-- ============================================================
-- 3. HR PLATFORM SETTINGS (single-row config table)
-- ============================================================
create table if not exists public.hr_platform_settings (
  id int primary key default 1,
  -- Attendance settings
  require_gps_clock_in boolean default true,
  require_gps_clock_out boolean default true,
  geofence_enabled boolean default true,
  default_geofence_radius integer default 150,
  allow_manual_correction boolean default true,
  late_threshold_minutes integer default 15,
  early_departure_threshold_minutes integer default 30,
  -- Working hours
  default_work_start_time time default '08:00',
  default_work_end_time time default '17:00',
  default_grace_period_minutes integer default 15,
  default_break_duration_minutes integer default 60,
  overtime_threshold_minutes integer default 480,
  default_working_days text[] default array['mon','tue','wed','thu','fri'],
  -- Leave entitlements
  leave_annual_days integer default 21,
  leave_sick_days integer default 10,
  leave_casual_days integer default 5,
  leave_maternity_days integer default 90,
  leave_paternity_days integer default 10,
  leave_compassionate_days integer default 5,
  leave_study_days integer default 5,
  leave_unpaid_days integer default 0,
  leave_approval_required boolean default true,
  leave_attachment_required boolean default false,
  leave_carry_forward boolean default false,
  -- Meta
  updated_at timestamptz default now(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint single_row check (id = 1)
);

-- Seed the single row
insert into public.hr_platform_settings (id) values (1)
  on conflict (id) do nothing;

alter table public.hr_platform_settings enable row level security;

-- ============================================================
-- 4. SETTINGS AUDIT TRAIL
-- ============================================================
create table if not exists public.hr_settings_audit (
  id uuid primary key default gen_random_uuid(),
  setting_key text not null,
  previous_value text,
  new_value text,
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz default now()
);

create index if not exists idx_settings_audit_key on public.hr_settings_audit(setting_key);
create index if not exists idx_settings_audit_time on public.hr_settings_audit(changed_at desc);

alter table public.hr_settings_audit enable row level security;

-- ============================================================
-- 5. ATTENDANCE CORRECTION AUDIT TRAIL
-- ============================================================
create table if not exists public.attendance_corrections_audit (
  id uuid primary key default gen_random_uuid(),
  attendance_id uuid references public.attendance_records(id) on delete cascade,
  field_name text not null,
  previous_value text,
  corrected_value text,
  reason text,
  corrected_by uuid references auth.users(id) on delete set null,
  corrected_at timestamptz default now()
);

create index if not exists idx_attendance_corr_audit_att on public.attendance_corrections_audit(attendance_id);

alter table public.attendance_corrections_audit enable row level security;

-- ============================================================
-- 6. GEO DISTANCE — Haversine formula (metres)
-- ============================================================
create or replace function public.geo_distance(lat1 float, lng1 float, lat2 float, lng2 float)
returns float language sql immutable as $$
  select 6371000.0 * 2 * asin(sqrt(
    power(sin(radians((lat2 - lat1) / 2.0)), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) *
    power(sin(radians((lng2 - lng1) / 2.0)), 2)
  ));
$$;

-- ============================================================
-- 7. CLOCK IN SECURE — server-side geofence validation
-- ============================================================
create or replace function public.clock_in_secure(
  p_lat float,
  p_lng float,
  p_accuracy float default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_employee record;
  v_branch  record;
  v_distance float;
  v_geofence text := 'no_geofence';
  v_late_min int := 0;
  v_work_start time;
  v_grace int;
  v_settings record;
  v_attendance_id uuid;
  v_clock_in_at timestamptz;
  v_today date := (now() at time zone 'UTC')::date;
begin
  -- Resolve employee
  select * into v_employee from public.employees where user_id = auth.uid() limit 1;
  if not found then
    raise exception 'No employee profile is linked to your account.';
  end if;

  -- Early duplicate check (trigger also enforces this)
  if exists (
    select 1 from public.attendance_records
    where employee_id = v_employee.id and attendance_date = v_today and clock_out is null
  ) then
    raise exception 'You have already clocked in today.';
  end if;

  -- Load platform settings
  select * into v_settings from public.hr_platform_settings where id = 1 limit 1;
  v_work_start := coalesce(v_settings.default_work_start_time, '08:00');
  v_grace := coalesce(v_settings.default_grace_period_minutes, 15);

  -- Resolve branch
  if v_employee.branch_id is not null then
    select * into v_branch from public.branches where id = v_employee.branch_id limit 1;
  elsif v_employee.branch is not null then
    select * into v_branch from public.branches
      where lower(branch_name) = lower(v_employee.branch) limit 1;
  end if;

  -- Geofence validation
  if found and v_branch.geofence_active
     and v_branch.latitude is not null and v_branch.longitude is not null then

    v_distance := public.geo_distance(p_lat, p_lng, v_branch.latitude, v_branch.longitude);

    if v_distance <= v_branch.geofence_radius then
      v_geofence := 'inside';
    else
      v_geofence := 'outside';
      raise exception
        'OUTSIDE_GEOFENCE:You are %.0fm from your branch geofence (permitted radius: %m). Please move closer to your workplace and try again.',
        v_distance, v_branch.geofence_radius;
    end if;

    v_work_start := coalesce(v_branch.work_start_time, v_work_start);
    v_grace := coalesce(v_branch.grace_period_minutes, v_grace);

  elsif coalesce(v_settings.geofence_enabled, true)
        and coalesce(v_settings.require_gps_clock_in, true)
        and v_branch is not null
        and v_branch.latitude is not null then
    -- Branch has coordinates but geofence not active — treat as no_geofence
    v_geofence := 'disabled';
  end if;

  -- Calculate late minutes
  v_late_min := greatest(0,
    round(extract(epoch from ((now() at time zone 'UTC')::time - v_work_start)) / 60.0 - v_grace)
  )::int;

  -- Insert (trigger stamps clock_in with now(), checks duplicates)
  v_clock_in_at := now();
  insert into public.attendance_records (
    employee_id, attendance_date, source,
    clock_in_lat, clock_in_lng, clock_in_accuracy,
    clock_in_distance, geofence_status, late_minutes, branch_id
  ) values (
    v_employee.id, v_today, 'web',
    p_lat, p_lng, p_accuracy,
    v_distance, v_geofence, v_late_min, v_branch.id
  )
  returning id into v_attendance_id;

  -- Set status based on lateness
  if v_late_min > 0 then
    update public.attendance_records set status = 'late' where id = v_attendance_id;
  end if;

  -- Audit
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_CLOCK_IN', 'AttendanceRecord', v_attendance_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    format('Clock-in. Geofence: %s. Late by %s min.', v_geofence, v_late_min),
    'info'
  );

  return jsonb_build_object(
    'ok', true,
    'attendance_id', v_attendance_id,
    'clock_in_at', v_clock_in_at,
    'geofence_status', v_geofence,
    'distance', v_distance,
    'late_minutes', v_late_min,
    'status', case when v_late_min > 0 then 'late' else 'present' end
  );
end; $$;

grant execute on function public.clock_in_secure(float, float, float) to authenticated;

-- ============================================================
-- 8. CLOCK OUT SECURE — server-side geofence validation
-- ============================================================
create or replace function public.clock_out_secure(
  p_attendance_id uuid,
  p_lat float,
  p_lng float,
  p_accuracy float default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_record  record;
  v_employee record;
  v_branch  record;
  v_distance float;
  v_geofence text := 'no_geofence';
  v_settings record;
  v_work_end time;
  v_early_min int := 0;
  v_total_min int;
  v_clock_out_at timestamptz;
begin
  -- Resolve employee
  select * into v_employee from public.employees where user_id = auth.uid() limit 1;
  if not found then
    raise exception 'No employee profile is linked to your account.';
  end if;

  -- Load the attendance record (bypass RLS via SECURITY DEFINER)
  select * into v_record from public.attendance_records where id = p_attendance_id;
  if not found then
    raise exception 'Attendance record not found.';
  end if;

  -- Ownership check
  if v_record.employee_id <> v_employee.id then
    raise exception 'You can only clock out of your own attendance session.';
  end if;

  if v_record.clock_out is not null then
    raise exception 'You have already clocked out today.';
  end if;

  -- Load settings
  select * into v_settings from public.hr_platform_settings where id = 1 limit 1;
  v_work_end := coalesce(v_settings.default_work_end_time, '17:00');

  -- Resolve branch for geofence
  if v_record.branch_id is not null then
    select * into v_branch from public.branches where id = v_record.branch_id limit 1;
  end if;

  -- Geofence validation for clock-out
  if found and v_branch.geofence_active
     and v_branch.latitude is not null and v_branch.longitude is not null then

    v_distance := public.geo_distance(p_lat, p_lng, v_branch.latitude, v_branch.longitude);

    if v_distance <= v_branch.geofence_radius then
      v_geofence := 'inside';
    else
      v_geofence := 'outside';
      raise exception
        'OUTSIDE_GEOFENCE:You are %.0fm from your branch geofence (permitted radius: %m). Please move closer to your workplace and try again.',
        v_distance, v_branch.geofence_radius;
    end if;

    v_work_end := coalesce(v_branch.work_end_time, v_work_end);
  end if;

  -- Stamp clock_out (trigger stamps now(), computes work_hours)
  v_clock_out_at := now();
  update public.attendance_records
    set clock_out = v_clock_out_at,
        clock_out_lat = p_lat,
        clock_out_lng = p_lng,
        clock_out_accuracy = p_accuracy,
        clock_out_distance = v_distance
    where id = p_attendance_id;

  -- Compute total minutes and early departure
  v_total_min := round(extract(epoch from (v_clock_out_at - v_record.clock_in)) / 60.0)::int;
  v_early_min := greatest(0,
    round(extract(epoch from (v_work_end - (v_clock_out_at at time zone 'UTC')::time)) / 60.0)
  )::int;

  -- Update computed fields (trigger won't fire for these since clock_in/clock_out unchanged)
  update public.attendance_records
    set total_minutes = v_total_min,
        early_departure_minutes = v_early_min,
        geofence_status = coalesce(v_geofence, geofence_status)
    where id = p_attendance_id;

  -- Set early_exit status if applicable
  if v_early_min > coalesce(v_settings.early_departure_threshold_minutes, 30) then
    update public.attendance_records set status = 'early_exit' where id = p_attendance_id;
  end if;

  -- Audit
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_CLOCK_OUT', 'AttendanceRecord', p_attendance_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    format('Clock-out. Worked %s min. Early departure: %s min.', v_total_min, v_early_min),
    'info'
  );

  return jsonb_build_object(
    'ok', true,
    'attendance_id', p_attendance_id,
    'clock_out_at', v_clock_out_at,
    'geofence_status', v_geofence,
    'distance', v_distance,
    'total_minutes', v_total_min,
    'early_departure_minutes', v_early_min,
    'work_hours', round(v_total_min / 60.0, 2)
  );
end; $$;

grant execute on function public.clock_out_secure(uuid, float, float, float) to authenticated;

-- ============================================================
-- 9. UPDATE ATTENDANCE TRIGGER — preserve late status on clock-out
-- ============================================================
create or replace function public.attendance_update_rules()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- HR corrections go through correct_attendance(), which sets this flag so
  -- the supplied times pass through untouched.
  if current_setting('app.correcting_attendance', true) = 'on' then
    return new;
  end if;
  if new.clock_out is distinct from old.clock_out or new.clock_in is distinct from old.clock_in then
    -- A normal employee clocks out with an UPDATE that sets clock_out; the
    -- server stamps the authoritative time and recomputes the session.
    if old.clock_in is null then
      raise exception 'Cannot clock out without clocking in.';
    end if;
    if new.clock_in is distinct from old.clock_in then
      raise exception 'Clock-in time cannot be edited directly.';
    end if;
    if new.clock_out is not null then
      new.clock_out := now();
    end if;
    if new.clock_out is not null and new.clock_out <= old.clock_in then
      raise exception 'Invalid clock-out time.';
    end if;
    new.work_hours := round(extract(epoch from (coalesce(new.clock_out, now()) - old.clock_in)) / 3600.0, 2);
    -- Preserve late status instead of always overwriting to 'present'
    if old.late_minutes > 0 then
      new.status := 'late';
    else
      new.status := 'present';
    end if;
    new.is_corrected := false;
  end if;
  if old.is_corrected and new.is_corrected = old.is_corrected then
    null;
  end if;
  return new;
end; $$;

-- ============================================================
-- 10. UPDATE SETTINGS RPC — with audit trail
-- ============================================================
create or replace function public.update_hr_settings(p_settings jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_current record;
  v_key text;
  v_old_val text;
  v_new_val text;
begin
  if public.current_role() not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to update HR settings.';
  end if;

  select * into v_current from public.hr_platform_settings where id = 1;

  for v_key in select jsonb_object_keys(p_settings) loop
    v_old_val := case v_key
      when 'require_gps_clock_in' then v_current.require_gps_clock_in::text
      when 'require_gps_clock_out' then v_current.require_gps_clock_out::text
      when 'geofence_enabled' then v_current.geofence_enabled::text
      when 'default_geofence_radius' then v_current.default_geofence_radius::text
      when 'allow_manual_correction' then v_current.allow_manual_correction::text
      when 'late_threshold_minutes' then v_current.late_threshold_minutes::text
      when 'early_departure_threshold_minutes' then v_current.early_departure_threshold_minutes::text
      when 'default_work_start_time' then v_current.default_work_start_time::text
      when 'default_work_end_time' then v_current.default_work_end_time::text
      when 'default_grace_period_minutes' then v_current.default_grace_period_minutes::text
      when 'default_break_duration_minutes' then v_current.default_break_duration_minutes::text
      when 'overtime_threshold_minutes' then v_current.overtime_threshold_minutes::text
      when 'leave_annual_days' then v_current.leave_annual_days::text
      when 'leave_sick_days' then v_current.leave_sick_days::text
      when 'leave_casual_days' then v_current.leave_casual_days::text
      when 'leave_maternity_days' then v_current.leave_maternity_days::text
      when 'leave_paternity_days' then v_current.leave_paternity_days::text
      when 'leave_compassionate_days' then v_current.leave_compassionate_days::text
      when 'leave_study_days' then v_current.leave_study_days::text
      when 'leave_unpaid_days' then v_current.leave_unpaid_days::text
      when 'leave_approval_required' then v_current.leave_approval_required::text
      when 'leave_attachment_required' then v_current.leave_attachment_required::text
      when 'leave_carry_forward' then v_current.leave_carry_forward::text
      else null
    end;
    v_new_val := p_settings->>v_key;
    if v_old_val is distinct from v_new_val then
      insert into public.hr_settings_audit (setting_key, previous_value, new_value, changed_by)
      values (v_key, v_old_val, v_new_val, auth.uid());
    end if;
  end loop;

  update public.hr_platform_settings set
    require_gps_clock_in = coalesce((p_settings->>'require_gps_clock_in')::boolean, require_gps_clock_in),
    require_gps_clock_out = coalesce((p_settings->>'require_gps_clock_out')::boolean, require_gps_clock_out),
    geofence_enabled = coalesce((p_settings->>'geofence_enabled')::boolean, geofence_enabled),
    default_geofence_radius = coalesce((p_settings->>'default_geofence_radius')::int, default_geofence_radius),
    allow_manual_correction = coalesce((p_settings->>'allow_manual_correction')::boolean, allow_manual_correction),
    late_threshold_minutes = coalesce((p_settings->>'late_threshold_minutes')::int, late_threshold_minutes),
    early_departure_threshold_minutes = coalesce((p_settings->>'early_departure_threshold_minutes')::int, early_departure_threshold_minutes),
    default_work_start_time = coalesce((p_settings->>'default_work_start_time')::time, default_work_start_time),
    default_work_end_time = coalesce((p_settings->>'default_work_end_time')::time, default_work_end_time),
    default_grace_period_minutes = coalesce((p_settings->>'default_grace_period_minutes')::int, default_grace_period_minutes),
    default_break_duration_minutes = coalesce((p_settings->>'default_break_duration_minutes')::int, default_break_duration_minutes),
    overtime_threshold_minutes = coalesce((p_settings->>'overtime_threshold_minutes')::int, overtime_threshold_minutes),
    leave_annual_days = coalesce((p_settings->>'leave_annual_days')::int, leave_annual_days),
    leave_sick_days = coalesce((p_settings->>'leave_sick_days')::int, leave_sick_days),
    leave_casual_days = coalesce((p_settings->>'leave_casual_days')::int, leave_casual_days),
    leave_maternity_days = coalesce((p_settings->>'leave_maternity_days')::int, leave_maternity_days),
    leave_paternity_days = coalesce((p_settings->>'leave_paternity_days')::int, leave_paternity_days),
    leave_compassionate_days = coalesce((p_settings->>'leave_compassionate_days')::int, leave_compassionate_days),
    leave_study_days = coalesce((p_settings->>'leave_study_days')::int, leave_study_days),
    leave_unpaid_days = coalesce((p_settings->>'leave_unpaid_days')::int, leave_unpaid_days),
    leave_approval_required = coalesce((p_settings->>'leave_approval_required')::boolean, leave_approval_required),
    leave_attachment_required = coalesce((p_settings->>'leave_attachment_required')::boolean, leave_attachment_required),
    leave_carry_forward = coalesce((p_settings->>'leave_carry_forward')::boolean, leave_carry_forward),
    updated_at = now(),
    updated_by = auth.uid()
  where id = 1;

  return jsonb_build_object('ok', true);
end; $$;

grant execute on function public.update_hr_settings(jsonb) to authenticated;

-- ============================================================
-- 11. CORRECT ATTENDANCE WITH AUDIT TRAIL
--    Extends the existing correct_attendance() to also write
--    to attendance_corrections_audit.
-- ============================================================
create or replace function public.correct_attendance(
  p_attendance_id uuid,
  p_clock_in timestamptz,
  p_clock_out timestamptz,
  p_reason text default 'Corrected by HR'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  actor_role text := public.current_role();
  v_old record;
begin
  if actor_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager') then
    raise exception 'Not authorized to correct attendance';
  end if;
  if p_clock_in is null then
    raise exception 'Clock-in time is required.';
  end if;
  if p_clock_out is not null and p_clock_out <= p_clock_in then
    raise exception 'Clock-out must be after clock-in.';
  end if;

  select * into v_old from public.attendance_records where id = p_attendance_id;
  if not found then
    raise exception 'Attendance record not found.';
  end if;

  -- Write audit trail
  insert into public.attendance_corrections_audit (attendance_id, field_name, previous_value, corrected_value, reason, corrected_by)
  values
    (p_attendance_id, 'clock_in', v_old.clock_in::text, p_clock_in::text, p_reason, auth.uid()),
    (p_attendance_id, 'clock_out', v_old.clock_out::text, p_clock_out::text, p_reason, auth.uid());

  perform set_config('app.correcting_attendance', 'on', true);
  update public.attendance_records
  set clock_in = p_clock_in,
      clock_out = p_clock_out,
      work_hours = round(extract(epoch from (coalesce(p_clock_out, now()) - p_clock_in)) / 3600.0, 2),
      total_minutes = round(extract(epoch from (coalesce(p_clock_out, now()) - p_clock_in)) / 60.0)::int,
      status = 'corrected',
      is_corrected = true,
      corrected_by = auth.uid(),
      corrected_at = now(),
      correction_reason = coalesce(p_reason, 'Corrected by HR')
  where id = p_attendance_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('ATTENDANCE_CORRECTED', 'AttendanceRecord', p_attendance_id::text,
          coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
          format('Attendance corrected to %s / %s. Reason: %s', p_clock_in, p_clock_out, p_reason),
          'warning');
  return jsonb_build_object('ok', true, 'attendance_id', p_attendance_id);
end; $$;

-- ============================================================
-- 12. RLS POLICIES
-- ============================================================

-- HR platform settings: only HR/super_admin can read/write
drop policy if exists "hr_settings_read" on public.hr_platform_settings;
create policy "hr_settings_read" on public.hr_platform_settings
  for select using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
  );

drop policy if exists "hr_settings_write" on public.hr_platform_settings;
create policy "hr_settings_write" on public.hr_platform_settings
  for all using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager')
  ) with check (
    public.current_role() in ('super_admin', 'admin', 'hr_manager')
  );

-- Settings audit: HR/super_admin read only
drop policy if exists "hr_settings_audit_read" on public.hr_settings_audit;
create policy "hr_settings_audit_read" on public.hr_settings_audit
  for select using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager')
  );

-- Attendance correction audit: HR/super_admin read only
drop policy if exists "attendance_corr_audit_read" on public.attendance_corrections_audit;
create policy "attendance_corr_audit_read" on public.attendance_corrections_audit
  for select using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager')
  );

-- Branch geofence: all authenticated users can read branch geofence config
-- (needed for employee app to know if geofence is active).
-- Only HR/super_admin can update geofence settings.
drop policy if exists "branches_read_all" on public.branches;
create policy "branches_read_all" on public.branches
  for select using (auth.uid() is not null);

drop policy if exists "branches_write_hr" on public.branches;
create policy "branches_write_hr" on public.branches
  for all using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager')
  ) with check (
    public.current_role() in ('super_admin', 'admin', 'hr_manager')
  );

-- ============================================================
-- DONE. All changes are additive and idempotent.
-- ============================================================
