-- ============================================================
-- PHASE 48 - FIX ATTENDANCE TIMEZONE TO AFRICA/LAGOS (GMT+1)
--
-- Attendance day boundaries, lateness, auto-clockout, server policy payloads,
-- and client display formatting all use Africa/Lagos. The timezone has no
-- daylight-saving transition, so this is always GMT+1.
--
-- Idempotent / safe to re-run.
-- ============================================================

alter table public.hr_platform_settings
  add column if not exists app_timezone text default 'Africa/Lagos';

update public.hr_platform_settings
   set app_timezone = 'Africa/Lagos'
 where id = 1;

create or replace function public.enforce_attendance_timezone()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.app_timezone := 'Africa/Lagos';
  return new;
end;
$$;

drop trigger if exists hr_platform_settings_attendance_timezone on public.hr_platform_settings;
create trigger hr_platform_settings_attendance_timezone
before insert or update on public.hr_platform_settings
for each row execute function public.enforce_attendance_timezone();

create or replace function public.att_app_timezone()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select 'Africa/Lagos';
$$;

create or replace function public.get_attendance_requirements()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_settings record;
begin
  select * into v_settings
    from public.hr_platform_settings
   where id = 1
   limit 1;

  return jsonb_build_object(
    'require_gps_clock_in', coalesce(v_settings.require_gps_clock_in, true),
    'require_gps_clock_out', coalesce(v_settings.require_gps_clock_out, true),
    'geofence_enabled', coalesce(v_settings.geofence_enabled, true),
    'default_geofence_radius', coalesce(v_settings.default_geofence_radius, 150),
    'late_threshold_minutes', coalesce(v_settings.late_threshold_minutes, 15),
    'early_departure_threshold_minutes', coalesce(v_settings.early_departure_threshold_minutes, 30),
    'default_work_start_time', coalesce(v_settings.default_work_start_time, '08:00')::text,
    'default_work_end_time', coalesce(v_settings.default_work_end_time, '17:00')::text,
    'default_grace_period_minutes', coalesce(v_settings.default_grace_period_minutes, 15),
    'app_timezone', 'Africa/Lagos'
  );
end;
$$;

grant execute on function public.get_attendance_requirements() to authenticated;
