# Director Intelligence — Phase 0 Discovery

**Date:** 2026-10-10 · **Branch:** `feat/director-intelligence-deepdive` · **Repo:** `infinitycore-sara-di`

Phase 0 is the map everything else is built on: what schema already existed, what
the Director Intelligence phases (1–3) added on top, the exact contracts, and what
was verified **live** against the Supabase database — including four defects found
and fixed during this discovery pass.

---

## 1. How to re-verify (live)

```bash
PSQL=/opt/homebrew/opt/libpq/bin/psql          # libpq via Homebrew; no bare `psql` on PATH
DSN=$(cat supabase/.temp/pooler-url)           # session-pooler URI (never commit/print it)
T=supabase/tests
$PSQL "$DSN" -X -q -t -A -v ON_ERROR_STOP=1 -f $T/20261110000006_idempotency_test.sql
$PSQL "$DSN" -X -q -t -A -v ON_ERROR_STOP=1 -f $T/20261110000009_director_rpc_test.sql
$PSQL "$DSN" -X -q -t -A -v ON_ERROR_STOP=1 -f $T/20261110000009_director_reconciliation_test.sql
```

All three tests run inside ONE transaction and **ROLL BACK** — production rows are
never written by tests (`director_metric_values` and `mpr_targets` are 0 after).

---

## 2. Pre-existing schema the feature stands on (discovered, not created)

### Organisation
| Object | Notes |
|---|---|
| `employees` (232 rows) | `id, full_name, employee_code, department, "position", branch_id, employment_status, is_archived …` — the staff spine for every RPC |
| `branches` (21 rows) | `branch_name, manager_id …` |
| `areas`, `branch_area_assignments(is_current)` | area-manager scoping |
| `departments` + `department_label()` | normalised department label used in filters |

### MPR scoring engine (the single source of truth — reused, never re-implemented)
| Object | Contract |
|---|---|
| `mpr_targets` | one row per `(employee_id, metric_code, period_label)`; `target_value`/`actual_value`. Metric codes read by the engine: `disbursement_value`, `total_outstanding_principal`, `pass_watch`, `substandard`, `doubtful`, `lost`, `case_load` |
| `compute_mpr_score(p_employee_id, p_period_label, p_branch_id)` | returns `{disbursement_score(35) + par_score(35) + caseload_score(30), subtotal, total, complete, missing[], par_percent, at_risk_principal, total_outstanding_principal, grade, grade_rating, grade_hex, badge}`. **Grade/total only when `complete=true`** (all three components measured) |
| `mpr_par_score(par_pct)` | PAR % → points via `mpr_par_bands` (1–30d/31–60d/61–90d/90+ ladder); returns NULL if no band matches (never fakes 0) |
| `mpr_ratio_score(actual, target, max)` | NULL propagation when unmeasured; `least(max, actual/target*max)` |
| `mpr_grade_for_score(score)` | returns `TABLE(grade, rating, hex_code, range_label)` — **4 TEXT columns** (important: see Finding F1) |
| `mpr_grade_bands` | 5 rows A–E, `hex_code` is text like `#059669` |
| `attendance_records` | attendance rate metric = `present / 20 * 100` over the range |

### Data-import + permissions foundations
- `bankone_import_batches` — carries `file_sha256` + partial unique index for file dedup.
- `current_role()` — session role claim; `has_permission(key)` → `_permission_state(auth.uid(), key).allowed`.
- `can_manage_bankone()` — write gate for import/upsert paths.
- Director RPCs are gated on `current_role() IN (md_ceo, chairman, director, super_admin) AND has_permission('director.executive.read')`.

---

## 3. What phases 1–3 added (migrations `20261110000006`–`20261110000013`)

### Phase 1 — multi-metric store (tables)
| Table | Purpose | RLS |
|---|---|---|
| `director_metric_definitions` (11 rows) | editable metric vocabulary: `portfolio, par_amount, par_pct, pass_watch, substandard, doubtful, lost, caseload_count, caseload_amount, disbursement_amount, disbursement_count` with unit + `snapshot_metric` semantics stored as DATA | read for authenticated |
| `director_metric_values` (0 rows) | ONE row per `(employee_id, as_of_date, metric_key)`; unique key `uq_director_metric_values_key` | SELECT gate: `can_manage_bankone OR director.executive.read OR performance.read` |
| `director_metric_values_history` (0 rows) | append-only audit of every overwrite (`insert / update / conflict_confirmed`) | read-only |
| `director_metric_settings` (1 row) | `min_caseload_for_ranking=0`, `bucket_dpd_thresholds` (1–30→pass_watch … 91+→lost), `status_bucket_map` — no hard-coded thresholds anywhere | read/write |
| `director_import_mapping_templates` (0 rows) | saved column-mapping templates for the import screen | read/write |

### Phase 2 — server RPCs (all `SECURITY DEFINER`, `SET search_path`, same role+permission gate)
| RPC | Returns |
|---|---|
| `director_filter_options()` | branches, area managers, departments, positions in caller scope |
| `director_scorecards(p_start,p_end,p_branch_ids,p_area_ids,p_department_ids,p_positions)` | bank/scope scorecard: portfolio, disbursement vs target, PAR (amount/%/buckets), caseload, overall score+grade, previous-period compare, per-metric `imported` flag |
| `director_branch_breakdown(...)` | branch ranking (rank, portfolio, disbursement+achievement, PAR %, score, grade, rank change), manager + area-manager blocks, per-branch top/bottom 5 |
| `director_branch_staff(p_branch_id,...,p_sort_by,p_sort_dir)` | one branch's staff: caseload, disbursement actual/target/%, PAR %, buckets, attendance rate+punctuality, target/overall score, grade — sortable server-side |
| `director_top_staff(...,p_n=5)` | bank-wide best/worst N **flat rows** `{full_name, employee_code, branch_name, position, caseload, overall_score, grade, grade_hex, par_pct, …}` + `per_branch.{branch_id}.{top,bottom}` |
| `director_upsert_metric_values(p_rows,p_batch_id,p_confirm_conflicts)` | single-transaction idempotent commit; only present keys updated; conflicts surfaced unless confirmed |
| `director_latest_asof(p_end)`, `director_metric_values_sync_unit()` | helpers used by the RPCs |

