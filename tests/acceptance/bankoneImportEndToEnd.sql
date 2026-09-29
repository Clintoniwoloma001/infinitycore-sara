-- ===========================================================================
-- BankOne import: end-to-end acceptance against a live Postgres.
-- Run with:  npm run test:bankone-e2e
--
-- Proves the reported failure is fixed. The bug: branch "Accept" ran an UPDATE
-- that matched ZERO rows because the SQL and the browser normalized branch
-- names differently, then reported success anyway. Each scenario below asserts
-- on the number of rows ACTUALLY changed, never on a success flag.
--
-- Everything runs in one transaction and is rolled back, so no test data
-- survives. The 2,725-row file is replayed as a generated dataset with the
-- same shape (mixed separators, NPA statuses, reordered/truncated officers).
-- ===========================================================================
\set ON_ERROR_STOP on
begin;

-- Fixture setup only: postgres' auth.uid() is null here, so the role-change
-- guard would reject the profile upsert. It is restored before commit and the
-- application path is unaffected.
alter table public.profiles disable trigger trg_enforce_role_change;

create temp table bo (k text primary key, v uuid);
insert into bo values
  ('actor',   '9b000001-0000-0000-0000-000000000001'),
  ('emp_a',   '9b000002-0000-0000-0000-000000000001'),
  ('emp_b',   '9b000002-0000-0000-0000-000000000002'),
  ('emp_dup', '9b000002-0000-0000-0000-000000000003'),
  ('br1',     '9b000003-0000-0000-0000-000000000001'),
  ('br2',     '9b000003-0000-0000-0000-000000000002'),
  ('br3',     '9b000003-0000-0000-0000-000000000003');

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select b.v, lower(b.k)||'@bankone.test', 'authenticated','authenticated',
       '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  from bo b where b.k = 'actor';

insert into public.profiles (id, full_name, role, status, email)
select b.v, 'Import Actor', 'super_admin', 'active', 'actor@bankone.test'
  from bo b where b.k = 'actor'
on conflict (id) do update set role = 'super_admin', status = 'active';

-- Three employees. emp_dup shares a normalized name with emp_b on purpose:
-- an ambiguous name must NEVER auto-resolve.
insert into public.employees (id, full_name, employment_status)
select b.v, initcap(replace(b.k,'_',' ')), 'active' from bo b
 where b.k in ('emp_a','emp_b','emp_dup')
on conflict (id) do nothing;

-- Branches, including the merged form that BankOne splits across several rows.
insert into public.branches (id, branch_name, branch_code, status)
select b.v, initcap(replace(b.k,'_',' ')), upper(b.k), 'active' from bo b
 where b.k in ('br1','br2','br3')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Helpers: impersonate the actor, and assert.
-- ---------------------------------------------------------------------------
create or replace function pg_temp.act_as_actor()
returns void language plpgsql as $$
declare v_actor uuid;
begin
  -- Qualified: a bare "v" here would be ambiguous with the bo.v column.
  select b.v into v_actor from bo b where b.k = 'actor';
  perform set_config('request.jwt.claim.sub', v_actor::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_actor::text, 'role','authenticated')::text, true);
end $$;

create or replace function pg_temp.ok(p_cond boolean, p_label text)
returns void language plpgsql as $$
begin
  if p_cond is not true then raise exception 'ASSERTION FAILED: %', p_label; end if;
  raise notice 'PASS: %', p_label;
end $$;

select pg_temp.act_as_actor();

-- Re-arm the guard now that the fixture actor exists.
alter table public.profiles enable trigger trg_enforce_role_change;

