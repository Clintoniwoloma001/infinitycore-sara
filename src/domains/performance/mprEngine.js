/**
 * ============================================================================
 * MPR (Monthly Performance Review) scoring engine — Infinity Microfinance Bank
 * ============================================================================
 *
 * THE SPEC, verbatim. This module is the single source of truth for every MPR
 * number in the product. The SQL engine in
 *   supabase/migrations/20261101000007_performance_grading_matrix.sql
 * mirrors it function-for-function, and `tests/performanceScoring.test.mjs`
 * pins BOTH to the same expectations so they cannot silently drift apart.
 *
 *   Total MPR Score (100 pts) = Disbursement (35)
 *                            + PAR (35)
 *                            + Caseload (30)
 *
 * NOTE ON THE ORIGINAL SPEC'S "Target / Actual": applied literally that
 * REVERSES both metrics it is used on — a loan officer who disburses twice
 * their target would score 0.5, and one who disburses nothing would score
 * min(35, target/0) = 35: a perfect score for zero work. The spec's own worked
 * example contradicts it (32.5/35 implies Actual/Target x 35, actual ~93% of
 * target). We follow the worked example, i.e. Actual/Target. Flagged for the
 * bank to confirm.
 *
 * ---------------------------------------------------------------------------
 * PAR bands: the spec's literal edges leave a decimal gap (4.0 then 4.1, 5.0
 * then 5.1, ...). A PAR of exactly 4.05% would fall through every band and be
 * scored 0 for "exceeding 10%", which is plainly wrong. Each band is therefore
 * an inclusive upper bound (<=4.0, <=5.0, <=6.0, <=7.0, <=10.0), which is
 * continuous and gap-free while preserving every stated boundary and value.
 * ---------------------------------------------------------------------------
 */

export const MPR_MAX = { disbursement: 35, par: 35, caseload: 30 }
export const MPR_TOTAL_MAX = 100

/** PAR scale exactly as tabled in the spec. */
export const PAR_BANDS = [
  { maxInclusive: 4.0, points: 35.0, label: '0% - 4.0%', assessment: 'Optimal Risk Control' },
  { maxInclusive: 5.0, points: 30.0, label: '4.1% - 5.0%', assessment: 'CBN Benchmark Baseline (<= 5%)' },
  { maxInclusive: 6.0, points: 20.0, label: '5.1% - 6.0%', assessment: 'Sub-optimal' },
  { maxInclusive: 7.0, points: 15.0, label: '6.1% - 7.0%', assessment: 'High Risk' },
  { maxInclusive: 10.0, points: 7.5, label: '7.1% - 10.0%', assessment: 'Critical Risk' },
  { maxInclusive: Infinity, points: 0.0, label: '> 10.0%', assessment: 'Non-performing Risk' },
]

/**
 * Grade bands exactly as tabled, with the spec's hex colours.
 *
 * `min` is the AUTHORITATIVE field. The spec writes integer ranges
 * ("76 - 89", "90 - 100"), which leave a gap between 89 and 90 — a score of
 * 89.99 would match no band at all. Bands are therefore matched as ordered
 * descending thresholds (>= 90, >= 76, >= 65, >= 60), which is the spec's
 * evident intent and is gap-free. `max` is retained for display only
 * ("90 - 100") and for the Excel/UI column headers.
 */
export const GRADE_BANDS = [
  { grade: 'A', rating: 'EXCELLENT', min: 90, max: 100, hex: '#10B981', rangeLabel: '90 - 100' },
  { grade: 'B', rating: 'VERY GOOD', min: 76, max: 89, hex: '#059669', rangeLabel: '76 - 89' },
  { grade: 'C', rating: 'GOOD', min: 65, max: 75, hex: '#F59E0B', rangeLabel: '65 - 75' },
  { grade: 'D', rating: 'AVERAGE', min: 60, max: 64, hex: '#F97316', rangeLabel: '60 - 64' },
  { grade: 'E', rating: 'UNSATISFACTORY', min: -Infinity, max: 59, hex: '#EF4444', rangeLabel: 'Below 60' },
]

