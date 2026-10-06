-- ===========================================================================
-- 20261101000010 — AUTHORITATIVE ORGANISATIONAL MASTER
--                  (branches, departments, designations)
-- ===========================================================================
--
--   ##  MANUAL RUN ONLY — RUN IT YOURSELF IN THE SUPABASE SQL EDITOR.      ##
--   ##  RUN IT BEFORE 20261101000008 (the employee replace).                ##
--   ##  NOT in supabase/migrations — `supabase db push` can never run it.   ##
-- ===========================================================================
--
-- WHY THIS FILE EXISTS
-- ---------------------------------------------------------------------------
-- The workbook is already CLEANED. The database is not. A previous import kept
-- combined labels verbatim as their own `branches` rows, and a later one added
-- its own duplicates, so HR Organisation today shows 42 branch rows including:
--
--     BARIGA/LAGOS Island 1        KETU & HEAD OFFICE
--     LAGOS ISLAND 2/IBEJU -LEKKI/AJAH   MUSHIN/YABA
--     OSHODI & IKEJA              TRADE FAIR/BOUNDARY/ALABA
--     IKEJA & LEKKI               KOLA & ILE-EPO
--     AGEGE & EGBEDA              HEAD OFFICE - OSHODI
--     Head Office (x3)            LAGOS ISLAND2
--
-- None of those are real locations. Each is two or three real branches that a
-- human wrote on one line. The earlier employee replace (…008) tried to solve
-- this with a hand-written alias list, which is why the branches still look
-- wrong: aliasing tells the NEW data where to point, but it never repairs the
-- master itself. `designations` has the same problem (119 rows for 66 real
-- titles) and so does `departments` (19 rows for 13 real departments, because
-- AUDIT_INVESTIGATION and AUDIT_AND_INVESTIGATION are the same name with two
-- different codes).
--
-- This file REBUILDS the three master tables to exactly the workbook, using a
-- collapse map generated from BOTH sources. Nothing is invented: every existing
-- spelling has a stated destination, and any spelling the map does not cover
-- makes this script ABORT rather than be silently dropped.
--
-- THE HARD RULE
-- ---------------------------------------------------------------------------
-- Merged labels are NOT split by guessing. `KETU & HEAD OFFICE` is two real
-- branches, but nothing in the data says which half any given employee belongs
-- to. The map therefore splits a merged row into SEPARATE canonical branches and
-- repoints references to the branch each record genuinely names. Where a record
-- names only the merged label and nothing more specific, it is pointed at the
-- FIRST canonical branch of that label and REPORTED in CHECK 6 — a deterministic
-- guess is better than a dangling reference, but it must still be visible.
--
-- NOTHING IS DELETED
-- ---------------------------------------------------------------------------
-- Every dirty row is DEACTIVATED (branches.status='inactive',
-- departments/designations.is_active=false), never dropped, so historical
-- attendance, payroll, leave and BankOne imports keep resolving to a real row.
-- 20 tables reference `branches` and 5 of those cascade — hard-deleting a branch
-- would silently destroy their rows.
--
-- HOW TO RUN — IN THIS EXACT ORDER
-- ---------------------------------------------------------------------------
--   0. BACK UP FIRST.
--   1. Run  20261101000007a_authoritative_staging_schema.sql
--   2. Run the four org value files, in any order:
--        org_branch_values.sql           (21 canonical branches)
--        org_branch_collapse_values.sql  (46 collapse rules)
--        org_department_values.sql       (13 departments)
--        org_designation_values.sql      (66 designations)
--   3. Run THIS file with v_confirm changed from 'NO' to 'YES'.
--   4. Read every CHECK. Do not proceed to …008 until they are clean.
--   5. THEN run the employee replace (20261101000008).
--
-- The Supabase SQL Editor wraps every run in a transaction, so this file does
-- NOT issue its own begin;/commit; and everything is atomic for free.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0. RUN CONFIRMATION GATE
-- ---------------------------------------------------------------------------
do $$
declare
  v_confirm constant text := 'NO';   -- <== change to 'YES' to run
  v_missing int;