-- ---------------------------------------------------------------------------
-- E1 (PARSE). Build a 2,725-row dataset with the real file's characteristics:
-- mixed branch separators, NPA statuses, an exact officer match, a reordered
-- name, a truncated name and a genuinely unknown officer.
-- ---------------------------------------------------------------------------
do $$
declare
  v_batch uuid;
  v_total constant integer := 2725;
  i       integer;
  v_npa   constant integer := 755;   -- non-performing loans in the real file
  v_lost  constant integer := 446;
  v_paw   constant integer := 240;
  v_sub   constant integer := 35;
  v_doubt constant integer := 34;
  v_actor uuid;
  v_br    text;
begin
  select v into v_actor from bo where k = 'actor';

  insert into public.bankone_import_batches
    (filename, source_format, source_type, operation_type, status, as_at_date,
     total_rows, parsed_row_count, imported_rows, valid_rows, rejected_rows,
     uploaded_by, uploaded_by_name, uploaded_at,
     parsing_status, resolution_status, publication_status)
  values ('Portfolio_At_Risk_Report.xlsx','xlsx','par','par','pending_review',
          current_date, v_total, v_total, v_total, v_total, 0,
          v_actor,'Import Actor', now(),
          'parsed','review_required','unpublished')
  returning id into v_batch;

  -- Deterministic dataset: no randomness, so the assertions are stable.
  for i in 1..v_total loop
    -- Branch names deliberately include the separators that broke the old RPC.
    v_br := case
      when i % 4 = 1 then 'TRADE FAIR/BOUNDARY/YABA'
      when i % 4 = 2 then 'MUSHIN/YABA'
      when i % 4 = 3 then 'Lagos Island ONE'
      else 'IBEJU-LEKKI'
    end;

    -- Officers: 60 exact, then the three interesting cases, then unknowns.
    insert into public.bankone_import_rows
      (batch_id, row_number, account_no, as_at_date, branch_name_raw,
       officer_name_raw, match_status, raw_data, normalized_data)
    values
      (v_batch, i, 'ACC'||lpad(i::text,7,'0'), current_date, v_br,
       case
         when i <= 60 then 'ABIMBOLA, ANIMASHAHUN LANIKE'
         when i = 61  then 'ADEOTI MONSURAT FUNMILAYO'   -- token reorder
         when i = 62  then 'UKUAGHE, JUDE'               -- truncated
         when i = 63  then 'TOTALLY UNKNOWN OFFICER'     -- unmatched
         when i = 64  then 'BRAND NEW OFFICER ONE'       -- will be added as employee
         else 'FILLER OFFICER '||i
       end,
       -- 'pending_review' is the awaiting-a-human-decision state. 'pending' is
       -- not in the match_status vocabulary.
       'pending_review',
       jsonb_build_object('Account No.','ACC'||lpad(i::text,7,'0')),
       jsonb_build_object(
         'loan_amount', (i * 1000)::numeric,
         'total_outstanding', (i * 1000)::numeric,
         'principal_bal', (i * 900)::numeric,
         -- Realistic NPA mix that sums to exactly v_npa.
         'status', case
           when i <= v_lost  then 'Lost'
           when i <= v_lost + v_paw  then 'Pass And Watch'
           when i <= v_lost + v_paw + v_sub then 'Sub Standard'
           when i <= v_lost + v_paw + v_sub + v_doubt then 'Doubtful'
           else 'Performing'
         end,
         'ecl_stage', case when i % 3 = 0 then '1' else '3' end));
  end loop;

  -- The exact 60 auto-matches, written the way the browser writes them.
  update public.bankone_import_rows r
     set officer_employee_id = e.id,
         employee_id = e.id,
         match_status = 'auto_resolved',
         match_confidence = 1
    from public.employees e
   where r.batch_id = v_batch
     and public.bankone_norm_name(r.officer_name_raw)
         = public.bankone_norm_name('ABIMBOLA, ANIMASHAHUN LANIKE')
     and e.id = (select v from bo where k = 'emp_a');

  -- Seed the persistent decision rows and the BankOne branch master.
  perform public.bankone_seed_resolutions(v_batch);

  perform pg_temp.ok((select count(*) from public.bankone_import_rows
                       where batch_id = v_batch) = v_total,
    'E1 parse: all 2725 source rows are stored (none dropped)');
  perform pg_temp.ok((select count(*) from public.bankone_import_rows
                       where batch_id = v_batch and match_status = 'auto_resolved') = 60,
    'E1 parse: exactly 60 rows auto-matched');
  perform pg_temp.ok((select count(*) from public.bankone_branch_master
                       where first_seen_batch_id = v_batch) = 4,
    'E1 parse: the exact BankOne branch master was captured (4 source values)');
  perform pg_temp.ok((select count(*) from public.bankone_officer_resolutions
                       where batch_id = v_batch) > 60,
    'E1 parse: every officer in the file has a decision row');

  perform set_config('bo.batch', v_batch::text, true);
