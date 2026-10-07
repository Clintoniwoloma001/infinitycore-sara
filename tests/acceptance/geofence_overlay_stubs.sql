-- Additive stub overlay for the geofence management acceptance run.
-- The shared attendance_tracking_stubs.sql predates these columns; nothing
-- below changes what the other acceptance scripts see (this file is only
-- copied in by run_geofence.sh).
alter table public.attendance_geofences add column if not exists department text;
alter table public.attendance_geofences add column if not exists created_by uuid;
alter table public.attendance_geofences add column if not exists updated_at timestamptz default now();
alter table public.employees add column if not exists is_archived boolean default false;
alter table public.profiles add column if not exists email text;
alter table public.branches add column if not exists location text;
alter table public.branches add column if not exists updated_at timestamptz default now();