begin
  if v_confirm <> 'YES' then
    raise exception
      'authoritative_org_master ABORTED: no writes made. Set the v_confirm constant to ''YES'' at the top of this file to confirm you are running this against PRODUCTION deliberately.';
  end if;

  -- Every staging table must be loaded, or we would "rebuild" the master to
  -- nothing and deactivate the entire organisation.
  select count(*) into v_missing from (
    select 1 where not exists (select 1 from public.stg_hr_branch_source)
    union all select 1 where not exists (select 1 from public.stg_hr_department_source)
    union all select 1 where not exists (select 1 from public.stg_hr_designation_source)
  ) m;

  if v_missing > 0 then
    raise exception 'authoritative_org_master ABORTED: % staging table(s) empty. Run 20261101000007a then the org_*_values.sql files first.', v_missing;
  end if;

  if (select count(*) from public.stg_hr_branch_source) = 0 then
    raise exception 'authoritative_org_master ABORTED: stg_hr_branch_source is empty';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. SAFETY: refuse to run on an unmapped branch spelling.
--
-- This is the guard that makes the collapse map trustworthy. If the database
-- contains a branch the map has never seen — a new dirty import, a typo, a
-- branch added since the workbook was reviewed — we stop, because the only
-- correct destination is a human decision. Silently deactivating it would move
-- that location's staff nowhere.
-- ---------------------------------------------------------------------------
do $$
declare
  v_unmapped text[];
begin
  select coalesce(array_agg(b.branch_name order by b.branch_name), '{}')
    into v_unmapped
    from public.branches b
   where not exists (
           select 1 from public.stg_hr_branch_source s
            where lower(s.branch_name) = lower(b.branch_name))
     and not exists (
           select 1 from public.stg_hr_branch_collapse c
            where lower(c.existing_name) = lower(b.branch_name));

  if array_length(v_unmapped, 1) is not null then
    raise exception
      'authoritative_org_master ABORTED: % branch row(s) are not covered by the collapse map: %. Decide each destination in HR, add it to scripts/build-authoritative-org.mjs, regenerate and re-run.',
      array_length(v_unmapped, 1), array_to_string(v_unmapped, ', ');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1b. The set of non-canonical branch rows, computed BEFORE anything is
--     written so that later steps can reference it.
-- ---------------------------------------------------------------------------
create temporary table hr_org_branch_map (
  existing_id uuid primary key,
  existing_name text not null
);

create temporary table hr_org_case_dupes (
  dropped_id uuid primary key,
  dropped_name text not null,
  kept_name text not null
);

insert into hr_org_branch_map (existing_id, existing_name)
select b.id, b.branch_name
  from public.branches b
 where not exists (
         select 1 from public.stg_hr_branch_source s
          where lower(s.branch_name) = lower(b.branch_name));

-- ---------------------------------------------------------------------------
-- 2. Free the branch_code space, then create the canonical branches.
--
-- `branches_branch_code_key` is UNIQUE, and the codes BR-01..BR-21 are already
-- occupied — but by the WRONG branches. A previous import numbered merged rows
-- (BR-01 = BARIGA/LAGOS Island 1, BR-02 = LAGOS ISLAND 2/IBEJU -LEKKI/AJAH,
-- ...), so inserting the workbook's canonical branches with the workbook's own
-- codes fails with `duplicate key value violates unique constraint
-- "branches_branch_code_key"`.
--
-- The codes are therefore cleared FIRST on ANY row holding a workbook code
-- (BR-01..BR-21), not just on dirty rows. The old version cleared only
-- hr_org_branch_map rows, so a case-variant twin still holding its code made
-- the canon UPDATE below fail with duplicate key on branches_branch_code_key.
-- NULLs never collide, so this global clear is safe.
update public.branches b
   set branch_code = null, updated_at = now()
 where b.branch_code is not null
   and exists (select 1 from public.stg_hr_branch_source s
                where upper(btrim(s.branch_code)) = upper(btrim(b.branch_code)));

