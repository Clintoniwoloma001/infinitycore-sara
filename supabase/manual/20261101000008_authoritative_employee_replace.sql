-- ============================================================================
-- 20261101000008 — AUTHORITATIVE EMPLOYEE REPLACE (DESTRUCTIVE)
-- ============================================================================
--
--   ####################################################################
--   ##                                                                ##
--   ##   MANUAL RUN ONLY — RUN IT YOURSELF IN THE SUPABASE SQL        ##
--   ##   EDITOR AGAINST PRODUCTION. NEVER RUN AUTOMATICALLY.           ##
--   ##                                                                ##
--   ####################################################################
--
-- Replaces the `employees` table with the authoritative HR master
-- (IT AUTOMATION LIST REVIEWED-3, 209 people) while preserving every linked
-- record: auth identities, profiles, attendance history, documents, payroll,
-- training and hierarchy.
--
-- ---------------------------------------------------------------------------
-- WHY THIS DOES NOT SIMPLY "DELETE FROM employees"
-- ---------------------------------------------------------------------------
-- 36 tables reference employees with ON DELETE CASCADE, and 16 more with
-- ON DELETE SET NULL. A plain DELETE would therefore silently destroy:
--     employee_digital_files   427 rows  (HR documents — irreplaceable)
--     employee_supervisors     771 rows  (the whole supervisory hierarchy)
--     attendance + biometrics  several rows
-- and would NULL out profiles.employee_id, payroll, leave and audit history.
-- The brief explicitly requires NO orphaned-record deletion, so this script
-- DELETES NOTHING. Instead it:
--
--   1. archives the current employees table into a full-fidelity snapshot
--   2. UPDATES employees IN PLACE, matching on staff_id (and email)
--   3. soft-archives rows that are absent from the authoritative master
--   4. inserts people who do not yet exist
--   5. re-links every FK and branch/hierarchy mapping onto the same ids
--
-- Employee ids are therefore PRESERVED, so auth identities, attendance,
-- payroll, documents and training all keep their references. This is
-- recoverable: step 1 leaves a complete backup, and ROLLBACK works because the
-- whole script is one transaction.
--
-- ---------------------------------------------------------------------------
-- EXCLUSIONS (HR resolves these out-of-band, then inserts them manually)
-- ---------------------------------------------------------------------------
--   IMFB/20/0147  two different people share this staff id
--   IMFB/23/0305  two different people share this staff id
--   a.shittu@infinitymfb.com  two different people share this email
--
-- ---------------------------------------------------------------------------
-- HOW TO RUN — IN THIS EXACT ORDER, IN THE SUPABASE SQL EDITOR
-- ---------------------------------------------------------------------------
--   Each step is its own "Run" button press. Do not combine them.
--
--   0. BACK UP FIRST (Dashboard -> Database -> Backups, or `supabase db dump`).
--      A backup is the only safety net if this is run against the wrong project.
--
--   1. Run  20261101000007a_authoritative_staging_schema.sql
--      Creates the three stg_* tables. It MUST run before the value files,
--      because those files are plain INSERTs against tables that do not exist
--      yet in a fresh production database. Safe to re-run.
--
--   2. Run the three generated value files, in any order:
--        employee_source_values.sql
--        employee_branch_values.sql
--        employee_supervisor_values.sql
--      Expect "INSERT 0 209", "INSERT 0 218" and "INSERT 0 208".
--
--   3. Run THIS file. Before you do, open it and change the ONE constant on the
--      line marked  <== change to 'YES' to run  from 'NO' to 'YES'. Until that is
--      done the script aborts on its first statement and writes nothing at all.
--      Then paste the whole file into the editor and run it.
--
--      Do NOT add begin; / commit; yourself — the SQL Editor already wraps every
--      run in a transaction, so a nested BEGIN would be rejected.
--
--   4. Read the verification report at the end of the output — it returns one
--      result set per CHECK. Do not declare success until you have read them.
--
-- This file lives in supabase/manual/ on purpose: it is NOT in supabase/migrations,
-- so `supabase db push` can never apply it unattended. The flag above is a second,
-- independent guard in case the file is ever copied back into the migrations
-- folder by accident.
--
-- Dry run (local docker, always rolled back):
--   npm run hr:authoritative:dryrun
--
-- Regenerate the value files after any workbook change:
--   npm run hr:authoritative:build
-- ============================================================================

