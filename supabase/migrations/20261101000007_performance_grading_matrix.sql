-- ============================================================================
-- 20261101000007 — MPR performance grading matrix (Infinity Microfinance Bank)
-- ============================================================================
--
-- Implements the FINCON induction blueprint EXACTLY:
--
--   Total MPR Score (100 pts) = Disbursement Score (35)
--                              + PAR Score (35)
--                              + Caseload Score (30)
--
-- This is a DISCRETE POINT-AWARD engine, not a weighted-average engine:
--   * PAR scores by a fixed band table (35/30/20/15/7.5/0 on PAR %).
--   * Disbursement and Caseload are capped linear ratios: min(max, ratio x max).
--
-- The JS engine in src/domains/performance/mprEngine.js is the single source of
-- truth and is mirrored here function-for-function. tests/performanceScoring.test.mjs
-- pins both to identical expectations so the two cannot silently drift.
--
-- IDEMPOTENT: safe to re-run. Additive: creates new objects and does not alter
-- any column that carries data. Run AFTER 20261101000006.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Metric catalogue
--
-- CAUTION: public.performance_metrics ALREADY EXISTS from an earlier phase with
-- a different shape (metric_name / metric_code / score_weight) and is referenced
-- by the Phase 67 rules-builder config. A `create table if not exists` with our
-- shape would silently do NOTHING against the real table and then fail on the
-- FK. So we ADD only the columns this engine needs and reuse the existing ones.
-- ---------------------------------------------------------------------------
alter table public.performance_metrics
  add column if not exists lower_is_better boolean not null default false,
  add column if not exists sort_order integer not null default 100;

comment on column public.performance_metrics.lower_is_better is
  'TRUE for metrics where a LOWER value is the good outcome (PAR %, watchlist loans). Drives ratio selection in compute_mpr_score(): higher-is-better uses Actual/Target, lower-is-better uses Target/Actual.';