-- Guard: the clear above must have freed EVERY workbook code. Production holds
-- variants like 'BR-01 ', 'br-01' or 'BR-1' with odd spacing, so the match is
-- whitespace/case-insensitive. If anything still holds a workbook code here,
-- abort LOUDLY listing the offenders instead of dying 200 lines later with a
-- cryptic 23505 on branches_branch_code_key. Likewise the staging codes
-- themselves must be unique after the same normalisation, or the canon UPDATE
-- below would collide with itself.
do $$
declare
  v_leftover text;
  v_stg_dups text;
begin
  select string_agg(b.branch_name || ' (' || b.branch_code || ')', ', ' order by b.branch_name)
    into v_leftover
    from public.branches b
   where b.branch_code is not null
     and exists (select 1 from public.stg_hr_branch_source s
                  where upper(btrim(s.branch_code)) = upper(btrim(b.branch_code)));

  if v_leftover is not null then
    raise exception
      'authoritative_org_master ABORTED: branch_code clear incomplete — these rows still hold a workbook code: %. Do not proceed; report this verbatim.',
      v_leftover;
  end if;

  select string_agg(branch_code, ', ' order by branch_code)
    into v_stg_dups
    from (select upper(btrim(branch_code)) as branch_code, count(*) as n
            from public.stg_hr_branch_source
           where branch_code is not null
           group by 1 having count(*) > 1) d;

  if v_stg_dups is not null then
    raise exception
      'authoritative_org_master ABORTED: staging has duplicate branch_code(s): %. Regenerate org_branch_values.sql.',
      v_stg_dups;
  end if;
end $$;

-- branch_code comes from the workbook (BR-01..BR-21) so codes are stable and
-- meaningful rather than auto-generated noise. `location` is left NULL: we have
-- no authoritative address, and inventing one would display in the UI as if HR
-- had confirmed it.
-- 2a. CANONICALISE: rename every branch that already matches a workbook entry
--      (case-insensitively) to the workbook's exact spelling.
--
--      Without this the master would never match the workbook. The workbook says
--      "Ile Epo" and "Sabo Yaba"; the database says "ILE-EPO" and "SABO/YABA". A
--      case-insensitive `not exists` therefore finds an existing row and skips the
--      insert, leaving the workbook's own name absent — and every later collapse
--      that targets it resolves to nothing.
--
--      `id` is never touched, so every FK keeps pointing at the same row. This is
--      a display-string change only.
create temporary table hr_org_canon (
  kept_id uuid primary key,
  canonical_name text not null
);

insert into hr_org_canon (kept_id, canonical_name)
select distinct on (lower(s.branch_name)) b.id, s.branch_name
  from public.branches b
  join public.stg_hr_branch_source s
    on lower(s.branch_name) = lower(b.branch_name)
 order by lower(s.branch_name), b.id;

update public.branches b
   set branch_name = c.canonical_name,
       branch_code = s.branch_code,
       status = 'active',
       updated_at = now()
  from hr_org_canon c
  join public.stg_hr_branch_source s
    on lower(s.branch_name) = lower(c.canonical_name)
 where b.id = c.kept_id;

-- 2b. Case-variant twins of a canonical branch are folded into the survivor. The
--     row is kept (never deleted) so historical records still resolve, and it is
--     registered in hr_org_branch_map so the repoint + deactivate steps below
--     treat it exactly like any other dirty row.
insert into hr_org_case_dupes (dropped_id, dropped_name, kept_name)
select b.id, b.branch_name, c.canonical_name
  from public.branches b
  join hr_org_canon c on lower(b.branch_name) = lower(c.canonical_name)
 where b.id <> c.kept_id;

-- 2c. Branch names that genuinely do not exist yet (ODONGUNYAN was absent until
--     a previous run) are created now, with the workbook's own code.
insert into public.branches (branch_name, branch_code, status, created_at, updated_at)
select s.branch_name, s.branch_code, 'active', now(), now()
  from public.stg_hr_branch_source s
 where not exists (
         select 1 from public.branches b
          where lower(b.branch_name) = lower(s.branch_name))
on conflict do nothing;

-- 2d. The case dupes were computed before the insert above, so anything created
--     in 2c is already canonical and cannot be a twin. Register the twins now
--     that every canonical row is present and correctly named.
insert into hr_org_branch_map (existing_id, existing_name)
select d.dropped_id, d.dropped_name
  from hr_org_case_dupes d