-- The Supabase SQL Editor already wraps every run in a transaction, so this file
-- deliberately does NOT issue its own begin;/commit; — a nested BEGIN would be
-- rejected as "there is already a transaction in progress". Everything below is
-- therefore atomic for free: if any statement fails, the editor rolls the whole
-- run back and nothing is written.

-- ---------------------------------------------------------------------------
-- 0. RUN CONFIRMATION GATE (deliberate hard stop).
--
--    Edit the one constant below from 'NO' to 'YES' to authorise this run.
--    It is a literal in this file rather than a session setting on purpose:
--    `set local` is silently discarded outside an explicit transaction block,
--    so a session-flag guard would behave differently in the SQL Editor than
--    in psql. A literal cannot vary by runner.
--
--    Until it is changed, the script aborts on the first statement and writes
--    nothing at all.
--
--    The ONLY automatic guard is that `employees` must be non-empty, i.e. a real
--    HR database rather than a blank one. There is deliberately NO hardcoded
--    headcount: an earlier version required exactly 430 rows, but 430 was the
--    LOCAL DEV figure, which included 215 synthetic `IMFB-KH-*` seed rows that
--    exist only in the development database. Production legitimately holds a
--    different number (212), so that check aborted a legitimate run. An
--    environment-specific expectation belongs in a dry run, not in a guard that
--    runs against production.
-- ---------------------------------------------------------------------------
do $$
declare
  v_n       int;
  v_confirm constant text := 'NO';   -- <== change to 'YES' to run
begin
  select count(*) into v_n from public.employees;

  if v_confirm <> 'YES' then
    raise exception
      'authoritative_employee_replace ABORTED: no writes made. Set the v_confirm constant to ''YES'' at the top of this file to confirm you are running this against PRODUCTION deliberately.';
  end if;

  if v_n = 0 then
    raise exception 'authoritative_employee_replace ABORTED: employees is empty — wrong environment or wrong project';
  end if;

  raise notice 'employees before replace: %', v_n;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Staging tables — the authoritative source, loaded by the generated files.
--
-- staff_id is the join key to the existing employees rows so that ids survive.
-- If two source rows share a staff id the ON CONFLICT keeps the first and the
-- conflict is reported in step 7 rather than silently picked.
-- ---------------------------------------------------------------------------
create table if not exists public.stg_hr_employee_source (
  staff_id text primary key,
  full_name text not null,
  first_name text,
  last_name text,
  email text,
  position text,
  department text,
  gender text,
  confirmation_status text,
  source_row jsonb
);

create table if not exists public.stg_hr_employee_branch_source (
  staff_id text not null,
  branch_label text not null
);
create unique index if not exists uq_stg_branch
  on public.stg_hr_employee_branch_source (staff_id, branch_label);

create table if not exists public.stg_hr_employee_supervisor_source (
  staff_id text primary key,
  supervisor_1 text,
  supervisor_2 text,
  supervisor_3 text
);

-- ---------------------------------------------------------------------------
-- 2. Backup snapshots — full fidelity, so this is reversible without a dump.
--
-- hr_employee_archive keeps a row for EVERY employee that existed before, with
-- the columns this migration is about to change. The auth/profile linkage is
-- snapshotted too, so a bad re-link can be traced back to the exact prior state.
-- ---------------------------------------------------------------------------
create table if not exists public.hr_employee_archive (
  snapshot_at timestamptz not null default now(),
  employee_id uuid not null,
  staff_id text,
  full_name text,
  email text,
  phone text,
  position text,
  department text,
  branch text,
  branch_id uuid,
  user_id uuid,
  employee_number text,
  employment_status text,
  sex text,
  nationality text,
  confirmation_status text,
  is_archived boolean,
  source text
);
create index if not exists idx_hr_employee_archive_emp
  on public.hr_employee_archive (employee_id);