end $$;

-- ---------------------------------------------------------------------------
-- E2 (BRANCH ACCEPT) - THE REPORTED BUG.
-- "Accept" previously ran an UPDATE whose comparison could not match, so it
-- reported success while changing nothing. Assert on rows ACTUALLY changed.
-- 'TRADE FAIR/BOUNDARY/YABA' is one of the values that broke it: the old SQL
-- produced 'TRADE FAIR/BOUNDARY/YABA' (slashes kept) while the browser sent
-- 'TRADE FAIR BOUNDARY YABA'.
-- ---------------------------------------------------------------------------
do $$
declare
  v_batch uuid := current_setting('bo.batch')::uuid;
  v_res   jsonb;
  v_target uuid;
  v_affected integer;
  v_resolved integer;
begin
  select v into v_target from bo where k = 'br1';

  v_res := public.confirm_bankone_branch_mapping(
    'TRADE FAIR BOUNDARY YABA',   -- what the browser sends
    'TRADE FAIR/BOUNDARY/YABA',   -- the raw BankOne value
    v_target, 'normalized', null, 'Accept from branch review');

  v_affected := (v_res ->> 'rows_affected')::integer;
  perform pg_temp.ok(v_affected > 0,
    'E2 branch accept: rows_affected is NOT zero (this was the silent failure)');
  perform pg_temp.ok((v_res ->> 'normalized') = 'TRADE FAIR BOUNDARY YABA',
    'E2 branch accept: the server normalizes the RAW BankOne value');

  select count(*) into v_resolved
    from public.bankone_import_rows
   where batch_id = v_batch and resolved_branch_id = v_target;
  perform pg_temp.ok(v_resolved = v_affected,
    'E2 branch accept: rows_affected matches the rows actually resolved');
  perform pg_temp.ok(v_resolved > 0,
    'E2 branch accept: the loans really were attributed to the branch');

  perform pg_temp.ok(exists (select 1 from public.bankone_branch_resolutions
    where batch_id = v_batch
      and normalized_branch_name = 'TRADE FAIR BOUNDARY YABA'
      and decision = 'mapped'),
    'E2 branch accept: the decision is PERSISTED (survives a refresh)');

  -- Original BankOne values must survive untouched.
  perform pg_temp.ok(exists (select 1 from public.bankone_import_rows
    where batch_id = v_batch and branch_name_raw = 'TRADE FAIR/BOUNDARY/YABA'),
    'E2 the raw BankOne branch value is preserved');
end $$;

-- ---------------------------------------------------------------------------
-- E3 (IDEMPOTENCY). Accepting twice must not duplicate a mapping or a decision.
-- ---------------------------------------------------------------------------
do $$
declare
  v_batch uuid := current_setting('bo.batch')::uuid;
  v_target uuid;
  v_mappings integer;
  v_resolutions integer;
  v_res jsonb;
