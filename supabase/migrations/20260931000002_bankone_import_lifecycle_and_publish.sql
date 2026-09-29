-- ============================================================================
-- BankOne import: shared normalization, batch lifecycle, resumable processing
-- and a real publish target.
-- ============================================================================
-- Run in Supabase SQL Editor AFTER 20260931000001. Idempotent and additive.
--
-- ROOT CAUSE 1 — branch Accept resolved nothing
--   confirm_bankone_branch_mapping reprocessed rows with
--     upper(replace(btrim(branch_name_raw), '-', ' ')) = p_normalized_...
--   but the browser sends normalizeBranch(raw), which ALSO strips '.' '/' and
--   '\' and collapses whitespace runs. For real bank names the two disagree:
--     "TRADE FAIR/BOUNDARY/YABA" -> SQL "TRADE FAIR/BOUNDARY/YABA"
--                                 JS  "TRADE FAIR BOUNDARY YABA"
--     "HEAD OFFICE - OSHODI"     -> SQL "HEAD OFFICE   OSHODI"  (3 spaces)
--                                 JS  "HEAD OFFICE OSHODI"
--   The UPDATE matched zero rows, the RPC still returned ok:true, the UI said
--   "mapped", and the issue reappeared forever. That is the reported
--   "Accept loads then stops without resolving".
--
--   Fix: one canonical SQL normalizer, used by EVERY reprocessing UPDATE, so
--   the database compares like-for-like. The browser already sends the same
--   normalized string.
--
-- ROOT CAUSE 2 — no server-side state
--   The page kept everything in React state and re-ran the whole parse/upload
--   after each decision, so a refresh lost the import and nothing was resumable.
--
-- This migration adds the missing state machine and the publish target, and
-- re-issues the two branch RPCs so their reprocessing can never silently
-- affect zero rows again.
begin;

-- ---------------------------------------------------------------------------
-- 1. ONE canonical normalizer. Mirrors src/domains/bankone/normalize.js:
--    branch -> strip . - / \ and collapse whitespace, upper
--    name   -> same, and commas become spaces ("SURNAME, OTHER" == "SURNAME OTHER")
-- ---------------------------------------------------------------------------
-- IMPORTANT: collapse whitespace AFTER the character replacement. A plain
-- regexp_replace('[-/]', ' ', 'g') turns "A - B" into "A   B" (three spaces),
-- which would NOT equal the browser's "A B" and would silently match zero rows
-- again. btrim alone does not fix an interior run.
create or replace function public.bankone_norm_branch(p text)
returns text language sql immutable parallel safe as $$
  select upper(btrim(regexp_replace(regexp_replace(p, '[.\-_/\\]+', ' ', 'g'), '\s+', ' ', 'g')));
$$;

create or replace function public.bankone_norm_name(p text)
returns text language sql immutable parallel safe as $$
  select upper(btrim(regexp_replace(regexp_replace(p, '[,.\-_/\\]+', ' ', 'g'), '\s+', ' ', 'g')));
$$;

comment on function public.bankone_norm_branch is
  'Canonical BankOne branch normalization. MUST stay byte-identical to normalizeBranch() in src/domains/bankone/normalize.js - the two are compared against each other when reprocessing import rows.';
comment on function public.bankone_norm_name is
  'Canonical BankOne officer-name normalization. MUST stay byte-identical to normalizeName() in src/domains/bankone/normalize.js.';

-- ---------------------------------------------------------------------------
-- 1c. bankone_created_employees was missing the column its own RPC already
--     wrote to: add_employee_from_bankone inserts normalized_source_name, but
--     the column was never created, so "Add as employee" failed with
--     'column "normalized_source_name" ... does not exist' - a second, separate
--     break in the very action the uploader relies on for unmatched officers.
--     Added additively; existing rows are untouched.
-- ---------------------------------------------------------------------------
alter table public.bankone_created_employees
  add column if not exists normalized_source_name text;

-- Backfill from the raw source name so historical rows become searchable.
update public.bankone_created_employees
   set normalized_source_name = public.bankone_norm_name(bankone_source_name)
 where normalized_source_name is null
   and bankone_source_name is not null;

create index if not exists idx_bankone_created_emp_norm
  on public.bankone_created_employees (normalized_source_name);

-- ---------------------------------------------------------------------------
-- 1d. Widen the mapping vocabularies. The importer distinguishes a BankOne
--     TRUNCATION from a manual confirmation, and records that a created
--     employee came from an import. The existing values all stay valid, so
--     historical mappings are untouched.
-- ---------------------------------------------------------------------------
alter table public.bankone_employee_mappings
  drop constraint if exists bankone_employee_mappings_match_type_check;
alter table public.bankone_employee_mappings
  add constraint bankone_employee_mappings_match_type_check
  check (match_type in (
    'exact_normalized','normalized_format','token_reorder','truncation',
    'high_confidence','manual','created_employee',
    -- NEW: explicit provenance for a BankOne-import decision
    'bankone_truncated','manually_confirmed','manually_created_employee',
    'left_unresolved'));

-- ---------------------------------------------------------------------------
-- 2. Batch lifecycle. The import becomes a durable, resumable state machine
--    instead of React state. Nothing here deletes a failed batch.
-- ---------------------------------------------------------------------------
alter table public.bankone_import_batches
  add column if not exists parsing_status     text not null default 'parsed',
  add column if not exists resolution_status  text not null default 'review_required',
  add column if not exists publication_status text not null default 'unpublished',
  add column if not exists auto_matched_rows  integer not null default 0,
  add column if not exists needs_review_rows  integer not null default 0,
  add column if not exists unmatched_rows     integer not null default 0,
  add column if not exists branch_issue_rows  integer not null default 0,
  add column if not exists published_at       timestamptz,
  add column if not exists error_message      text,
  add column if not exists last_progress_at   timestamptz not null default now(),
  add column if not exists updated_at         timestamptz not null default now();

-- The lifecycle vocabulary, enforced so an unknown state can never be stored.
alter table public.bankone_import_batches
  drop constraint if exists bankone_import_batches_parsing_status_check;
