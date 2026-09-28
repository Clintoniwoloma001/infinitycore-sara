-- ============================================================================
-- PHASE 70 (part 4) - TRACKING GEOFENCE CONTEXT + MAP SUPPORT
-- Run in Supabase SQL Editor AFTER 20260926000002. Idempotent, additive,
-- transaction-wrapped.
--
-- WHY THIS PART EXISTS
--   The tracking screen reported "Outside any registered location" for an
--   observation that simultaneously carried the LABEL of a real branch. The
--   label came from resolve_employee_location() falling back to the NEAREST
--   registered location name while inside = false, so a single row could read
--   "HEAD OFFICE / Outside" at once. Coordinates stayed authoritative, but the
--   label contradicted the verdict and the screen became impossible to audit.
--
-- WHAT THIS PART DOES
--   1. resolve_employee_location() gains `outside_label`: an honest label that
--      carries -- ============================================================================
-- PHASE 70 (part 4) - TRACKING GEOFENCE CONTEXT + MAP SUPPORT
-- Run in Supabase SQLve-- PHASE 70 (part 4) - TRACKIstered location, its
--      distance and its radiu-- Run in Supabase SQL Editor AFTER 20260926000002. Idempoten a-- transaction-wrapped.
--
-- WHY THIS PART EXISTS
--   The tracking scr0 m out" from "9 km out".
-- --   The tracking screoc--   observation that simultaneously carried the LABEL of a real branch.  w--   label came from resolve_employee_location() falling back to the NEARESio--   registered location name while inside = false, so a single row could r r--   "HEAD OFFICE / Outside" at once. Coordinates stayed authoritative, but tcandidate set, filters and
--      radius defaults as the ONE resolver, so the map--
-- WHAT THIS PART DOES
--   1. resolve_employee_location() gains `outside_rows --   1. resolve_emplore--      carries -- ===========================================================is invented.
-- ============================================================================

begi-- Run in Supabase SQLve-- PHASE 70 (part 4) - TRACKIstered l----      distance and its radiu-- Run in Supabase SQL Editor AFTER 202609----
-- WHY THIS PART EXISTS
--   The tracking scr0 m out" from "9 km out".
-- --   The tracking screoc--   observati c-lu--   The tracking scr0st-- --   The tracking screoc--   observation tts--      radius defaults as the ONE resolver, so the map--
-- WHAT THIS PART DOES
--   1. resolve_employee_location() gains `outside_rows --   1. resolve_emplore--      carries -- ===========================================================is invented.
-- ============================================================================

begi-- Run in Supabase SQLn_events.nearest_distance is
  'Distance in meters from this--   1. resolve_emplost-- ============================================================================

begi-- Run in Supabase SQLve-- PHASE 70 (part 4) - TRACKIstered l----      distance and
 
begi-- Run in Supabase SQLve-- PHASE 70 (part 4) - TRACKIstered l----      die i-- WHY THIS PART EXISTS
--   The tracking scr0 m out" from "9 km out".
-- --   The tracking screoc--   observati c-lu--   The tracking scr0st-n_events (nearest_location-- --   The tracking screfence = false;