-- Auth / profile linkage BEFORE any change (for the re-link and for auditing).
create table if not exists public.hr_profile_link_archive (
  snapshot_at timestamptz not null default now(),
  profile_id uuid not null,
  profile_email text,
  profile_full_name text,
  profile_role text,
  employee_id uuid,
  auth_user_id uuid
);

insert into public.hr_employee_archive
  (employee_id, staff_id, full_name, email, phone, position, department, branch,
   branch_id, user_id, employee_number, employment_status, sex, nationality,
   confirmation_status, is_archived, source)
select id, staff_id, full_name, email, phone, position, department, branch,
       branch_id, user_id, employee_number, employment_status, sex, nationality,
       confirmation_status, is_archived, source
  from public.employees;

insert into public.hr_profile_link_archive
  (profile_id, profile_email, profile_full_name, profile_role, employee_id, auth_user_id)
select p.id, p.email, p.full_name, p.role, p.employee_id, e.user_id
  from public.profiles p
  left join public.employees e on e.id = p.employee_id;

-- Attendance history keyed by the LEGACY employee id, so it can be verified
-- (and restored) after the replace without losing a single row.
create table if not exists public.hr_attendance_restore (
  snapshot_at timestamptz not null default now(),
  attendance_id uuid not null,
  legacy_employee_id uuid,
  attendance_date date,
  clock_in timestamptz,
  clock_out timestamptz,
  restored_employee_id uuid
);
create index if not exists idx_hr_attendance_restore_emp
  on public.hr_attendance_restore (legacy_employee_id);

insert into public.hr_attendance_restore
  (attendance_id, legacy_employee_id, attendance_date, clock_in, clock_out)
select a.id, a.employee_id, a.attendance_date, a.clock_in, a.clock_out
  from public.attendance_records a;

-- ---------------------------------------------------------------------------
-- 3. Pre-flight: the staging tables must be loaded and self-consistent.
-- ---------------------------------------------------------------------------
do $$
declare v_src int; v_br int; v_conf int;
begin
  select count(*) into v_src from public.stg_hr_employee_source;
  if v_src = 0 then
    raise exception 'authoritative_employee_replace aborted: stg_hr_employee_source is empty. Run the generated value files first: node scripts/build-authoritative-employees.mjs --emit';
  end if;

  select count(*) into v_br from public.stg_hr_employee_branch_source;
  select count(*) into v_conf from (
    select b.staff_id from public.stg_hr_employee_branch_source b
     left join public.stg_hr_employee_source s on s.staff_id = b.staff_id
     where s.staff_id is null
  ) orphan;

  if v_conf > 0 then
    raise exception 'authoritative_employee_replace aborted: % branch rows reference a staff_id absent from the source table', v_conf;
  end if;

  raise notice 'source people: %, branch rows: %', v_src, v_br;
end $$;

-- ---------------------------------------------------------------------------
-- 4. UPSERT the authoritative people, PRESERVING employee ids.
--
-- Matching is by staff_id first — the only stable key across both datasets —
-- and only then by email, for legacy rows whose staff_id is null or was never
-- populated. Because ids are reused, every FK pointing at employees keeps
-- pointing at the same person: auth identities, attendance, payroll, documents
-- and training all survive untouched.
-- ---------------------------------------------------------------------------
-- 4a. Existing rows matched by staff_id: refresh the HR-master attributes.
--     NB: employees stores a single `full_name` plus `sex` (no first_name /
--     last_name / gender columns), so the split parts are only used to rebuild
--     full_name when the master supplies one.
update public.employees e
   set full_name            = coalesce(s.full_name, e.full_name),
       email                = coalesce(s.email, e.email),
       position             = coalesce(s.position, e.position),
       department           = coalesce(s.department, e.department),
       sex                  = coalesce(s.gender, e.sex),
       confirmation_status  = coalesce(s.confirmation_status, e.confirmation_status),
       import_source        = 'IT AUTOMATION LIST REVIEWED-3',
       updated_at           = now()
  from public.stg_hr_employee_source s
 where s.staff_id is not null
   and e.staff_id = s.staff_id;

