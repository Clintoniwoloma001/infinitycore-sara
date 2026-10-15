-- ============================================================================
-- Proposed Date Corrections for 2026-10-14
-- Purpose: Correct as-at dates in BankOne import snapshots that may have
-- been entered with future dates or month/day swaps.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- STEP 1: BACKUP EVERY TABLE BEFORE MAKING CHANGES
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bankone_import_batches_bak_20261014 AS SELECT * FROM public.bankone_import_batches;
CREATE TABLE IF NOT EXISTS bankone_portfolio_snapshots_bak_20261014 AS SELECT * FROM public.bankone_portfolio_snapshots;
CREATE TABLE IF NOT EXISTS bankone_import_rows_bak_20261014 AS SELECT * FROM public.bankone_import_rows;
CREATE TABLE IF NOT EXISTS bankone_officer_resolutions_bak_20261014 AS SELECT * FROM public.bankone_officer_resolutions;
CREATE TABLE IF NOT EXISTS bankone_branch_resolutions_bak_20261014 AS SELECT * FROM public.bankone_branch_resolutions;
CREATE TABLE IF NOT EXISTS bankone_unresolved_officers_bak_20261014 AS SELECT * FROM public.bankone_unresolved_officers;
CREATE TABLE IF NOT EXISTS bankone_employee_mappings_bak_20261014 AS SELECT * FROM public.bankone_employee_mappings;
CREATE TABLE IF NOT EXISTS bankone_branch_mappings_bak_20261014 AS SELECT * FROM public.bankone_branch_mappings;
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- STEP 2: IDENTIFY DATES LATER THAN TODAY + 1 DAY (2026-10-15)
--    Flag every as_at_date in bankone_import_batches and bankone_portfolio_snapshots
--    that is later than 2026-10-15 (Africa/Lagos timezone).
-- ---------------------------------------------------------------------------
SELECT
  b.id AS batch_id,
  b.filename,
  b.operation_type,
  b.status,
  b.as_at_date,
  b.parsing_status,
  b.resolution_status,
  b.publication_status,
  bp.id AS snapshot_id,
  bp.report_type,
  bp.as_at_date AS snap_as_at_date,
  bp.total_outstanding,
  bp.par_ratio
FROM public.bankone_import_batches b
LEFT JOIN public.bankone_portfolio_snapshots bp ON bp.batch_id = b.id
WHERE b.as_at_date > '2026-10-15'::date
   OR bp.as_at_date > '2026-10-15'::date
ORDER BY b.as_at_date DESC, bp.as_at_date DESC;

-- ---------------------------------------------------------------------------
-- STEP 3: IDENTIFY MONTH/DAY SWAPS (e.g. September loaded as October)
--    Compare the as_at_date against the raw source filename import batch.
--    If the file was imported for 2026-09-28 but as_at_date = 2026-10-28,
--    this query flags the discrepancy.
-- ---------------------------------------------------------------------------
SELECT
  b.id AS batch_id,
  b.filename,
  b.as_at_date AS batch_as_at,
  (SELECT created_at::date FROM public.bankone_import_batches WHERE id = b.id) AS batch_created
FROM public.bankone_import_batches b
WHERE b.as_at_date IS NOT NULL
  AND (b.as_at_date > '2026-10-15'::date
       OR EXISTS (
         SELECT 1 FROM public.bankone_import_batches b2
         WHERE b2.filename ILIKE '%' || TO_CHAR(b.as_at_date, 'Mon DD, YYYY') || '%'
           AND b2.as_at_date IS NOT NULL
       ))
ORDER BY b.id;

-- ---------------------------------------------------------------------------
-- STEP 4: CORRECT BATCH as_at_date TO MATCH SOURCE DATE
--    If the batch was created for 2026-09-28 but as_at_date = 2026-10-28,
--    correct it. Only correct if the batch created_at is earlier than the
--    as_at_date (suggests the date was entered wrong).
-- ---------------------------------------------------------------------------
UPDATE public.bankone_import_batches
SET as_at_date = '2026-09-28'::date
WHERE id IN (
    SELECT b.id
    FROM public.bankone_import_batches b
    WHERE b.as_at_date > '2026-10-15'::date
      AND (SELECT created_at::date FROM public.bankone_import_batches WHERE id = b.id) < b.as_at_date
);

