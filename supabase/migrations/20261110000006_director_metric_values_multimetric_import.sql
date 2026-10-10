-- ============================================================================
-- 20261110000006_director_metric_values_multimetric_import.sql  (PHASE 1)
-- ============================================================================
-- WHY: the BankOne import publishes AGGREGATE snapshots only (portfolio / branch
-- / officer: total_outstanding, non_performing_outstanding, par_ratio). There is
-- no per-employee PAR bucket split, no caseload count, and mpr_targets (the MPR
-- scoring input) is empty. This adds ONE canonical value table — one row per
-- (employee_id, as_of_date, metric_key) — written by the import, read by the
-- Phase 2 scorecards. It does NOT add a second scoring formula; the MPR engine
-- (compute_mpr_score / mpr_par_score / mpr_ratio_score / mpr_grade_for_score)
-- is unchanged and stays the only producer of a score or grade.
--
-- RULES: additive + idempotent only; no destructive SQL; one value per key with
-- a unique constraint; a later file updates ONLY the metrics it contains and
-- never nulls/zeroes the rest; every overwrite is recorded in a history table;
-- file SHA-256 dedup; conflicts surfaced not silently overwritten; weights /
-- targets / days-past-due bucket limits are NEVER hard-coded here (the scoring
-- engine reads them from mpr_par_bands / mpr_grade_bands / settings).
--
-- Run AFTER 20261110000005. begin/commit so a failure applies nothing.
-- ============================================================================

begin;

-- 1. Metric vocabulary — DATA, not a CHECK list, so a metric can be added with
--    no constraint-dropping migration. unit: amount|count|percent.
--    snapshot_metric=true -> point-in-time (latest as-of <= range end);
--    snapshot_metric=false -> a FLOW summed over the range (disbursement).
create table if not exists public.director_metric_definitions (
  metric_key        text primary key,
  label             text not null,
  unit              text not null check (unit in ('amount','count','percent')),
  snapshot_metric   boolean not null default true,
  in_par_numerator  boolean not null default false,
  is_portfolio      boolean not null default false,
  is_caseload       boolean not null default false,
  is_disbursement   boolean not null default false,
  sort_order        integer not null default 100,
  description       text
);

comment on table public.director_metric_definitions is
  'Vocabulary of metric_key values the multi-metric import may store and the Director scorecards render. snapshot_metric=true means point-in-time (latest as-of <= range end); false means a flow summed over the range. Weights/targets/bucket limits are NOT stored here — the scoring engine reads them from mpr_par_bands/mpr_grade_bands/settings.';

insert into public.director_metric_definitions
  (metric_key, label, unit, snapshot_metric, in_par_numerator, is_portfolio, is_caseload, is_disbursement, sort_order, description)
values
  ('portfolio',        'Loan portfolio (outstanding)', 'amount',  true,  false, true,  false, false, 10, 'Total outstanding principal, point-in-time.'),
  ('par_amount',       'PAR amount (at-risk principal)', 'amount', true, true, false, false, false, 20, 'Sum of the four non-performing buckets.'),
  ('par_pct',          'PAR %', 'percent', true, false, false, false, false, 30, 'PAR amount / portfolio x 100.'),
  ('pass_watch',       'Pass & Watch', 'amount', true, true, false, false, false, 40, 'Pass & Watch bucket outstanding.'),
  ('substandard',      'Substandard', 'amount', true, true, false, false, false, 50, 'Substandard bucket outstanding.'),
  ('doubtful',         'Doubtful', 'amount', true, true, false, false, false, 60, 'Doubtful bucket outstanding.'),
  ('lost',             'Lost', 'amount', true, true, false, false, false, 70, 'Lost bucket outstanding.'),
  ('caseload_count',   'Caseload (active client loans)', 'count', true, false, false, true, false, 80, 'Active client loan count, point-in-time.'),
  ('caseload_amount',  'Caseload amount', 'amount', true, false, false, true, false, 85, 'Caseload principal, when the sheet carries it.'),
  ('disbursement_amount', 'Disbursement (booked in range)', 'amount', false, false, false, false, true, 90, 'FLOW: principal booked over the date range.'),
  ('disbursement_count',  'Disbursement count', 'count', false, false, false, false, true, 95, 'FLOW: loans booked over the date range.')
on conflict (metric_key) do update
  set label=excluded.label, unit=excluded.unit, snapshot_metric=excluded.snapshot_metric,
      in_par_numerator=excluded.in_par_numerator, is_portfolio=excluded.is_portfolio,
      is_caseload=excluded.is_caseload, is_disbursement=excluded.is_disbursement,
      sort_order=excluded.sort_order, description=excluded.description;

-- 2. The value store. ONE row per (employee_id, as_of_date, metric_key). unit is
--    denormalised for query simplicity but a trigger keeps it consistent with the
--    definition table so the importer can never mislabel a unit.
create table if not exists public.director_metric_values (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references public.employees(id) on delete cascade,
  as_of_date      date not null,
  metric_key      text not null references public.director_metric_definitions(metric_key) on delete restrict,
  value           numeric(20,4) not null,
  unit            text not null check (unit in ('amount','count','percent')),
  source_batch_id uuid references public.bankone_import_batches(id) on delete set null,
  imported_at     timestamptz not null default now(),
  imported_by     uuid references auth.users(id) on delete set null,
  updated_at      timestamptz not null default now(),
  constraint uq_director_metric_values_key unique (employee_id, as_of_date, metric_key)
);