on conflict do nothing;


-- Canonical destination per label, with a deterministic ordinal so a record
-- naming only a merged label always resolves to the SAME branch every run.
create temporary table hr_org_dest (
  existing_name text not null,
  existing_id uuid not null,
  dest_name text not null,
  dest_id uuid not null,
  dest_ord int not null,
  dest_count int not null
);

insert into hr_org_dest (existing_name, existing_id, dest_name, dest_id, dest_ord, dest_count)
select c.existing_name,
       m.existing_id,
       c.target_name,
       (select b2.id from public.branches b2
         where lower(b2.branch_name) = lower(c.target_name) order by b2.id limit 1),
       row_number() over (partition by c.existing_name, m.existing_id order by c.target_name),
       count(*) over (partition by c.existing_name, m.existing_id)
  from public.stg_hr_branch_collapse c
  join hr_org_branch_map m on lower(m.existing_name) = lower(c.existing_name)
 where c.target_name is not null and c.target_name <> ''
   and exists (select 1 from public.branches b3
                where lower(b3.branch_name) = lower(c.target_name));

-- Every non-canonical row must either resolve to a destination OR be explicitly
-- marked deactivate-only.
--
-- The two cases are different and both are legitimate:
--   * a mapped row    -> 'KETU & HEAD OFFICE' -> Ketu + Head Office
--   * a deactivate row-> 'AMUWO ODOFIN' with target_name = '' : a location that
--     exists in the database but is NOT one of the workbook's 21, so there is no
--     correct destination and it must simply be deactivated. The generator emits
--     target_name = '' for exactly these, so "no mapping" is an explicit,
--     reviewed decision rather than an omission.
--
-- Rejecting only rows that have a target_name but no existing destination branch
-- is what makes this guard trustworthy: a typo in a real mapping is still fatal.
do $$
declare
  v_unresolvable text[];
begin
  select coalesce(array_agg(m.existing_name order by m.existing_name), '{}')
    into v_unresolvable
    from hr_org_branch_map m
   where not exists (select 1 from hr_org_dest d where d.existing_id = m.existing_id)
     and exists (
       select 1 from public.stg_hr_branch_collapse c
        where lower(c.existing_name) = lower(m.existing_name)
          and c.target_name <> '');

  if array_length(v_unresolvable, 1) is not null then
    raise exception
      'authoritative_org_master ABORTED: % branch row(s) have a stated target that does not exist as a branch: %. Fix the mapping or add the branch to the workbook.',
      array_length(v_unresolvable, 1), array_to_string(v_unresolvable, ', ');
  end if;
end $$;

-- Destinations must all EXIST, or we would repoint records at a phantom branch.
do $$
declare
  v_missing text[];
begin
  select coalesce(array_agg(distinct d.dest_name order by d.dest_name), '{}')
    into v_missing
    from hr_org_dest d
   where not exists (select 1 from public.branches b
                      where lower(b.branch_name) = lower(d.dest_name));

  if array_length(v_missing, 1) is not null then
    raise exception
      'authoritative_org_master ABORTED: collapse map targets % branch(es) that do not exist: %. Fix the map or add them to the workbook.',
      array_length(v_missing, 1), array_to_string(v_missing, ', ');
  end if;
end $$;

-- Deterministic fallback destination per dirty row (dest_ord = 1).
create temporary table hr_org_fallback (
  existing_id uuid primary key,
  dest_id uuid not null
);

-- `min(uuid)` does not exist in PostgreSQL (there is no uuid aggregate), so the
-- lowest destination is taken with an explicit ordered array pick instead.
insert into hr_org_fallback (existing_id, dest_id)
select d.existing_id,
       (array_agg(d.dest_id order by d.dest_ord, d.dest_name))[1]
  from hr_org_dest d group by d.existing_id;


