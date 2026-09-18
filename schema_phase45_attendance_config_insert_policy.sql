-- ============================================================================
-- schema_phase45_attendance_config_insert_policy.sql
-- ============================================================================
-- Purpose:
--   Fix RLS on public.attendance_config so configuration writes work for HR roles.
--
-- Background:
--   attendanceEngineService.updateConfig() may need to create the singleton
--   row in older environments. The table only had FOR UPDATE ("attendance_config_manage")
--   and FOR SELECT ("attendance_config_read") policies, so that INSERT path
--   failed under RLS with:
--     "new row violates row-level security policy for table "attendance_config""
--   when saving from Attendance Management -> Configuration (and the same path
--   used by Platform Settings / Attendance Settings).
--
-- Features:
--   1. Adds a FOR INSERT policy allowing super_admin / admin / hr_manager,
--      matching the existing FOR UPDATE manage policy.
--
-- Idempotent / safe to re-run.
-- ============================================================================

DROP POLICY IF EXISTS "attendance_config_insert"
ON public.attendance_config;

CREATE POLICY "attendance_config_insert"
ON public.attendance_config
FOR INSERT
TO authenticated
WITH CHECK (
    public.current_role() IN (
        'super_admin',
        'admin',
        'hr_manager'
    )
);