-- ---------------------------------------------------------------------------
-- STEP 5: CORRECT PORTFOLIO SNAPSHOTS as_at_date TO MATCH BATCH
--    Snapshots must have as_at_date matching their batch's as_at_date.
--    If a snapshot was published with a future date, correct it.
-- ---------------------------------------------------------------------------
UPDATE public.bankone_portfolio_snapshots ps
SET as_at_date = b.as_at_date
FROM public.bankone_import_batches b
WHERE ps.batch_id = b.id
  AND ps.as_at_date != b.as_at_date
  AND b.as_at_date <= '2026-10-15'::date;

-- ---------------------------------------------------------------------------
-- STEP 5V: CORRECT SNAPSHOT as_at_date WHEN BATCH date is also wrong
--    If both the batch and snapshot have future dates, correct both to the
--    earliest valid date. Use the batch created_at as a reference if available.
-- ---------------------------------------------------------------------------
UPDATE public.bankone_import_batches b
SET as_at_date = (SELECT MIN(batch_date::date) FROM (SELECT b.id AS batch_id, b.as_at_date AS batch_date FROM public.bankone_import_batches b JOIN public.bankone_portfolio_snapshots bp ON bp.batch_id = b.id WHERE b.as_at_date > '2026-10-15'::date AND bp.as_at_date > '2026-10-15'::date) wd WHERE wd.batch_id = b.id)
WHERE id IN (SELECT batch_id FROM (SELECT b.id AS batch_id, b.as_at_date AS batch_date, bp.id AS snapshot_id, bp.as_at_date AS snap_date FROM public.bankone_import_batches b JOIN public.bankone_portfolio_snapshots bp ON bp.batch_id = b.id WHERE b.as_at_date > '2026-10-15'::date AND bp.as_at_date > '2026-10-15'::date) wd);

UPDATE public.bankone_portfolio_snapshots bp
SET as_at_date = (SELECT MIN(snap_date::date) FROM (SELECT b.id AS batch_id, b.as_at_date AS batch_date, bp.id AS snapshot_id, bp.as_at_date AS snap_date FROM public.bankone_import_batches b JOIN public.bankone_portfolio_snapshots bp ON bp.batch_id = b.id WHERE b.as_at_date > '2026-10-15'::date AND bp.as_at_date > '2026-10-15'::date) wd WHERE wd.batch_id = bp.batch_id)
WHERE id IN (SELECT snapshot_id FROM (SELECT b.id AS batch_id, b.as_at_date AS batch_date, bp.id AS snapshot_id, bp.as_at_date AS snap_date FROM public.bankone_import_batches b JOIN public.bankone_portfolio_snapshots bp ON bp.batch_id = b.id WHERE b.as_at_date > '2026-10-15'::date AND bp.as_at_date > '2026-10-15'::date) wd);

-- ---------------------------------------------------------------------------
-- STEP 6: VERIFICATION QUERY - Confirm all dates are on or before today
-- ---------------------------------------------------------------------------
SELECT
  'batches' AS object_type,
  COUNT(*) FILTER (WHERE as_at_date > '2026-10-15'::date) AS future_dated_batches,
  COUNT(*) AS total_batches
FROM public.bankone_import_batches
UNION ALL
SELECT
  'portfolio_snapshots',
  COUNT(*) FILTER (WHERE as_at_date > '2026-10-15'::date),
  COUNT(*)
FROM public.bankone_portfolio_snapshots
UNION ALL
SELECT
  'import_rows_date_check',
  COUNT(*) FILTER (WHERE (normalized_data->>'disbursementDate')::date > '2026-10-15'::date),
  COUNT(*)
FROM public.bankone_import_rows
WHERE normalized_data IS NOT NULL;

-- ---------------------------------------------------------------------------
-- STEP 7: ROLLBACK SCRIPT (run if corrections cause issues)
-- ---------------------------------------------------------------------------
-- Restore from backups using DELETE/INSERT (PostgreSQL has no RESTORE command)
DELETE FROM public.bankone_import_batches WHERE id IN (SELECT id FROM public.bankone_import_batches_bak_20261014);
INSERT INTO public.bankone_import_batches SELECT * FROM public.bankone_import_batches_bak_20261014;

DELETE FROM public.bankone_portfolio_snapshots WHERE id IN (SELECT id FROM public.bankone_portfolio_snapshots_bak_20261014);
INSERT INTO public.bankone_portfolio_snapshots SELECT * FROM public.bankone_portfolio_snapshots_bak_20261014;

-- Repeat for other tables as needed.
-- ---------------------------------------------------------------------------
-- END OF PROPOSED DATE CORRECTIONS
-- ============================================================================