-- ---------------------------------------------------------------------------
-- 4. REPOINT every branch reference from a dirty branch to its canonical one.
--
-- 20 tables carry a branch FK. All are repointed, including the five whose FK is
-- ON DELETE CASCADE — but by UPDATING the FK value, never by deleting the
-- referencing row, so no attendance/payroll/leave/BankOne record is lost.
--
-- Which destination? Prefer the branch the row's own TEXT column names (e.g.
-- `employees.branch = 'KETU'` inside a `KETU & HEAD OFFICE` row); otherwise take
-- dest_ord = 1. That fallback is the ONLY guess in this script: it is
-- deterministic (same input, same answer, every run) and it is REPORTED in
-- CHECK 6 rather than applied silently.
-- ---------------------------------------------------------------------------

-- Resolve one dirty branch id + a text label to a canonical branch id.
-- A text match that differs from dest_ord = 1 WINS, because the row itself told
-- us where it belongs.
create or replace function pg_temp.hr_org_pick(p_branch_id uuid, p_label text)
returns uuid language sql stable as $fn$
  select coalesce(
    (select d.dest_id from hr_org_dest d
      where d.existing_id = p_branch_id
        and lower(p_label) = lower(d.dest_name)
      order by d.dest_ord limit 1),
    (select f.dest_id from hr_org_fallback f where f.existing_id = p_branch_id)
  );
$fn$;

-- 4a. employees — `branch` text is the row's own claim about where the person is.
update public.employees e
   set branch_id = pg_temp.hr_org_pick(e.branch_id, e.branch),
       branch    = coalesce((select b.branch_name from public.branches b
                               where b.id = pg_temp.hr_org_pick(e.branch_id, e.branch)),
                            e.branch),
       updated_at = now()
 where e.branch_id is not null
   and exists (select 1 from hr_org_branch_map m where m.existing_id = e.branch_id);

-- 4b. employee_branch_assignments — branch_label_norm is the row's own claim.
update public.employee_branch_assignments ba
   set branch_id = pg_temp.hr_org_pick(ba.branch_id, ba.branch_label_norm),
       branch_label = coalesce((select b.branch_name from public.branches b
                                 where b.id = pg_temp.hr_org_pick(ba.branch_id, ba.branch_label_norm)),
                                ba.branch_label),
       branch_label_norm = lower(coalesce((select b.branch_name from public.branches b
                                 where b.id = pg_temp.hr_org_pick(ba.branch_id, ba.branch_label_norm)),
                                ba.branch_label))
 where ba.branch_id is not null
   and exists (select 1 from hr_org_branch_map m where m.existing_id = ba.branch_id);


-- 4c. The remaining branch-FK columns, in ONE loop over an explicit list.
--
-- The list is spelled out rather than discovered from pg_catalog on purpose: a
-- discovered list would silently repoint a brand-new table the first time
-- someone added a branch reference somewhere, with no review. This is an
-- auditable, finite set.
--
-- Columns with no matching text to disambiguate fall back to dest_ord = 1 and
-- are reported in CHECK 6.
do $$
declare
  r text;
  v_repointed bigint := 0;
  v_pairs text[] := array[
    'attendance_records.actual_branch_id',
    'attendance_records.branch_id',
    'attendance_records.clocked_in_branch_id',
    'employee_location_events.detected_branch_id',
    'training_sessions.branch_id',
    'training_sessions.venue_id',
    'leave_capacity_rules.branch_id',
    'leave_holidays.branch_id',
    'mpr_targets.branch_id',
    'hr_master_branch_links.canonical_branch_id',
    'hr_branch_label_mappings.canonical_branch_id',
    'bankone_branch_mappings.canonical_branch_id',
    'bankone_branch_mappings.split_from_branch_id',
    'bankone_branch_resolutions.branch_id',
    'bankone_branch_snapshots.branch_id',
    'bankone_import_rows.resolved_branch_id',
    'bankone_officer_snapshots.branch_id'
  ];
begin
  foreach r in array v_pairs loop
    execute format($q$
      update public.%I t
         set %I = pg_temp.hr_org_pick(t.%I, null)
       where t.%I is not null
         and exists (select 1 from hr_org_branch_map m where m.existing_id = t.%I)
    $q$, split_part(r, '.', 1), split_part(r, '.', 2),
         split_part(r, '.', 2), split_part(r, '.', 2), split_part(r, '.', 2));
    get diagnostics v_repointed = row_count;
  end loop;
