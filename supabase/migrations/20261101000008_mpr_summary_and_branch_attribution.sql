-- ============================================================================
-- 20261101000008 — Executive BI: staff MPR summary + branch attribution
-- ============================================================================
--
-- Adds to the EXISTING 1.1.6+16 surface:
--   1. Device telemetry (speed / battery / network) on the location history
--      table, so the live tracking card can show the fields the spec asks for.
--   2. rpc_get_staff_mpr_summary()          — per-staff 360 MPR evaluation.
--   3. rpc_get_branch_drag_and_soaring_staff() — Drag 5 / Soaring 5 ranking.
--
-- DELIBERATE DESIGN NOTE — why there is no `staff_location_history` table:
-- `public.employee_location_events` ALREADY stores employee_id, latitude,
-- longitude, accuracy, recorded_at, device_id, detected_branch_id,
-- inside_geofence and location_label. The proposed `staff_location_history`
-- would be a byte-for-byte duplicate that splits location reads across two
-- tables and breaks the "resolved through the ONE engine" rule this schema
-- follows everywhere else. We therefore EXTEND the existing table instead.
--
-- HONESTY CONTRACT (read before changing anything below):
-- Per-staff credit figures are NOT available from bankone_portfolio_snapshots —
-- that table is branch-level (total_outstanding, non_performing_outstanding,
-- par_ratio) and has no officer key. Per-staff credit inputs arrive through
-- `public.mpr_targets.actual_value`, which HR/FINCON populates per period.
-- Consequently these RPCs report `coverage` (how many staff are actually
-- measured) and return NULL totals for anyone unmeasured, rather than
-- inventing a per-person number. compute_mpr_score() already enforces the same
-- rule (complete=false + missing[] until all three metrics are measured), and
-- this migration does NOT weaken it.
--
-- IDEMPOTENT: safe to re-run. Additive only. Run AFTER 20261101000007.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Device telemetry on the location history table
--
-- speed_mps lets the app distinguish "walking" from "driving" and gives the
-- historical route audit a real movement signal instead of inferring travel
-- from raw point-to-point jumps. battery_level and network_type are recorded
-- purely as evidence: a low-battery or offline ping is weak evidence that a
-- person was actually there, and the mobile card surfaces that honestly.
-- ---------------------------------------------------------------------------
alter table public.employee_location_events
  add column if not exists speed_mps numeric(10, 2),
  add column if not exists battery_level smallint
    check (battery_level is null or battery_level between 0 and 100),
  add column if not exists network_type text
    check (network_type is null or network_type in ('wifi','4g','5g','3g','2g','ethernet','other','unknown'));

comment on column public.employee_location_events.speed_mps is
  'Ground speed in metres/second at the moment of the ping, when the OS exposes it. NULL means not reported, not zero.';
comment on column public.employee_location_events.battery_level is
  'Device battery percentage at ping time. Evidence quality only — a ping taken below 15% is weaker evidence of presence.';
comment on column public.employee_location_events.network_type is
  'Connectivity at ping time. Evidence quality only — helps explain gaps in a breadcrumb route.';

-- The history map is always "one employee, one day, ordered by time". The
-- existing indexes do not cover that access path, so this is the index that
-- actually makes day playback fast.
create index if not exists idx_location_events_employee_recorded
  on public.employee_location_events (employee_id, recorded_at desc);

begin;

