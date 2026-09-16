-- ============================================================
-- PHASE 30: HR / ATTENDANCE STABILIZATION (RECOVERY)
--
-- Fixes schema drift between the repo migrations and the deployed
-- database:
--   1. attendance_records is MISSING the original phase-6 columns
--      (clock_in, clock_out, work_hours, location_lat/lng,
--      is_corrected, corrected_*, device_info) on the deployed DB.
--      The attendance_insert_rules() BEFORE INSERT trigger references
--      NEW.clock_in, so any clock-in/clock-out writes fail with
--      `record "new" has no field "clock_in"` / `column "clock_out"
--      does not exist`.
--   2. attendance_geofences is MISSING created_by on the deployed DB,
--      so createGeofence() fails (the Phase 9/11 migration added it
--      with ADD COLUMN IF NOT EXISTS for other columns but not this one
--      in the deployed environment).
--   3. Guarantees the server-authoritative clock triggers exist in the
--      expected (phase-6) form.
--
-- ALL ADDITIVE + IDEMPOTENT — safe to re-run in the Supabase SQL editor.
-- ============================================================

-- ============================================================
-- 1. attendance_records — restore original phase-6 core columns
-- ============================================================
ALTER TABLE public.attendance_records
  ADD COLUMN IF NOT EXISTS clock_in timestamptz,
  ADD COLUMN IF NOT EXISTS clock_out timestamptz,
  ADD COLUMN IF NOT EXISTS work_hours numeric(6, 2),
  ADD COLUMN IF NOT EXISTS location_lat numeric(10, 6),
  ADD COLUMN IF NOT EXISTS location_lng numeric(10, 6),
  ADD COLUMN IF NOT EXISTS location_status text,
  ADD COLUMN IF NOT EXISTS device_info text,
  ADD COLUMN IF NOT EXISTS is_corrected boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS corrected_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS corrected_at timestamptz,
  ADD COLUMN IF NOT EXISTS correction_reason text;

-- Location columns referenced by the geofence clock-in flow + events
ALTER TABLE public.attendance_records
  ADD COLUMN IF NOT EXISTS geofence_id uuid REFERENCES public.attendance_geofences(id) ON DELETE SET NULL;

-- Phase-9 numeric/accuracy columns (safe no-ops when already present)
ALTER TABLE public.attendance_records
  ADD COLUMN IF NOT EXISTS clock_in_accuracy numeric(8, 2),
  ADD COLUMN IF NOT EXISTS clock_out_accuracy numeric(8, 2),
  ADD COLUMN IF NOT EXISTS clock_in_distance numeric(10, 2),
  ADD COLUMN IF NOT EXISTS clock_out_distance numeric(10, 2),
  ADD COLUMN IF NOT EXISTS early_departure_minutes integer DEFAULT 0;

-- Helpers for the terminal open-session / bypass lookups
CREATE INDEX IF NOT EXISTS idx_attendance_open_sessions
  ON public.attendance_records(employee_id, attendance_date)
  WHERE clock_out IS NULL;
CREATE INDEX IF NOT EXISTS idx_attendance_geofence
  ON public.attendance_records(geofence_id);

-- ============================================================
-- 2. attendance_geofences — restore created_by for createGeofence()
-- ============================================================
ALTER TABLE public.attendance_geofences
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_geofence_created_by ON public.attendance_geofences(created_by);

-- ============================================================
-- 3. attendance_records — guarantee server-authoritative clock rules
--    (phase-6 definitions; recreated defensively so the triggers exist
--    in the expected form on every environment).
-- ============================================================
CREATE OR REPLACE FUNCTION public.attendance_insert_rules()
RETURNS trigger language plpgsql security definer set search_path = public AS $$
DECLARE
  open_sessions int;
BEGIN
  new.clock_in := now();
  IF new.attendance_date IS NULL THEN
    new.attendance_date := (new.clock_in at time zone 'UTC')::date;
  END IF;
  IF new.clock_out IS NOT NULL THEN
    RAISE EXCEPTION 'Clock-out must be performed through an update on this record.';
  END IF;
  SELECT count(*) INTO open_sessions
  FROM public.attendance_records
  WHERE employee_id = new.employee_id
    AND attendance_date = new.attendance_date
    AND clock_out IS NULL;
  IF open_sessions > 0 THEN
    RAISE EXCEPTION 'An open attendance session already exists for this employee today.';
  END IF;
  new.source := coalesce(new.source, 'web');
  RETURN new;
END; $$;

DROP TRIGGER IF EXISTS attendance_before_insert ON public.attendance_records;
CREATE TRIGGER attendance_before_insert
  BEFORE INSERT ON public.attendance_records
  FOR EACH ROW EXECUTE FUNCTION public.attendance_insert_rules();

CREATE OR REPLACE FUNCTION public.attendance_update_rules()
RETURNS trigger language plpgsql security definer set search_path = public AS $$
BEGIN
  -- HR corrections flow through correct_attendance() with this flag set.
  IF current_setting('app.correcting_attendance', true) = 'on' THEN
    RETURN new;
  END IF;
  IF new.clock_out IS DISTINCT FROM old.clock_out OR new.clock_in IS DISTINCT FROM old.clock_in THEN
    IF old.clock_in IS NULL THEN
      RAISE EXCEPTION 'Cannot clock out without clocking in.';
    END IF;
    IF new.clock_in IS DISTINCT FROM old.clock_in THEN
      RAISE EXCEPTION 'Clock-in time cannot be edited directly.';
    END IF;
    IF new.clock_out IS NOT NULL THEN
      new.clock_out := now();
    END IF;
    IF new.clock_out IS NOT NULL AND new.clock_out <= old.clock_in THEN
      RAISE EXCEPTION 'Invalid clock-out time.';
    END IF;
    new.work_hours := round(extract(epoch FROM (coalesce(new.clock_out, now()) - old.clock_in)) / 3600.0, 2);
    new.status := 'present';
    new.is_corrected := false;
  END IF;
  IF old.is_corrected AND new.is_corrected = old.is_corrected THEN
    NULL;
  END IF;
  RETURN new;
END; $$;

DROP TRIGGER IF EXISTS attendance_before_update ON public.attendance_records;
CREATE TRIGGER attendance_before_update
  BEFORE UPDATE ON public.attendance_records
  FOR EACH ROW EXECUTE FUNCTION public.attendance_update_rules();

-- ============================================================
-- 4. RLS — ensure the configured-location readers can list geofences
--    (no-op when policies already exist).
-- ============================================================
ALTER TABLE public.attendance_geofences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "geofence_read" ON public.attendance_geofences;
CREATE POLICY "geofence_read" ON public.attendance_geofences
  FOR SELECT USING (auth.role() = 'authenticated');

-- ============================================================
-- DONE. Verify with:
--   select column_name from information_schema.columns
--   where table_schema='public' and table_name='attendance_records'
--   order by ordinal_position;
-- ============================================================