Scores are ALWAYS computed once, server-side, by `compute_mpr_score()` — web and
mobile only format what the RPC returns.

### Phase 3 — web consumers
- Routes (nav-gated): `/director` (`DirectorDashboard`, `DIRECTOR_EXECUTIVE_READ`), `/director-intelligence` (deep dive, same permission), `/director-metric-import` (`BANKONE_READ`).
- `src/services/directorIntelligenceService.js` wraps the four read RPCs; `src/components/directorIntelligence/*` render scorecards, global filter bar, branch/staff tables, best/worst lists; `formatScorecard*.js` are pure formatters covered by `tests/directorIntelligence_formatters.test.mjs`.
- Contract assumption: **best/worst/per-branch rows are flat** (fields directly on the element).

---

## 4. Live verification (2026-10-10, against the Supabase staging DB)

| Check | Result |
|---|---|
| `20261110000006_idempotency_test.sql` | **PASS (exit 0)** — A(8 inserts) → B(caseload-only: 0 inserts, 2 updates, other metrics untouched) → A again (0 changes); history 8+2=10 rows; unconfirmed conflict stored value unchanged; confirmed conflict wins + `action=conflict_confirmed`; ROLLBACK → 0 rows |
| `20261110000009_director_rpc_test.sql` | **PASS (exit 0)** — hr_officer rejected on all 3 gated RPCs with `insufficient_permissions: director.executive.read`; scorecards/breakdown/branch_staff shapes OK; `PASS top_staff: best=Ajisegbede … score=87.17 grade=B (flat)`; ROLLBACK → 0 rows |
| `20261110000009_director_reconciliation_test.sql` | **PASS (exit 0)** — RECON 1/1b/2/3 all match direct SQL (bank 1,600,000,000 = sum of staff = sum of branches; one-branch + one-department filters match); `complete=true, grade B, par 2.25%`; new hard assertions PASS; ROLLBACK → `values=0, targets=0` |
| Node tests (Phase 1 + 3) | `tests/directorMetricImport.test.mjs` (7) and `tests/directorIntelligence_formatters.test.mjs` pass |

Live row counts after everything: `director_metric_values=0`, `history=0`,
`mpr_targets=0`, `metric_definitions=11`, `settings=1`, `employees=232`,
`branches=21`, `bankone_import_batches=5`. **Production data untouched.**

---

## 5. Findings fixed during this discovery pass

**F1 — `compute_mpr_score` grade lookup was broken live (fixed: migration `20261110000013`).**
The live function declared `v_grade public.mpr_grade_bands` (a COMPOSITE) but filled
it with `select g.* into v_grade from mpr_grade_for_score(...)`, which returns
`TABLE(grade, rating, hex_code, range_label)` — all text. plpgsql assigns composite
targets **positionally**, so `hex_code` (`'#059669'`) was cast into `min_score
(numeric)` → `invalid input syntax for type numeric: "#059669"` on **every complete
score**, breaking `director_top_staff` (and any graded row). Fixed by selecting into
three **scalar** text variables (`v_grade, v_rating, v_hex`).

**F2 — why the obvious rollback to `v_grade record` also fails.**
The RETURN arms use `v_grade is not null`. Verified live: `IS NULL` on an
*unassigned* record returns `true`, but `IS NOT NULL` raises
`record "v_grade" is not assigned yet` — and SQL does **not** short-circuit
`false AND <expr>`. Scalar variables avoid the whole class of problem; this is why
migration 0013 uses them instead of the canonical `record`.

**F3 — `director_top_staff` returned nested rows (fixed: edited migration `…012`, re-applied).**
`jsonb_agg(x)` aggregated the wrapper composite, producing
`{"rn":1,"f":{…}}` instead of flat rows — the frontend (`s.full_name`) and the RPC
test (`best->0->>full_name`) would have seen `undefined`. Now aggregates `x.f
order by x.rn`. `per_branch` rows were already flat.

**F4 — reconciliation test could never reach `complete=true` (fixed: test edit + hard assertions).**
`compute_mpr_score` reads `target_value` then **overwrites** `v_portfolio` with
`actual_value` for `total_outstanding_principal`; the seed had `actual=NULL`, so PAR
had no denominator → `missing=['par']` forever. Seed now populates `actual_value`,
and both SQL tests gained `RAISE EXCEPTION` assertions (flat row, complete+graded,
portfolio equality) so they fail loudly instead of only printing numbers.

---

## 6. Known state / next steps

- **No metric data imported yet** (`director_metric_values=0`, `mpr_targets=0`) — the
  scorecards will report `imported=false` per metric until an operator uploads a file
  at `/director-metric-import` (SHA-256 dedup, conflict confirm, coverage tab).
- Migrations `…006`–`…013` are applied on staging; the branch ships them for
  `apply-migration-remote.sh` on deploy; rollbacks for `…006` and `…013` live in
  `supabase/manual/`.
- Mobile (Director Intelligence on Flutter) is a separate phase and should consume the
  exact RPC contracts in §3 — no second formula, no client-side weights.