-- 4b. Legacy rows with a NULL staff_id but a matching email are adopted by
--     their email, and given the authoritative staff_id.
update public.employees e
   set staff_id             = s.staff_id,
       full_name            = coalesce(s.full_name, e.full_name),
       position             = coalesce(s.position, e.position),
       department           = coalesce(s.department, e.department),
       confirmation_status  = coalesce(s.confirmation_status, e.confirmation_status),
       import_source        = 'IT AUTOMATION LIST REVIEWED-3',
       updated_at           = now()
  from public.stg_hr_employee_source s
 where e.staff_id is null
   and s.email is not null
   and lower(e.email) = lower(s.email);

-- 4c. Genuinely new people.
insert into public.employees
  (staff_id, full_name, email, position, department, sex,
   confirmation_status, import_source, employment_status, created_at, updated_at)
select s.staff_id, s.full_name, s.email, s.position,
       s.department, s.gender, s.confirmation_status,
       'IT AUTOMATION LIST REVIEWED-3', 'active', now(), now()
  from public.stg_hr_employee_source s
 where not exists (select 1 from public.employees e where e.staff_id = s.staff_id);

-- ---------------------------------------------------------------------------
-- 5. Employees NOT in the authoritative master are ARCHIVED, never deleted.
--
-- They may be the excluded conflict records HR still has to resolve, contractors
-- the workbook omits, or rows that simply have no workbook entry. Hard-deleting
-- them would cascade away their attendance and documents. Archiving keeps every
-- reference intact and reversible, and step 7 lists them so HR can decide.
-- ---------------------------------------------------------------------------
update public.employees e
   set is_archived     = true,
       archived_at     = now(),
       archive_reason  = 'Not present in IT AUTOMATION LIST REVIEWED-3 authoritative master'
 where not exists (
         select 1 from public.stg_hr_employee_source s where s.staff_id = e.staff_id
       )
   and e.staff_id is not null
   and coalesce(e.is_archived, false) = false;

-- Rows with no staff_id at all cannot be judged against the master; leave them
-- alone and let step 7 report them rather than archiving a person on a guess.

-- ---------------------------------------------------------------------------
-- 6. Re-link profiles and restore auth linkage.
--
-- profiles.employee_id is a SET NULL FK, so it may have been blanked; we rematch
-- on email first (the key Supabase auth actually shares) and fall back to a
-- normalised full_name. A profile is only ever re-pointed when the match is
-- UNAMBIGUOUS — exactly one candidate — so we can never attach an account to
-- the wrong person.
-- ---------------------------------------------------------------------------
-- 6a. profiles -> employees by email.
update public.profiles p
   set employee_id = e.id
  from public.employees e
 where p.employee_id is null
   and p.email is not null
   and lower(p.email) = lower(e.email)
   and e.email is not null
   and (select count(*) from public.employees x
         where x.email is not null and lower(x.email) = lower(p.email)) = 1;

-- 6b. profiles -> employees by normalised full_name, but ONLY for staff-like
--     profiles and ONLY against rows that are still active.
--
--     Name matching is a weak key, so it is deliberately fenced in three ways:
--       * customer-profile roles never bind to an employee by name,
--       * archived rows are excluded (they are the "not in the master" set —
--         binding a live login to a departed record is exactly the mistake the
--         Phase 69 incident class warns about),
--       * the name must resolve to exactly one candidate.
--     Anything that fails these tests stays unlinked and is reported in CHECK 4
--     for an explicit HR decision, rather than being guessed at.
update public.profiles p
   set employee_id = e.id
  from public.employees e
 where p.employee_id is null
   and p.full_name is not null
   and p.role is distinct from 'customer'
   and not coalesce(e.is_archived, false)
   and lower(regexp_replace(p.full_name, '\s+', ' ', 'g'))
       = lower(regexp_replace(e.full_name, '\s+', ' ', 'g'))
   and (select count(*) from public.employees x
         where not coalesce(x.is_archived, false)
           and x.full_name is not null
           and lower(regexp_replace(x.full_name, '\s+', ' ', 'g'))
               = lower(regexp_replace(p.full_name, '\s+', ' ', 'g'))) = 1;

