-- ===========================================================================
-- Branch split contract: verifies the reported failure and the silent bug.
-- Run with: npm run test:bankone-split
-- Everything runs in one transaction and is ROLLED BACK.
-- ===========================================================================
\set ON_ERROR_STOP on
begin;

alter table public.profiles disable trigger trg_enforce_role_change;

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('9d000001-0000-0000-0000-000000000001','split@bankone.test','authenticated','authenticated',
        '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now())
on conflict (id) do nothing;

insert into public.profiles (id, full_name, role, status, email)
values ('9d000001-0000-0000-0000-000000000001','Split Actor','super_admin','active','split@bankone.test')
on conflict (id) do update set role='super_admin', status='active';

alter table public.profiles enable trigger trg_enforce_role_change;

create temp table sp (k text primary key, v uuid);
insert into sp values
  ('actor',   '9d000001-0000-0000-0000-000000000001'),
  ('batch',   '9d000000-0000-0000-0000-000000000001'),
  ('parent',  '9d000003-0000-0000-0000-000000000001'),
  ('b_mush',  '9d000003-0000-0000-0000-000000000002'),
  ('b_yaba',  '9d000003-0000-0000-0000-000000000003');

select set_config('request.jwt.claim.sub', (select v::text from sp where k='actor'), true);
select set_config('request.jwt.claims',
  json_build_object('sub',(select v::text from sp where k='actor'),'role','authenticated')::text, true);

create or replace function pg_temp.ok(p boolean, p_label text)
returns void language plpgsql as $$
begin
  if p is not true then raise exception 'ASSERTION FAILED: %', p_label; end if;
  raise notice 'PASS: %', p_label;
end $$;

-- A combined InfinityCore branch, and BankOne loans carrying the slash form.
insert into public.branches (id, branch_name, branch_code, status)
values ('9d000003-0000-0000-0000-000000000001','Mushin/Yaba','MUSHY','active')
on conflict (id) do nothing;

insert into public.bankone_import_batches
  (id, filename, source_format, source_type, operation_type, status, as_at_date, total_rows)
values ('9d000000-0000-0000-0000-000000000001','split.xlsx','xlsx','par','par','pending_review', current_date, 2)
on conflict (id) do nothing;

-- The REAL BankOne source values use a slash, which the legacy normalizer kept.
insert into public.bankone_import_rows
  (batch_id, row_number, raw_data, branch_name_raw, normalized_data)
select '9d000000-0000-0000-0000-000000000001', g, '{}'::jsonb, 'Mushin/Yaba',
       jsonb_build_object('total_outstanding', g * 1000)
  from generate_series(1,2) g;

-- The pending review row the split is expected to close.
insert into public.bankone_branch_resolutions
  (batch_id, raw_branch_name, normalized_branch_name, decision, loan_count, outstanding_total)
values ('9d000000-0000-0000-0000-000000000001', 'Mushin/Yaba', 'MUSHIN YABA', 'pending', 2, 3000)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- S1: THE DEPLOYED CONTRACT. The frontend must be able to see exactly one
--     function with the snake_case argument names it sends.
-- ---------------------------------------------------------------------------
do $$
declare v jsonb;
begin
  v := public.bankone_split_branch_signature();
  perform pg_temp.ok(v ->> 'exists' = 'true', 'S1 split_bankone_branch is deployed');
  perform pg_temp.ok((v ->> 'overload_count')::int = 1,
    'S1 exactly ONE overload (no PostgREST ambiguity)');
  perform pg_temp.ok(
    (select array_agg(a ->> 'name' order by ord)
       from jsonb_array_elements(v -> 'args') with ordinality as a(a, ord))
    = array['p_parent_branch_id','p_new_branch_names','p_source_import_id','p_reason'],
    'S1 argument names match the frontend payload exactly');
  perform pg_temp.ok(
    (select array_agg(a ->> 'type' order by ord)
       from jsonb_array_elements(v -> 'args') with ordinality as a(a, ord))
    = array['uuid','text[]','uuid','text'],
    'S1 argument types are uuid / text[] / uuid / text');
end $$;

-- ---------------------------------------------------------------------------
-- S2: THE SPLIT ITSELF. The parent is a combined "Mushin/Yaba"; BankOne's raw
--     value carries the same slash. Under the legacy normalizer the re-pointing
--     UPDATE compared 'MUSHIN/YABA' against a key built from 'MUSHIN'/'YABA'
--     and matched nothing, so a split "succeeded" while re-pointing ZERO loans.
-- ---------------------------------------------------------------------------
do $$
declare
  v_parent uuid := (select v from sp where k='parent');
  v_res    jsonb;
begin
  -- The new branch names correspond to the two halves of the BankOne source
  -- value "Mushin/Yaba", which is exactly the real split case: BankOne reports
  -- "Mushin" and "Yaba" separately while InfinityCore holds one "Mushin/Yaba".
  v_res := public.split_bankone_branch(
    v_parent, array['Mushin','Yaba'],
    (select v from sp where k='batch'), 'BankOne reports these separately');

  perform pg_temp.ok(v_res -> 'ok' = 'true', 'S2 the split succeeds');

  -- THE ASSERTION THAT MATTERS: loans actually re-pointed. Under the legacy
  -- normalizer the mapping key kept the slash ("MUSHIN/YABA") and matched
  -- nothing, so this returned 0 while reporting success.
  perform pg_temp.ok((v_res ->> 'rows_repointed')::int > 0,
    'S2 rows_repointed > 0 (the legacy version silently re-pointed nothing)');

  -- The parent is retired, never deleted.
  perform pg_temp.ok((select status from public.branches where id = v_parent) = 'inactive',
    'S2 the parent branch is deactivated, NOT deleted');
  perform pg_temp.ok((select count(*) from public.branches where id = v_parent) = 1,
    'S2 the parent branch row still exists');

  -- The mapping key is CANONICAL, so a split and an accept can never produce
  -- two rows for the same BankOne branch.
  perform pg_temp.ok(exists (select 1 from public.bankone_branch_mappings
      where split_from_branch_id = v_parent
        and normalized_bankone_branch_name = 'MUSHIN'),
    'S2 the mapping key is canonical (MUSHIN, not MUSHIN/YABA)');
  perform pg_temp.ok(not exists (select 1 from public.bankone_branch_mappings
      where split_from_branch_id = v_parent
        and normalized_bankone_branch_name like '%/%'),
    'S2 no split mapping key retains a slash');

  -- Branch records are created or reused; exactly one mapping per new branch.
  perform pg_temp.ok(
    jsonb_array_length(v_res -> 'created_branch_ids')
    + jsonb_array_length(v_res -> 'reused_branch_ids') = 2,
    'S2 exactly one branch record per new name (created or reused)');
  perform pg_temp.ok((select count(*) from public.bankone_branch_mappings
      where split_from_branch_id = v_parent) = 2,
    'S2 exactly one mapping per new branch (no duplicate keys)');

  -- The loans of the split branch now resolve to a REAL branch.
  perform pg_temp.ok((select count(*) from public.bankone_import_rows
      where batch_id = (select v from sp where k='batch')
        and resolved_branch_id is not null
        and resolved_branch_id <> v_parent) = 2,
    'S2 both loans moved off the retired parent onto the new branches');

  -- The combined parent yields exactly ONE review row ("MUSHIN YABA"), and the
  -- split closes it. The two new branch mappings are the per-name records.
  perform pg_temp.ok((select count(*) from public.bankone_branch_resolutions
      where batch_id = (select v from sp where k='batch')
        and mapping_method = 'split'
        and decision = 'mapped'
        and branch_id is not null) = 1,
    'S2 the pending branch resolution is closed by the split');
  perform pg_temp.ok(exists (select 1 from public.audit_logs where action = 'BRANCH_SPLIT'),
    'S2 BRANCH_SPLIT is audited');
end $$;

-- ---------------------------------------------------------------------------
-- S3: IDEMPOTENCY. Splitting again must reuse the existing branches.
-- ---------------------------------------------------------------------------
do $$
declare
  v_parent uuid := (select v from sp where k='parent');
  v_res    jsonb;
  v_before integer;
begin
  select count(*) into v_before from public.branches;
  v_res := public.split_bankone_branch(
    v_parent, array['Mushin','Yaba'],
    (select v from sp where k='batch'), 'Re-run');
  perform pg_temp.ok((select count(*) from public.branches) = v_before,
    'S3 a repeated split creates NO new branch records');
  perform pg_temp.ok(jsonb_array_length(v_res -> 'reused_branch_ids') = 2,
    'S3 both existing branches are reused');
end $$;

-- ---------------------------------------------------------------------------
-- S4: VALIDATION AND AUTHORIZATION are preserved, not bypassed.
-- ---------------------------------------------------------------------------
do $$
declare v_raised boolean;
begin
  begin
    perform public.split_bankone_branch(
      (select v from sp where k='parent'), array['OnlyOne'], null, 'needs two');
  exception when others then v_raised := true; end;
  perform pg_temp.ok(v_raised, 'S4 a split with fewer than two names is refused');

  v_raised := false;
  begin
    perform public.split_bankone_branch(
      (select v from sp where k='parent'), array['A','B'], null, '   ');
  exception when others then v_raised := true; end;
  perform pg_temp.ok(v_raised, 'S4 a split with a blank reason is refused');

  v_raised := false;
  begin
    perform public.split_bankone_branch(
      '00000000-0000-0000-0000-000000000000'::uuid, array['A','B'], null, 'missing parent');
  exception when others then v_raised := true; end;
  perform pg_temp.ok(v_raised, 'S4 splitting a non-existent branch is refused');
end $$;

-- An unauthorized caller must still be blocked: the RPC was NOT made public.
do $$
declare v_raised boolean := false;
begin
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('9d000001-0000-0000-0000-000000000002','nope@bankone.test','authenticated','authenticated',
          '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now())
  on conflict (id) do nothing;

  -- set_config must be consumed in place: a bare SELECT in a plpgsql block has
  -- no destination and raises "query has no destination for result data".
  perform set_config('request.jwt.claim.sub', '9d000001-0000-0000-0000-000000000002', true);
  perform set_config('request.jwt.claims',
    '{"sub":"9d000001-0000-0000-0000-000000000002","role":"authenticated"}', true);

  begin
    perform public.split_bankone_branch(
      (select v from sp where k='parent'), array['X','Y'], null, 'unauthorized');
  exception when others then v_raised := true; end;

  perform pg_temp.ok(v_raised,
    'S4 an unauthorized caller is refused (the RPC was NOT made public)');
end $$;

rollback;
