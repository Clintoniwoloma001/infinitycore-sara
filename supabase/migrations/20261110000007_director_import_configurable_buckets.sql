-- ============================================================================
-- 20261110000007_director_import_configurable_buckets.sql  (PHASE 1)
-- ============================================================================
-- WHY: the brief forbids hard-coding the days-past-due bucket limits and the
-- caseload minimum. PAR buckets already come from mpr_par_bands (points per PAR
-- % band) and grades from mpr_grade_bands — both editable tables the scoring
-- engine reads. What is NOT yet configurable is (a) how a raw loan STATUS string
-- maps to the four PAR buckets, and (b) the minimum caseload a staff member must
-- have to appear in best/worst rankings. Both are stored here as editable rows
-- with sane defaults so nothing is hard-coded in application code.
--
-- Additive + idempotent. Run AFTER 20261110000006.
-- ============================================================================

begin;

-- A single-row settings bag for Director Intelligence / import behaviour. Kept in
-- a table (not code) so the operator can edit it without a deploy. upserted by
-- save_director_metric_settings() below.
create table if not exists public.director_metric_settings (
  id                       boolean primary key default true check (id),
  -- Minimum caseload (active client loans) a staff member must have to be
  -- eligible for best/worst rankings. NULL/0 = no minimum.
  min_caseload_for_ranking integer not null default 0,
  -- Days-past-due thresholds that define each PAR bucket when the source sheet
  -- gives days_overdue instead of a status label. lower<=dpd for that bucket.
  -- Stored as an ordered array of {metric_key, min_dpd}. The first row whose
  -- range contains the dpd wins.
  bucket_dpd_thresholds    jsonb not null default '[
      {"metric_key":"pass_watch","min_dpd":1},
      {"metric_key":"substandard","min_dpd":90},
      {"metric_key":"doubtful","min_dpd":180},
      {"metric_key":"lost","min_dpd":365}
    ]'::jsonb,
  -- Which raw STATUS strings count as performing (NOT in the PAR numerator).
  performing_status_values  jsonb not null default '["performing","current","active"]'::jsonb,
  -- Raw STATUS -> bucket metric_key, used when the sheet carries a label.
  status_bucket_map         jsonb not null default '{
      "pass and watch":"pass_watch",
      "pass & watch":"pass_watch",
      "pwl":"pass_watch",
      "watch":"pass_watch",
      "sub standard":"substandard",
      "substandard":"substandard",
      "doubtful":"doubtful",
      "lost":"lost"
    }'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

comment on table public.director_metric_settings is
  'Editable Director Intelligence / import settings: minimum caseload for rankings, days-past-due bucket thresholds, performing status values, and the raw STATUS -> bucket map. Everything the brief says must be configurable lives here with a default the operator can change; nothing is hard-coded in application code.';

alter table public.director_metric_settings enable row level security;

drop policy if exists "director_metric_settings_read" on public.director_metric_settings;
create policy "director_metric_settings_read" on public.director_metric_settings
  for select to authenticated using (public.can_manage_bankone() or public.has_permission('director.executive.read'));

drop policy if exists "director_metric_settings_write" on public.director_metric_settings;
create policy "director_metric_settings_write" on public.director_metric_settings
  for all to authenticated using (public.can_manage_bankone()) with check (public.can_manage_bankone());

revoke all on public.director_metric_settings from anon;

-- Ensure the single row exists (idempotent).
insert into public.director_metric_settings (id) values (true) on conflict (id) do nothing;

commit;