-- ---------------------------------------------------------------------------
-- 2. MPR inputs — one row per employee per period per metric.
--
-- actual_value NULL means "NOT MEASURED", which is deliberately distinct from 0
-- ("measured, and it was zero"). Unmeasured metrics are EXCLUDED from the total
-- rather than scored 0, so an employee is never penalised for missing data.
-- ---------------------------------------------------------------------------
create table if not exists public.mpr_targets (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  metric_code text not null,
  period_label text not null,
  branch_id uuid references public.branches(id) on delete cascade,
  period_start date,
  period_end date,
  target_value numeric(18,2) not null,
  actual_value numeric(18,2),
  weight numeric(6,2) not null default 0,
  status text not null default 'draft'
    check (status in ('draft','submitted','approved','locked')),
  created_by uuid references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_mpr_targets_employee_period
  on public.mpr_targets (employee_id, period_label);

-- One row per employee/metric/period/branch. NULL branch is coalesced to the nil
-- uuid so the unique index still applies — Postgres treats NULLs as distinct in
-- a plain unique index, which would permit duplicate org-wide targets.
create unique index if not exists uq_mpr_targets_scope
  on public.mpr_targets (
    employee_id, metric_code, period_label,
    coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

comment on table public.mpr_targets is
  'Per-employee MPR inputs: target_value and actual_value for disbursement, PAR buckets and caseload. actual_value NULL = not yet measured (excluded from the score); 0 = measured and zero.';
-- ---------------------------------------------------------------------------
-- 3. Grade bands — the spec table, as data so DB / UI / export all agree.
-- ---------------------------------------------------------------------------
create table if not exists public.mpr_grade_bands (
  grade text primary key check (grade in ('A','B','C','D','E')),
  rating text not null,
  min_score numeric(5,2) not null,
  max_score numeric(5,2) not null,
  hex_code text not null,
  range_label text not null,
  sort_order integer not null default 100
);

insert into public.mpr_grade_bands
  (grade, rating, min_score, max_score, hex_code, range_label, sort_order)
values
  ('A','EXCELLENT',       90, 100, '#10B981', '90 - 100',  10),
  ('B','VERY GOOD',       76,  89, '#059669', '76 - 89',   20),
  ('C','GOOD',            65,  75, '#F59E0B', '65 - 75',   30),
  ('D','AVERAGE',         60,  64, '#F97316', '60 - 64',   40),
  ('E','UNSATISFACTORY',  0,   59, '#EF4444', 'Below 60',  50)
on conflict (grade) do update
  set rating      = excluded.rating,
      min_score   = excluded.min_score,
      max_score   = excluded.max_score,
      hex_code    = excluded.hex_code,
      range_label = excluded.range_label,
      sort_order  = excluded.sort_order;

comment on table public.mpr_grade_bands is
  'Grade bands A-E with the approved rating, hex colour and display range. Matching uses the descending min_score THRESHOLD, not a min/max range test: the spec''s integer ranges (76-89, 90-100) leave a gap between 89 and 90 in which no band would match.';

-- ---------------------------------------------------------------------------
-- 4. PAR band table — the spec table, as data.
--
-- max_par_pct is an INCLUSIVE UPPER BOUND. The spec writes "0% - 4%" then
-- "4.1% - 5%", leaving a decimal gap: a PAR of 4.05% would match no row and be
-- scored 0 as though it exceeded 10%. Inclusive bounds (<=4.0, <=5.0, ...) are
-- continuous and gap-free while preserving every stated boundary and value.
-- ---------------------------------------------------------------------------
create table if not exists public.mpr_par_bands (
  id integer generated always as identity primary key,
  max_par_pct numeric(5,2),          -- NULL = no ceiling
  points numeric(5,2) not null,
  range_label text not null,
  assessment text not null,
  sort_order integer not null default 100
);

comment on table public.mpr_par_bands is
  'PAR % band table. max_par_pct is an INCLUSIVE UPPER BOUND; NULL means no ceiling. Points are awarded per band, never prorated.';
-- Seed the PAR bands. Re-running is safe: the seed is applied only when the
-- table is empty, so an operator's later corrections are never stomped.
do $$
begin
  if not exists (select 1 from public.mpr_par_bands) then
    insert into public.mpr_par_bands
      (max_par_pct, points, range_label, assessment, sort_order)
    values
      (4.0,  35.0, '0% - 4.0%',    'Optimal Risk Control',           10),
      (5.0,  30.0, '4.1% - 5.0%',  'CBN Benchmark Baseline (<= 5%)', 20),
      (6.0,  20.0, '5.1% - 6.0%',  'Sub-optimal',                    30),
      (7.0,  15.0, '6.1% - 7.0%',  'High Risk',                      40),
      (10.0,  7.5, '7.1% - 10.0%', 'Critical Risk',                  50),
      (null,  0.0, '> 10.0%',      'Non-performing Risk',            60);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Grade from total score
--
-- Threshold match (score >= min_score), NOT a min/max range test — see the note
-- on mpr_grade_bands for why the spec's integer ranges leave gaps.
-- ---------------------------------------------------------------------------
create or replace function public.mpr_grade_for_score(p_score numeric)
returns table (grade text, rating text, hex_code text, range_label text)
language sql
stable
security invoker
set search_path = public
as $$
  select b.grade, b.rating, b.hex_code, b.range_label
    from public.mpr_grade_bands b
   where p_score is not null
     and p_score >= b.min_score
   order by b.min_score desc
   limit 1;
$$;

comment on function public.mpr_grade_for_score(numeric) is
  'Maps a total MPR score to its A-E grade via the descending min_score threshold. Returns no row when the score is NULL (nothing measured).';

-- ---------------------------------------------------------------------------
-- 6. PAR % -> points, via the inclusive-upper-bound band table.
-- ---------------------------------------------------------------------------
create or replace function public.mpr_par_score(p_par_pct numeric)
returns numeric
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_points numeric;
begin
  if p_par_pct is null or p_par_pct < 0 then
    return null;
  end if;
  select b.points into v_points
    from public.mpr_par_bands b
   where b.max_par_pct is null
      or p_par_pct <= b.max_par_pct
   order by b.max_par_pct asc nulls last
   limit 1;
  -- Falling off the end (no band matched and no NULL-ceiling fallback row) means
  -- the band table is incomplete; surface NULL rather than inventing a 0 that
  -- would silently score real risk as perfect.
  return v_points;
end;
$$;

comment on function public.mpr_par_score(numeric) is
  'PAR % -> points, using the inclusive-upper-bound band table. NULL in, NULL out.';

-- ---------------------------------------------------------------------------
-- 7. Capped ratio score for Disbursement (max 35) and Caseload (max 30)
--
--   score = min(max, actual / target * max)
--
-- actual NULL ("not measured") or target NULL/0 yields NULL, never 0 — an
-- unmeasured metric must not be scored as zero, which would punish an employee
-- for data we do not have.
-- ---------------------------------------------------------------------------
create or replace function public.mpr_ratio_score(
  p_actual numeric,
  p_target numeric,
  p_max numeric
)
returns numeric
language plpgsql
immutable
security invoker
set search_path = public
as $$
begin
  if p_actual is null then
    return null;                                 -- not measured
  end if;
  if p_target is null or p_target <= 0 then
    return null;                                 -- undefined ratio
  end if;
  return round(least(p_max, (p_actual / p_target) * p_max), 2);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. compute_mpr_score — the one scoring entry point (mirrors evaluateMpr in JS)
--
--   Total MPR Score = Disbursement (35) + PAR (35) + Caseload (30)
--
-- Reads one employee/period's inputs from mpr_targets and returns the three
-- component scores, PAR %, total and grade.
--
-- The total and grade are returned ONLY when all three components are measured.
-- When one is unmeasured the subtotal is still returned, but `complete` is false
-- and `total`/`grade` are NULL — so a dashboard can never rank someone on a
-- third of their score while looking authoritative.
-- ---------------------------------------------------------------------------
create or replace function public.compute_mpr_score(
  p_employee_id uuid,
  p_period_label text,
  p_branch_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_vals jsonb;
  v_disb_target numeric; v_disb_actual numeric;
  v_pass_watch numeric := 0; v_substandard numeric := 0;
  v_doubtful numeric := 0;   v_lost numeric := 0;
  v_portfolio numeric;
  v_caseload_target numeric; v_caseload_actual numeric;

  v_at_risk numeric;
  v_par_pct numeric;
  v_par_score numeric;
  v_disb_score numeric;
  v_caseload_score numeric;
  v_subtotal numeric;
  v_complete boolean;
  v_missing text[] := '{}';
  v_grade record;
begin
  -- Pull every input this period into named variables. Each metric is a row in
  -- mpr_targets keyed by metric_code, so adding a metric later needs no code
  -- change here beyond one variable pair.
  select
    max(t.target_value) filter (where t.metric_code = 'disbursement_value'),
    max(t.actual_value) filter (where t.metric_code = 'disbursement_value'),
    max(t.target_value) filter (where t.metric_code = 'pass_watch'),
    max(t.actual_value) filter (where t.metric_code = 'pass_watch'),
    max(t.target_value) filter (where t.metric_code = 'substandard'),
    max(t.actual_value) filter (where t.metric_code = 'substandard'),
    max(t.target_value) filter (where t.metric_code = 'doubtful'),
    max(t.actual_value) filter (where t.metric_code = 'doubtful'),
    max(t.target_value) filter (where t.metric_code = 'lost'),
    max(t.actual_value) filter (where t.metric_code = 'lost'),
    max(t.target_value) filter (where t.metric_code = 'total_outstanding_principal'),
    max(t.actual_value) filter (where t.metric_code = 'total_outstanding_principal'),
    max(t.target_value) filter (where t.metric_code = 'case_load'),
    max(t.actual_value) filter (where t.metric_code = 'case_load')
    into
    v_disb_target, v_disb_actual,
    v_pass_watch, v_pass_watch,
    v_substandard, v_substandard,
    v_doubtful, v_doubtful,
    v_lost, v_lost,
    v_portfolio, v_portfolio,
    v_caseload_target, v_caseload_actual
    from public.mpr_targets t
   where t.employee_id = p_employee_id
     and t.period_label = p_period_label
     and (p_branch_id is null or t.branch_id is null or t.branch_id = p_branch_id);

  -- PAR numerator: the four non-performing buckets are the ACTUAL values; the
  -- target columns carry the portfolio's total outstanding principal.
  v_at_risk := coalesce(v_pass_watch, 0) + coalesce(v_substandard, 0)
             + coalesce(v_doubtful, 0) + coalesce(v_lost, 0);

  if v_portfolio is not null and v_portfolio > 0 then
    v_par_pct := round((v_at_risk / v_portfolio) * 100, 4);
  elsif v_at_risk = 0 then
    v_par_pct := 0;                                  -- genuinely 0% PAR
  else
    v_par_pct := null;                               -- bad denominator, no score
  end if;

  v_par_score      := public.mpr_par_score(v_par_pct);
  v_disb_score     := public.mpr_ratio_score(v_disb_actual, v_disb_target, 35);
  v_caseload_score := public.mpr_ratio_score(v_caseload_actual, v_caseload_target, 30);

  if v_disb_score is null     then v_missing := array_append(v_missing, 'disbursement'); end if;
  if v_par_score is null      then v_missing := array_append(v_missing, 'par'); end if;
  if v_caseload_score is null then v_missing := array_append(v_missing, 'caseload'); end if;
  v_complete := coalesce(array_length(v_missing, 1), 0) = 0;

  v_subtotal := round(coalesce(v_disb_score, 0) + coalesce(v_par_score, 0)
                      + coalesce(v_caseload_score, 0), 2);

  if v_complete then
    select g.* into v_grade from public.mpr_grade_for_score(v_subtotal) g;
  end if;

  return jsonb_build_object(
    'ok', true,
    'employee_id', p_employee_id,
    'period_label', p_period_label,
    'par_percent', v_par_pct,
    'at_risk_principal', v_at_risk,
    'total_outstanding_principal', v_portfolio,
    'disbursement_score', v_disb_score,
    'par_score', v_par_score,
    'caseload_score', v_caseload_score,
    'subtotal', v_subtotal,
    'complete', v_complete,
    'missing', to_jsonb(v_missing),
    'total', case when v_complete then v_subtotal else null end,
    'grade', case when v_complete then v_grade.grade else null end,
    'grade_rating', case when v_complete then v_grade.rating else null end,
    'grade_hex', case when v_complete then v_grade.hex_code else null end,
    'badge', case when v_complete then v_grade.grade || ' - ' || v_grade.rating else null end
  );
end;
$$;

comment on function public.compute_mpr_score(uuid, text, uuid) is
  'Weighted MPR evaluation: Disbursement (35) + PAR (35) + Caseload (30) = 100. Returns total and grade ONLY when all three components are measured; otherwise subtotal with complete=false and a missing[] list.';

revoke all on function public.compute_mpr_score(uuid, text, uuid) from public;
revoke all on function public.compute_mpr_score(uuid, text, uuid) from anon;
grant execute on function public.compute_mpr_score(uuid, text, uuid) to authenticated;

commit;
comment on function public.mpr_ratio_score(numeric, numeric, numeric) is
  'min(max, actual/target x max) with NULL propagation for unmeasured inputs. Used for Disbursement (max 35) and Caseload (max 30).';