alter table public.bankone_import_batches
  add constraint bankone_import_batches_parsing_status_check
  check (parsing_status in
    ('uploaded','parsing','parsed','review_required','resolving',
     'ready_to_publish','publishing','published','failed'));

alter table public.bankone_import_batches
  drop constraint if exists bankone_import_batches_resolution_status_check;
alter table public.bankone_import_batches
  add constraint bankone_import_batches_resolution_status_check
  check (resolution_status in
    ('pending','review_required','in_progress','resolved','partially_resolved','failed'));

alter table public.bankone_import_batches
  drop constraint if exists bankone_import_batches_publication_status_check;
alter table public.bankone_import_batches
  add constraint bankone_import_batches_publication_status_check
  check (publication_status in
    ('unpublished','validating','ready','publishing','published','blocked','failed'));

-- The resume query: the newest unfinished import for this user.
create index if not exists idx_bankone_batches_open
  on public.bankone_import_batches (created_at desc)
  where publication_status <> 'published';

-- ---------------------------------------------------------------------------
-- 3. Per-decision resolution records. One row per (batch, kind, source value)
--    so every officer/branch decision is PERSISTENT, idempotent and auditable -
--    and the review screen can be rebuilt entirely from the database.
-- ---------------------------------------------------------------------------
create table if not exists public.bankone_officer_resolutions (
  id                uuid primary key default gen_random_uuid(),
  batch_id          uuid not null references public.bankone_import_batches(id) on delete cascade,
  raw_officer_name  text,
  normalized_name   text not null,
  -- null = deliberately left unresolved. Never auto-filled.
  employee_id       uuid references public.employees(id) on delete set null,
  decision          text not null default 'pending'
    check (decision in ('pending','mapped','created_employee','left_unresolved')),
  match_type        text,
  confidence        numeric,
  loan_count        integer not null default 0,
  outstanding_total numeric not null default 0,
  reason            text,
  decided_by        uuid references auth.users(id) on delete set null,
  decided_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- IDEMPOTENCY KEY: one decision per officer per batch. A double-click can never
-- create a second resolution, which is what made "Accept" unsafe before.
create unique index if not exists uq_bankone_officer_resolution
  on public.bankone_officer_resolutions (batch_id, normalized_name);

create table if not exists public.bankone_branch_resolutions (
  id                     uuid primary key default gen_random_uuid(),
  batch_id               uuid not null references public.bankone_import_batches(id) on delete cascade,
  raw_branch_name        text,
  normalized_branch_name text not null,
  branch_id              uuid references public.branches(id) on delete set null,
  decision               text not null default 'pending'
    check (decision in ('pending','mapped','split','unresolved')),
  mapping_method         text,
  loan_count             integer not null default 0,
  outstanding_total      numeric not null default 0,
  reason                 text,
  decided_by             uuid references auth.users(id) on delete set null,
  decided_at             timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create unique index if not exists uq_bankone_branch_resolution
  on public.bankone_branch_resolutions (batch_id, normalized_branch_name);

create index if not exists idx_bankone_branch_res_open
  on public.bankone_branch_resolutions (batch_id) where decision = 'pending';

-- The exact BankOne branch master as it appears in the source file. No
-- invented branches: these are the values actually present.
create table if not exists public.bankone_branch_master (
  id            uuid primary key default gen_random_uuid(),
  source_name   text not null,
  normalized_name text not null,
  branch_code   text,
  first_seen_batch_id uuid references public.bankone_import_batches(id) on delete set null,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);
create unique index if not exists uq_bankone_branch_master_norm
  on public.bankone_branch_master (normalized_name);

-- ---------------------------------------------------------------------------
-- 4. The PUBLISH TARGET. Branch-level and officer-level are SEPARATE tables on
--    purpose: branch metrics may use every branch-resolved loan, while officer
--    metrics may only use loans attributed to a verified employee. Unresolved
--    officer portfolio is stored as an explicit UNATTRIBUTED row so it stays
--    visible in reporting but can never leak into an individual's score.
-- ---------------------------------------------------------------------------
create table if not exists public.bankone_portfolio_snapshots (
  id                    uuid primary key default gen_random_uuid(),
  batch_id              uuid not null references public.bankone_import_batches(id) on delete cascade,
  as_at_date            date not null,
  report_type           text not null,
  source_filename       text,
  -- Authored by the publish RPC, never by the browser.
  published_by          uuid references auth.users(id) on delete set null,
  published_at          timestamptz not null default now(),
  -- Accounting. These must reconcile, and the publish gate enforces it.
  total_source_rows     integer not null,
  parsed_rows           integer not null,
  invalid_rows          integer not null,
  auto_resolved_rows    integer not null default 0,
  manually_resolved_rows integer not null default 0,
  unresolved_officer_rows integer not null default 0,
  resolved_branch_rows  integer not null default 0,
  unresolved_branch_rows integer not null default 0,
  total_outstanding     numeric not null default 0,
  non_performing_outstanding numeric not null default 0,
  par_ratio             numeric,
  status                text not null default 'published'
    check (status in ('published','superseded')),
  created_at            timestamptz not null default now()
);

create index if not exists idx_bankone_snapshots_asat
  on public.bankone_portfolio_snapshots (as_at_date desc, report_type);

-- One published snapshot per (report type, as-at date): a re-import replaces
-- the prior figure rather than double-counting it.
create unique index if not exists uq_bankone_snapshot_asat
  on public.bankone_portfolio_snapshots (report_type, as_at_date)
  where status = 'published';

-- Branch level: EVERY branch-resolved loan counts, resolved officer or not.
create table if not exists public.bankone_branch_snapshots (
  id                  uuid primary key default gen_random_uuid(),
  snapshot_id         uuid not null references public.bankone_portfolio_snapshots(id) on delete cascade,
  branch_id           uuid references public.branches(id) on delete set null,
  raw_branch_name     text,
  area_id             uuid references public.areas(id) on delete set null,
  loan_count          integer not null default 0,
  total_outstanding   numeric not null default 0,
  principal_outstanding numeric not null default 0,
  non_performing_count integer not null default 0,
  non_performing_outstanding numeric not null default 0,
  ecl_stage_1_outstanding numeric not null default 0,
  ecl_stage_2_outstanding numeric not null default 0,
  ecl_stage_3_outstanding numeric not null default 0,
  par_ratio           numeric,
  -- How much of this branch is NOT attributable to a named employee.
  unattributed_outstanding numeric not null default 0,
  unattributed_loan_count   integer not null default 0,
  created_at          timestamptz not null default now()
);
create index if not exists idx_bankone_branch_snap
  on public.bankone_branch_snapshots (snapshot_id);

-- Officer level: ONLY verified employees appear. There is deliberately no row
-- for an unresolved officer, so no performance figure can be invented.
create table if not exists public.bankone_officer_snapshots (
  id                  uuid primary key default gen_random_uuid(),
  snapshot_id         uuid not null references public.bankone_portfolio_snapshots(id) on delete cascade,
  employee_id         uuid not null references public.employees(id) on delete cascade,
  branch_id           uuid references public.branches(id) on delete set null,
  raw_officer_names   text[],
  loan_count          integer not null default 0,
  total_outstanding   numeric not null default 0,
  non_performing_count integer not null default 0,
  non_performing_outstanding numeric not null default 0,
  par_ratio           numeric,
  created_at          timestamptz not null default now()
);
create unique index if not exists uq_bankone_officer_snap
  on public.bankone_officer_snapshots (snapshot_id, employee_id);

-- ---------------------------------------------------------------------------
-- 5. RE-ISSUE confirm_bankone_branch_mapping.
--    The ONLY behavioural change is the reprocessing comparison: it now uses
--    bankone_norm_branch() so it matches the string the browser sent, and it
--    REPORTS how many rows it actually changed. A mapping that affects zero
--    rows is now visibly a failure instead of a fake success.
-- ---------------------------------------------------------------------------
create or replace function public.confirm_bankone_branch_mapping(
  p_normalized_bankone_branch_name text,
  p_bankone_branch_name            text,
  p_canonical_branch_id            uuid,
  p_mapping_type                   text default 'manual',
  p_split_from_branch_id           uuid default null,
  p_reason                         text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id          uuid;
  v_norm        text;
  v_affected    integer;
  v_batch_ids   uuid[];
  v_batch       uuid;
begin
  if not public.can_manage_bankone() then
    raise exception 'You are not allowed to change BankOne branch mappings.';
  end if;
  if p_canonical_branch_id is null then
    raise exception 'Choose the InfinityCore branch this BankOne branch maps to.';
  end if;
  if not exists (select 1 from public.branches where id = p_canonical_branch_id) then
    raise exception 'That InfinityCore branch does not exist.';
  end if;

  -- Normalize ON THE SERVER from the raw BankOne value, so the stored key can
  -- never drift from what the reprocessing step compares.
  v_norm := public.bankone_norm_branch(coalesce(p_bankone_branch_name, p_normalized_bankone_branch_name));
  if v_norm is null or v_norm = '' then
    raise exception 'A BankOne branch name is required.';
  end if;

  insert into public.bankone_branch_mappings
    (normalized_bankone_branch_name, bankone_branch_name, canonical_branch_id,
     mapping_type, status, created_by)
  values (v_norm, p_bankone_branch_name, p_canonical_branch_id,
          coalesce(p_mapping_type,'manual'), 'active', auth.uid())
  on conflict (normalized_bankone_branch_name) do update
    set canonical_branch_id = excluded.canonical_branch_id,
        bankone_branch_name  = excluded.bankone_branch_name,
        mapping_type         = excluded.mapping_type,
        status               = 'active',
        created_by           = auth.uid(),
        updated_at           = now()
  returning id into v_id;

  -- THE FIX: compare with the shared normalizer on BOTH sides.
  update public.bankone_import_rows
     set resolved_branch_id = p_canonical_branch_id,
         match_status = case when match_status = 'unresolved' then 'auto_resolved'
                             else match_status end
   where branch_name_raw is not null
     and public.bankone_norm_branch(branch_name_raw) = v_norm;
  get diagnostics v_affected = row_count;

  -- Record the decision for every batch that actually contained this branch,
  -- so the review screen is rebuilt from the database, not from React state.
  for v_batch in
    select distinct batch_id from public.bankone_import_rows
     where branch_name_raw is not null
       and public.bankone_norm_branch(branch_name_raw) = v_norm
  loop
    insert into public.bankone_branch_resolutions
      (batch_id, raw_branch_name, normalized_branch_name, branch_id,
       decision, mapping_method, loan_count, outstanding_total,
       reason, decided_by, decided_at)
    values
      (v_batch, p_bankone_branch_name, v_norm, p_canonical_branch_id,
       'mapped', coalesce(p_mapping_type,'manual'),
       (select count(*) from public.bankone_import_rows r
         where r.batch_id = v_batch
           and public.bankone_norm_branch(r.branch_name_raw) = v_norm),
       (select coalesce(sum(coalesce((r.normalized_data->>'total_outstanding')::numeric,0)),0)
          from public.bankone_import_rows r
         where r.batch_id = v_batch
           and public.bankone_norm_branch(r.branch_name_raw) = v_norm),
       p_reason, auth.uid(), now())
    on conflict (batch_id, normalized_branch_name) do update
      set branch_id = excluded.branch_id,
          decision = excluded.decision,
          mapping_method = excluded.mapping_method,
          loan_count = excluded.loan_count,
          outstanding_total = excluded.outstanding_total,
          decided_by = auth.uid(),
          decided_at = now(),
          updated_at = now();
  end loop;

  perform public.bankone_audit('BRANCH_MAPPING_CONFIRMED', 'bankone_branch_mapping', v_id::text,
    jsonb_build_object('bankone_branch', p_bankone_branch_name,
                       'normalized', v_norm,
                       'canonical_branch_id', p_canonical_branch_id,
                       'mapping_type', p_mapping_type,
                       'rows_affected', v_affected,
                       'reason', p_reason));

  return jsonb_build_object(
    'ok', true, 'id', v_id, 'normalized', v_norm,
    'rows_affected', v_affected);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. RE-ISSUE the officer decision RPCs so each one PERSISTS a resolution row.
--    Idempotency comes from uq_bankone_officer_resolution (batch + normalized
--    name), so a double-click updates the same row instead of duplicating.
-- ---------------------------------------------------------------------------
create or replace function public.confirm_bankone_employee_mapping(
  p_normalized_source_name text,
  p_bankone_source_name    text,
  p_employee_id            uuid,
  p_match_type             text default 'manual',
  p_confidence             numeric default 1,
  p_reason                 text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id        uuid;
  v_norm      text;
  v_affected  integer;
  v_batch     uuid;
begin
  if not public.can_manage_bankone() then
    raise exception 'You are not allowed to change BankOne officer mappings.';
  end if;
  if p_employee_id is null then
    raise exception 'Choose the employee this BankOne name refers to.';
  end if;
  if not exists (select 1 from public.employees where id = p_employee_id) then
    raise exception 'That employee does not exist.';
  end if;

  v_norm := public.bankone_norm_name(coalesce(p_bankone_source_name, p_normalized_source_name));
  if v_norm is null or v_norm = '' then
    raise exception 'A BankOne officer name is required.';
  end if;

  -- The PERMANENT mapping: future imports resolve this name automatically.
  insert into public.bankone_employee_mappings
    (bankone_source_name, normalized_source_name, employee_id, match_type,
     confidence, status, source, created_by)
  values (p_bankone_source_name, v_norm, p_employee_id,
          p_match_type, p_confidence, 'active', 'admin', auth.uid())
  on conflict (normalized_source_name) do update
    set employee_id = excluded.employee_id,
        match_type  = excluded.match_type,
        confidence  = excluded.confidence,
        status      = 'active',
        source      = 'admin',
        created_by  = auth.uid(),
        updated_at  = now()
  returning id into v_id;

  -- Reprocess: attribute every row of this officer, in EVERY batch.
  update public.bankone_import_rows
     set officer_employee_id = p_employee_id,
         employee_id = p_employee_id,
         match_status = 'auto_resolved',
         match_confidence = p_confidence
   where officer_employee_id is null
     and public.bankone_norm_name(officer_name_raw) = v_norm;
  get diagnostics v_affected = row_count;

  update public.bankone_unresolved_officers
     set status = 'mapped', updated_at = now()
   where normalized_source_name is not distinct from v_norm;

  for v_batch in
    select distinct batch_id from public.bankone_import_rows
     where public.bankone_norm_name(officer_name_raw) = v_norm
  loop
    insert into public.bankone_officer_resolutions
      (batch_id, raw_officer_name, normalized_name, employee_id,
       decision, match_type, confidence, loan_count, outstanding_total,
       reason, decided_by, decided_at)
    values
      (v_batch, p_bankone_source_name, v_norm, p_employee_id,
       'mapped', p_match_type, p_confidence,
       (select count(*) from public.bankone_import_rows r
         where r.batch_id = v_batch
           and public.bankone_norm_name(r.officer_name_raw) = v_norm),
       (select coalesce(sum(coalesce((r.normalized_data->>'total_outstanding')::numeric,0)),0)
          from public.bankone_import_rows r
         where r.batch_id = v_batch
           and public.bankone_norm_name(r.officer_name_raw) = v_norm),
       p_reason, auth.uid(), now())
    on conflict (batch_id, normalized_name) do update
      set employee_id = excluded.employee_id,
          decision = excluded.decision,
          match_type = excluded.match_type,
          confidence = excluded.confidence,
          loan_count = excluded.loan_count,
          outstanding_total = excluded.outstanding_total,
          decided_by = auth.uid(),
          decided_at = now(),
          updated_at = now();
  end loop;

  perform public.bankone_audit('OFFICER_MAPPING_CONFIRMED', 'bankone_employee_mapping', v_id::text,
    jsonb_build_object('source_name', p_bankone_source_name, 'normalized', v_norm,
                       'employee_id', p_employee_id, 'match_type', p_match_type,
                       'rows_affected', v_affected, 'reason', p_reason));

  return jsonb_build_object('ok', true, 'id', v_id, 'normalized', v_norm,
                            'rows_affected', v_affected);
end;
$$;

-- Leave unresolved: the portfolio stays UNATTRIBUTED. Nothing is assigned.
create or replace function public.mark_bankone_officer_unresolved(
  p_normalized_source_name text,
  p_bankone_source_name    text,
  p_reason                 text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id      uuid;
  v_norm    text;
  v_batch   uuid;
begin
  if not public.can_manage_bankone() then
    raise exception 'You are not allowed to change BankOne officer mappings.';
  end if;
  v_norm := public.bankone_norm_name(coalesce(p_bankone_source_name, p_normalized_source_name));
  if v_norm is null or v_norm = '' then
    raise exception 'A BankOne officer name is required.';
  end if;

  -- A deliberate "unresolved" is NOT the same as a permanent mapping: it must
  -- not resolve automatically on the next import, so it is recorded with
  -- status 'unresolved' and is skipped by the auto-resolution read.
  insert into public.bankone_employee_mappings
    (bankone_source_name, normalized_source_name, employee_id, match_type,
     confidence, status, source, created_by)
  values (p_bankone_source_name, v_norm, null, 'left_unresolved', 0,
          'unresolved', 'admin', auth.uid())
  on conflict (normalized_source_name) do update
    set status = 'unresolved',
        employee_id = null,
        match_type = excluded.match_type,
        confidence = 0,
        created_by = auth.uid(),
        updated_at = now()
  returning id into v_id;

  for v_batch in
    select distinct batch_id from public.bankone_import_rows
     where public.bankone_norm_name(officer_name_raw) = v_norm
  loop
    insert into public.bankone_officer_resolutions
      (batch_id, raw_officer_name, normalized_name, employee_id,
       decision, match_type, confidence, loan_count, outstanding_total,
       reason, decided_by, decided_at)
    values
      (v_batch, p_bankone_source_name, v_norm, null,
       'left_unresolved', 'left_unresolved', 0,
       (select count(*) from public.bankone_import_rows r
         where r.batch_id = v_batch
           and public.bankone_norm_name(r.officer_name_raw) = v_norm),
       (select coalesce(sum(coalesce((r.normalized_data->>'total_outstanding')::numeric,0)),0)
          from public.bankone_import_rows r
         where r.batch_id = v_batch
           and public.bankone_norm_name(r.officer_name_raw) = v_norm),
       p_reason, auth.uid(), now())
    on conflict (batch_id, normalized_name) do update
      set employee_id = null,
          decision = excluded.decision,
          match_type = excluded.match_type,
          confidence = 0,
          decided_by = auth.uid(),
          decided_at = now(),
          updated_at = now();
  end loop;

  perform public.bankone_audit('OFFICER_LEFT_UNRESOLVED', 'bankone_employee_mapping', v_id::text,
    jsonb_build_object('source_name', p_bankone_source_name, 'normalized', v_norm,
                       'reason', p_reason));

  return jsonb_build_object('ok', true, 'id', v_id, 'normalized', v_norm);
end;
$$;

-- Add as employee. Creates a PENDING employee from BankOne facts ONLY: no
-- email, phone, salary, designation, department, supervisor or RBAC role is
-- invented, and no sign-in account is created. Then the permanent mapping is
-- written and every affected loan is reprocessed automatically, so the user
-- never has to map those loans again.
create or replace function public.add_employee_from_bankone(
  p_bankone_source_name    text,
  p_normalized_source_name text,
  p_branch_name_raw        text default null,
  p_source_import_id       uuid default null,
  p_branch_id              uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp_id  uuid;
  v_emp_num text;
  v_norm    text;
  v_branch  uuid := p_branch_id;
  v_affected integer;
begin
  if not public.can_manage_bankone() then
    raise exception 'You are not allowed to add employees from a BankOne import.';
  end if;
  if p_bankone_source_name is null or btrim(p_bankone_source_name) = '' then
    raise exception 'A BankOne officer name is required.';
  end if;
  v_norm := public.bankone_norm_name(p_bankone_source_name);

  -- Resolve the branch when the caller knows the BankOne name but no id yet.
  if v_branch is null and p_branch_name_raw is not null then
    select b.id into v_branch
      from public.bankone_branch_mappings m
      join public.branches b on b.id = m.canonical_branch_id
     where m.normalized_bankone_branch_name = public.bankone_norm_branch(p_branch_name_raw)
       and m.status = 'active'
     limit 1;
  end if;

  -- Employee number follows the existing generator when one exists; it is NOT
  -- invented here.
  begin
    execute 'select public.generate_employee_number()' into v_emp_num;
  exception when others then
    v_emp_num := null;
  end;

  -- 'onboarding' is the EXISTING pending state for an employee record in this
  -- schema (see employees_employment_status_check). Using anything else would
  -- be inventing a status. No account, role or compensation is created.
  insert into public.employees
    (full_name, branch_id, employment_status, created_by)
  values
    (btrim(p_bankone_source_name), v_branch, 'onboarding', auth.uid())
  returning id into v_emp_id;

  update public.employees
     set employee_number = v_emp_num
   where id = v_emp_id and v_emp_num is not null;

  insert into public.bankone_created_employees
    (employee_id, bankone_source_name, normalized_source_name,
     branch_name_raw, source_import_id, verification_status, created_by)
  values (v_emp_id, p_bankone_source_name, v_norm, p_branch_name_raw,
          p_source_import_id, 'pending', auth.uid())
  on conflict do nothing;

  -- The PERMANENT mapping, so tomorrow's import resolves without a question.
  insert into public.bankone_employee_mappings
    (bankone_source_name, normalized_source_name, employee_id, match_type,
     confidence, status, source, created_by)
  values (p_bankone_source_name, v_norm, v_emp_id, 'manually_created_employee',
          1, 'active', 'admin', auth.uid())
  on conflict (normalized_source_name) do update
    set employee_id = excluded.employee_id,
        match_type = excluded.match_type,
        confidence = 1,
        status = 'active',
        source = 'admin',
        created_by = auth.uid(),
        updated_at = now();

  -- Reprocess every loan of this officer immediately.
  update public.bankone_import_rows
     set officer_employee_id = v_emp_id,
         employee_id = v_emp_id,
         match_status = 'auto_resolved',
         match_confidence = 1
   where officer_employee_id is null
     and public.bankone_norm_name(officer_name_raw) = v_norm;
  get diagnostics v_affected = row_count;

  update public.bankone_unresolved_officers
     set status = 'mapped', updated_at = now()
   where normalized_source_name is not distinct from v_norm;

  perform public.bankone_audit('EMPLOYEE_CREATED_FROM_BANKONE', 'employee', v_emp_id::text,
    jsonb_build_object('source_name', p_bankone_source_name, 'employee_id', v_emp_id,
                       'branch_name_raw', p_branch_name_raw,
                       'source_import_id', p_source_import_id,
                       'rows_reprocessed', v_affected));

  return jsonb_build_object('ok', true, 'employee_id', v_emp_id,
                            'employee_number', v_emp_num,
                            'branch_id', v_branch,
                            'rows_affected', v_affected);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. THE STATE READER. Everything the review page renders comes from here, so
--    a browser refresh resumes exactly where it left off and the summary can
--    never disagree with the resolution lists.
-- ---------------------------------------------------------------------------
create or replace function public.bankone_get_import_state(p_batch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  b          public.bankone_import_batches;
  v_officers jsonb;
  v_branches jsonb;
  v_summary  jsonb;
begin
  select * into b from public.bankone_import_batches where id = p_batch_id;
  if b.id is null then raise exception 'Import batch not found.'; end if;

  -- Officer decisions. Candidates come from the saved mappings so the UI can
  -- still show "possible employee" after a refresh.
  select coalesce(jsonb_agg(x order by x.loan_count desc, x.raw_officer_name), '[]'::jsonb)
    into v_officers
    from (
      select o.raw_officer_name,
             o.normalized_name,
             o.employee_id,
             e.full_name as employee_name,
             o.decision, o.match_type, o.confidence,
             o.loan_count, o.outstanding_total, o.reason, o.decided_at,
             (select jsonb_agg(jsonb_build_object(
                       'id', em.id, 'full_name', em.full_name,
                       'designation', d.title, 'department', em.department,
                       'branch', br.branch_name,
                       'employment_status', em.employment_status)
                        order by em.full_name)
                from public.bankone_employee_mappings m2
                join public.employees em on em.id = m2.employee_id
                left join public.designations d on d.id = em.designation_id
                left join public.branches br on br.id = em.branch_id
               where m2.normalized_source_name = o.normalized_name
                 and m2.status = 'active') as candidates
        from public.bankone_officer_resolutions o
        left join public.employees e on e.id = o.employee_id
       where o.batch_id = p_batch_id
    ) x;

  -- Branch decisions.
  select coalesce(jsonb_agg(x order by x.loan_count desc, x.raw_branch_name), '[]'::jsonb)
    into v_branches
    from (
      select br.raw_branch_name, br.normalized_branch_name, br.branch_id,
             cb.branch_name as branch_name, br.decision, br.mapping_method,
             br.loan_count, br.outstanding_total, br.reason, br.decided_at
        from public.bankone_branch_resolutions br
        left join public.branches cb on cb.id = br.branch_id
       where br.batch_id = p_batch_id
    ) x;

  -- LIVE summary, computed from the rows themselves, never from React state.
  select jsonb_build_object(
      'total_rows',    b.total_rows,
      'parsed_rows',   (select count(*) from public.bankone_import_rows r
                         where r.batch_id = p_batch_id),
      'invalid_rows',  coalesce(b.rejected_rows,0),
      'auto_matched_rows', (select count(*) from public.bankone_import_rows r
                             where r.batch_id = p_batch_id
                               and r.match_status = 'auto_resolved'),
      'resolved_officer_rows', (select count(*) from public.bankone_import_rows r
                             where r.batch_id = p_batch_id
                               and r.officer_employee_id is not null),
      'unresolved_officer_rows', (select count(*) from public.bankone_import_rows r
                             where r.batch_id = p_batch_id
                               and r.officer_employee_id is null),
      'resolved_branch_rows', (select count(*) from public.bankone_import_rows r
                             where r.batch_id = p_batch_id
                               and r.resolved_branch_id is not null),
      'unresolved_branch_rows', (select count(*) from public.bankone_import_rows r
                             where r.batch_id = p_batch_id
                               and r.resolved_branch_id is null),
      'officer_pending',   (select count(*) from public.bankone_officer_resolutions
                             where batch_id = p_batch_id and decision = 'pending'),
      'branch_pending',    (select count(*) from public.bankone_branch_resolutions
                             where batch_id = p_batch_id and decision = 'pending'),
      'resolved_outstanding', (select coalesce(sum(coalesce(
             (r.normalized_data->>'total_outstanding')::numeric,0)),0)
          from public.bankone_import_rows r
         where r.batch_id = p_batch_id and r.officer_employee_id is not null),
      'unattributed_outstanding', (select coalesce(sum(coalesce(
             (r.normalized_data->>'total_outstanding')::numeric,0)),0)
          from public.bankone_import_rows r
         where r.batch_id = p_batch_id and r.officer_employee_id is null),
      'unattributed_loan_count', (select count(*)
          from public.bankone_import_rows r
         where r.batch_id = p_batch_id and r.officer_employee_id is null)
    ) into v_summary;

  return jsonb_build_object(
    'ok', true,
    'batch', jsonb_build_object(
      'id', b.id, 'filename', b.filename, 'source_type', b.source_type,
      'operation_type', b.operation_type, 'as_at_date', b.as_at_date,
      'status', b.status, 'parsing_status', b.parsing_status,
      'resolution_status', b.resolution_status,
      'publication_status', b.publication_status,
      'error_message', b.error_message,
      'last_progress_at', b.last_progress_at,
      'created_at', b.created_at, 'published_at', b.published_at),
    'summary', v_summary,
    'officers', v_officers,
    'branches', v_branches);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. PUBLISH. Nothing becomes an official snapshot until the accounting
--    reconciles and every branch is resolved. Unresolved OFFICERS are allowed:
--    their loans stay in the branch totals and are excluded from officer
--    performance, exactly as required.
--
--    ACCOUNTING GATE (the anti-drop rule):
--       total_source_rows = parsed_rows + invalid_rows
--    If a single source row were ever silently lost, this raises and NOTHING is
--    published.
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
     total_outstanding, non_performing_outstanding, par_ratio, status)
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
$$;

-- ---------------------------------------------------------------------------
-- 9. Seed the persistent decision rows for a freshly parsed batch. Called once
--    per batch, idempotently, so the review screen has something to render and
--    every officer/branch in the FILE is represented (including the ones the
--    browser already auto-resolved).
-- ---------------------------------------------------------------------------
create or replace function public.bankone_seed_resolutions(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_officers integer;
  v_branches integer;
begin
  if not public.can_manage_bankone() then
    raise exception 'You are not allowed to seed BankOne import resolutions.';
  end if;

  -- The exact BankOne branch master: whatever the file contains, no more.
  insert into public.bankone_branch_master (source_name, normalized_name, first_seen_batch_id)
  select distinct r.branch_name_raw, public.bankone_norm_branch(r.branch_name_raw), p_batch_id
    from public.bankone_import_rows r
   where r.batch_id = p_batch_id
     and r.branch_name_raw is not null
     and public.bankone_norm_branch(r.branch_name_raw) <> ''
  on conflict (normalized_name) do nothing;

  -- Every officer in the file gets a decision row, so unresolved loans are
  -- retained and visible rather than dropped. Grouping collapses the
  -- auto-resolved and the pending names into ONE row per distinct source name.
  -- NB: min()/max() are not defined for uuid, so the employee id is taken with a
  -- correlated subquery; the grouping is therefore done over a MATERIALIZED CTE
  -- column, because a subquery may not reference a grouped-but-ungrouped column.
  with keyed as materialized (
    select r.batch_id,
           r.officer_name_raw,
           public.bankone_norm_name(r.officer_name_raw) as norm,
           r.officer_employee_id,
           r.resolved_branch_id,
           r.match_confidence,
           coalesce((r.normalized_data->>'total_outstanding')::numeric,0) as outstanding
      from public.bankone_import_rows r
     where r.batch_id = p_batch_id
  )
  insert into public.bankone_officer_resolutions
    (batch_id, raw_officer_name, normalized_name, employee_id,
     decision, match_type, confidence, loan_count, outstanding_total)
  select k.batch_id,
         min(k.officer_name_raw),
         k.norm,
         (select k2.officer_employee_id from keyed k2
           where k2.norm = k.norm and k2.officer_employee_id is not null limit 1),
         case when exists (select 1 from keyed k3
                            where k3.norm = k.norm and k3.officer_employee_id is not null)
              then 'mapped' else 'pending' end,
         case when exists (select 1 from keyed k3
                            where k3.norm = k.norm and k3.officer_employee_id is not null)
              then 'existing_mapping' else null end,
         max(k.match_confidence),
         count(*),
         sum(k.outstanding)
    from keyed k
   where k.officer_name_raw is not null and k.norm <> ''
   group by k.batch_id, k.norm
  on conflict (batch_id, normalized_name) do nothing;
  get diagnostics v_officers = row_count;

  with keyed as materialized (
    select r.batch_id,
           r.branch_name_raw,
           public.bankone_norm_branch(r.branch_name_raw) as norm,
           r.resolved_branch_id,
           coalesce((r.normalized_data->>'total_outstanding')::numeric,0) as outstanding
      from public.bankone_import_rows r
     where r.batch_id = p_batch_id
  )
  insert into public.bankone_branch_resolutions
    (batch_id, raw_branch_name, normalized_branch_name, branch_id,
     decision, mapping_method, loan_count, outstanding_total)
  select k.batch_id,
         min(k.branch_name_raw),
         k.norm,
         (select k2.resolved_branch_id from keyed k2
           where k2.norm = k.norm and k2.resolved_branch_id is not null limit 1),
         case when exists (select 1 from keyed k3
                            where k3.norm = k.norm and k3.resolved_branch_id is not null)
              then 'mapped' else 'pending' end,
         case when exists (select 1 from keyed k3
                            where k3.norm = k.norm and k3.resolved_branch_id is not null)
              then 'auto' else null end,
         count(*),
         sum(k.outstanding)
    from keyed k
   where k.branch_name_raw is not null and k.norm <> ''
   group by k.batch_id, k.norm
  on conflict (batch_id, normalized_branch_name) do nothing;
  get diagnostics v_branches = row_count;

  update public.bankone_import_batches
     set needs_review_rows = (select count(*) from public.bankone_officer_resolutions
                               where batch_id = p_batch_id and decision = 'pending'),
         unmatched_rows = (select count(*) from public.bankone_import_rows
                            where batch_id = p_batch_id and officer_employee_id is null),
         branch_issue_rows = (select count(*) from public.bankone_branch_resolutions
                               where batch_id = p_batch_id and decision = 'pending'),
         last_progress_at = now(), updated_at = now()
   where id = p_batch_id;

  perform public.bankone_audit('IMPORT_PARSED', 'bankone_import_batch', p_batch_id::text,
    jsonb_build_object('officers_seeded', v_officers, 'branches_seeded', v_branches));

  return jsonb_build_object('ok', true, 'officers_seeded', v_officers,
                            'branches_seeded', v_branches);
end;
$$;

-- The newest unfinished import, so a refresh can offer "Resume import".
create or replace function public.bankone_get_open_imports(p_limit integer default 10)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', b.id, 'filename', b.filename, 'as_at_date', b.as_at_date,
           'source_type', b.source_type, 'operation_type', b.operation_type,
           'parsing_status', b.parsing_status,
           'resolution_status', b.resolution_status,
           'publication_status', b.publication_status,
           'error_message', b.error_message,
           'total_rows', b.total_rows,
           'last_progress_at', b.last_progress_at,
           'created_at', b.created_at)
         order by b.created_at desc), '[]'::jsonb)
    from public.bankone_import_batches b
   where b.publication_status <> 'published'
   limit greatest(coalesce(p_limit, 10), 1);
$$;

-- ---------------------------------------------------------------------------
-- 10. RLS. Reads follow the existing import read policy; every WRITE goes
--     through the SECURITY DEFINER RPCs above, which are role gated and
--     audited. No client may mutate a resolution or a snapshot directly.
-- ---------------------------------------------------------------------------
alter table public.bankone_officer_resolutions enable row level security;
alter table public.bankone_branch_resolutions  enable row level security;
alter table public.bankone_branch_master       enable row level security;
alter table public.bankone_portfolio_snapshots  enable row level security;
alter table public.bankone_branch_snapshots    enable row level security;
alter table public.bankone_officer_snapshots   enable row level security;

drop policy if exists "bankone_officer_resolutions_read" on public.bankone_officer_resolutions;
create policy "bankone_officer_resolutions_read" on public.bankone_officer_resolutions
  for select to authenticated using (public.can_manage_bankone());

drop policy if exists "bankone_branch_resolutions_read" on public.bankone_branch_resolutions;
create policy "bankone_branch_resolutions_read" on public.bankone_branch_resolutions
  for select to authenticated using (public.can_manage_bankone());

drop policy if exists "bankone_branch_master_read" on public.bankone_branch_master;
create policy "bankone_branch_master_read" on public.bankone_branch_master
  for select to authenticated using (true);

drop policy if exists "bankone_snapshots_read" on public.bankone_portfolio_snapshots;
create policy "bankone_snapshots_read" on public.bankone_portfolio_snapshots
  for select to authenticated using (public.can_manage_bankone());

drop policy if exists "bankone_branch_snapshots_read" on public.bankone_branch_snapshots;
create policy "bankone_branch_snapshots_read" on public.bankone_branch_snapshots
  for select to authenticated using (public.can_manage_bankone());

drop policy if exists "bankone_officer_snapshots_read" on public.bankone_officer_snapshots;
create policy "bankone_officer_snapshots_read" on public.bankone_officer_snapshots
  for select to authenticated using (public.can_manage_bankone());

-- Direct writes are revoked; the RPCs own all mutation.
revoke insert, update, delete on public.bankone_officer_resolutions from anon, authenticated;
revoke insert, update, delete on public.bankone_branch_resolutions  from anon, authenticated;
revoke insert, update, delete on public.bankone_branch_master       from anon, authenticated;
revoke insert, update, delete on public.bankone_portfolio_snapshots  from anon, authenticated;
revoke insert, update, delete on public.bankone_branch_snapshots    from anon, authenticated;
revoke insert, update, delete on public.bankone_officer_snapshots   from anon, authenticated;
revoke all on public.bankone_officer_resolutions from anon;
revoke all on public.bankone_branch_resolutions  from anon;
revoke all on public.bankone_portfolio_snapshots  from anon;
revoke all on public.bankone_branch_snapshots    from anon;
revoke all on public.bankone_officer_snapshots   from anon;

grant select on public.bankone_officer_resolutions to authenticated;
grant select on public.bankone_branch_resolutions  to authenticated;
grant select on public.bankone_branch_master       to authenticated;
grant select on public.bankone_portfolio_snapshots to authenticated;
grant select on public.bankone_branch_snapshots   to authenticated;
grant select on public.bankone_officer_snapshots  to authenticated;

-- ---------------------------------------------------------------------------
-- 11. Grants.
-- ---------------------------------------------------------------------------
grant execute on function public.bankone_norm_branch(text)      to authenticated, service_role;
grant execute on function public.bankone_norm_name(text)        to authenticated, service_role;
grant execute on function public.bankone_get_import_state(uuid) to authenticated;
grant execute on function public.bankone_get_open_imports(integer) to authenticated;
grant execute on function public.bankone_seed_resolutions(uuid) to authenticated;
grant execute on function public.bankone_publish_snapshot(uuid) to authenticated;

revoke all on function public.bankone_publish_snapshot(uuid) from anon;
revoke all on function public.bankone_seed_resolutions(uuid) from anon;

comment on function public.bankone_publish_snapshot is
  'Publishes a BankOne import into the branch/officer snapshot tables. Refuses unless total_source_rows = parsed_rows + invalid_rows and every loan has a branch identity. Unresolved officers are allowed and stay unattributed; they are excluded from officer-level performance by construction.';
comment on function public.bankone_get_import_state is
  'The single source of truth for the import review screen: batch lifecycle, live summary and every persisted officer/branch decision. A browser refresh loses nothing.';
comment on function public.bankone_norm_branch is
  'MUST stay byte-identical to normalizeBranch() in src/domains/bankone/normalize.js. The reprocessing UPDATEs compare the browser''s normalized value against this, so any drift silently matches zero rows again.';

-- ---------------------------------------------------------------------------
-- 7b. The publish verdict, WITHOUT raising. The UI calls this to show the exact
--     reason before the user presses Publish, and after a failed publish it can
--     persist 'blocked' - which the publish function itself can never do,
--     because a RAISE aborts the transaction and rolls the status write back.
-- ---------------------------------------------------------------------------
create or replace function public.bankone_validate_publish(p_batch_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with b as (select * from public.bankone_import_batches where id = p_batch_id),
  counts as (
    select
      (select count(*) from public.bankone_import_rows r where r.batch_id = p_batch_id) as parsed,
      (select count(*) from public.bankone_import_rows r
        where r.batch_id = p_batch_id and r.resolved_branch_id is null) as branch_pending,
      (select count(*) from public.bankone_officer_resolutions o
        where o.batch_id = p_batch_id and o.decision = 'pending') as officer_pending
  )
  select jsonb_build_object(
    'ok', true,
    'batch_id', p_batch_id,
    'total_source_rows', coalesce(b.total_rows, 0),
    'parsed_rows', c.parsed,
    'invalid_rows', coalesce(b.rejected_rows, 0),
    'unresolved_branch_rows', c.branch_pending,
    'officer_decisions_pending', c.officer_pending,
    -- The accounting gate, stated as DATA so the caller can persist it.
    'reconciles', (coalesce(b.total_rows, 0) = c.parsed + coalesce(b.rejected_rows, 0)),
    -- Officers may stay unresolved; branch identity may not.
    'can_publish', (coalesce(b.total_rows, 0) = c.parsed + coalesce(b.rejected_rows, 0))
                   and c.branch_pending = 0,
    'blockers', (
      select coalesce(jsonb_agg(x.msg), '[]'::jsonb) from (
        select 'Row accounting does not reconcile: ' || coalesce(b.total_rows,0)
               || ' source rows but ' || c.parsed || ' parsed + '
               || coalesce(b.rejected_rows,0) || ' invalid.' as msg
          where coalesce(b.total_rows, 0) <> c.parsed + coalesce(b.rejected_rows, 0)
        union all
        select c.branch_pending || ' loan(s) still have no branch identity. Map every BankOne branch before publishing.' as msg
          where c.branch_pending > 0
      ) x
    )
  )
    from b cross join counts c;
$$;

-- Persist the verdict. Deliberately separate from the read, so 'blocked'
-- survives the publish failure that triggered it.
create or replace function public.bankone_mark_publication_blocked(
  p_batch_id uuid,
  p_reason   text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_manage_bankone() then
    raise exception 'You are not allowed to change BankOne import state.';
  end if;
  update public.bankone_import_batches
     set publication_status = 'blocked',
         error_message = p_reason,
         last_progress_at = now(),
         updated_at = now()
   where id = p_batch_id;
  perform public.bankone_audit('IMPORT_BATCH_FAILED', 'bankone_import_batch', p_batch_id::text,
    jsonb_build_object('reason', p_reason, 'publication_status', 'blocked'));
  return jsonb_build_object('ok', true, 'publication_status', 'blocked');
end;
$$;

comment on function public.bankone_validate_publish is
  'Reports whether a batch may be published, and why not, WITHOUT raising. Used by the UI to show the real blocker and to persist publication_status = blocked after a failed publish (a RAISE would roll that write back).';

-- Granted here, after every function above exists.
grant execute on function public.bankone_validate_publish(uuid) to authenticated;
grant execute on function public.bankone_mark_publication_blocked(uuid, text) to authenticated;
revoke all on function public.bankone_mark_publication_blocked(uuid, text) from anon;

commit;