-- 6c. Restore employees.user_id (the auth identity) from the profile archive.
--     The archive holds the PRE-replace pairing, so auth identities are carried
--     across even if the employee row itself was matched by a different key.
--     NB: the value written is a.auth_user_id (the auth.users PK) — writing
--     a.employee_id here would put an employee uuid into the auth column and
--     break every login for that person.
update public.employees e
   set user_id = a.auth_user_id
  from public.hr_profile_link_archive a
 where a.auth_user_id is not null
   and e.user_id is null
   and a.employee_id = e.id;

-- ---------------------------------------------------------------------------
-- 7. Multi-branch assignments — one employee, many branches.
--
-- Branch matching is case-insensitive because the DB stores names inconsistently
-- ("Head Office", "HEAD OFFICE", "AGEGE"). `branches` contains duplicate names
-- for some locations, so exactly ONE branch id is chosen deterministically
-- (lowest uuid) rather than an unordered "first" match.
--
-- The workbook uses labels that do not all exist as `branches` rows, so an
-- explicit ALIAS table maps the unambiguous renames to the branch that already
-- exists (e.g. "Sabo Yaba" -> "SABO/YABA"). A label with no alias and no exact
-- match would otherwise be dropped silently by the inner join — losing a branch
-- assignment with no error — so any REMAINING unmatched label gets a real
-- `branches` row created for it, which is then reported in CHECK 13 for HR to
-- rename/confirm. Nothing is ever silently discarded.
--
-- branch_label is stored on the assignment as well as the FK, because
-- employee_branch_assignments.branch_label is NOT NULL and is what the
-- reconciliation UI displays.
-- ---------------------------------------------------------------------------
-- The three hr_* tables below are TEMPORARY but deliberately NOT declared
-- "on commit drop". Under autocommit (running this file statement-by-statement,
-- as the Supabase SQL Editor does) an "on commit drop" table is destroyed at the
-- end of its own statement's implicit transaction, so the very next statement
-- fails with `relation "hr_branch_alias" does not exist`. They are dropped
-- explicitly at the end of this script instead.
create temporary table hr_branch_alias (source_label text primary key, target_label text);
insert into hr_branch_alias (source_label, target_label) values
  ('Ibeju Lekki Two (Ajah)','AJAH'),
  ('Sabo Yaba',             'SABO/YABA'),
  ('Lagos Island ONE',      'LAGOS ISLAND 1'),
  ('Ile Epo',               'ILE-EPO'),
  ('Lagos Island TWO SME',  'LAGOS ISLAND 2'),
  ('Tradefair',             'TRADE FAIR');

-- 7a. Canonical label for every workbook label (alias first, else the label).
create temporary table hr_branch_resolved as
select distinct bs.branch_label as source_label,
       coalesce(
         (select a.target_label from hr_branch_alias a
           where lower(a.source_label) = lower(bs.branch_label)),
         bs.branch_label) as canonical_label
  from public.stg_hr_employee_branch_source bs;

-- 7b. Create a real branch for any canonical label that still has no row.
--     branch_code is left NULL deliberately: it is not unique-constrained and no
--     code has been agreed with HR, so a fabricated one would be worse than none.
--     RETURNING into a temp table records exactly which branches this run
--     created, so CHECK 13 can report them without guessing from timestamps.
create temporary table hr_branch_created (branch_id uuid primary key, branch_name text);