/** Loan status buckets that make up the PAR numerator, by days past due. */
export const PAR_STATUS_BUCKETS = [
  { key: 'performing', label: 'Performing', minDays: 0, maxDays: 0, inPar: false },
  { key: 'pass_watch', label: 'Pass & Watch', minDays: 1, maxDays: 30, inPar: true },
  { key: 'substandard', label: 'Substandard', minDays: 31, maxDays: 60, inPar: true },
  { key: 'doubtful', label: 'Doubtful', minDays: 61, maxDays: 90, inPar: true },
  { key: 'lost', label: 'Lost', minDays: 91, maxDays: Infinity, inPar: true },
]

const num = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** Round to `dp` decimals, avoiding 32.499999999999996 style artefacts. */
export const round = (v, dp = 2) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return null
  const f = 10 ** dp
  return Math.round((v + Number.EPSILON) * f) / f
}
// ---------------------------------------------------------------------------
// 1.1  PAR (%) = (Pass&Watch + Substandard + Doubtful + Lost)
//                / Total Outstanding Principal  x 100
// ---------------------------------------------------------------------------
export function computeParPercent({ passWatch = 0, substandard = 0, doubtful = 0, lost = 0, totalOutstandingPrincipal } = {}) {
  const atRisk = (num(passWatch) || 0) + (num(substandard) || 0) + (num(doubtful) || 0) + (num(lost) || 0)
  const total = num(totalOutstandingPrincipal)
  // A zero portfolio is genuinely 0% PAR, but only if the at-risk buckets are
  // also zero. If they are not, the denominator is bad data and we must not
  // report a confident 0% ("Optimal Risk Control", 35 pts).
  if (total === null || total <= 0) {
    return {
      parPercent: atRisk > 0 ? null : 0,
      valid: atRisk === 0,
      reason: atRisk > 0 ? 'total_outstanding_principal_missing' : null,
      atRisk,
    }
  }
  return { parPercent: round((atRisk / total) * 100, 4), valid: true, reason: null, atRisk }
}

/** Classify a loan by days past due into the spec's five buckets. */
export function bucketForDaysPastDue(daysPastDue) {
  const d = num(daysPastDue)
  if (d === null || d < 0) return null
  const b = PAR_STATUS_BUCKETS.find((x) => d >= x.minDays && d <= x.maxDays)
  return b ? b.key : null
}

/** Which bucket (if any) counts toward the PAR numerator. */
export function isInParBucket(bucketKey) {
  const b = PAR_STATUS_BUCKETS.find((x) => x.key === bucketKey)
  return Boolean(b && b.inPar)
}

// ---------------------------------------------------------------------------
// 1.2  PAR score — max 35, from the discrete band table (NOT a ratio).
// ---------------------------------------------------------------------------
export function computeParScore(parPercent) {
  const p = num(parPercent)
  if (p === null || p < 0) return null
  const band = PAR_BANDS.find((b) => p <= b.maxInclusive)
  return band ? band.points : null
}

// ---------------------------------------------------------------------------
// 1.3  Disbursement (max 35) & Caseload (max 30) — capped linear ratios.
// ---------------------------------------------------------------------------
export function computeDisbursementScore(actualDisbursementValue, targetDisbursementValue) {
  return cappedRatioScore(actualDisbursementValue, targetDisbursementValue, MPR_MAX.disbursement)
}

export function computeCaseloadScore(activeClientLoanCount, targetCaseloadCount) {
  return cappedRatioScore(activeClientLoanCount, targetCaseloadCount, MPR_MAX.caseload)
}

function cappedRatioScore(actual, target, max) {
  const a = num(actual)
  const t = num(target)
  // A missing actual is "not measured": it must NOT be scored 0 (which would
  // penalise an employee we simply have no data for) nor full marks. The
  // caller drops it from the total instead.
  if (a === null) return null
  if (t === null || t <= 0) return null // target missing/zero -> undefined ratio
  return round(Math.min(max, (a / t) * max), 2)
}

