-- ============================================================================
-- ROLLBACK — employee_live_positions_v4
-- ============================================================================
-- Only needed if the Live positions tab must be reverted to v3 behaviour.
-- Nothing here touches data: it removes ONE function and puts the web page
-- back on v3. No table, row or permission is altered.
--
-- HOW TO APPLY
--   psql "$POSTGRES_URL" -f supabase/manual/20261110000006_live_positions_v4_rollback.sql
--
-- NOTE ON ORDER
-- The web page must be rolled back in the SAME deploy as this script, or the
-- tab will call a function that no longer exists. Reverting the page to
-- employee_live_positions_v3 (or to trackingService.livePositions) restores the
-- old behaviour: all 232 employees, 224 "No location yet" rows, alphabetical
-- order, and the headline/chip mismatch that shipped. That is a deliberate,
-- known consequence of rolling back — not a new defect.

BEGIN;

-- 1. Drop v4. Older functions are untouched and keep working, so an app build
--    that still calls employee_live_positions_v3 continues to work unaffected.
DROP FUNCTION IF EXISTS public.employee_live_positions_v4(
  integer, text, uuid, text, text
);

-- 2. Sanity: v3 must still be there and callable after the rollback.
DO $$
BEGIN
  IF to_regprocedure('public.employee_live_positions_v3(integer,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'employee_live_positions_v3 is missing; the rollback cannot proceed safely';
  END IF;
  RAISE NOTICE 'employee_live_positions_v3 present; employee_live_positions_v4 dropped';
END
$$;

COMMIT;
