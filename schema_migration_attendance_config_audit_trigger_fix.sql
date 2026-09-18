-- ============================================================================
-- Attendance configuration audit trigger repair
-- ============================================================================
-- The original trigger function attempted to write audit_logs.user_id, but
-- audit_logs stores the actor in user_name. Replacing the function prevents
-- every attendance_config update from being rolled back by the audit trigger.
--
-- Idempotent / safe to run in the live Supabase SQL Editor.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.log_attendance_config_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.audit_logs (
    action,
    entity_type,
    entity_id,
    user_name,
    details,
    severity
  )
  VALUES (
    'ATTENDANCE_CONFIG_CHANGE',
    'AttendanceConfig',
    NEW.id::text,
    coalesce(auth.uid()::text, 'system'),
    jsonb_build_object('old', to_jsonb(OLD), 'new', to_jsonb(NEW))::text,
    'info'
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS attendance_config_audit ON public.attendance_config;

CREATE TRIGGER attendance_config_audit
  AFTER UPDATE ON public.attendance_config
  FOR EACH ROW
  EXECUTE FUNCTION public.log_attendance_config_change();