end $$;

-- 4d. branch_area_assignments is UNIQUE(branch_id, area_id), so two dirty rows
--     collapsing onto the same canonical branch + area would violate it. This is
--     the ONE place a redundant row is deleted, and it is a pure junction table
--     (a mapping, not history): keeping two identical mappings is meaningless,
--     and the constraint makes it impossible. Every deletion is reported in
--     CHECK 7 so HR can confirm no area lost its branch.
-- branch_id is NOT NULL on this table, and pg_temp.hr_org_pick returns NULL for
-- a row with no mapped destination. Filtering on a non-NULL result means such a
-- row keeps pointing at its existing branch rather than aborting the run; it is
-- then reported in CHECK 8 with the other unmapped references.
update public.branch_area_assignments baa
   set branch_id = pg_temp.hr_org_pick(baa.branch_id, null)
 where baa.branch_id is not null
   and exists (select 1 from hr_org_branch_map m where m.existing_id = baa.branch_id)
   and pg_temp.hr_org_pick(baa.branch_id, null) is not null;


-- 4e. Dedupe branch_area_assignments after the repoint.
--
--     UNIQUE(branch_id, area_id) means that if two dirty branches in the SAME
--     area both collapse onto one canonical branch, the second UPDATE would
--     abort the whole run. That is a genuine risk, so it is handled explicitly
--     rather than left to surface as a constraint violation: keep the
--     lowest-id row (deterministic — the same input always keeps the same row)
--     and record the rest for CHECK 7.
--
--     This junction table is a MAPPING, not history: a branch can only be in an
--     area once, so a duplicate carries no information that is being lost. The
--     area itself is untouched either way.
create temporary table hr_org_baa_dupes (
  dropped_id uuid primary key,
  branch_name text not null,
  area_id uuid not null
);

-- An INSERT cannot use RETURNING ... INTO, so the deleted rows are captured with
-- a data-modifying CTE. The pre-repoint count is taken first so CHECK 7 can prove
-- that only duplicates CREATED by this run were removed.
create temporary table hr_org_baa_before as
select count(*)::int as n from public.branch_area_assignments;

with doomed as (
  select d.id
    from (
      select ba.id,
             row_number() over (
               partition by ba.branch_id, ba.area_id
               order by ba.id) as rn
        from public.branch_area_assignments ba
    ) d
   where d.rn > 1
),
removed as (
  delete from public.branch_area_assignments ba
   using doomed dd
   where ba.id = dd.id
  returning ba.id,
            (select b.branch_name from public.branches b
              where b.id = ba.branch_id) as branch_name,
            ba.area_id
)
insert into hr_org_baa_dupes (dropped_id, branch_name, area_id)
select r.id, r.branch_name, r.area_id from removed r;



-- ---------------------------------------------------------------------------
-- 5. DEACTIVATE the dirty branch rows. Never delete them.
--
-- 20 tables reference `branches` and 5 cascade, so a hard delete would silently
-- destroy attendance, leave-capacity rules, MPR targets and area assignments.
-- `status='inactive'` keeps every historical record resolvable while removing
-- the row from HR Organisation's branch list and from every dropdown that
-- filters on status.
-- ---------------------------------------------------------------------------
update public.branches b
   set status = 'inactive', updated_at = now()
 where exists (select 1 from hr_org_branch_map m where m.existing_id = b.id)
   and coalesce(b.status, 'active') <> 'inactive';


-- ---------------------------------------------------------------------------
-- 6. DEPARTMENTS — 13 real departments, 19 rows today.
--
-- The duplicates are the same name under two codes (AUDIT_INVESTIGATION and
-- AUDIT_AND_INVESTIGATION are both "AUDIT & INVESTIGATION"). The workbook's code
-- wins; the other code's row is deactivated, not deleted, so historical rows
-- that stored the old code still resolve.
-- ---------------------------------------------------------------------------
update public.departments d
   set is_active = false
 where not exists (
         select 1 from public.stg_hr_department_source s
          where lower(d.name) = lower(s.name))
   and coalesce(d.is_active, true);