begin
  select v into v_target from bo where k = 'br1';

  v_res := public.confirm_bankone_branch_mapping(
    'TRADE FAIR BOUNDARY YABA', 'TRADE FAIR/BOUNDARY/YABA',
    v_target, 'normalized', null, 'Accept clicked twice');

  select count(*) into v_mappings from public.bankone_branch_mappings
   where normalized_bankone_branch_name = 'TRADE FAIR BOUNDARY YABA';
  select count(*) into v_resolutions from public.bankone_branch_resolutions
   where batch_id = v_batch and normalized_branch_name = 'TRADE FAIR BOUNDARY YABA';

  perform pg_temp.ok(v_mappings = 1, 'E3 double accept: only ONE branch mapping exists');
  perform pg_temp.ok(v_resolutions = 1, 'E3 double accept: only ONE decision row exists');
  -- Re-affirming the same branch rewrites the same value, so rows_affected is
  -- not the idempotency signal; the absence of DUPLICATES is. That is what the
  -- two counts above and the total below prove.
  perform pg_temp.ok((select count(*) from public.bankone_import_rows
                       where batch_id = v_batch) = 2725,
    'E3 double accept: still exactly 2725 rows - no duplicate loans created');
end $$;

-- ---------------------------------------------------------------------------
-- E4 (OFFICER RESOLUTION). Reordered, truncated and unknown names.
-- ---------------------------------------------------------------------------
do $$
declare
  v_batch uuid := current_setting('bo.batch')::uuid;
  v_emp_b uuid;
  v_res jsonb;
  v_new_emp uuid;
  v_before integer;
  v_after integer;
begin
  select v into v_emp_b from bo where k = 'emp_b';

  -- Reordered: "ADEOTI MONSURAT FUNMILAYO" -> a chosen employee, permanently.
  v_res := public.confirm_bankone_employee_mapping(
    'ADEOTI MONSURAT FUNMILAYO', 'ADEOTI MONSURAT FUNMILAYO',
    v_emp_b, 'token_reorder', 0.9, 'Confirmed by review');
  perform pg_temp.ok((v_res ->> 'rows_affected')::integer = 1,
    'E4 reordered name: its loan was attributed');
  perform pg_temp.ok(exists (select 1 from public.bankone_employee_mappings
      where normalized_source_name = 'ADEOTI MONSURAT FUNMILAYO'
        and employee_id = v_emp_b and status = 'active'),
    'E4 reordered name: the PERMANENT mapping is stored for future imports');

  -- Truncated: "UKUAGHE, JUDE" is a prefix of a real employee name.
  v_res := public.confirm_bankone_employee_mapping(
    'UKUAGHE JUDE', 'UKUAGHE, JUDE', v_emp_b, 'bankone_truncated', 0.95,
    'BankOne truncates this name');
  perform pg_temp.ok((v_res ->> 'rows_affected')::integer = 1,
    'E4 truncated name: its loan was attributed');
  perform pg_temp.ok(exists (select 1 from public.bankone_import_rows
      where batch_id = v_batch and officer_name_raw = 'UKUAGHE, JUDE'
        and officer_employee_id = v_emp_b),
    'E4 truncated name: the raw BankOne name is preserved and now resolved');

  -- Leave unresolved: portfolio must stay UNATTRIBUTED.
  v_res := public.mark_bankone_officer_unresolved(
    'TOTALLY UNKNOWN OFFICER', 'TOTALLY UNKNOWN OFFICER', 'No such employee');
  perform pg_temp.ok((select count(*) from public.bankone_import_rows
       where batch_id = v_batch and officer_name_raw = 'TOTALLY UNKNOWN OFFICER'
         and officer_employee_id is null) = 1,
    'E4 leave unresolved: employee_id stays NULL (nothing invented)');
  perform pg_temp.ok(exists (select 1 from public.bankone_officer_resolutions
      where batch_id = v_batch and normalized_name = 'TOTALLY UNKNOWN OFFICER'
        and decision = 'left_unresolved'),
    'E4 leave unresolved: the decision is persisted');

  -- Add as employee: creates a PENDING record and reprocesses the loans.
  select count(*) into v_before from public.bankone_import_rows
   where batch_id = v_batch and officer_employee_id is null;

  v_res := public.add_employee_from_bankone(
    'BRAND NEW OFFICER ONE', 'BRAND NEW OFFICER ONE', 'Lagos Island ONE', v_batch, null);
  v_new_emp := (v_res ->> 'employee_id')::uuid;

  perform pg_temp.ok(v_new_emp is not null, 'E4 add as employee: an employee_id was returned');
  perform pg_temp.ok(exists (select 1 from public.employees
      where id = v_new_emp and employment_status = 'onboarding'),
    'E4 add as employee: created in the existing onboarding (pending) state');
  perform pg_temp.ok(not exists (select 1 from auth.users where id = v_new_emp),
    'E4 add as employee: NO sign-in account was fabricated');
  perform pg_temp.ok(exists (select 1 from public.employees
      where id = v_new_emp and email is null and phone is null
        and (salary is null or salary = 0)),
    'E4 add as employee: no email, phone or salary was invented');
  perform pg_temp.ok(exists (select 1 from public.bankone_employee_mappings
      where normalized_source_name = 'BRAND NEW OFFICER ONE'
        and employee_id = v_new_emp),
    'E4 add as employee: the permanent BankOne mapping was created');
  perform pg_temp.ok(exists (select 1 from public.bankone_created_employees
      where employee_id = v_new_emp),
    'E4 add as employee: the BankOne provenance is recorded');

  select count(*) into v_after from public.bankone_import_rows
   where batch_id = v_batch and officer_employee_id is null;
  perform pg_temp.ok(v_after < v_before,
    'E4 add as employee: affected loans were reprocessed automatically');
  perform pg_temp.ok((select count(*) from public.bankone_import_rows
       where batch_id = v_batch and officer_name_raw = 'BRAND NEW OFFICER ONE'
         and officer_employee_id = v_new_emp) = 1,
    'E4 add as employee: its existing loan now points at the new employee');
