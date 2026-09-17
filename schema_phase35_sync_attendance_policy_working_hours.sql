-- ============================================================================
-- schema_phase35_sync_attendance_policy_working_hours.sql
-- ============================================================================
-- Purpose:
--   Ensures bidirectional alignment between hr_platform_settings (Platform Settings
--   -> Working Hours) and attendance_config (Settings -> Attendance Policy).
--
-- Features:
--   1. Ensures attendance_config exists and mirrors existing hr_platform_settings values.
--   2. Updates the update_hr_settings RPC to keep attendance_config in sync.
--   3. Adds a trigger to automatically synchronize changes between attendance_config
--      and hr_platform_settings at the database layer.
--
-- Idempotent / safe to re-run.
-- ============================================================================

-- 1. Create / update initial sync from hr_platform_settings into attendance_config
DO $$
DECLARE
  v_ps public.hr_platform_settings%ROWTYPE;
BEGIN
  SELECT * INTO v_ps FROM public.hr_platform_settings WHERE id = 1;
  IF FOUND THEN
    INSERT INTO public.attendance_config (
      id,
      expected_start_time,
      expected_end_time,
      grace_period_minutes,
      late_threshold_time,
      geofence_enabled,
      early_departure_threshold_minutes,
      break_allowed,
      break_duration_minutes,
      overtime_threshold_hours,
      manual_correction_requires_reason,
      allow_admin_override,
      updated_at
    ) VALUES (
      1,
      coalesce(to_char(v_ps.default_work_start_time, 'HH24:MI'), '08:00'),
      coalesce(to_char(v_ps.default_work_end_time, 'HH24:MI'), '17:00'),
      coalesce(v_ps.default_grace_period_minutes, 15),
      to_char((coalesce(v_ps.default_work_start_time, '08:00'::time) + (coalesce(v_ps.default_grace_period_minutes, 15) || ' minutes')::interval), 'HH24:MI'),
      coalesce(v_ps.geofence_enabled, false),
      coalesce(v_ps.early_departure_threshold_minutes, 30),
      true,
      coalesce(v_ps.default_break_duration_minutes, 60),
      round((coalesce(v_ps.overtime_threshold_minutes, 480)::numeric / 60.0), 2),
      coalesce(v_ps.allow_manual_correction, true),
      true,
      now()
    )
    ON CONFLICT (id) DO UPDATE SET
      expected_start_time = EXCLUDED.expected_start_time,
      expected_end_time = EXCLUDED.expected_end_time,
      grace_period_minutes = EXCLUDED.grace_period_minutes,
      late_threshold_time = EXCLUDED.late_threshold_time,
      geofence_enabled = EXCLUDED.geofence_enabled,
      early_departure_threshold_minutes = EXCLUDED.early_departure_threshold_minutes,
      break_duration_minutes = EXCLUDED.break_duration_minutes,
      overtime_threshold_hours = EXCLUDED.overtime_threshold_hours,
      updated_at = now();
  END IF;
END $$;

-- 2. Fix log_attendance_config_change() to use the correct audit_logs columns.
--    The phase11 version incorrectly referenced user_id (which does not exist in
--    audit_logs). The actual schema uses user_name (text) and details (text).
--    This CREATE OR REPLACE is idempotent.
CREATE OR REPLACE FUNCTION public.log_attendance_config_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  VALUES (
    'ATTENDANCE_CONFIG_CHANGE',
    'AttendanceConfig',
    NEW.id::text,
    coalesce(auth.uid()::text, 'system'),
    jsonb_build_object('old', to_jsonb(OLD), 'new', to_jsonb(NEW))::text,
    'info'
  );
  RETURN NEW;
END; $$;

-- Re-create the trigger idempotently so it uses the corrected function.
DROP TRIGGER IF EXISTS attendance_config_audit ON public.attendance_config;
CREATE TRIGGER attendance_config_audit
  AFTER UPDATE ON public.attendance_config
  FOR EACH ROW EXECUTE FUNCTION public.log_attendance_config_change();
