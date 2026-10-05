/**
 * MPR scoring tests — pins the engine to the bank's spec.
 *
 * The headline case is `SPEC WORKED EXAMPLE`: the exact numbers from the
 * blueprint's own worked example, which must reproduce the documented scores
 * (32.5 / 35.0 / 27.0 / 94.5 / Grade A). That is the strongest available check
 * that the engine agrees with the document it was written from.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MPR_MAX, MPR_TOTAL_MAX, PAR_BANDS, GRADE_BANDS, PAR_STATUS_BUCKETS,
  round, bucketForDaysPastDue, isInParBucket,
  computeParPercent, computeParScore,
  computeDisbursementScore, computeCaseloadScore,
  assignGrade, gradeBadge, evaluateMpr, summariseMpr,
} from '../src/domains/performance/mprEngine.js'

// ---------------------------------------------------------------------------
// The spec's own worked example (Staff 1: 94.5%, Grade A)
// ---------------------------------------------------------------------------
export const SPEC_ROW_1 = {
  actualDisbursementValue: 928571,   // 32.5 / 35  =>  actual/target = 0.9286
  targetDisbursementValue: 1000000,
  passWatch: 140000, substandard: 0, doubtful: 0, lost: 0,
  totalOutstandingPrincipal: 5000000, // 140000/5000000 = 2.8% PAR
  activeClientLoanCount: 90,         // 27 / 30    =>  90/100
  targetCaseloadCount: 100,
}

test('SPEC WORKED EXAMPLE: reproduces the documented 94.5 / Grade A', () => {
  const r = evaluateMpr(SPEC_ROW_1)
  assert.equal(r.disbursementScore, 32.5)
  assert.equal(r.parPercent, 2.8)
  assert.equal(r.parScore, 35.0)
  assert.equal(r.caseloadScore, 27.0)
  assert.equal(r.total, 94.5)
  assert.equal(r.grade, 'A')
  assert.equal(r.badge, 'A - EXCELLENT')
  assert.equal(r.gradeHex, '#10B981')
})

test('SPEC WORKED EXAMPLE: staff 4 scores 53.0 -> Grade E (per the table)', () => {
  const r = evaluateMpr({
    ...SPEC_ROW_1,
    actualDisbursementValue: 571429,      // 20/35
    passWatch: 340000,                    // 6.8% PAR -> 15
    activeClientLoanCount: 60,            // 18/30
  })
  assert.equal(r.disbursementScore, 20)
  assert.equal(r.parScore, 15)
  assert.equal(r.caseloadScore, 18)
  assert.equal(r.total, 53)
// ---------------------------------------------------------------------------
// PAR % formula
// ---------------------------------------------------------------------------
test('PAR % = at-risk buckets / total outstanding principal x 100', () => {
  const r = computeParPercent({
    passWatch: 100, substandard: 200, doubtful: 300, lost: 400,
    totalOutstandingPrincipal: 5000,
  })
  assert.equal(r.atRisk, 1000)
  assert.equal(r.parPercent, 20) // 1000/5000
})

test('PAR % is 0 and valid for a zero portfolio with no at-risk loans', () => {
  const r = computeParPercent({ totalOutstandingPrincipal: 0 })
  assert.equal(r.parPercent, 0)
  assert.equal(r.valid, true)
})

test('PAR % is NULL (not 0) when buckets are non-empty but principal is missing', () => {
  // Guards the dangerous case: reporting 0% PAR would earn full 35 risk points.
  const r = computeParPercent({ passWatch: 5000, totalOutstandingPrincipal: null })
  assert.equal(r.parPercent, null)
  assert.equal(r.valid, false)
  assert.equal(r.reason, 'total_outstanding_principal_missing')
})

// ---------------------------------------------------------------------------
// PAR band table — every stated band, boundary and point value
// ---------------------------------------------------------------------------
test('PAR band table matches the spec point-for-point', () => {
  assert.deepEqual(PAR_BANDS.map((b) => [b.label, b.points]), [
    ['0% - 4.0%', 35.0],
    ['4.1% - 5.0%', 30.0],
    ['5.1% - 6.0%', 20.0],
    ['6.1% - 7.0%', 15.0],
    ['7.1% - 10.0%', 7.5],
    ['> 10.0%', 0.0],
  ])
})

test('PAR score at every band centre', () => {
  const expected = [
    [0, 35], [2.8, 35], [4.5, 30], [5.5, 20], [6.5, 15], [8.5, 7.5], [12, 0],
  ]
  for (const [par, points] of expected) {
    assert.equal(computeParScore(par), points, `PAR ${par}% should score ${points}`)
  }
})

test('PAR band boundaries are inclusive and continuous (no decimal gaps)', () => {
  // The spec's literal edges (4.0 then 4.1) would score these 0 as "> 10%".
  assert.equal(computeParScore(4.05), 30)
  assert.equal(computeParScore(5.05), 20)
  assert.equal(computeParScore(6.05), 15)
  assert.equal(computeParScore(7.05), 7.5)
  assert.equal(computeParScore(10.05), 0)
  // Exact stated boundaries.
  assert.equal(computeParScore(4.0), 35)
  assert.equal(computeParScore(5.0), 30)
  assert.equal(computeParScore(10.0), 7.5)
})

test('PAR score is monotone non-increasing as risk rises', () => {
  let prev = Infinity
  for (const p of [0, 1, 2, 3, 4, 4.5, 5, 5.5, 6, 6.5, 7, 8, 9, 10, 11, 50]) {
    const s = computeParScore(p)
    assert.ok(s <= prev, `PAR ${p}% scored ${s}, above previous ${prev}`)
    prev = s
  }
})
  assert.equal(r.grade, 'E')
})

test('weights sum to 100 as the spec states', () => {
  assert.equal(MPR_MAX.disbursement, 35)
  assert.equal(MPR_MAX.par, 35)
  assert.equal(MPR_MAX.caseload, 30)
  assert.equal(MPR_MAX.disbursement + MPR_MAX.par + MPR_MAX.caseload, MPR_TOTAL_MAX)
})
// ---------------------------------------------------------------------------
// Disbursement / Caseload — capped ratios
// ---------------------------------------------------------------------------
test('disbursement score = min(35, actual/target x 35)', () => {
  assert.equal(computeDisbursementScore(1000000, 1000000), 35)
  assert.equal(computeDisbursementScore(500000, 1000000), 17.5)
  assert.equal(computeDisbursementScore(0, 1000000), 0)
})

test('disbursement score is CAPPED at 35 when actual exceeds target', () => {
  assert.equal(computeDisbursementScore(2000000, 1000000), 35)
  assert.equal(computeDisbursementScore(10000000, 1000000), 35)
})

test('caseload score is CAPPED at 30 when actual exceeds target', () => {
  assert.equal(computeCaseloadScore(100, 100), 30)
  assert.equal(computeCaseloadScore(250, 100), 30)
  assert.equal(computeCaseloadScore(90, 100), 27)
})

test('missing or zero target yields NULL, not a confident zero', () => {
  assert.equal(computeDisbursementScore(500000, null), null)
  assert.equal(computeDisbursementScore(500000, 0), null)
  assert.equal(computeCaseloadScore(50, 0), null)
})

test('missing actual yields NULL (never scored as 0)', () => {
  assert.equal(computeDisbursementScore(null, 1000000), null)
  assert.equal(computeCaseloadScore(undefined, 100), null)
})

// ---------------------------------------------------------------------------
// Grade bands
// ---------------------------------------------------------------------------
test('grade band table matches the spec including hex colours', () => {
  assert.deepEqual(GRADE_BANDS.map((g) => [g.grade, g.rating, g.hex]), [
    ['A', 'EXCELLENT', '#10B981'],
    ['B', 'VERY GOOD', '#059669'],
    ['C', 'GOOD', '#F59E0B'],
    ['D', 'AVERAGE', '#F97316'],
    ['E', 'UNSATISFACTORY', '#EF4444'],
  ])
})

test('grade assignment at every band boundary', () => {
  const cases = [
    [100, 'A'], [90, 'A'], [89.99, 'B'], [89, 'B'], [76, 'B'], [75.99, 'C'],
    [75, 'C'], [65, 'C'], [64.99, 'D'], [64, 'D'], [60, 'D'], [59.99, 'E'],
    [50, 'E'], [0, 'E'],
  ]
  for (const [score, grade] of cases) {
    assert.equal(assignGrade(score).grade, grade, `score ${score} should be grade ${grade}`)
  }
})

test('no score between 0 and 100 falls outside the grade bands', () => {
  for (let s = 0; s <= 100; s += 0.01) assert.ok(assignGrade(s), `no grade for ${s}`)
})

test('gradeBadge formats as "<GRADE> - <RATING>"', () => {
  assert.equal(gradeBadge(94.5), 'A - EXCELLENT')
  assert.equal(gradeBadge(53), 'E - UNSATISFACTORY')
  assert.equal(gradeBadge(null), null)
})

// ---------------------------------------------------------------------------
// Loan status buckets (spec 1.1 classifications)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Partial-data behaviour
// ---------------------------------------------------------------------------
test('an unmeasured component blocks the grade but still reports a subtotal', () => {
  const r = evaluateMpr({ ...SPEC_ROW_1, activeClientLoanCount: null })
  assert.equal(r.caseloadScore, null)
  assert.deepEqual(r.missing, ['caseload'])
  assert.equal(r.partial, true)
  assert.equal(r.complete, false)
  assert.equal(r.total, null, 'must not publish a total from 2 of 3 components')
  assert.equal(r.grade, null)
  assert.equal(r.subtotal, 67.5, 'subtotal of the measured parts is still reported')
})

test('a fully-measured row is complete and unflagged', () => {
  const r = evaluateMpr(SPEC_ROW_1)
  assert.equal(r.complete, true)
  assert.equal(r.partial, false)
  assert.deepEqual(r.missing, [])
})

test('total can never exceed 100', () => {
  const r = evaluateMpr({
    actualDisbursementValue: 1e9, targetDisbursementValue: 1,
    passWatch: 0, substandard: 0, doubtful: 0, lost: 0,
    totalOutstandingPrincipal: 1e9,
    activeClientLoanCount: 1e6, targetCaseloadCount: 1,
  })
  assert.equal(r.total, 100)
  assert.equal(r.grade, 'A')
})

test('zero performance across all three metrics scores 0 -> Grade E', () => {
  const r = evaluateMpr({
    actualDisbursementValue: 0, targetDisbursementValue: 1000,
    passWatch: 500, substandard: 0, doubtful: 0, lost: 0,
    totalOutstandingPrincipal: 1000,
    activeClientLoanCount: 0, targetCaseloadCount: 50,
  })
  assert.equal(r.total, 0)
  assert.equal(r.grade, 'E')
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
test('summariseMpr gives headcount, average and grade distribution', () => {
  const s = summariseMpr([
    { staffName: 'A', ...SPEC_ROW_1 },
    { staffName: 'B', ...SPEC_ROW_1, activeClientLoanCount: null },
  ])
  assert.equal(s.headcount, 2)
  assert.equal(s.completeCount, 1)
  assert.equal(s.provisionalCount, 1)
  assert.equal(s.average, 94.5)
  assert.equal(s.averageGrade.grade, 'A')
  assert.equal(s.distribution.find((d) => d.grade === 'A').count, 1)
})

test('round() avoids binary floating point artefacts', () => {
  assert.equal(round(0.1 + 0.2), 0.3)
  assert.equal(round(32.499999999999996), 32.5)
  assert.equal(round(null), null)
})
test('days-past-due classifies into the spec five buckets', () => {
  assert.equal(bucketForDaysPastDue(0), 'performing')
  assert.equal(bucketForDaysPastDue(1), 'pass_watch')
  assert.equal(bucketForDaysPastDue(30), 'pass_watch')
  assert.equal(bucketForDaysPastDue(31), 'substandard')
  assert.equal(bucketForDaysPastDue(60), 'substandard')
  assert.equal(bucketForDaysPastDue(61), 'doubtful')
  assert.equal(bucketForDaysPastDue(90), 'doubtful')
  assert.equal(bucketForDaysPastDue(91), 'lost')
  assert.equal(bucketForDaysPastDue(400), 'lost')
})

test('only the four non-performing buckets feed the PAR numerator', () => {
  assert.equal(isInParBucket('performing'), false)
  for (const k of ['pass_watch', 'substandard', 'doubtful', 'lost']) {
    assert.equal(isInParBucket(k), true, `${k} must count toward PAR`)
  }
  assert.equal(PAR_STATUS_BUCKETS.length, 5)
})