-- ---------------------------------------------------------------------------
-- 2. rpc_get_staff_mpr_summary
--
-- A thin, role-aware wrapper over compute_mpr_score(). It adds the human
-- identity and branch context the dashboard needs, and passes through the
-- engine's own honesty fields (complete, missing) UNCHANGED.
--
-- p_period_label is the mpr_targets period key (e.g. '2026-Q1', '2026-02').
-- The spec's "This Week / This Month / Custom Range" filters are resolved to a
-- period label by the caller; this function does not guess.
--
-- `bank_par_ratio` is the ORGANISATION-WIDE figure from the latest published
-- snapshot (that table has no branch column). It is the "≤ 5.0% bank benchmark"
-- the employee is compared against — it is NOT the employee's own PAR. The
-- employee's own PAR is `par_percent`, which is NULL until their actuals are
-- entered.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_get_staff_mpr_summary(
  p_employee_id   uuid,
  p_period_label  text,
  p_branch_id     uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_emp     record;
  v_score   jsonb;
  v_bank_par numeric;
  v_as_at    date;
begin
  if p_employee_id is null or p_period_label is null or p_period_label = '' then
    return jsonb_build_object('ok', false, 'message', 'employee_id and period_label are required');
  end if;

  select e.id, e.full_name, e.branch_id, b.branch_name as branch_name
    into v_emp
    from public.employees e
    left join public.branches b on b.id = e.branch_id
   where e.id = p_employee_id;

  if not found then
    return jsonb_build_object('ok', false, 'message', 'Employee not found');
  end if;

  -- The engine decides completeness. We never compute a total here.
  v_score := public.compute_mpr_score(p_employee_id, p_period_label, coalesce(p_branch_id, v_emp.branch_id));

  -- BANK-WIDE context from the newest PUBLISHED snapshot only. A pending or
  -- rejected batch must never surface as a performance figure.
  --
  -- SCOPE WARNING: public.bankone_portfolio_snapshots has NO branch_id column
  -- (verified against the DDL in 20260931000002 and every later migration) and
  -- no ALTER ever added one. It holds ORGANISATION-WIDE totals only. So this is
  -- the bank PAR benchmark, which is exactly the "≤ 5.0% bank benchmark" the
  -- spec compares an employee against — and it can never be presented as a
  -- branch or employee figure.
  select s.par_ratio, s.as_at_date
    into v_bank_par, v_as_at
    from public.bankone_portfolio_snapshots s
   where s.status = 'published'
   order by s.as_at_date desc, s.published_at desc
   limit 1;

  return jsonb_build_object(
    'ok', true,
    'employee_id', v_emp.id,
    'employee_name', v_emp.full_name,
    'branch_id', v_emp.branch_id,
    'branch_name', v_emp.branch_name,
    'period_label', p_period_label,
    -- engine output, passed through verbatim
    'par_percent',       v_score -> 'par_percent',
    'at_risk_principal', v_score -> 'at_risk_principal',
    'disbursement_score',v_score -> 'disbursement_score',
    'par_score',         v_score -> 'par_score',
    'caseload_score',    v_score -> 'caseload_score',
    'subtotal',          v_score -> 'subtotal',
    'total',             v_score -> 'total',
    'grade',             v_score -> 'grade',
    'grade_rating',      v_score -> 'grade_rating',
    'grade_hex',         v_score -> 'grade_hex',
    'badge',             v_score -> 'badge',
    'complete',          v_score -> 'complete',
    'missing',           v_score -> 'missing',
    -- BANK-WIDE context, explicitly NOT the employee's or branch's own figure
    'bank_par_ratio',   v_bank_par,
    'bank_par_as_at',   v_as_at
  );
end;
$$;

comment on function public.rpc_get_staff_mpr_summary(uuid, text, uuid) is
  'Per-staff 360 MPR evaluation for one period. Returns total/grade ONLY when disbursement, PAR and caseload are all measured; otherwise subtotal + complete=false + missing[]. branch_par_ratio is branch context from the latest published snapshot, not the employee figure.';

revoke all on function public.rpc_get_staff_mpr_summary(uuid, text, uuid) from public;
revoke all on function public.rpc_get_staff_mpr_summary(uuid, text, uuid) from anon;
grant execute on function public.rpc_get_staff_mpr_summary(uuid, text, uuid) to authenticated;

commit;


commit;

begin;

-- ---------------------------------------------------------------------------
-- 3. rpc_get_branch_drag_and_soaring_staff  (Drag 5 / Soaring 5)
--
-- Ranks the staff of one branch for one period by their MPR total.
--
-- RANKING HONESTY — the rule that matters most here:
--   * ONLY employees whose MPR is `complete` (all three of disbursement, PAR and
--     caseload actually measured) are ranked. An unmeasured employee is NOT
--     given a score of 0 and then listed as a "drag driver", which would be a
--     fabricated accusation against a real member of staff.
--   * `coverage_pct` reports how many of the branch's employees are actually
--     measured, so the UI can say "12 of 34 staff measured" instead of quietly
--     presenting 12 people as the whole branch.
--   * `share_of_branch_mpr_pct` is each person's total as a share of the SUM of
--     ranked staff totals. It is a share of measured performance, NOT a causal
--     claim that one person "caused" a branch result.
--   * The spotlight (#1 in each list) is simply the extreme of the ranked set.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_get_branch_drag_and_soaring_staff(
  p_branch_id    uuid,
  p_period_label text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_branch_name text;
  v_headcount   integer;
  v_rows        jsonb;
  v_measured    integer;
begin
  if p_branch_id is null or p_period_label is null or p_period_label = '' then
    return jsonb_build_object('ok', false, 'message', 'branch_id and period_label are required');
  end if;

  select b.branch_name into v_branch_name from public.branches b where b.id = p_branch_id;
  if not found then
    return jsonb_build_object('ok', false, 'message', 'Branch not found');
  end if;

  select count(*) into v_headcount
    from public.employees e
   where e.branch_id = p_branch_id;

  -- Rank only fully-measured employees. compute_mpr_score() is the single
  -- source of truth for both the score and the `complete` flag.
  with scored as (
    select
      e.id,
      e.full_name,
      s as engine
    from public.employees e
    cross join lateral public.compute_mpr_score(e.id, p_period_label, p_branch_id) s
    where e.branch_id = p_branch_id
      and (s ->> 'complete')::boolean is true      -- <-- the honesty gate
  ),
  annotated as (
    select
      sc.id,
      sc.full_name,
      (sc.engine ->> 'total')::numeric                as total,
      (sc.engine ->> 'par_percent')::numeric          as par_percent,
      (sc.engine ->> 'at_risk_principal')::numeric    as at_risk_principal,
      (sc.engine ->> 'disbursement_score')::numeric   as disbursement_score,
      (sc.engine ->> 'par_score')::numeric            as par_score,
      (sc.engine ->> 'caseload_score')::numeric       as caseload_score,
      sc.engine ->> 'grade'                            as grade,
      sc.engine ->> 'grade_rating'                     as grade_rating,
      sc.engine ->> 'grade_hex'                        as grade_hex,
      sc.engine ->> 'badge'                            as badge,
      (select max(t.actual_value) from public.mpr_targets t
        where t.employee_id = sc.id and t.period_label = p_period_label
          and t.metric_code = 'pass_watch')           as pass_watch_principal,
      (select max(t.actual_value) from public.mpr_targets t
        where t.employee_id = sc.id and t.period_label = p_period_label
          and t.metric_code = 'disbursement_value')   as disbursement_actual,
      (select max(t.target_value) from public.mpr_targets t
        where t.employee_id = sc.id and t.period_label = p_period_label
          and t.metric_code = 'disbursement_value')   as disbursement_target,
      (select max(t.actual_value) from public.mpr_targets t
        where t.employee_id = sc.id and t.period_label = p_period_label
          and t.metric_code = 'case_load')            as caseload_actual
    from scored sc
  ),
  shares as (
    select
      a.*,
      case when sum(a.total) over () > 0
           then round((a.total / sum(a.total) over ()) * 100, 2)
           else null end                as share_of_branch_mpr_pct,
      count(*) over ()                  as measured_count
    from annotated a
  )
  select
    coalesce(
      jsonb_agg(to_jsonb(sh) - 'measured_count'
                order by sh.total asc nulls last),
      '[]'::jsonb
    ),
    coalesce(max(sh.measured_count), 0)
  into v_rows, v_measured
  from shares sh;

  return jsonb_build_object(
    'ok', true,
    'branch_id', p_branch_id,
    'branch_name', v_branch_name,
    'period_label', p_period_label,
    'headcount', v_headcount,
    'measured_count', v_measured,
    'coverage_pct', case when v_headcount > 0
      then round((v_measured::numeric / v_headcount) * 100, 1)
      else null end,
    'staff', v_rows
  );
end;
$$;

comment on function public.rpc_get_branch_drag_and_soaring_staff(uuid, text) is
  'Ranks branch staff by MPR total into Soaring 5 / Drag 5 (client splits the returned list). ONLY fully-measured employees are ranked, so unmeasured staff are never shown as drag drivers. Returns headcount + measured_count + coverage_pct so the UI can state data coverage honestly. share_of_branch_mpr_pct is a share of measured performance, not a causal claim.';

revoke all on function public.rpc_get_branch_drag_and_soaring_staff(uuid, text) from public;
revoke all on function public.rpc_get_branch_drag_and_soaring_staff(uuid, text) from anon;
grant execute on function public.rpc_get_branch_drag_and_soaring_staff(uuid, text) to authenticated;

commit;