--     An INSERT ... SELECT cannot use RETURNING ... INTO, so the created rows are
--     captured through a data-modifying CTE instead.
with created as (
  insert into public.branches (branch_name, status)
  select r.canonical_label, 'active'
    from hr_branch_resolved r
   where not exists (
           select 1 from public.branches b
            where lower(b.branch_name) = lower(r.canonical_label))
  returning id, branch_name
)
insert into hr_branch_created (branch_id, branch_name)
select c.id, c.branch_name from created c;

-- assignment_type is constrained to primary|responsibility|temporary. The branch
-- that matches the employee's own `branch` column is the 'primary' one; the
-- additional workbook branches (the multi-branch staff) are 'responsibility'.
-- Deriving it keeps the constraint satisfied without hardcoding every value.
insert into public.employee_branch_assignments
  (employee_id, branch_id, branch_label, branch_label_norm, assignment_type,
   is_primary, is_active, source_sheet)
select e.id,
       b.branch_id,
       b.branch_label,
       lower(b.branch_label),
       case when lower(b.branch_label) = lower(e.branch)
            then 'primary' else 'responsibility' end,
       (lower(b.branch_label) = lower(e.branch)),
       true,
       'IT AUTOMATION LIST REVIEWED-3'
  from public.stg_hr_employee_branch_source bs
  join public.employees e on e.staff_id = bs.staff_id
  join hr_branch_resolved r on lower(r.source_label) = lower(bs.branch_label)
  -- Deterministic single branch per canonical label.
  join lateral (
    select x.id as branch_id, x.branch_name as branch_label
      from public.branches x
     where lower(x.branch_name) = lower(r.canonical_label)
     order by x.id
     limit 1
  ) b on true
on conflict do nothing;

-- hr_branch_created is NOT dropped here: CHECK 13 still reads it further down.
-- All three are dropped explicitly at the very end of this script.

-- employees.branch holds only the PRIMARY branch, so it is set from the
-- assignment marked primary (or the first available assignment).
update public.employees e
   set branch = src.branch_label,
       branch_id = src.branch_id
  from (
    select d.employee_id, d.branch_label, d.branch_id
      from (
        select ba.employee_id, b.branch_name as branch_label, b.id as branch_id,
               row_number() over (
                 partition by ba.employee_id
                 order by ba.is_primary desc nulls last, b.branch_name
               ) as rn
          from public.employee_branch_assignments ba
          join public.branches b on b.id = ba.branch_id
      ) d
     where d.rn = 1
  ) src
 where e.id = src.employee_id;

-- ---------------------------------------------------------------------------
-- 8. Three-level supervisory hierarchy.
--
-- Supervisors arrive from the workbook as NAMES, so each level is resolved to a
-- single unambiguous employee. An unmatched or ambiguous name leaves the column
-- NULL and is REPORTED in step 10 — a name is never guessed at.
-- ---------------------------------------------------------------------------
update public.employees e
   set supervisor_1st_id = s1.id
  from public.stg_hr_employee_supervisor_source s
  left join public.employees s1 on lower(s1.full_name) = lower(s.supervisor_1)
 where e.staff_id = s.staff_id
   and s.supervisor_1 is not null and s.supervisor_1 <> ''
   and (select count(*) from public.employees x
         where lower(x.full_name) = lower(s.supervisor_1)) = 1;

update public.employees e
   set supervisor_2nd_id = s2.id
  from public.stg_hr_employee_supervisor_source s
  left join public.employees s2 on lower(s2.full_name) = lower(s.supervisor_2)
 where e.staff_id = s.staff_id
   and s.supervisor_2 is not null and s.supervisor_2 <> ''
   and (select count(*) from public.employees x
         where lower(x.full_name) = lower(s.supervisor_2)) = 1;

update public.employees e
   set supervisor_3rd_id = s3.id
  from public.stg_hr_employee_supervisor_source s
  left join public.employees s3 on lower(s3.full_name) = lower(s.supervisor_3)
 where e.staff_id = s.staff_id
   and s.supervisor_3 is not null and s.supervisor_3 <> ''
   and (select count(*) from public.employees x
         where lower(x.full_name) = lower(s.supervisor_3)) = 1;