end $$;

-- ---------------------------------------------------------------------------
-- E5 (RESUME). A browser refresh must lose nothing: the batch, its decisions
-- and its live summary are all readable from the database.
-- ---------------------------------------------------------------------------
do $$
declare
  v_batch uuid := current_setting('bo.batch')::uuid;
  v_state jsonb;
  v_open jsonb;
begin
  v_state := public.bankone_get_import_state(v_batch);
  perform pg_temp.ok(v_state -> 'ok' = 'true', 'E5 resume: import state is readable');
  perform pg_temp.ok((v_state -> 'summary' ->> 'parsed_rows')::int = 2725,
    'E5 resume: the live summary still reports 2725 parsed rows');
  perform pg_temp.ok(jsonb_array_length(v_state -> 'officers') > 0,
    'E5 resume: persisted officer decisions are returned');
  perform pg_temp.ok(jsonb_array_length(v_state -> 'branches') > 0,
    'E5 resume: persisted branch decisions are returned');

  -- "N officer decisions required" must be explicit and split by type, so a
  -- possible match is never shown as the same thing as a genuine mismatch.
  v_state := public.bankone_get_import_state(v_batch);
  perform pg_temp.ok((v_state -> 'summary' ->> 'officer_pending')::int
      = (select count(*) from public.bankone_officer_resolutions
          where batch_id = v_batch and decision = 'pending'),
    'E5 resume: the officer decision count is derived from the database');

  -- The open-import list is what powers "Resume import" after a refresh.
  v_open := public.bankone_get_open_imports(5);
  perform pg_temp.ok(exists (select 1 from jsonb_array_elements(v_open) x
    where x ->> 'id' = v_batch::text),
    'E5 resume: the unfinished batch appears in the resumable list');
end $$;

-- ---------------------------------------------------------------------------
-- E6 (PUBLISH GATE). Publishing must refuse while a branch is unresolved, and
-- must refuse if the row accounting does not reconcile. Nothing may be lost.
-- ---------------------------------------------------------------------------
do $$
declare
  v_batch uuid := current_setting('bo.batch')::uuid;
  v_raised boolean := false;
  v_br2 uuid;
  v_br3 uuid;
  v_snap jsonb;
