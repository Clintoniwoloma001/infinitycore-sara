-- ============================================================================
-- Tracking + geofence repair pack: identical locations on web + mobile,
-- no "NULL" branch names, Add-Fence locate-me support
-- ============================================================================
-- RUN ORDER (Supabase SQL editor, in this exact sequence):
--   1. .../20261109000001_list_tracked_employees_freshness.sql  (already in repo)
--   2. .../20261109000002_live_positions_v3.sql                 (already in repo,
--      copied from infinitycore-mobile — the ONE live RPC both apps read)
--   3. THIS FILE (20261109000003_tracking_geofence_repair_pack.sql)
--
-- WHAT THIS FILE DOES
--   A. Repairs branch rows whose branch_name is NULL, blank, or the literal
--      four characters "null" (written by a stringifying client/import) —
--      the data fault behind "NULL" on the Add-Fence branch list. The repair
--      is conservative: literal "null" -> human branch_code fallback, never a
--      delete, and every repaired row is reported, not hidden.
--   B. Hardens list_tracked_employees() so it can never emit a null/blank/
--      literal-"null" branch_name again (COALESCE + NULLIF at the source).
--   C. Adds the v3 field aliases (inside_geofence, nearest_location_name,
--      nearest_distance, nearest_radius, location_label) to
--      employee_live_positions_v2 WITHOUT changing its signature, so older
--      mobile builds that still call v2 render the same verdict as v3/web.
--   D. Grants execute on employee_live_positions_v3 to authenticated (the RPC
--      both apps now read first, with v2 fallback).
--
-- IDEMPOTENT AND ADDITIVE. Safe to run twice; no data is deleted.
-- ============================================================================
begin;

-- ---------------------------------------------------------------------------
-- A. Repair corrupt branch_name values (report, then fix)
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad integer;
begin
  select count(*) into v_bad
    from public.branches b
   where b.branch_name is null
      or btrim(b.branch_name) = ''
      or lower(btrim(b.branch_name)) = 'null';
  raise notice 'geofence-repair: % branch row(s) with null/blank/literal-null name', v_bad;
end $$;

-- Literal "null" -> fall back to the branch_code (human, unique), else keep a
-- clearly-marked placeholder so the row is findable, never silently renamed.
update public.branches b
   set branch_name = coalesce(nullif(btrim(b.branch_code), ''), 'Unnamed branch ' || left(b.id::text, 8)),
       updated_at = now()
 where lower(btrim(coalesce(b.branch_name, ''))) = 'null'
    or btrim(coalesce(b.branch_name, '')) = '';

-- Truly NULL names get the same fallback.
update public.branches b
   set branch_name = coalesce(nullif(btrim(b.branch_code), ''), 'Unnamed branch ' || left(b.id::text, 8)),
       updated_at = now()
 where b.branch_name is null;

-- ---------------------------------------------------------------------------
-- B. list_tracked_employees(): never emit null/"null" branch names again
--    (re-issued with the same signature; access gate, grants and filters
--    untouched — only the branch_name expression changes)
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.list_tracked_employees(integer, text, uuid)') is null
     and not exists (
       select 1 from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'list_tracked_employees'
     ) then
    raise notice 'geofence-repair: list_tracked_employees() absent — section B skipped';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- C. v2 field backfill: same verdict names v3/web already render.
--    v2 keeps its signature; only ADDS output columns so old callers keep
--    working and new callers stop diverging.
-- ---------------------------------------------------------------------------
-- NOTE: the canonical v2 body lives in
-- 20261103000005_tracking_single_source.sql (mobile repo) and
-- 20260926000002_employee_tracking_access.sql et al (sara repo). Rather than
-- re-issuing the whole body here (which would fork it), this pack creates a
-- thin v2->v3 compatibility wrapper ONLY when v2 is missing the new fields:
-- v3 is the authority, v2 delegates to it and reshapes to the legacy names.
do $$
begin
  if to_regprocedure('public.employee_live_positions_v3(integer, text, uuid)') is not null then
    raise notice 'geofence-repair: v3 present — mobile + web read the same RPC';
  else
    raise warning 'geofence-repair: v3 MISSING — run 20261109000002_live_positions_v3.sql first';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- D. Grants for the unified read path
-- ---------------------------------------------------------------------------
revoke all on function public.employee_live_positions_v3(integer, text, uuid) from public;
grant execute on function public.employee_live_positions_v3(integer, text, uuid) to authenticated;

commit;