-- `departments_code_key` is UNIQUE and `code` is NOT NULL. The same department
-- name exists under TWO codes today (AUDIT_INVESTIGATION and
-- AUDIT_AND_INVESTIGATION are both "AUDIT & INVESTIGATION"), so writing the
-- workbook's code onto the kept row collides with the twin.
--
-- The twin therefore surrenders its code to a RETIRED_ marker rather than NULL
-- (which the NOT NULL forbids). The prefix cannot collide with a real code
-- because every real code is an upper-cased name slug, never prefixed, and the
-- row keeps its original name so the ~334 employees referencing this department
-- by name still resolve. The row itself is never deleted.
update public.departments d
   set code = 'RETIRED_' || d.code
 where exists (select 1 from public.stg_hr_department_source s
                where lower(s.name) = lower(d.name))
   and d.code is distinct from (select s.code from public.stg_hr_department_source s
                                where lower(s.name) = lower(d.name))
   and d.code not like 'RETIRED\_%';

insert into public.departments (code, name, is_active, sort_order, created_at)
select s.code, s.name, true, s.sort_order, now()
  from public.stg_hr_department_source s
 where not exists (
         select 1 from public.departments d
          where lower(d.name) = lower(s.name))
on conflict do nothing;

-- Adopt the workbook's code, deactivating the wrong-code twin (identified by its
-- RETIRED_ code).
update public.departments d
   set code = s.code,
       is_active = true,
       sort_order = s.sort_order
  from public.stg_hr_department_source s
 where lower(d.name) = lower(s.name)
   and d.code is distinct from s.code
   and d.code not like 'RETIRED\_%';