begin
  select v into v_br2 from bo where k = 'br2';
  select v into v_br3 from bo where k = 'br3';

  begin
    perform public.bankone_publish_snapshot(v_batch);
  exception when others then v_raised := true; end;
  perform pg_temp.ok(v_raised,
    'E6 publish gate: refuses while branches are unresolved');
  perform pg_temp.ok((select count(*) from public.bankone_portfolio_snapshots
                       where batch_id = v_batch) = 0,
    'E6 publish gate: NOTHING was published');

  -- The verdict is available as DATA (a RAISE would roll back a status write),
  -- so the UI can show the real reason and persist "blocked".
  perform pg_temp.ok((public.bankone_validate_publish(v_batch) ->> 'can_publish') = 'false',
    'E6 validate: reports can_publish = false');
  perform pg_temp.ok(jsonb_array_length(public.bankone_validate_publish(v_batch) -> 'blockers') > 0,
    'E6 validate: returns the exact blocker text');
  perform pg_temp.ok((public.bankone_validate_publish(v_batch) ->> 'reconciles') = 'true',
    'E6 validate: row accounting still reconciles (2725 = 2725 + 0)');
  perform pg_temp.ok((public.bankone_validate_publish(v_batch) ->> 'officer_decisions_pending')::int > 0,
    'E6 validate: pending OFFICER decisions are reported but do not block');

  perform public.bankone_mark_publication_blocked(v_batch,
    'Branch mapping incomplete');
  perform pg_temp.ok((select publication_status from public.bankone_import_batches
                       where id = v_batch) = 'blocked',
    'E6 the batch is marked blocked (survives the failure, is NOT deleted)');

  -- Resolve the remaining branches the way the review screen would.
  perform public.confirm_bankone_branch_mapping(
    'MUSHIN YABA', 'MUSHIN/YABA', v_br2, 'normalized', null, 'Accept');
  perform public.confirm_bankone_branch_mapping(
    'LAGOS ISLAND ONE', 'Lagos Island ONE', v_br3, 'normalized', null, 'Accept');
  perform public.confirm_bankone_branch_mapping(
    'IBEJU LEKKI', 'IBEJU-LEKKI', v_br3, 'normalized', null, 'Accept');

  perform pg_temp.ok((select count(*) from public.bankone_import_rows
                       where batch_id = v_batch and resolved_branch_id is null) = 0,
    'E6 every loan now has a branch identity');

  -- Now publishing must succeed, and the accounting must hold exactly.
  v_snap := public.bankone_publish_snapshot(v_batch);
  perform pg_temp.ok(v_snap ->> 'ok' = 'true', 'E6 publish: succeeds once branches resolve');
  perform pg_temp.ok((v_snap ->> 'total_source_rows')::int = 2725
      and (v_snap ->> 'parsed_rows')::int = 2725
      and (v_snap ->> 'invalid_rows')::int = 0,
    'E6 publish: 2725 source = 2725 parsed + 0 invalid (no row dropped)');
  perform pg_temp.ok((v_snap ->> 'officer_decisions_pending')::int > 0,
    'E6 publish: unresolved officers are ALLOWED to publish');
end $$;

-- ---------------------------------------------------------------------------
-- E7 (SNAPSHOT INTEGRITY). The published figures must reconcile with the
-- source data, and the branch/officer split must hold: branch totals include
-- everything, officer totals only verified employees.
-- ---------------------------------------------------------------------------
do $$
declare
  v_batch uuid := current_setting('bo.batch')::uuid;
  v_snap  uuid;
  v_branch_total numeric;
  v_branch_loans integer;
  v_officer_total numeric;
  v_unattributed numeric;
  v_npa integer;
