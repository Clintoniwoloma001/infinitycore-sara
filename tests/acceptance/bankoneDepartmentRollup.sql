-- ============================================================================
-- Acceptance: BankOne publish department rollup + snapshot-sourced executive
-- financials (migration 20261102000001_bankone_publish_rollup_and_executive_sync).
--
-- Run by scripts/test-bankone-rollup.sh AFTER applying
-- 20260931000002 (lifecycle) and 20261102000001 (this feature's migration).
--
-- Everything runs inside one transaction and ends in ROLLBACK: no fixture
-- data survives. ON_ERROR_STOP is on, so a genuine failure aborts the run;
-- assertions raise 'ASSERTION FAILED: ...'.
--
-- What is proven:
--   1. Publishing a PAR batch writes loan_count / total_disbursed /
--      total_repaid on the portfolio snapshot and builds department rows
--      (Credit & Marketing / Operations / Unattributed) whose figures match
--      the imported rows exactly, incl. percent PAR (x100 already applied).
--   2. Department loan counts reconcile with the portfolio loan count.
--   3. Re-running the rollup is idempotent.
--   4. A DISBURSEMENT batch produces NO department rows (PAR gate) while
--      still getting its portfolio aggregates.
--   5. get_director_executive_snapshot reads the published snapshot:
--      loan_portfolio = snapshot outstanding, period disbursed/repaid are
--      scoped to loans booked inside the window via disbursementDate, and
--      the legacy expressions are bypassed only while a snapshot exists.
--   6. Re-publishing the same (report_type, as_at_date) supersedes the old
--      snapshot and rebuilds fresh department rows for the new one.
-- ============================================================================

begin;

-- Self-repair: older acceptance fixtures temporarily repoint these FKs at a
-- local stand-in table. If that state ever gets committed, handle_new_user()
-- cannot insert the fixture profile and its exception handler masks the real
-- error ("control reached end of trigger"). Repoint back inside this
-- transaction (rolled back with everything else).
do $$
begin
  if exists (select 1 from pg_constraint
              where conname = 'profiles_id_fkey'
                and confrelid <> 'auth.users'::regclass) then
    alter table public.profiles drop constraint profiles_id_fkey;
    alter table public.profiles
      add constraint profiles_id_fkey
      foreign key (id) references auth.users(id) on delete cascade;
  end if;

  if exists (select 1 from pg_constraint
              where conname = 'employees_user_id_fkey'
                and confrelid <> 'auth.users'::regclass) then
    alter table public.employees drop constraint employees_user_id_fkey;
    alter table public.employees
      add constraint employees_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete set null;
  end if;
end $$;

-- Fixture setup only: postgres' auth.uid() is null here, so the role-change
-- guard would reject the profile upsert. Rolled back with everything else.
alter table public.profiles disable trigger trg_enforce_role_change;

create temp table bo (k text primary key, v uuid);
insert into bo values
  ('actor', '9b100001-0000-0000-0000-000000000001'),
  ('emp_a', '9b100002-0000-0000-0000-000000000001'),
  ('emp_b', '9b100002-0000-0000-0000-000000000002'),
  ('br1',   '9b100003-0000-0000-0000-000000000001'),
  ('batch1','9b100004-0000-0000-0000-000000000001'),
  ('batch2','9b100004-0000-0000-0000-000000000002'),
  ('batchd','9b100004-0000-0000-0000-000000000003'),
  ('snap1', '9b100005-0000-0000-0000-000000000001'),
  ('snap2', '9b100005-0000-0000-0000-000000000003');

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select b.v, lower(b.k)||'@rollup.test', 'authenticated','authenticated',
       '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  from bo b where b.k = 'actor';

insert into public.profiles (id, full_name, role, status, email)
select b.v, 'Rollup Actor', 'super_admin', 'active', 'actor@rollup.test'
  from bo b where b.k = 'actor'
on conflict (id) do update set role = 'super_admin', status = 'active';

insert into public.employees (id, full_name, employment_status, department)
select b.v, 'Alice Assets' , 'active', 'Credit & Marketing' from bo b where b.k = 'emp_a'
on conflict (id) do nothing;
insert into public.employees (id, full_name, employment_status, department)
select b.v, 'Bob Books', 'active', 'Operations' from bo b where b.k = 'emp_b'
on conflict (id) do nothing;

insert into public.branches (id, branch_name, branch_code, status)
select b.v, 'Rollup Branch', 'RB1', 'active' from bo b where b.k = 'br1'
on conflict (id) do nothing;

-- Local-only stubs: hosted environments already have these from
-- 20260924000003 (department hygiene); the local dev DB may not. The
-- definitions are copied verbatim from that migration and rolled back here.
create or replace function public.is_role_like_department(p_value text)
returns boolean language sql immutable set search_path = public as $$
  select upper(regexp_replace(btrim(coalesce(p_value, '')), '\s+', ' ', 'g')) = any (array[
    'MD','M.D','M.D.','MD/CEO','MD, CEO','MD & CEO','MD / CEO','CEO',
    'MANAGING DIRECTOR','MANAGING DIRECTOR/CEO','CHAIRMAN','CHAIRMAN/CEO',
    'DIRECTOR','BOARD','BOARD OF DIRECTORS'
  ]);
$$;

create or replace function public.department_label(p_value text)
returns text language sql immutable set search_path = public as $$
  select case
    when public.is_role_like_department(p_value) then 'Unassigned'
    else coalesce(nullif(btrim(p_value), ''), 'Unassigned')
  end;
$$;

-- ---------------------------------------------------------------------------
-- Helpers: impersonate the actor, assert.
-- ---------------------------------------------------------------------------
create or replace function pg_temp.act_as_actor()
returns void language plpgsql as $$
declare v_actor uuid;
begin
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

-- ---------------------------------------------------------------------------
-- 1. PAR batch: 6 loans across two officers plus two unattributed.
--    Dates are relative to today so the director window maths is stable.
--    disb / loan / outstanding / status:
--      A emp_a  c-3   1000 /  400  Pass And Watch  (NPA, current window)
--      B emp_a  c-15   500 /  500  Performing      (previous window)
--      C emp_b  c-30  2000 / 1500  Sub Standard    (NPA, outside both)
--      D emp_b  c-3    800 /  200  Performing      (current window)
--      E none   c-15   300 /  300  Performing      (previous window)
--      F none   c-30   700 /    0  Lost            (NPA, outside both)
--    Totals: loan_count 6, disbursed 5300, repaid 2400, outstanding 2900,
--            NPA outstanding 1900 -> par 65.5172.
-- ---------------------------------------------------------------------------
insert into public.bankone_import_batches
  (id, filename, source_type, operation_type, as_at_date, total_rows, rejected_rows)
select b.v, 'rollup_par.csv', 'par', 'par', current_date, 6, 0
  from bo b where b.k = 'batch1';

insert into public.bankone_import_rows
  (batch_id, row_number, account_no, branch_name_raw, officer_name_raw,
   officer_employee_id, resolved_branch_id, match_status, raw_data, normalized_data)
select (select v from bo where k = 'batch1'), n, 'ACC'||n, 'Rollup Branch',
       case when off = 'emp_a' then 'Alice Assets'
            when off = 'emp_b' then 'Bob Books' else 'Unknown Person' end,
       case when off in ('emp_a','emp_b') then (select v from bo where k = off) end,
       (select v from bo where k = 'br1'),
       'auto_resolved',
       '{}'::jsonb,
       jsonb_build_object(
         'loan_amount', la, 'total_outstanding', ont, 'status', st,
         'days_overdue', 0,
         'disbursementDate', (current_date - age_days)::text)
  from (values
    (1,'emp_a',1000,400,'Pass And Watch',3),
    (2,'emp_a', 500, 500,'Performing',15),
    (3,'emp_b',2000,1500,'Sub Standard',30),
    (4,'emp_b', 800, 200,'Performing',3),
    (5,'none',  300, 300,'Performing',15),
    (6,'none',  700,   0,'Lost',30)
  ) as t(n, off, la, ont, st, age_days);

select pg_temp.act_as_actor();
select pg_temp.ok((select public.bankone_publish_snapshot((select v from bo where k='batch1')) ->> 'ok') = 'true',
  'publish PAR batch returns ok');

select pg_temp.ok((
  select s.loan_count = 6
     and s.total_disbursed = 5300
     and s.total_repaid = 2400
     and s.total_outstanding = 2900
     and s.par_ratio = round(1900 * 100 / 2900.0, 4)
     and s.status = 'published'
    from public.bankone_portfolio_snapshots s
   where s.batch_id = (select v from bo where k = 'batch1')
), 'portfolio snapshot carries the new aggregates + percent PAR');

insert into bo (k, v)
select 'snap1', id from public.bankone_portfolio_snapshots
 where batch_id = (select v from bo where k = 'batch1')
on conflict (k) do update set v = excluded.v;

select pg_temp.ok((
  select count(*) = 3
    from public.bankone_department_snapshots
   where snapshot_id = (select v from bo where k = 'snap1')
), 'PAR snapshot produced 3 department rows');

select pg_temp.ok((
  select d.loan_count = 2 and d.total_outstanding = 900
     and d.total_disbursed = 1500 and d.total_repaid = 600
     and d.non_performing_count = 1 and d.non_performing_outstanding = 400
     and d.par_ratio = round(400 * 100 / 900.0, 4)
    from public.bankone_department_snapshots d
   where d.snapshot_id = (select v from bo where k = 'snap1')
     and d.department = 'Credit & Marketing'
), 'Credit & Marketing department row matches its imported loans');

select pg_temp.ok((
  select d.loan_count = 2 and d.total_outstanding = 1700
     and d.total_disbursed = 2800 and d.total_repaid = 1100
     and d.non_performing_count = 1 and d.non_performing_outstanding = 1500
     and d.par_ratio = round(1500 * 100 / 1700.0, 4)
    from public.bankone_department_snapshots d
   where d.snapshot_id = (select v from bo where k = 'snap1')
     and d.department = 'Operations'
), 'Operations department row matches its imported loans');

select pg_temp.ok((
  select d.loan_count = 2 and d.total_outstanding = 300
     and d.total_disbursed = 1000 and d.total_repaid = 700
     and d.non_performing_count = 1 and d.non_performing_outstanding = 0
     and d.par_ratio = 0
    from public.bankone_department_snapshots d
   where d.snapshot_id = (select v from bo where k = 'snap1')
     and d.department = 'Unattributed'
), 'officer-less loans land in Unattributed with honest figures');

select pg_temp.ok((
  select coalesce(sum(d.loan_count), 0) = s.loan_count
    from public.bankone_portfolio_snapshots s
    left join public.bankone_department_snapshots d
      on d.snapshot_id = s.id
   where s.id = (select v from bo where k = 'snap1')
   group by s.id
), 'department loan counts reconcile with the portfolio loan count');

-- 3. Rollup idempotency.
select pg_temp.ok(
  (select public.bankone_rollup_departments((select v from bo where k = 'snap1'))) = 3,
  'rollup re-run returns the same 3 rows');
select pg_temp.ok((
  select count(*) = 3
    from public.bankone_department_snapshots
   where snapshot_id = (select v from bo where k = 'snap1')
), 'rollup re-run did not duplicate department rows');

-- ---------------------------------------------------------------------------
-- 4. Director executive snapshot reads the published snapshot.
--    Window: [today-10, today]; previous: [today-21, today-11].
--    In-window bookings: A (1000, repaid 600) + D (800, repaid 600).
--    Previous-window bookings: B (500, repaid 0) + E (300, repaid 0).
-- ---------------------------------------------------------------------------
do $$
declare
  v_doc jsonb;
  v_start date := current_date - 10;
  v_end   date := current_date;
begin
  v_doc := public.get_director_executive_snapshot(v_start, v_end);

  if ((v_doc -> 'summary' ->> 'loan_portfolio')::numeric) <> 2900 then
    raise exception 'ASSERTION FAILED: director loan_portfolio = snapshot outstanding (expected 2900, got %)',
      v_doc -> 'summary' ->> 'loan_portfolio';
  end if;
  raise notice 'PASS: director loan_portfolio comes from the published snapshot';

  if ((v_doc -> 'summary' ->> 'loans_disbursed')::numeric) <> 1800 then
    raise exception 'ASSERTION FAILED: director loans_disbursed in window (expected 1800, got %)',
      v_doc -> 'summary' ->> 'loans_disbursed';
  end if;
  raise notice 'PASS: director loans_disbursed scoped to bookings inside the window';

  if ((v_doc -> 'summary' ->> 'previous_loans_disbursed')::numeric) <> 800 then
    raise exception 'ASSERTION FAILED: director previous_loans_disbursed (expected 800, got %)',
      v_doc -> 'summary' ->> 'previous_loans_disbursed';
  end if;
  raise notice 'PASS: director previous_loans_disbursed scoped to the previous window';

  if ((v_doc -> 'summary' ->> 'repayments')::numeric) <> 1200 then
    raise exception 'ASSERTION FAILED: director repayments (expected 1200, got %)',
      v_doc -> 'summary' ->> 'repayments';
  end if;
  raise notice 'PASS: director repayments = principal recovered on in-window bookings';

  if ((v_doc -> 'summary' ->> 'previous_repayments')::numeric) <> 0 then
    raise exception 'ASSERTION FAILED: director previous_repayments (expected 0, got %)',
      v_doc -> 'summary' ->> 'previous_repayments';
  end if;
  raise notice 'PASS: director previous_repayments computed from the snapshot too';

  if ((v_doc -> 'loans' -> 'status' ->> 'count')::numeric) <> 2
     or ((v_doc -> 'loans' -> 'status' ->> 'principal')::numeric) <> 1800
     or ((v_doc -> 'loans' -> 'status' ->> 'outstanding')::numeric) <> 2900 then
    raise exception 'ASSERTION FAILED: director loans.status block (got %)',
      v_doc -> 'loans';
  end if;
  raise notice 'PASS: director loans.status block is snapshot-sourced';
end $$;

-- ---------------------------------------------------------------------------
-- 5. DISBURSEMENT batch: aggregates yes, department rows NO (PAR gate).
-- ---------------------------------------------------------------------------
insert into public.bankone_import_batches
  (id, filename, source_type, operation_type, as_at_date, total_rows, rejected_rows)
select b.v, 'rollup_disb.csv', 'disbursement', 'disbursement', current_date, 2, 0
  from bo b where b.k = 'batchd';

insert into public.bankone_import_rows
  (batch_id, row_number, account_no, branch_name_raw, officer_name_raw,
   officer_employee_id, resolved_branch_id, match_status, raw_data, normalized_data)
select (select v from bo where k = 'batchd'), n, 'DS'||n, 'Rollup Branch',
       'Alice Assets', (select v from bo where k = 'emp_a'),
       (select v from bo where k = 'br1'), 'auto_resolved',
       '{}'::jsonb,
       jsonb_build_object('loan_amount', la, 'total_outstanding', la,
                          'disbursementDate', (current_date - 1)::text)
  from (values (1, 1500), (2, 500)) as t(n, la);

select pg_temp.ok((
  select (public.bankone_publish_snapshot((select v from bo where k = 'batchd')) ->> 'ok') = 'true'
), 'publish DISBURSEMENT batch returns ok');

select pg_temp.ok((
  select s.loan_count = 2 and s.total_disbursed = 2000
    from public.bankone_portfolio_snapshots s
   where s.batch_id = (select v from bo where k = 'batchd')
), 'disbursement snapshot still gets portfolio aggregates');

select pg_temp.ok((
  select count(*) = 0
    from public.bankone_department_snapshots d
    join public.bankone_portfolio_snapshots s on s.id = d.snapshot_id
   where s.batch_id = (select v from bo where k = 'batchd')
), 'disbursement snapshot produced NO department rows (PAR gate)');

-- ---------------------------------------------------------------------------
-- 6. Re-publish the same (report_type, as_at_date): supersede + fresh rows.
-- ---------------------------------------------------------------------------
insert into public.bankone_import_batches
  (id, filename, source_type, operation_type, as_at_date, total_rows, rejected_rows)
select b.v, 'rollup_par_v2.csv', 'par', 'par', current_date, 2, 0
  from bo b where b.k = 'batch2';

insert into public.bankone_import_rows
  (batch_id, row_number, account_no, branch_name_raw, officer_name_raw,
   officer_employee_id, resolved_branch_id, match_status, raw_data, normalized_data)
select (select v from bo where k = 'batch2'), n, 'V2'||n, 'Rollup Branch',
       'Alice Assets', (select v from bo where k = 'emp_a'),
       (select v from bo where k = 'br1'), 'auto_resolved',
       '{}'::jsonb,
       jsonb_build_object('loan_amount', la, 'total_outstanding', ont,
                          'status', 'Performing',
                          'disbursementDate', (current_date - 1)::text)
  from (values (1, 100, 50), (2, 400, 400)) as t(n, la, ont);

select pg_temp.ok((
  select (public.bankone_publish_snapshot((select v from bo where k = 'batch2')) ->> 'ok') = 'true'
), 're-publish PAR batch returns ok');

select pg_temp.ok((
  select s.status = 'superseded'
    from public.bankone_portfolio_snapshots s
   where s.batch_id = (select v from bo where k = 'batch1')
), 'older PAR snapshot was superseded, not double-counted');

select pg_temp.ok((
  select count(*) filter (where s.status = 'published') = 1
    from public.bankone_portfolio_snapshots s
   where s.report_type = 'par' and s.as_at_date = current_date
), 'exactly one published PAR snapshot for the as-at date');

insert into bo (k, v)
select 'snap2', id from public.bankone_portfolio_snapshots
 where batch_id = (select v from bo where k = 'batch2')
on conflict (k) do update set v = excluded.v;

select pg_temp.ok((
  select d.loan_count = 2 and d.total_outstanding = 450
     and d.total_disbursed = 500 and d.total_repaid = 50
    from public.bankone_department_snapshots d
   where d.snapshot_id = (select v from bo where k = 'snap2')
     and d.department = 'Credit & Marketing'
), 'new snapshot has freshly rebuilt department rows');

select pg_temp.ok((
  select count(*) = 1
    from public.bankone_department_snapshots
   where snapshot_id = (select v from bo where k = 'snap2')
), 'new snapshot department rows are not stale/duplicated');

rollback;
