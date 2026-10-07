-- ============================================================================
-- BankOne publish rollup + executive snapshot sync
-- ============================================================================
-- Run in Supabase SQL Editor AFTER
-- 20261101000009_supervisory_directory.sql. Idempotent/additive, wrapped in
-- begin/commit. Frontend consumers shipped earlier (Performance department
-- scorecards, Director financial cards, snapshot refresh bus) degrade to
-- empty until this file is applied.
--
-- WHY
--   Publishing a BankOne import only ever wrote portfolio/branch/officer
--   totals. Nothing produced DEPARTMENT-level rows, and the executive
--   snapshot read the (empty) live loans/repayments ledger, so the Director
--   financial cards showed zero after a successful import.
--
-- WHAT THIS FILE DOES
--   1. Adds loan_count / total_disbursed / total_repaid aggregate columns to
--      bankone_portfolio_snapshots (existing rows stay null until backfill).
--   2. Creates bankone_department_snapshots (RLS: can_manage_bankone() OR
--      performance.read) -- the rows Performance.jsx reads via
--      listLatestDepartmentSnapshots().
--   3. Adds public.bankone_rollup_departments(uuid): rebuilds a snapshot's
--      department rows from its imported loan rows. PAR batches only -- PAR
--      is the portfolio of record; a disbursement batch has no honest
--      outstanding balance or status, so it must never emit PAR figures.
--      Officer-less loans land in 'Unattributed'; officer loans are grouped
--      by public.department_label(e.department) so names match the
--      employee-derived department rows on the Performance page.
--   4. Backfills every already-published snapshot (aggregates + rollup) and
--      audits the backfill once (idempotent: a second run finds nothing).
--   5. Re-issues bankone_publish_snapshot() byte-compatible with
--      20260931000002 (same signature, same can_manage_bankone() gate in the
--      first 1400 chars, same accounting/branch gates, same supersede logic,
--      same return keys incl. snapshot_id, same IMPORT_PUBLISHED audit, same
--      revoke-from-anon) PLUS the new aggregate columns and one
--      perform public.bankone_rollup_departments(v_snap_id).
--   6. Re-issues get_director_executive_snapshot(): the financial summary
--      keys (loans_disbursed / previous_loans_disbursed / loan_portfolio /
--      repayments / previous_repayments) and the 'loans' block now prefer
--      the latest published PAR snapshot (as-at <= window end, par-first,
--      newest first); window figures are scoped to that batch's
--      disbursementDate. With no snapshot published the legacy loans/
--      repayments expressions stay in force, so nothing regresses on an
--      un-migrated deployment. Everything else in the function (gates,
--      20::int expected_days, resolved_employee_id, to_jsonb(x) roles
--      aggregate, filters, staff/leave/trend payloads) is unchanged.
--
-- SEMANTICS (deliberate, documented)
--   * loan_portfolio    = point-in-time outstanding at the chosen snapshot.
--   * loans_disbursed   = principal booked inside [start, end] (disbursementDate).
--   * repayments        = principal recovered to date on loans booked inside
--                         [start, end] = sum(max(loan_amount - outstanding, 0)).
--                         A PAR report has no repayment dates; the live
--                         repayments ledger fallback is kept when no snapshot
--                         exists.
--   * par_ratio everywhere is PERCENT (npa*100/outstanding, 4dp) -- already
--     x100, never multiplied again by any consumer.
-- ============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. Portfolio-level aggregate columns.
--    Nullable: rows published before this file stay null until step 4.
-- ---------------------------------------------------------------------------
alter table public.bankone_portfolio_snapshots
  add column if not exists loan_count integer,
  add column if not exists total_disbursed numeric,
  add column if not exists total_repaid numeric;

-- ---------------------------------------------------------------------------
-- 2. Department snapshot rows (the Performance scorecard money columns).
-- ---------------------------------------------------------------------------
create table if not exists public.bankone_department_snapshots (
  id                       uuid primary key default gen_random_uuid(),
  snapshot_id              uuid not null references public.bankone_portfolio_snapshots(id) on delete cascade,
  department               text not null,
  loan_count               integer not null default 0,
  total_outstanding        numeric not null default 0,
  total_disbursed          numeric,
  total_repaid             numeric,
  non_performing_count     integer not null default 0,
  non_performing_outstanding numeric not null default 0,
  par_ratio                numeric,
  created_at               timestamptz not null default now()
);

create unique index if not exists uq_bankone_dept_snap
  on public.bankone_department_snapshots (snapshot_id, department);

alter table public.bankone_department_snapshots enable row level security;

-- Read model, never a browser write surface. can_manage_bankone() covers the
-- importers; performance.read covers viewers of the scorecard who are not
-- BankOne managers (the frontend degrades to [] when the query is denied).
drop policy if exists "bankone_department_snapshots_read" on public.bankone_department_snapshots;
create policy "bankone_department_snapshots_read" on public.bankone_department_snapshots
  for select to authenticated
  using (public.can_manage_bankone() or public.has_permission('performance.read'));

