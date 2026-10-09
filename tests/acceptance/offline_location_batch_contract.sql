-- ============================================================================
-- offline_location_batch_contract.sql
-- ============================================================================
-- Proves the single-source-of-truth offline batch contract, run inside a
-- transaction that is ALWAYS rolled back, so no row is ever persisted.
--
-- CONTRACT UNDER TEST (sync_offline_location_batch):
--   1. Identity comes from auth.uid(); a spoofed payload employee_id is IGNORED.
--   2. A duplicate on the 4-column key (employee_id, recorded_at, latitude,
--      longitude) is SKIPPED, not double-inserted.
--   3. An invalid row (null/out-of-range lat or lng, or a bad recorded_at)
--      is SKIPPED as invalid.
--   4. Rows land in employee_location_events and are CLASSIFIED by the
--      BEFORE INSERT trigger (inside_geofence is non-null).
--   5. The ORIGINAL recorded_at is preserved (backfilled, not now()).
--   6. sync_status = 'backfilled_offline', is_offline_record = true.
--
-- HOW TO RUN (from infinitycore-sara):
--   cat tests/acceptance/offline_location_batch_contract.sql \
--     | supabase db query --linked
-- The file itself wraps everything in BEGIN ... ROLLBACK.
-- ============================================================================
BEGIN;

-- Impersonate the first employee that actually has a profile, so auth.uid()
-- resolves to a real in-scope employee. Read-only set_config; rolled back.
SELECT set_config(
  'request.jwt.claims',
  (SELECT json_build_object('sub', p.id::text, 'role', 'authenticated')::text
     FROM public.profiles p LIMIT 1),
  true
);

-- Capture each RPC return in a temp table so the synced/skipped/invalid
-- counts are visible in the final result set (the CLI renders only the last
-- SELECT). Use a coordinate that cannot collide with any existing row.
CREATE TEMP TABLE _results (
  batch   text,
  status  text,
  synced  int,
  skipped int,
  invalid int
);

-- Batch 1: valid + duplicate + invalid (null lat). Expect
--   synced=1, skipped=1 (dup), invalid=1 (null lat). Spoofed id ignored.
INSERT INTO _results
SELECT ('b1', r)::text, (r ->> 'status'),
       (r ->> 'records_synced')::int, (r ->> 'records_skipped')::int,
       (r ->> 'records_invalid')::int
FROM public.sync_offline_location_batch(jsonb_build_array(
  jsonb_build_object('employee_id','00000000-0000-0000-0000-000000000000',
                     'latitude',6.4281,'longitude',3.4219,'accuracy',12,
                     'recorded_at', now() - interval '3 minutes'),
  jsonb_build_object('employee_id','00000000-0000-0000-0000-000000000000',
                     'latitude',6.4281,'longitude',3.4219,'accuracy',12,
                     'recorded_at', now() - interval '3 minutes'),
  jsonb_build_object('employee_id','00000000-0000-0000-0000-000000000000',
                     'latitude',NULL,'longitude',3.4219,'accuracy',12,
                     'recorded_at', now() - interval '2 minutes')
)) r;

-- Batch 2: a second, uniquely-coordinated duplicate pair + one invalid.
INSERT INTO _results
SELECT ('b2', r)::text, (r ->> 'status'),
       (r ->> 'records_synced')::int, (r ->> 'records_skipped')::int,
       (r ->> 'records_invalid')::int
FROM public.sync_offline_location_batch(jsonb_build_array(
  jsonb_build_object('employee_id','00000000-0000-0000-0000-000000000000',
                     'latitude',6.555001,'longitude',3.555001,'accuracy',9,
                     'recorded_at', now() - interval '97 minutes'),
  jsonb_build_object('employee_id','00000000-0000-0000-0000-000000000000',
                     'latitude',6.555001,'longitude',3.555001,'accuracy',9,
                     'recorded_at', now() - interval '97 minutes'),
  jsonb_build_object('employee_id','00000000-0000-0000-0000-000000000000',
                     'latitude',NULL,'longitude',3.555001,'accuracy',9,
                     'recorded_at', now() - interval '96 minutes')
)) r;

-- Surface the contract: batch, status, synced, skipped, invalid.
SELECT batch, status, synced, skipped, invalid FROM _results
UNION ALL
-- And the shape of the row we just wrote (classified, backfilled, past ts).
SELECT 'rowshape' AS batch,
       jsonb_build_object(
         'sync_status',        sync_status,
         'is_offline_record',  is_offline_record,
         'classified',         inside_geofence IS NOT NULL,
         'recorded_at_past',   recorded_at < now() - interval '1 minute'
       )::text AS status,
       NULL::int, NULL::int, NULL::int
FROM public.employee_location_events
WHERE latitude = 6.555001 AND longitude = 3.555001
ORDER BY batch;

ROLLBACK;