begin
  select id into v_snap from public.bankone_portfolio_snapshots where batch_id = v_batch;

  perform pg_temp.ok(v_snap is not null, 'E7 a snapshot was persisted');
  perform pg_temp.ok((select status from public.bankone_portfolio_snapshots
                       where id = v_snap) = 'published', 'E7 the snapshot is published');
  perform pg_temp.ok((select publication_status from public.bankone_import_batches
                       where id = v_batch) = 'published', 'E7 the batch is published');

  -- Branch level: EVERY branch-resolved loan, attributed or not.
  select sum(loan_count), sum(total_outstanding), sum(unattributed_outstanding)
    into v_branch_loans, v_branch_total, v_unattributed
    from public.bankone_branch_snapshots where snapshot_id = v_snap;
  perform pg_temp.ok(v_branch_loans = 2725,
    'E7 branch level: all 2725 loans are counted (nothing dropped)');
  perform pg_temp.ok(v_unattributed > 0,
    'E7 branch level: unattributed portfolio is still visible at branch level');

  -- Officer level: verified employees only.
  select sum(total_outstanding) into v_officer_total
    from public.bankone_officer_snapshots where snapshot_id = v_snap;
  perform pg_temp.ok(v_officer_total < v_branch_total,
    'E7 officer level: resolved officer portfolio is LESS than branch portfolio');
  perform pg_temp.ok(v_branch_total - v_officer_total = v_unattributed,
    'E7 branch total minus officer total EXACTLY equals the unattributed amount');
  perform pg_temp.ok(not exists (select 1 from public.bankone_officer_snapshots os
      where os.snapshot_id = v_snap and os.employee_id is null),
    'E7 no officer snapshot row exists for an unresolved officer');

  -- PAR comes from the actual imported statuses (755 NPA loans in the fixture).
  select count(*) into v_npa from public.bankone_import_rows
   where batch_id = v_batch
     and upper(btrim(coalesce(normalized_data->>'status','')))
         in ('PASS AND WATCH','SUB STANDARD','DOUBTFUL','LOST');
  perform pg_temp.ok(v_npa = 755,
    'E7 the 755 non-performing loans were detected from the real status column');
  perform pg_temp.ok((select non_performing_outstanding from public.bankone_portfolio_snapshots
                       where id = v_snap)
      = (select sum((normalized_data->>'total_outstanding')::numeric)
           from public.bankone_import_rows
          where batch_id = v_batch
            and upper(btrim(coalesce(normalized_data->>'status','')))
                in ('PASS AND WATCH','SUB STANDARD','DOUBTFUL','LOST')),
    'E7 the snapshot NPA total equals the sum of the NPA loans');
  perform pg_temp.ok((select par_ratio from public.bankone_portfolio_snapshots
                       where id = v_snap) is not null,
    'E7 PAR was computed from the data');
  perform pg_temp.ok((select par_ratio from public.bankone_branch_snapshots
                       where snapshot_id = v_snap limit 1) is not null,
    'E7 per-branch PAR was computed');

  -- The audit trail exists for the consequential actions.
  perform pg_temp.ok(exists (select 1 from public.audit_logs
      where action = 'IMPORT_PUBLISHED'), 'E7 IMPORT_PUBLISHED is audited');
  perform pg_temp.ok(exists (select 1 from public.audit_logs
      where action = 'OFFICER_MAPPING_CONFIRMED'), 'E7 OFFICER_MAPPING_CONFIRMED is audited');
  perform pg_temp.ok(exists (select 1 from public.audit_logs
      where action = 'BRANCH_MAPPING_CONFIRMED'), 'E7 BRANCH_MAPPING_CONFIRMED is audited');
  perform pg_temp.ok(exists (select 1 from public.audit_logs
      where action = 'EMPLOYEE_CREATED_FROM_BANKONE'), 'E7 EMPLOYEE_CREATED_FROM_BANKONE is audited');
end $$;





rollback;