-- ---------------------------------------------------------------------------
-- 9. Attendance restoration.
--
-- Employee ids are preserved by step 4, so attendance rows keep their
-- employee_id automatically and NOTHING needs rewriting. This step only
-- verifies that claim and re-points any row whose employee_id went missing,
-- matching on staff_id via the archive.
-- ---------------------------------------------------------------------------
update public.hr_attendance_restore r
   set restored_employee_id = e.id
  from public.employees e
 where r.restored_employee_id is null
   and e.staff_id = (
     select a.staff_id from public.hr_employee_archive a
      where a.employee_id = r.legacy_employee_id
      limit 1
   );

update public.attendance_records a
   set employee_id = r.restored_employee_id
  from public.hr_attendance_restore r
 where r.attendance_id = a.id
   and a.employee_id is null
   and r.restored_employee_id is not null;

-- ---------------------------------------------------------------------------
-- 10. Audit trail.
--
-- audit_logs in this schema is (action text, entity_type text, entity_id TEXT,
-- user_name text, details TEXT, severity text, created_at). Written to match
-- exactly — a mismatched audit insert would abort the whole transaction and
-- lose the replace, so the write is deliberately minimal and defensive.
-- ---------------------------------------------------------------------------
insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
select
    case
      when e.is_archived then 'EMPLOYEE_ARCHIVED_HR_MASTER_REPLACE'
      else 'EMPLOYEE_SYNCED_HR_MASTER_REPLACE'
    end,
    'employee',
    e.id::text,
    coalesce(auth.uid()::text, 'system'),
    'staff_id=' || coalesce(e.staff_id, '-')
      || ' full_name=' || coalesce(e.full_name, '-')
      || ' archived=' || coalesce(e.is_archived, false)::text
      || ' source=IT AUTOMATION LIST REVIEWED-3',
    case when e.is_archived then 'warning' else 'info' end
  from public.employees e
 where e.import_source = 'IT AUTOMATION LIST REVIEWED-3'
    or (e.is_archived and e.archive_reason like 'Not present in IT AUTOMATION LIST REVIEWED-3%');

-- ---------------------------------------------------------------------------
-- 11. VERIFICATION REPORT — read this before declaring success.
-- ---------------------------------------------------------------------------
--
-- =========== AUTHORITATIVE EMPLOYEE REPLACE — VERIFICATION ===========

-- Environment note: employee counts differ between environments. Local dev has
-- 430 rows because it also contains 215 synthetic `IMFB-KH-*` seed rows that do
-- not exist in production. Judge this run by matched_by_staff_id = 209, not by
-- employees_total.

--
-- headcount --
select
  (select count(*) from public.employees)                                 as employees_total,
  (select count(*) from public.stg_hr_employee_source)                   as source_expected,
  (select count(*) from public.employees e
     join public.stg_hr_employee_source s on s.staff_id = e.staff_id)    as matched_by_staff_id,
  (select count(*) from public.employees where coalesce(is_archived,false)) as archived,
  (select count(*) from public.hr_employee_archive)                      as snapshot_rows;

--
-- CHECK 1: every source person exists (expect NO rows) --
select s.staff_id, s.full_name
  from public.stg_hr_employee_source s
  left join public.employees e on e.staff_id = s.staff_id
 where e.id is null;

--
-- CHECK 2: duplicate staff_id among active rows (expect NO rows) --
select staff_id, count(*) from public.employees
 where coalesce(is_archived,false) = false and staff_id is not null
 group by staff_id having count(*) > 1;

--
-- CHECK 3: duplicate email among active rows (expect NO rows) --
select lower(email) as email, count(*) from public.employees
 where coalesce(is_archived,false) = false and email is not null and email <> ''
 group by lower(email) having count(*) > 1;