// ---------------------------------------------------------------------------
// Section 2 — grade from total score.
// ---------------------------------------------------------------------------
export function assignGrade(totalScore) {
  const s = num(totalScore)
  if (s === null) return null
  // Threshold match, NOT a min/max range test: see the note on GRADE_BANDS —
  // range testing leaves every score in (89, 90), (75, 76), (64, 65) ungraded.
  return GRADE_BANDS.find((g) => s >= g.min) || GRADE_BANDS[GRADE_BANDS.length - 1]
}

/** Badge text used in the UI and the Excel export, e.g. "A - EXCELLENT". */
export function gradeBadge(totalScore) {
  const g = assignGrade(totalScore)
  return g ? `${g.grade} - ${g.rating}` : null
}

// ---------------------------------------------------------------------------
// Full MPR evaluation for one staff member.
// ---------------------------------------------------------------------------
/**
 * @param {object} input
 * @param {number} input.actualDisbursementValue
 * @param {number} input.targetDisbursementValue
 * @param {number} [input.passWatch] @param {number} [input.substandard]
 * @param {number} [input.doubtful]       @param {number} [input.lost]
 * @param {number} input.totalOutstandingPrincipal
 * @param {number} input.activeClientLoanCount
 * @param {number} input.targetCaseloadCount
 */
export function evaluateMpr(input = {}) {
  const par = computeParPercent(input)
  const parScore = par.valid ? computeParScore(par.parPercent) : null
  const disbursementScore = computeDisbursementScore(input.actualDisbursementValue, input.targetDisbursementValue)
  const caseloadScore = computeCaseloadScore(input.activeClientLoanCount, input.targetCaseloadCount)

  const parts = [
    { key: 'disbursement', label: 'Disbursement', max: MPR_MAX.disbursement, score: disbursementScore },
    { key: 'par', label: 'PAR', max: MPR_MAX.par, score: parScore },
    { key: 'caseload', label: 'Caseload', max: MPR_MAX.caseload, score: caseloadScore },
  ]

  const missing = parts.filter((p) => p.score === null).map((p) => p.key)
  const scored = parts.filter((p) => p.score !== null)
  const subtotal = round(scored.reduce((a, p) => a + p.score, 0), 2)

  // The total (and therefore the grade) is only meaningful when every component
  // is measured. With a part missing we still return the subtotal, but flagged
  // `partial` so the UI shows it as provisional rather than silently ranking
  // someone on a third of their score.
  const complete = missing.length === 0
  const grade = complete ? assignGrade(subtotal) : null

  return {
    parPercent: par.parPercent,
    parValid: par.valid,
    parReason: par.reason,
    atRiskPrincipal: par.atRisk,
    disbursementScore,
    parScore,
    caseloadScore,
    parts,
    subtotal,
    scoredMax: scored.reduce((a, p) => a + p.max, 0),
    complete,
    missing,
    partial: !complete,
    total: complete ? subtotal : null,
    grade: grade ? grade.grade : null,
    gradeRating: grade ? grade.rating : null,
    gradeHex: grade ? grade.hex : null,
    badge: grade ? gradeBadge(subtotal) : null,
  }
}

/** Team summary: grade distribution + average, for the dashboard header. */
export function summariseMpr(rows = []) {
  const evaluated = rows.map((r) => ({ ...r, evaluation: r.evaluation || evaluateMpr(r) }))
  const complete = evaluated.filter((r) => r.evaluation.complete)
  const distribution = GRADE_BANDS.map((g) => ({
    grade: g.grade,
    rating: g.rating,
    hex: g.hex,
    count: evaluated.filter((r) => r.evaluation.grade === g.grade).length,
  }))
  const avg = complete.length
    ? round(complete.reduce((a, r) => a + r.evaluation.total, 0) / complete.length, 2)
    : null
  return {
    headcount: evaluated.length,
    completeCount: complete.length,
    provisionalCount: evaluated.length - complete.length,
    average: avg,
    averageGrade: assignGrade(avg),
    distribution,
    rows: evaluated,
  }
}