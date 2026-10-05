-- ============================================================================
-- READ-ONLY PRE-FLIGHT for the authoritative employee replace
-- ============================================================================
--
--   ##  SAFE TO RUN ANY TIME. THIS FILE WRITES NOTHING.  ##
--
-- Run this against PRODUCTION after step 2 (the three value files are loaded)
-- and BEFORE running the replace. It answers the only question that matters
-- before you commit: what exactly is about to change, and is the workbook
-- really loaded?
--
-- Every statement is a SELECT. There is no INSERT/UPDATE/DELETE/DDL anywhere
-- in this file, so it cannot damage anything.
--
-- WHAT TO LOOK AT
--   A. workbook_loaded  must be 209 / 218 / 208. If not, the value files did
--      not load and you must stop — running the replace now would archive
--      everyone.
--   B. unmatched_employees  are the rows that will be ARCHIVED. Read the list.
--      If it contains anyone you expect to still be employed, stop and
--      investigate before continuing.
--   C. Headcounts are environment-specific and are NOT expected to match
--      local dev. Local has 430 because it also holds 215 synthetic
--      `IMFB-KH-*` seed rows that do not exist in production.
-- ============================================================================

-- A. Is the authoritative workbook actually loaded?
select 'A. workbook_loaded' as check,
       (select count(*) from public.stg_hr_employee_source)   as source_209_expected,
       (select count(*) from public.stg_hr_employee_branch_source) as branches_218_expected,
       (select count(*) from public.stg_hr_employee_supervisor_source) as supervisors_208_expected;

-- B. What will be ARCHIVED (i.e. is in the database but not in the workbook)?
select 'B. will_be_archived' as check,
       e.staff_id, e.full_name, e.email, e.branch
  from public.employees e
  left join public.stg_hr_employee_source s on s.staff_id = e.staff_id
 where s.staff_id is null
 order by e.staff_id nulls last;

-- B2. Just the count, for a quick yes/no.
select 'B2. unmatched_employee_count' as check, count(*) as will_be_archived
  from public.employees e
  left join public.stg_hr_employee_source s on s.staff_id = e.staff_id
 where s.staff_id is null;

-- C. Environment context (no expectation attached to these numbers).
select 'C. environment' as check,
       (select count(*) from public.employees)                                          as employees_total,
       (select count(*) from public.employees where staff_id like 'IMFB-KH-%')          as synthetic_seed_rows,
       (select count(*) from public.employee_digital_files)                            as hr_documents,
       (select count(*) from public.employee_supervisors)                              as supervisor_links,
       (select count(*) from public.attendance_records)                                as attendance_rows,
       (select count(*) from public.profiles)                                           as profiles;

-- D. Would the workbook create anyone who does not exist yet?
select 'D. new_people_to_be_created' as check, s.staff_id, s.full_name
  from public.stg_hr_employee_source s
  left join public.employees e on e.staff_id = s.staff_id
 where e.id is null
 order by s.staff_id;

-- E. Branch labels with no matching `branches` row, split into the two cases
--    that mean completely different things.
--
--    The replace script (20261101000008) resolves workbook labels through a
--    fixed alias map before it looks in `branches`. That map lives in a
--    TEMPORARY table, so this read-only file cannot read it — the identical
--    map is inlined below as a CTE instead. If you ever change the aliases in
--    the replace script, change them here too or this check goes stale.
--
--    E1 (alias_resolved) — the label is merely a spelling variant. The replace
--        maps it onto an existing branch; NO new branch is created. Harmless.
--    E2 (genuinely_new_branch_label) — no alias and no existing branch row, so
--        the replace WILL create a new branch with branch_code left NULL.
--        Every row here is a decision to confirm with HR.
select 'E2. genuinely_new_branch_label' as check,
       x.branch_label,
       x.staff,
       'replace will CREATE this branch (branch_code stays NULL)' as what_will_happen
  from (
    select bs.branch_label, count(*) as staff
      from public.stg_hr_employee_branch_source bs
     where not exists (select 1 from public.branches b
                        where lower(b.branch_name) = lower(bs.branch_label))
       and not exists (select 1 from (values ('Ibeju Lekki Two (Ajah)'),
                                              ('Sabo Yaba'),
                                              ('Lagos Island ONE'),
                                              ('Ile Epo'),
                                              ('Lagos Island TWO SME'),
                                              ('Tradefair')
                                     ) as a(source_label)
                        where lower(a.source_label) = lower(bs.branch_label))
     group by bs.branch_label
  ) x
 order by x.staff desc;

-- E1. Labels handled by the alias map. Sanity check only: each of these must
--     resolve to a target_label that EXISTS in `branches`, otherwise the
--     replace will create a new branch under the target name and the
--     alias silently changes where staff are assigned.
select 'E1. alias_resolved' as check,
       a.source_label,
       a.target_label,
       (select count(*) from public.branches b
         where lower(b.branch_name) = lower(a.target_label)) > 0 as target_branch_exists
  from (values ('Ibeju Lekki Two (Ajah)', 'AJAH'),
               ('Sabo Yaba',             'SABO/YABA'),
               ('Lagos Island ONE',      'LAGOS ISLAND 1'),
               ('Ile Epo',               'ILE-EPO'),
               ('Lagos Island TWO SME',  'LAGOS ISLAND 2'),
               ('Tradefair',             'TRADE FAIR')
       ) as a(source_label, target_label)
 where exists (select 1 from public.stg_hr_employee_branch_source bs
                where lower(bs.branch_label) = lower(a.source_label))
 order by a.source_label;