--
-- CHECK 4: profile re-link (unlinked_profiles should be 0) --
select (select count(*) from public.profiles)                                as profiles_total,
       (select count(*) from public.profiles where employee_id is not null) as linked_profiles,
       (select count(*) from public.profiles where employee_id is null)     as unlinked_profiles;

--
-- CHECK 5: auth identities missing from auth.users (expect NO rows) --
select p.id, p.email, p.role from public.profiles p
 where not exists (select 1 from auth.users u where u.id = p.id);

--
-- CHECK 6: attendance with no employee (expect orphan_attendance = 0) --
select count(*) as orphan_attendance from public.attendance_records a
 where a.employee_id is null;

--
-- CHECK 7: attendance preserved vs step-2 snapshot (all three equal) --
select (select count(*) from public.hr_attendance_restore)             as snapshotted,
       (select count(*) from public.attendance_records)                as still_present,
       (select count(*) from public.hr_attendance_restore r
          join public.attendance_records a on a.id = r.attendance_id) as restored_ok;
--
-- CHECK 8: preserved row counts (documents/hierarchy must NOT be zeroed) --
select 'employee_digital_files' as tbl, count(*) from public.employee_digital_files
union all select 'employee_supervisors', count(*) from public.employee_supervisors
union all select 'employee_branch_assignments', count(*) from public.employee_branch_assignments;

--
-- CHECK 9: multi-branch coverage (expect 7 people with >1 branch) --
select e.staff_id, e.full_name, count(*) as branches
  from public.employees e
  join public.employee_branch_assignments ba on ba.employee_id = e.id
 group by e.staff_id, e.full_name having count(*) > 1 order by branches desc;

--
-- CHECK 10: hierarchy coverage --
select (select count(*) from public.employees where coalesce(is_archived,false)=false) as active_people,
       (select count(*) from public.employees where supervisor_1st_id is not null)     as has_1st_level,
       (select count(*) from public.employees where supervisor_2nd_id is not null)     as has_2nd_level,
       (select count(*) from public.employees where supervisor_3rd_id is not null)     as has_3rd_level;

--
-- CHECK 11: UNRESOLVED supervisors (HR review queue, not failures) --
select s.staff_id as employee_staff_id, s.supervisor_1, s.supervisor_2, s.supervisor_3
  from public.stg_hr_employee_supervisor_source s
  join public.employees e on e.staff_id = s.staff_id
 where e.supervisor_1st_id is null
    or (s.supervisor_2 is not null and s.supervisor_2 <> '' and e.supervisor_2nd_id is null)
    or (s.supervisor_3 is not null and s.supervisor_3 <> '' and e.supervisor_3rd_id is null);

--
-- CHECK 12: archived, pending HR decision (NOT deleted) --
select staff_id, full_name, coalesce(email,'-') as email, archive_reason
  from public.employees
 where coalesce(is_archived, false) = true
 order by staff_id nulls last;

--
-- CHECK 13: BRANCHES AUTO-CREATED from workbook labels (HR should rename/confirm) --
select c.branch_name,
       (select count(*) from public.employee_branch_assignments ba
         where ba.branch_id = c.branch_id) as staff_assigned
  from hr_branch_created c
 order by c.branch_name;

--
-- CHECK 14: branch assignments created vs source rows (both must be 218) --
select (select count(*) from public.employee_branch_assignments
         where source_sheet = 'IT AUTOMATION LIST REVIEWED-3') as assignments_created,
       (select count(*) from public.stg_hr_employee_branch_source) as source_rows;

--
-- ============================ END VERIFICATION ============================
-- Once committed, ROLLBACK is no longer available. Restore from
-- public.hr_employee_archive / hr_profile_link_archive, or replay a backup.

-- Scratch tables are dropped last, after every CHECK has read them.
drop table if exists hr_branch_created;
drop table if exists hr_branch_resolved;
drop table if exists hr_branch_alias;

-- Everything above ran inside the editor's own transaction, so the changes are
-- already durable. If you are running this from psql instead, wrap the file in
-- begin; ... commit; yourself.