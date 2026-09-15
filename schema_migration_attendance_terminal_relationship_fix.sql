-- ============================================================
-- MIGRATION: ATTENDANCE TERMINAL RELATIONSHIP FIX (idempotent)
-- ============================================================
-- Root cause (hosted InfraPlatformBug):
--   The Attendance Terminal page's device/geofence select does
--       .select('*, attendance_geofences(name, location_name)')
--   For PostgREST to resolve that embed it needs, in this order:
--     1. attendance_geofences(meta) to actually HAVE the embedded
--        column `location_name` (phase14's variant omitted it), AND
--     2. a real FK from attendance_devices.location_id
--        -> attendance_geofences(id) so the relationship exists in
--        the schema cache.
--   Depending on which of the two `create table if not exists`
--   attendance_devices owners (phase11 vs phase14) ran first on the
--   hosted DB, either one could be missing -> the relationship fails
--   with the red "Could not find a relationship between
--   'attendance_devices' and 'attendance_geofences'" terminal error.
--
-- Fix: make the schema VALID regardless of which owner ran. Both
-- steps are additive + idempotent so this file can be re-run any
-- time (including on a database where the FK/column already exist).
-- No RLS/schema-cache suppression. No data loss.
-- ============================================================

-- STEP 1: attendance_geofences must expose `location_name` so the
--         embed has a real column to project.
alter table public.attendance_geofences
  add column if not exists location_name text;

-- STEP 2: guarantee attendance_devices -> attendance_geofences FK.
--         (ADD CONSTRAINT IF NOT EXISTS does not exist in Postgres;
--          guard with a catalog check so it stays idempotent.)
do $$
begin
  if not exists (
    select 1
      from pg_constraint c
      join pg_attribute  a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
      join pg_class     rc on rc.oid = c.confrelid
     where c.contype = 'f'
       and c.conrelid = 'public.attendance_devices'::regclass
       and rc.relname = 'attendance_geofences'
       and a.attname = 'location_id'
  ) then
    alter table public.attendance_devices
      add constraint fk_attendance_devices_geofence
      foreign key (location_id)
      references public.attendance_geofences(id)
      on delete set null;
  end if;
end $$;