revoke insert, update, delete on public.bankone_department_snapshots from anon, authenticated;
revoke all on public.bankone_department_snapshots from anon;
grant select on public.bankone_department_snapshots to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Rollup helper: department rows for one snapshot.
-- ---------------------------------------------------------------------------
create or replace function public.bankone_rollup_departments(p_snapshot_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch   uuid;
  v_report  text;
begin
  -- auth.uid() is null when this runs from the SQL Editor (migration
  -- backfill), which must not be blocked; every real caller carries a JWT.
  if auth.uid() is not null and not public.can_manage_bankone() then
    raise exception 'You are not allowed to build BankOne department rollups.';
  end if;

  select batch_id, report_type
    into v_batch, v_report
    from public.bankone_portfolio_snapshots
   where id = p_snapshot_id;
  if v_batch is null then
    raise exception 'Snapshot not found.';
  end if;

  -- PAR only: a disbursement/transactions batch has no status and its
  -- total_outstanding degenerates to loan_amount, which would surface a
  -- fake 0% PAR on the scorecard. Non-PAR snapshots get no rows (return 0).
  if v_report <> 'par' then
    return 0;
  end if;

  delete from public.bankone_department_snapshots where snapshot_id = p_snapshot_id;

  insert into public.bankone_department_snapshots
    (snapshot_id, department, loan_count, total_outstanding,
     total_disbursed, total_repaid,
     non_performing_count, non_performing_outstanding, par_ratio)
  select p_snapshot_id,
         case when r.officer_employee_id is null then 'Unattributed'
              else public.department_label(e.department) end,
         count(*)::int,
         coalesce(sum(coalesce((r.normalized_data->>'total_outstanding')::numeric, 0)), 0),
         case when count(r.normalized_data->>'loan_amount') > 0
              then sum(coalesce((r.normalized_data->>'loan_amount')::numeric, 0)) end,
         case when count(r.normalized_data->>'loan_amount') > 0
              then sum(greatest(coalesce((r.normalized_data->>'loan_amount')::numeric, 0)
                                - coalesce((r.normalized_data->>'total_outstanding')::numeric, 0), 0)) end,
         count(*) filter (where upper(btrim(coalesce(r.normalized_data->>'status','')))
                            in ('PASS AND WATCH','SUB STANDARD','DOUBTFUL','LOST'))::int,
         coalesce(sum(coalesce((r.normalized_data->>'total_outstanding')::numeric, 0))
           filter (where upper(btrim(coalesce(r.normalized_data->>'status','')))
                     in ('PASS AND WATCH','SUB STANDARD','DOUBTFUL','LOST')), 0),
         null
    from public.bankone_import_rows r
    left join public.employees e on e.id = r.officer_employee_id
   where r.batch_id = v_batch
   group by 2;

  update public.bankone_department_snapshots s
     set par_ratio = case when s.total_outstanding > 0
                          then round(s.non_performing_outstanding * 100 / s.total_outstanding, 4)
                          else null end
   where s.snapshot_id = p_snapshot_id;

  return (select count(*)::int
            from public.bankone_department_snapshots
           where snapshot_id = p_snapshot_id);
end;
$$;

revoke all on function public.bankone_rollup_departments(uuid) from public;
revoke all on function public.bankone_rollup_departments(uuid) from anon;
grant execute on function public.bankone_rollup_departments(uuid) to authenticated;

comment on function public.bankone_rollup_departments(uuid) is
  'Rebuilds bankone_department_snapshots for one published snapshot from its imported loan rows. PAR batches only; called by bankone_publish_snapshot and by the backfill in this migration.';

-- ---------------------------------------------------------------------------
-- 4. Backfill: already-published snapshots get aggregates + department rows.
--    The rollup step only touches PAR snapshots, so re-running this file
--    finds nothing to do and writes no second audit row.
-- ---------------------------------------------------------------------------
update public.bankone_portfolio_snapshots s
   set loan_count = x.cnt,
       total_disbursed = x.disb,
       total_repaid = x.repaid
  from (
    select r.batch_id,
           count(*)::int as cnt,
           case when count(r.normalized_data->>'loan_amount') > 0
                then sum(coalesce((r.normalized_data->>'loan_amount')::numeric, 0)) end as disb,
           case when count(r.normalized_data->>'loan_amount') > 0
                then sum(greatest(coalesce((r.normalized_data->>'loan_amount')::numeric, 0)
                                  - coalesce((r.normalized_data->>'total_outstanding')::numeric, 0), 0)) end as repaid
      from public.bankone_import_rows r
     group by r.batch_id
  ) x
 where s.batch_id = x.batch_id
   and s.status = 'published';

do $$
declare v_n integer := 0;
begin
  select count(*)
    into v_n
    from public.bankone_portfolio_snapshots s
   where s.status = 'published'
     and s.report_type = 'par'
     and not exists (select 1
                       from public.bankone_department_snapshots d
                      where d.snapshot_id = s.id);

  if v_n > 0 then
    perform public.bankone_rollup_departments(s.id)
      from public.bankone_portfolio_snapshots s
     where s.status = 'published'
       and s.report_type = 'par'
       and not exists (select 1
                         from public.bankone_department_snapshots d
                        where d.snapshot_id = s.id);

    perform public.bankone_audit('DEPARTMENT_ROLLUP_BACKFILLED',
      'bankone_portfolio_snapshot', null,
      jsonb_build_object('snapshots', v_n));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. bankone_publish_snapshot(): re-issue of 20260931000002 with the
--    aggregates + rollup call. All gates, checks, supersede logic, audit and
--    return keys are unchanged (tests/bankoneImportParity.test.mjs pins the
--    contract against the original file; this body stays compatible with it).
-- ---------------------------------------------------------------------------
create or replace function public.bankone_publish_snapshot(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  b             public.bankone_import_batches;
  v_total       integer;
  v_parsed      integer;
  v_invalid     integer;
  v_branch_pend integer;
  v_officer_pend integer;
  v_snap_id     uuid;
  v_npa         numeric;
  v_outstanding numeric;
  v_loan_count   integer;
  v_disbursed    numeric;
  v_repaid       numeric;
begin
  if not public.can_manage_bankone() then
    raise exception 'You are not allowed to publish a BankOne import.';
  end if;
  select * into b from public.bankone_import_batches where id = p_batch_id;
  if b.id is null then raise exception 'Import batch not found.'; end if;
  if b.as_at_date is null then raise exception 'This import has no as-at date.'; end if;

  select count(*) into v_parsed from public.bankone_import_rows where batch_id = p_batch_id;
  v_total   := coalesce(b.total_rows, 0);
  v_invalid := coalesce(b.rejected_rows, 0);

  -- THE ACCOUNTING GATE: no source row may vanish.
  if v_total <> v_parsed + v_invalid then
    update public.bankone_import_batches
       set publication_status = 'blocked',
           error_message = format('Row accounting does not reconcile: %s source rows, %s parsed + %s invalid.',
                                  v_total, v_parsed, v_invalid),
           updated_at = now()
     where id = p_batch_id;
    raise exception 'Row accounting does not reconcile: %s source rows but %s parsed + %s invalid. Nothing was published and no records were lost - resolve and retry.',
      v_total, v_parsed, v_invalid;
  end if;

  -- Branch identity is REQUIRED for branch-level performance.
  select count(*) into v_branch_pend
    from public.bankone_import_rows
   where batch_id = p_batch_id and resolved_branch_id is null;
  if v_branch_pend > 0 then
    -- Deliberately NO status write here. A RAISE aborts the whole transaction,
    -- so an UPDATE immediately before it would roll straight back and the batch
    -- would look untouched to the user. bankone_validate_publish() returns this
    -- same verdict, and the caller persists it, so "blocked" survives the error.
    raise exception '%s loan(s) still have no branch identity. Map every BankOne branch before publishing. Nothing was lost - the import is still resumable.', v_branch_pend;
  end if;

  -- Officer decisions may remain open; they simply stay unattributed.
  select count(*) into v_officer_pend
    from public.bankone_officer_resolutions
   where batch_id = p_batch_id and decision = 'pending';

  -- NPA and totals come from the ACTUAL imported data, never a hardcoded figure.
  select coalesce(sum(coalesce((normalized_data->>'total_outstanding')::numeric,0)),0),
         coalesce(sum(coalesce((normalized_data->>'total_outstanding')::numeric,0))
           filter (where upper(btrim(coalesce(normalized_data->>'status','')))
                     in ('PASS AND WATCH','SUB STANDARD','DOUBTFUL','LOST')),0)
    into v_outstanding, v_npa
    from public.bankone_import_rows
   where batch_id = p_batch_id;

  -- Portfolio economics for the rollup consumers (Performance department
  -- scorecards, executive cards): principal originally booked, principal
  -- still outstanding, and principal recovered to date. Recovery is the
  -- honest approximation max(loan_amount - total_outstanding, 0) -- there is
  -- no repayment ledger inside a PAR report.
  select count(*),
         case when count(normalized_data->>'loan_amount') > 0
              then sum(coalesce((normalized_data->>'loan_amount')::numeric, 0)) end,
         case when count(normalized_data->>'loan_amount') > 0
              then sum(greatest(coalesce((normalized_data->>'loan_amount')::numeric, 0)
                                - coalesce((normalized_data->>'total_outstanding')::numeric, 0), 0)) end
    into v_loan_count, v_disbursed, v_repaid
    from public.bankone_import_rows
   where batch_id = p_batch_id;

  update public.bankone_import_batches
     set publication_status = 'publishing', updated_at = now()
   where id = p_batch_id;

  -- A re-import of the same report/date supersedes rather than double-counts.
  update public.bankone_portfolio_snapshots
     set status = 'superseded'
   where report_type = b.operation_type
     and as_at_date = b.as_at_date
     and status = 'published';

  insert into public.bankone_portfolio_snapshots
    (batch_id, as_at_date, report_type, source_filename, published_by,
     total_source_rows, parsed_rows, invalid_rows,
     auto_resolved_rows, manually_resolved_rows, unresolved_officer_rows,
     resolved_branch_rows, unresolved_branch_rows,
     total_outstanding, non_performing_outstanding, par_ratio,
     loan_count, total_disbursed, total_repaid, status)
  values
    (p_batch_id, b.as_at_date, b.operation_type, b.filename, auth.uid(),
     v_total, v_parsed, v_invalid,
     (select count(*) from public.bankone_import_rows
       where batch_id = p_batch_id and match_status = 'auto_resolved'),
     (select count(*) from public.bankone_import_rows
       where batch_id = p_batch_id and match_status = 'auto_resolved'
         and officer_employee_id is not null),
     (select count(*) from public.bankone_import_rows
       where batch_id = p_batch_id and officer_employee_id is null),
     (select count(*) from public.bankone_import_rows
       where batch_id = p_batch_id and resolved_branch_id is not null),
     v_branch_pend, v_outstanding, v_npa,
     case when v_outstanding > 0 then round(v_npa * 100 / v_outstanding, 4) else null end,
     v_loan_count, v_disbursed, v_repaid,
     'published')
  returning id into v_snap_id;

  -- BRANCH level: every branch-resolved loan, attributed or not.
  insert into public.bankone_branch_snapshots
    (snapshot_id, branch_id, raw_branch_name, area_id, loan_count,
     total_outstanding, principal_outstanding, non_performing_count,
     non_performing_outstanding, ecl_stage_1_outstanding,
     ecl_stage_2_outstanding, ecl_stage_3_outstanding, par_ratio,
     unattributed_outstanding, unattributed_loan_count)
  select v_snap_id, r.resolved_branch_id,
         min(r.branch_name_raw),
         (select baa.area_id from public.branch_area_assignments baa
           where baa.branch_id = r.resolved_branch_id and baa.is_current limit 1),
         count(*),
         -- COALESCE is required: sum(...) FILTER returns NULL (not 0) when no
         -- row matches, which would violate the NOT NULL on the snapshot column.
         -- The test dataset intentionally has no stage-2 loans.
         coalesce(sum(coalesce((r.normalized_data->>'total_outstanding')::numeric,0)),0),
         coalesce(sum(coalesce((r.normalized_data->>'principal_bal')::numeric,0)),0),
         count(*) filter (where upper(btrim(coalesce(r.normalized_data->>'status','')))
                            in ('PASS AND WATCH','SUB STANDARD','DOUBTFUL','LOST')),
         coalesce(sum(coalesce((r.normalized_data->>'total_outstanding')::numeric,0))
           filter (where upper(btrim(coalesce(r.normalized_data->>'status','')))
                     in ('PASS AND WATCH','SUB STANDARD','DOUBTFUL','LOST')),0),
         coalesce(sum(coalesce((r.normalized_data->>'total_outstanding')::numeric,0))
           filter (where btrim(coalesce(r.normalized_data->>'ecl_stage','')) = '1'),0),
         coalesce(sum(coalesce((r.normalized_data->>'total_outstanding')::numeric,0))
           filter (where btrim(coalesce(r.normalized_data->>'ecl_stage','')) = '2'),0),
         coalesce(sum(coalesce((r.normalized_data->>'total_outstanding')::numeric,0))
           filter (where btrim(coalesce(r.normalized_data->>'ecl_stage','')) = '3'),0),
         null,
         coalesce(sum(coalesce((r.normalized_data->>'total_outstanding')::numeric,0))
           filter (where r.officer_employee_id is null),0),
         count(*) filter (where r.officer_employee_id is null)
    from public.bankone_import_rows r
   where r.batch_id = p_batch_id
   group by r.resolved_branch_id;

  -- PAR per branch, from that branch's OWN imported numbers.
  update public.bankone_branch_snapshots s
     set par_ratio = case when s.total_outstanding > 0
                          then round(s.non_performing_outstanding * 100 / s.total_outstanding, 4)
                          else null end
   where s.snapshot_id = v_snap_id;

  -- OFFICER level: verified employees ONLY. An unresolved officer gets NO row,
  -- so unattributed portfolio can never inflate an individual's performance.
  insert into public.bankone_officer_snapshots
    (snapshot_id, employee_id, branch_id, raw_officer_names, loan_count,
     total_outstanding, non_performing_count, non_performing_outstanding, par_ratio)
  -- max(uuid) does not exist, so the officer's branch is taken with a scalar
  -- subquery (an officer may appear under several BankOne branch labels).
  select v_snap_id, r.officer_employee_id,
         (select r2.resolved_branch_id
            from public.bankone_import_rows r2
           where r2.batch_id = p_batch_id
             and r2.officer_employee_id = r.officer_employee_id
             and r2.resolved_branch_id is not null
           limit 1),
         array_agg(distinct r.officer_name_raw),
         count(*),
         coalesce(sum(coalesce((r.normalized_data->>'total_outstanding')::numeric,0)),0),
         count(*) filter (where upper(btrim(coalesce(r.normalized_data->>'status','')))
                            in ('PASS AND WATCH','SUB STANDARD','DOUBTFUL','LOST')),
         coalesce(sum(coalesce((r.normalized_data->>'total_outstanding')::numeric,0))
           filter (where upper(btrim(coalesce(r.normalized_data->>'status','')))
                     in ('PASS AND WATCH','SUB STANDARD','DOUBTFUL','LOST')),0),
         null
    from public.bankone_import_rows r
   where r.batch_id = p_batch_id
     and r.officer_employee_id is not null
   group by r.officer_employee_id;

  update public.bankone_officer_snapshots s
     set par_ratio = case when s.total_outstanding > 0
                          then round(s.non_performing_outstanding * 100 / s.total_outstanding, 4)
                          else null end
   where s.snapshot_id = v_snap_id;

  -- Department rollup: the rows the Performance scorecards read. The helper
  -- itself only builds them for PAR batches (the portfolio of record).
  perform public.bankone_rollup_departments(v_snap_id);

  update public.bankone_import_batches
     set status = 'completed',
         parsing_status = 'published',
         resolution_status = case when v_officer_pend > 0
                                  then 'partially_resolved' else 'resolved' end,
         publication_status = 'published',
         published_at = now(),
         auto_matched_rows = (select count(*) from public.bankone_import_rows
                               where batch_id = p_batch_id and match_status = 'auto_resolved'),
         needs_review_rows = v_officer_pend,
         unmatched_rows = (select count(*) from public.bankone_import_rows
                            where batch_id = p_batch_id and officer_employee_id is null),
         branch_issue_rows = v_branch_pend,
         error_message = null,
         last_progress_at = now(),
         updated_at = now()
   where id = p_batch_id;

  perform public.bankone_audit('IMPORT_PUBLISHED', 'bankone_portfolio_snapshot', v_snap_id::text,
    jsonb_build_object('batch_id', p_batch_id, 'as_at_date', b.as_at_date,
                       'total_source_rows', v_total, 'parsed', v_parsed,
                       'invalid', v_invalid, 'officer_pending', v_officer_pend));

  return jsonb_build_object(
    'ok', true, 'snapshot_id', v_snap_id,
    'total_source_rows', v_total, 'parsed_rows', v_parsed, 'invalid_rows', v_invalid,
    'officer_decisions_pending', v_officer_pend,
    'unresolved_branch_rows', v_branch_pend);
end;
$$;;

revoke all on function public.bankone_publish_snapshot(uuid) from public;
revoke all on function public.bankone_publish_snapshot(uuid) from anon;
grant execute on function public.bankone_publish_snapshot(uuid) to authenticated;

comment on function public.bankone_publish_snapshot(uuid) is
  'Publishes a BankOne import into the branch/officer/department snapshot tables. Refuses unless total_source_rows = parsed_rows + invalid_rows and every loan has a branch identity. Unresolved officers are allowed and stay unattributed; they are excluded from officer-level performance by construction and grouped under Unattributed at department level.';

-- ---------------------------------------------------------------------------
-- 6. get_director_executive_snapshot(): re-issue of 20260931000008 with the
--    snapshot-sourced financial keys (see banner). Gates, CTE structure,
--    20::int expected_days, resolved_employee_id leave handling, the
--    to_jsonb(x) roles aggregate and every non-financial payload key are
--    carried over unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.get_director_executive_snapshot(
  p_start_date date default null, p_end_date date default null,
  p_department text default null, p_branch_id uuid default null,
  p_area text default null, p_role text default null,
  p_designation_id uuid default null, p_employee_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_end date := coalesce(p_end_date, current_date);
  v_start date := coalesce(p_start_date, date_trunc('month', current_date)::date);
  v_previous_end date := v_start - 1;
  v_previous_start date := v_start - (v_end - v_start + 1);
  v_result jsonb;
  v_snap_id uuid;
  v_snap_batch uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if public.current_role() not in ('md_ceo','chairman','director','super_admin')
     or not public.has_permission('director.executive.read') then
    raise exception 'insufficient_permissions: director.executive.read';
  end if;
  if v_end < v_start or v_end > current_date or v_start < current_date - interval '2 years' then
    raise exception 'Invalid executive reporting period';
  end if;

  -- FINANCIAL SOURCE: the latest published BankOne PAR snapshot whose as-at
  -- date sits at or before the window end. PAR is preferred over every other
  -- report type because only it carries an honest outstanding balance and
  -- loan status; period figures come from that batch's loan rows (scoped by
  -- disbursementDate). When no snapshot has ever been published the legacy
  -- live loans/repayments expressions below remain in force unchanged.
  select s.id, s.batch_id
    into v_snap_id, v_snap_batch
    from public.bankone_portfolio_snapshots s
   where s.status = 'published'
     and s.as_at_date <= v_end
   order by (s.report_type <> 'par'), s.as_at_date desc, s.published_at desc
   limit 1;

  with booked as (
    -- Loans booked inside a date window, taken from the chosen snapshot's
    -- batch. disbursementDate is only converted when it is a clean ISO date,
    -- so one stray source value can never abort the whole executive snapshot.
    select case when r.normalized_data->>'disbursementDate' ~ '^\d{4}-\d{2}-\d{2}$'
                 then (r.normalized_data->>'disbursementDate')::date end as booked_on,
           coalesce((r.normalized_data->>'loan_amount')::numeric, 0) as loan_amount,
           coalesce((r.normalized_data->>'total_outstanding')::numeric, 0) as outstanding
      from public.bankone_import_rows r
     where v_snap_batch is not null
       and r.batch_id = v_snap_batch
  ), scoped as (
    select e.*, b.branch_name, d.title as designation_title,
      coalesce(nullif(e.area,''),(select coalesce(a.area_name,a.area_code) from public.branch_area_assignments baa
        join public.areas a on a.id=baa.area_id where baa.branch_id=e.branch_id and baa.is_current limit 1)) area_name,
      coalesce(p.role,'staff') platform_role,
      public.department_label(e.department) department_label,
      (select doc.file_path from public.documents doc where doc.entity_type='employee' and doc.entity_id=e.id
        and lower(coalesce(doc.document_type,''))='profile_picture' order by doc.created_at desc limit 1) profile_picture_path
    from public.employees e
    left join public.profiles p on p.id=e.user_id
    left join public.branches b on b.id=e.branch_id
    left join public.designations d on d.id=e.designation_id
    where (p_department is null or lower(coalesce(e.department,''))=lower(p_department))
      and (p_branch_id is null or e.branch_id=p_branch_id)
      and (p_area is null or lower(coalesce(e.area,''))=lower(p_area)
        or exists (select 1 from public.branch_area_assignments baa join public.areas a on a.id=baa.area_id
          where baa.branch_id=e.branch_id and baa.is_current and lower(coalesce(a.area_name,a.area_code))=lower(p_area)))
      and (p_role is null or coalesce(p.role,'staff')=p_role)
      and (p_designation_id is null or e.designation_id=p_designation_id)
      and (p_employee_id is null or e.id=p_employee_id)
  ), ids as (select id from scoped), range_days as (
    select series_date::date as attendance_date
    from generate_series(v_start::timestamp, v_end::timestamp, interval '1 day') as dates(series_date)
    where extract(isodow from series_date::date) < 6
  ), attendance as (
    select * from public.attendance_records where employee_id in (select id from ids) and attendance_date between v_start and v_end
  ), previous_attendance as (
    select * from public.attendance_records where employee_id in (select id from ids) and attendance_date between v_previous_start and v_previous_end
  ), kpis as (
    select * from public.employee_kpis where employee_id in (select id from ids) and coalesce(updated_at,created_at)::date between v_start and v_end
  ), previous_kpis as (
    select * from public.employee_kpis where employee_id in (select id from ids) and coalesce(updated_at,created_at)::date between v_previous_start and v_previous_end
  ), targets as (
    select * from public.targets where employee_id in (select id from ids) and coalesce(start_date,created_at::date)<=v_end
      and coalesce(end_date,'infinity'::date)>=v_start and status not in ('cancelled','missed')
  ), leave_rows as (
    select lr.*, coalesce(lr.employee_id, e.id) as resolved_employee_id
      from public.leave_requests lr
      left join public.employees e on e.user_id = lr.created_by
     where coalesce(lr.employee_id, e.id) in (select id from ids)
  ), staff as (
    select s.*,
      (select count(*) from attendance a where a.employee_id=s.id and a.clock_in is not null)::int attendance_present,
      (select count(*) from previous_attendance a where a.employee_id=s.id and a.clock_in is not null)::int previous_attendance_present,
      20::int expected_days,
      (select count(*) from kpis k where k.employee_id=s.id)::int kpi_count,
      (select count(*) from kpis k where k.employee_id=s.id and k.status in ('completed','acknowledged'))::int kpi_completed,
      (select count(*) from targets t where t.employee_id=s.id)::int target_count,
      (select count(*) from targets t where t.employee_id=s.id and t.status='achieved')::int target_achieved,
      (select count(*) from leave_rows l where l.resolved_employee_id=s.id and l.status='approved' and l.start_date<=v_end and l.end_date>=v_start)::int leave_count
    from scoped s
  ), overall as (
    select count(*)::int total_staff, count(*) filter(where employment_status='active')::int active_staff,
      count(*) filter(where employment_status='on_leave' or leave_count>0)::int on_leave,
      coalesce(round(100.0*sum(attendance_present)/nullif(sum(expected_days),0)),0) attendance_rate,
      coalesce(round(100.0*sum(previous_attendance_present)/nullif(sum(expected_days),0)),0) previous_attendance_rate,
      coalesce(round(100.0*sum(kpi_completed)/nullif(sum(kpi_count),0)),0) kpi_completion,
      coalesce(round(100.0*sum(target_achieved)/nullif(sum(target_count),0)),0) target_completion from staff
  ), perf as (
    select coalesce(round(avg(least(200,100.0*actual_value/nullif(target_value,0))),1),0) achievement_pct from kpis where target_value<>0
  ), previous_perf as (
    select coalesce(round(avg(least(200,100.0*actual_value/nullif(target_value,0))),1),0) achievement_pct from previous_kpis where target_value<>0
  ), target_perf as (
    select coalesce(round(100.0*sum(current_value)/nullif(sum(target_value),0),1),0) achievement_pct from targets where target_value<>0
  )
  select jsonb_build_object(
    'generated_at',now(),'range',jsonb_build_object('start',v_start,'end',v_end,'previous_start',v_previous_start,'previous_end',v_previous_end),
    'summary',(select to_jsonb(o) from overall o) || jsonb_build_object(
      'absent',(select coalesce(sum(expected_days-attendance_present),0)::int from staff where employment_status='active' and leave_count=0),
      'kpi_achievement',(select achievement_pct from perf),'previous_kpi_achievement',(select achievement_pct from previous_perf),
      'target_achievement',(select achievement_pct from target_perf),
      'loans_disbursed',case when v_snap_id is null
        then (select coalesce(sum(principal_amount),0) from public.loans where coalesce(disbursed_date,created_at::date) between v_start and v_end)
        else (select coalesce(sum(loan_amount),0) from booked where booked_on between v_start and v_end) end,
      'previous_loans_disbursed',case when v_snap_id is null
        then (select coalesce(sum(principal_amount),0) from public.loans where coalesce(disbursed_date,created_at::date) between v_previous_start and v_previous_end)
        else (select coalesce(sum(loan_amount),0) from booked where booked_on between v_previous_start and v_previous_end) end,
      'loan_portfolio',case when v_snap_id is null
        then (select coalesce(sum(outstanding_balance),0) from public.loans where status in ('active','disbursed','performing'))
        else (select total_outstanding from public.bankone_portfolio_snapshots where id = v_snap_id) end,
      -- Period "repayments" = principal recovered on loans BOOKED inside the
      -- window (max(loan_amount - outstanding, 0)); a PAR report carries no
      -- repayment dates, and the empty live ledger would otherwise show zero.
      'repayments',case when v_snap_id is null
        then (select coalesce(sum(amount),0) from public.repayments where payment_date between v_start and v_end)
        else (select coalesce(sum(greatest(loan_amount - outstanding,0)),0) from booked where booked_on between v_start and v_end) end,
      'previous_repayments',case when v_snap_id is null
        then (select coalesce(sum(amount),0) from public.repayments where payment_date between v_previous_start and v_previous_end)
        else (select coalesce(sum(greatest(loan_amount - outstanding,0)),0) from booked where booked_on between v_previous_start and v_previous_end) end,
      'active_recruitment',(select count(*) from public.hr_candidates where application_status not in ('hired','rejected','withdrawn')),
      'open_onboarding',(select count(*) from public.employee_onboarding_submissions where onboarding_status in ('submitted','under_review','pending_guarantor','guarantor_submitted','correction_requested')),
      'pending_leave',(select count(*) from leave_rows where status='pending'),
      'upcoming_resumptions',(select count(*) from leave_rows where status='approved' and end_date between v_end and v_end+14)
    ),
    'filters',jsonb_build_object(
      'departments',(select coalesce(jsonb_agg(jsonb_build_object('id',x.name,'name',x.name) order by x.name),'[]') from (select distinct public.department_label(e.department) name from public.employees e) x where x.name <> 'Unassigned'),
      'branches',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',branch_name) order by branch_name),'[]') from public.branches where coalesce(status,'active')='active'),
      'areas',(select coalesce(jsonb_agg(jsonb_build_object('id',area_code,'name',coalesce(area_name,area_code)) order by area_code),'[]') from public.areas where is_active),
      'roles',(select coalesce(jsonb_agg(jsonb_build_object('id',role,'name',role) order by role),'[]') from (select distinct role from public.profiles) x),
      'designations',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',title,'department',department) order by title,department),'[]') from public.designations where is_active),
      'employees',(select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'name',e.full_name,'department',public.department_label(e.department),'branch',b.branch_name) order by e.full_name),'[]') from public.employees e left join public.branches b on b.id=e.branch_id)
    ),
    'departments',(select coalesce(jsonb_agg(x order by (x->>'total_staff')::int desc),'[]') from (
      select jsonb_build_object('id',department_label,'name',department_label,'total_staff',count(*),'active_staff',count(*) filter(where employment_status='active'),'attendance_rate',coalesce(round(100.0*sum(attendance_present)/nullif(sum(expected_days),0)),0),'kpi_completion',coalesce(round(100.0*sum(kpi_completed)/nullif(sum(kpi_count),0)),0),'target_completion',coalesce(round(100.0*sum(target_achieved)/nullif(sum(target_count),0)),0),'on_leave',count(*) filter(where leave_count>0),'completion_rate',coalesce(round((sum(attendance_present)+sum(kpi_completed)+sum(target_achieved))*100.0/nullif(sum(expected_days)+sum(kpi_count)+sum(target_count),0)),0)) x
      from staff group by department_label) x),
    'branches',(select coalesce(jsonb_agg(x order by (x->>'total_staff')::int desc),'[]') from (
      select jsonb_build_object('id',coalesce(branch_name,'Unassigned'),'name',coalesce(branch_name,'Unassigned'),'total_staff',count(*),'active_staff',count(*) filter(where employment_status='active'),'attendance_rate',coalesce(round(100.0*sum(attendance_present)/nullif(sum(expected_days),0)),0),'kpi_completion',coalesce(round(100.0*sum(kpi_completed)/nullif(sum(kpi_count),0)),0),'target_completion',coalesce(round(100.0*sum(target_achieved)/nullif(sum(target_count),0)),0),'on_leave',count(*) filter(where leave_count>0)) x
      from staff group by coalesce(branch_name,'Unassigned')) x),
    'areas',(select coalesce(jsonb_agg(x order by (x->>'total_staff')::int desc),'[]') from (
      select jsonb_build_object('id',coalesce(area_name,'Unassigned'),'name',coalesce(area_name,'Unassigned'),'total_staff',count(*),'active_staff',count(*) filter(where employment_status='active'),'attendance_rate',coalesce(round(100.0*sum(attendance_present)/nullif(sum(expected_days),0)),0),'kpi_completion',coalesce(round(100.0*sum(kpi_completed)/nullif(sum(kpi_count),0)),0),'target_completion',coalesce(round(100.0*sum(target_achieved)/nullif(sum(target_count),0)),0),'on_leave',count(*) filter(where leave_count>0)) x
      from staff group by coalesce(area_name,'Unassigned')) x),
    'staff',(select coalesce(jsonb_agg(to_jsonb(x) order by full_name),'[]') from (select id,user_id,full_name,profile_picture_path,platform_role,department_label as department,branch_name,area_name,"position",designation_title,hire_date,employment_status,leave_count,attendance_present,expected_days,case when expected_days>0 then round(100.0*attendance_present/expected_days) end attendance_rate,kpi_completed,kpi_count,target_achieved,target_count from staff) x),
    'leave',(select coalesce(jsonb_agg(to_jsonb(x) order by end_date),'[]') from (
      -- Join on resolved_employee_id, NOT the raw employee_id column. A legacy
      -- request whose employee_id could not be backfilled is null there but is
      -- still resolvable via created_by, and joining on the raw column would
      -- silently drop it from the director's leave list.
      select l.id,l.resolved_employee_id as employee_id,e.full_name,public.department_label(e.department) as department,e."position",l.leave_type,l.start_date,l.end_date,l.status,greatest(0,l.end_date-current_date) days_remaining
      from leave_rows l join public.employees e on e.id=l.resolved_employee_id
      where l.status='approved' and l.start_date<=v_end and l.end_date>=v_start
      union all
      select l.id,l.resolved_employee_id as employee_id,e.full_name,public.department_label(e.department) as department,e."position",l.leave_type,l.start_date,l.end_date,l.status,0
      from leave_rows l join public.employees e on e.id=l.resolved_employee_id where l.status in ('pending','rejected') order by 1) x),
    'roles',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)->>'name'),'[]') from (
      select coalesce(nullif(btrim(designation_title),''),nullif(btrim("position"),''),'Unassigned') name,
        count(*) staff,coalesce(round(100.0*sum(attendance_present)/nullif(sum(expected_days),0)),0) attendance_rate,
        coalesce(round(100.0*sum(kpi_completed)/nullif(sum(kpi_count),0)),0) kpi_completion,
        coalesce(round(100.0*sum(target_achieved)/nullif(sum(target_count),0)),0) target_completion
      from staff group by 1) x),
    'trend',(select coalesce(jsonb_agg(to_jsonb(x) order by attendance_date),'[]') from (
      select d.attendance_date,coalesce(round(100.0*count(a.id) filter(where a.clock_in is not null)/nullif(count(s.id),0)),0) attendance_rate
      from range_days d cross join staff s left join attendance a on a.employee_id=s.id and a.attendance_date=d.attendance_date group by d.attendance_date) x),
    'loans',jsonb_build_object('status',jsonb_build_object(
      'count',case when v_snap_id is null
        then (select count(*) from public.loans where coalesce(disbursed_date,created_at::date) between v_start and v_end)
        else (select count(*) from booked where booked_on between v_start and v_end) end,
      'principal',case when v_snap_id is null
        then (select coalesce(sum(principal_amount),0) from public.loans where coalesce(disbursed_date,created_at::date) between v_start and v_end)
        else (select coalesce(sum(loan_amount),0) from booked where booked_on between v_start and v_end) end,
      'outstanding',case when v_snap_id is null
        then (select coalesce(sum(outstanding_balance),0) from public.loans)
        else (select coalesce(sum(outstanding),0) from booked) end))
  ) into v_result;
  return v_result;
end;
$$;;

revoke all on function public.get_director_executive_snapshot(date,date,text,uuid,text,text,uuid,uuid) from public;
grant execute on function public.get_director_executive_snapshot(date,date,text,uuid,text,text,uuid,uuid) to authenticated;

commit;