create index if not exists idx_director_metric_values_date
  on public.director_metric_values (as_of_date, metric_key);
create index if not exists idx_director_metric_values_emp
  on public.director_metric_values (employee_id, metric_key, as_of_date desc);
create index if not exists idx_director_metric_values_batch
  on public.director_metric_values (source_batch_id);

comment on table public.director_metric_values is
  'Canonical per-employee metric values written by the multi-metric import and read by the Director scorecards. ONE row per (employee_id, as_of_date, metric_key). A later import updates only the metric keys it contains and never nulls/zeroes the others. Never holds a target or weight — those live in mpr_targets / settings and are joined at score time.';

alter table public.director_metric_values enable row level security;

drop policy if exists "director_metric_values_read" on public.director_metric_values;
create policy "director_metric_values_read" on public.director_metric_values
  for select to authenticated
  using (
    public.can_manage_bankone()
    or public.has_permission('director.executive.read')
    or public.has_permission('performance.read')
  );

revoke insert, update, delete on public.director_metric_values from anon, authenticated;
revoke all on public.director_metric_values from anon;
grant select on public.director_metric_values to authenticated;

create or replace function public.director_metric_values_sync_unit()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_unit text;
begin
  select unit into v_unit from public.director_metric_definitions where metric_key = new.metric_key;
  if v_unit is not null then new.unit := v_unit; end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_director_metric_values_sync_unit on public.director_metric_values;
create trigger trg_director_metric_values_sync_unit
  before insert or update on public.director_metric_values
  for each row execute function public.director_metric_values_sync_unit();

-- 3. History. EVERY overwrite writes one row (old, new, batch, who, when).
--    Append-only: the current value is always recoverable from the newest prior
--    history row, so nothing is ever lost.
create table if not exists public.director_metric_values_history (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null,
  as_of_date      date not null,
  metric_key      text not null,
  old_value       numeric(20,4),
  new_value       numeric(20,4) not null,
  unit            text not null,
  old_batch_id    uuid,
  new_batch_id    uuid,
  action          text not null check (action in ('insert','update','conflict_confirmed')),
  changed_by      uuid references auth.users(id) on delete set null,
  changed_at      timestamptz not null default now()
);

create index if not exists idx_dmv_history_key
  on public.director_metric_values_history (employee_id, as_of_date, metric_key, changed_at desc);

comment on table public.director_metric_values_history is
  'Append-only audit of every value written to director_metric_values. action=insert is the first value; action=update is a later file replacing it; action=conflict_confirmed is a conflict the operator chose to resolve by letting the newer value win.';

alter table public.director_metric_values_history enable row level security;

drop policy if exists "director_metric_values_history_read" on public.director_metric_values_history;
create policy "director_metric_values_history_read" on public.director_metric_values_history
  for select to authenticated
  using (
    public.can_manage_bankone()
    or public.has_permission('director.executive.read')
    or public.has_permission('performance.read')
  );

revoke insert, update, delete on public.director_metric_values_history from anon, authenticated;
revoke all on public.director_metric_values_history from anon;
grant select on public.director_metric_values_history to authenticated;

-- 4. File SHA-256 dedup on the batch table. Additive column + partial unique
--    index (non-null only) so legacy rows are untouched and re-uploading the
--    identical file is detectable.
alter table public.bankone_import_batches
  add column if not exists file_sha256 text;

comment on column public.bankone_import_batches.file_sha256 is
  'SHA-256 of the uploaded file bytes. Re-uploading an identical file is detected here and shown as "already imported on <date> by <user>" unless the operator ticks re-import anyway.';

create unique index if not exists uq_bankone_import_batches_sha256
  on public.bankone_import_batches (file_sha256)
  where file_sha256 is not null;

-- 5. Saved mapping templates for the multi-metric MPR sheet. Kept separate from
--    bankone_column_mappings (the generic transaction import) so the two never
--    collide. mapping maps a canonical field to the header text found in the
--    file; fuzzy_synonyms lists accepted variants. Only BankOne managers write.
create table if not exists public.director_import_mapping_templates (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  mapping         jsonb not null,
  fuzzy_synonyms  jsonb not null default '{}'::jsonb,
  is_default      boolean not null default false,
  created_by      uuid references auth.users(id) on delete set null,
  created_by_name text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists uq_director_import_mapping_name
  on public.director_import_mapping_templates (name);

comment on table public.director_import_mapping_templates is
  'Saved, editable column-mapping templates for the multi-metric MPR sheet. Only BankOne managers may write.';

alter table public.director_import_mapping_templates enable row level security;

drop policy if exists "director_import_mapping_templates_read" on public.director_import_mapping_templates;
create policy "director_import_mapping_templates_read" on public.director_import_mapping_templates
  for select to authenticated using (public.can_manage_bankone());

drop policy if exists "director_import_mapping_templates_write" on public.director_import_mapping_templates;
create policy "director_import_mapping_templates_write" on public.director_import_mapping_templates
  for all to authenticated
  using (public.can_manage_bankone())
  with check (public.can_manage_bankone());

revoke all on public.director_import_mapping_templates from anon;

commit;