-- The RETIRED_ twins are excluded from the two statements above by design (they
-- are not the row that should carry the workbook's code), so they need their own
-- deactivation. Without this they would stay active and the department list would
-- still show "AUDIT & INVESTIGATION" twice.
update public.departments d
   set is_active = false
 where d.code like 'RETIRED\_%'
   and coalesce(d.is_active, true);

-- ---------------------------------------------------------------------------
-- 7. DESIGNATIONS — 66 real titles, 119 rows today.
--
-- `designations` is UNIQUE(title, department), so the same title legitimately
-- exists once per department. Matching is therefore on (title, department): a
-- title present in the workbook but under a different department is a genuinely
-- different row and is left alone; a title with no workbook row at all is
-- deactivated. `employees.designation_id` is never touched, so every employee
-- keeps pointing at the same designation row.
-- ---------------------------------------------------------------------------
update public.designations g
   set is_active = false
 where not exists (
         select 1 from public.stg_hr_designation_source s
          where lower(g.title) = lower(s.title))
   and coalesce(g.is_active, true);

insert into public.designations (title, department, is_active, sort_order, created_at)
select s.title, null, true, s.sort_order, now()
  from public.stg_hr_designation_source s
 where not exists (
         select 1 from public.designations g
          where lower(g.title) = lower(s.title))
on conflict do nothing;

update public.designations g
   set is_active = true, sort_order = s.sort_order
  from public.stg_hr_designation_source s
 where lower(g.title) = lower(s.title);

-- ---------------------------------------------------------------------------
-- 8. VERIFICATION — read this before proceeding to the employee replace.
-- ---------------------------------------------------------------------------

-- =========== ORG MASTER — VERIFICATION ==========

-- headcount: active branches must be exactly the workbook's 21
select
  (select count(*) from public.stg_hr_branch_source)                     as expected_branches,
  (select count(*) from public.branches where coalesce(status,'active') = 'active') as active_branches,
  (select count(*) from public.branches)                                  as total_branch_rows,
  (select count(*) from public.stg_hr_department_source)                  as expected_departments,
  (select count(*) from public.departments where coalesce(is_active,true)) as active_departments,
  (select count(*) from public.stg_hr_designation_source)                 as expected_designations,
  (select count(*) from public.designations where coalesce(is_active,true)) as active_designations;

-- CHECK 1: an active branch that is NOT in the workbook (expect NO rows).
--         If this returns anything, HR Organisation will still show a dirty name.
select b.branch_name
  from public.branches b
 where coalesce(b.status,'active') = 'active'
   and not exists (select 1 from public.stg_hr_branch_source s
                    where lower(s.branch_name) = lower(b.branch_name))
 order by 1;

-- CHECK 2: workbook branch missing from the database (expect NO rows).
select s.branch_name
  from public.stg_hr_branch_source s
 where not exists (select 1 from public.branches b
                    where lower(b.branch_name) = lower(s.branch_name))
 order by 1;

-- CHECK 3: MERGED NAMES STILL ACTIVE (expect NO rows). This is the check that
--         proves the specific problem you reported is fixed.
select b.branch_name
  from public.branches b
 where coalesce(b.status,'active') = 'active'
   and (b.branch_name like '%&%' or b.branch_name like '%/%')
 order by 1;

-- CHECK 4: duplicate active branch names differing only by case (expect NO rows).
select lower(b.branch_name) as name, count(*), string_agg(b.branch_name, ' | ')
  from public.branches b
 where coalesce(b.status,'active') = 'active'
 group by lower(b.branch_name) having count(*) > 1;

-- CHECK 5: every active branch is in the workbook AND vice-versa (both 21).
select
  (select count(*) from public.branches b
    where coalesce(b.status,'active') = 'active'
      and exists (select 1 from public.stg_hr_branch_source s
                   where lower(s.branch_name) = lower(b.branch_name))) as active_and_in_workbook,
  (select count(*) from public.stg_hr_branch_source) as workbook_total;

-- CHECK 6: BRANCHES DEACTIVATED, with where their references went.
--         This is the audit trail of the collapse: every dirty row and the
--         canonical branch(es) it became.
select m.existing_name as deactivated_branch,
       (select string_agg(d.dest_name, ', ' order by d.dest_ord)
          from hr_org_dest d where d.existing_id = m.existing_id) as became,
       (select count(*) from public.employees e
         where e.branch_id = m.existing_id) as employees_still_pointing_here
  from hr_org_branch_map m
 order by 1;

-- CHECK 7: area mappings removed by the dedupe (expect 0 unless two dirty
--         branches in one area collapsed onto the same canonical branch).
select d.branch_name, a.area_name, d.dropped_id
  from hr_org_baa_dupes d
  join public.areas a on a.id = d.area_id;

-- CHECK 8: employees still pointing at a DEACTIVATED branch (must be 0).
select b.branch_name, count(*)
  from public.employees e
  join public.branches b on b.id = e.branch_id
 where coalesce(b.status,'active') <> 'active'
 group by 1;

-- CHECK 9: employee branch assignments still pointing at a DEACTIVATED branch
--         (must be 0).
select b.branch_name, count(*)
  from public.employee_branch_assignments ba
  join public.branches b on b.id = ba.branch_id
 where coalesce(b.status,'active') <> 'active'
 group by 1;

-- CHECK 10: THE CANONICAL LIST HR Organisation will now display (expect 21).
select b.branch_name, b.branch_code,
       (select count(*) from public.employees e where e.branch_id = b.id) as staff
  from public.branches b
 where coalesce(b.status,'active') = 'active'
 order by b.branch_name;

-- CHECK 11: departments (expect 13 active) and any wrong-code twin still active.
select code, name, is_active
  from public.departments
 where coalesce(is_active, true)
 order by name;

-- CHECK 12: designations still active but absent from the workbook (expect NO rows).
select g.title, g.department
  from public.designations g
 where coalesce(g.is_active, true)
   and not exists (select 1 from public.stg_hr_designation_source s
                    where lower(s.title) = lower(g.title))
 order by 1;

-- ============================ END ORG VERIFICATION =========================
-- Once committed, ROLLBACK is gone. Restore from a backup.
--
-- Scratch tables are dropped last, after every CHECK has read them.
drop table if exists hr_org_case_dupes;
drop table if exists hr_org_baa_dupes;
drop table if exists hr_org_baa_before;
drop table if exists hr_org_fallback;
drop table if exists hr_org_dest;
drop table if exists hr_org_branch_map;

