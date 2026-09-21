// ------------------------------------------------------------------
// InfinityCore — Performance Rules Builder (Phase 67)
// Pure node test of the no-code business-rules layer. No live DB.
// Covers: default-config round-trip for every seeded config key,
// exact deterministic sentences, range/weight/overlap/sanction-order
// validation, variable availability, and the new UI wiring.
// Run: npm run test:rules-builder
// ------------------------------------------------------------------

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { getTranslator, availableVariableKeys } from '../src/domains/performance/rules/index.js'
import { describeRule } from '../src/domains/performance/rules/format.js'
import { bonusRuleFromEntry } from '../src/domains/performance/rules/validate.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const MIGRATION = join(ROOT, '..', 'schema_phase26_hr_master_data.sql')

let passed = 0
const ok = (name) => { passed++; console.log(`  ✓ ${name}`) }

// --------------------------------------------------------------- seeds
// Parse the seeded performance_config tuples straight out of the phase-26
// migration so the tests always run against the current bank defaults.
const sql = readFileSync(MIGRATION, 'utf8')
const tupleRe = /\(\s*'([\w.]+)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'((?:[^']|'')*)'::jsonb,\s*'((?:[^']|'')*)'::jsonb,\s*([\s\S]*?)\s*\)/g
const seeds = new Map()
for (const m of sql.matchAll(tupleRe)) {
  const unescape = (s) => s.replace(/''/g, "'")
  seeds.set(m[1], {
    section: m[2],
    label: m[3],
    dataType: m[4],
    bankDefault: JSON.parse(unescape(m[5])),
    currentValue: JSON.parse(unescape(m[6])),
  })
}
assert.ok(seeds.has('mpr.components'), 'seed parser must find mpr.components')
assert.ok(seeds.has('bonus.productivity'), 'seed parser must find bonus.productivity')

// ------------------------------------------------------------- helpers
const deepRoundTrip = (translator, config) =>
  assert.deepEqual(translator.toConfig(translator.fromConfig(config)), config)

console.log('\n■ Default-config round-trip + validation (against live migration seed)')
for (const [key, seed] of seeds) {
  const t = getTranslator(key)
  const draft = t.fromConfig(seed.currentValue)
  if (t.editable) {
    deepRoundTrip(t, seed.currentValue)
    ok(`${key}: toConfig(fromConfig(current)) reproduces the stored value exactly`)
    const errors = t.validate(draft)
    assert.deepEqual(errors, [], `${key} default must validate clean; got: ${JSON.stringify(errors)}`)
    ok(`${key}: default config validates with zero errors`)
  } else {
    ok(`${key}: engine/info item is correctly marked non-editable`)
  }
}

// ------------------------------------------------------ exact sentences
console.log('\n■ Deterministic plain-language sentences (frozen spec)')
{
  const t = getTranslator('mpr.components')
  const [line] = t.describe(t.fromConfig(seeds.get('mpr.components').currentValue))
  assert.equal(line, 'MPR = Disbursement 35% + Par 35% + Caseload 30% · total 100%')
  ok('mpr.components describe == "MPR = Disbursement 35% + Par 35% + Caseload 30% · total 100%"')
}
{
  const t = getTranslator('bonus.productivity')
  const lines = t.describe(t.fromConfig(seeds.get('bonus.productivity').currentValue))
  assert.equal(
    lines[0],
    'Rule 1: When MPR Score is at least 75%, the employee receives a productivity bonus equal to 60% of gross salary.'
  )
  assert.equal(
    lines[1],
    'Rule 2: When MPR Score is between 60% and 74%, the employee receives a productivity bonus equal to 30% of gross salary.'
  )
  ok('bonus productivity rules read as spec sentences (≥75% → 60%, 60–74% → 30%)')
}
{
  const t = getTranslator('sanctions.performance')
  const lines = t.describe(t.fromConfig(seeds.get('sanctions.performance').currentValue))
  assert.ok(lines.some((l) => l.endsWith('Final step (any MPR): Staff asked to resign — no bonus forfeiture.')))
  assert.ok(lines.some((l) => l.includes('authorized human approval')))
  ok('sanctions: final "Staff asked to resign" step renders as blank-threshold, human-approval step')
}
{
  const { rules } = getTranslator('bonus.productivity').fromConfig(seeds.get('bonus.productivity').currentValue)
  assert.equal(
    describeRule(rules[0]),
    'When MPR Score is at least 75%, the employee receives a productivity bonus equal to 60% of gross salary.'
  )
  assert.equal(
    describeRule(rules[1]),
    'When MPR Score is between 60% and 74%, the employee receives a productivity bonus equal to 30% of gross salary.'
  )
  ok('describeRule produces the exact spec copy (no drift)')
}

// ------------------------------------------------------------ validation
console.log('\n■ Validation behaviour (mutated drafts)')
{
  const t = getTranslator('mpr.components')
  const draft = t.fromConfig(seeds.get('mpr.components').currentValue)
  draft[0].weight = '50' // 50 + 35 + 30 = 115
  const errors = t.validate(draft)
  assert.ok(errors.some((e) => /must total 100%/.test(e)), 'weights!=100 must be rejected')
  ok('mpr.components: weights must sum to 100%')

  const okDraft = t.fromConfig(seeds.get('mpr.components').currentValue)
  okDraft[0].weight = '35'
  assert.deepEqual(t.validate(okDraft), [])
  ok('mpr.components: restored weights validate clean')
}
{
  const t = getTranslator('mpr.par_bands')
  const draft = t.fromConfig(seeds.get('mpr.par_bands').currentValue)
  draft.push({ min_pct: 8, max_pct: 12, score: 5 }) // overlaps the 10.1–∞ band
  const errors = t.validate(draft)
  assert.ok(errors.some((e) => /overlaps/.test(e)), 'overlapping PAR bands must be rejected')
  ok('mpr.par_bands: overlapping bands produce an error')
}
{
  const t = getTranslator('sanctions.performance')
  const draft = t.fromConfig(seeds.get('sanctions.performance').currentValue)
  draft.splice(3, 0, { month: '1.5', mpr_threshold_pct: '50', sanction: 'Disjointed', bonus_forfeit_pct: '10' })
  const errors = t.validate(draft)
  assert.ok(errors.some((e) => /ascending occurrence order/.test(e)))
  ok('sanctions: out-of-order occurrence rejected')
}
{
  const t = getTranslator('bonus.qualification')
  const draft = t.fromConfig(seeds.get('bonus.qualification').currentValue)
  assert.deepEqual(t.validate(draft), [])
  draft.mpr_min = '80'
  draft.mpr_max = '75'
  assert.ok(t.validate(draft).some((e) => /must not be below/.test(e)))
  ok('bonus.qualification: max < min rejected; defaults valid')
}
{
  // Bonus rule overlap: two open-ended "≥" rules overlap by definition.
  const t = getTranslator('bonus.productivity')
  const draft = t.fromConfig(seeds.get('bonus.productivity').currentValue)
  assert.deepEqual(t.validate(draft), [], 'default bonus scale (≥75 + 60–74) must not overlap')
  draft.rules.push(bonusRuleFromEntry({ min_mpr_pct: 70, percent_of_gross: 45 }))
  const errors = t.validate(draft)
  assert.ok(errors.some((e) => /overlap/.test(e)), 'overlapping bonus ranges must be rejected')
  ok('bonus.productivity: overlapping tiers rejected; default scale clean')
}

// ----------------------------------------------------------- variables
console.log('\n■ Variable catalog discipline')
{
  const unavailable = ['attendance_pct', 'late_count', 'absence_count', 'leave_balance', 'leave_utilization', 'outstanding_principal', 'loan_count', 'days_past_due']
  const available = availableVariableKeys()
  for (const key of unavailable) assert.ok(!available.includes(key), `${key} must stay unavailable`)
  ok('no unavailable variables (attendance/leave/callback) can be selected in rules')
  assert.ok(available.includes('mpr_pct') && available.includes('par_pct') && available.includes('designation'))
  ok('core MPR variables remain selectable')
}

// ------------------------------------------------------------- UI wiring
console.log('\n■ UI wiring')
{
  const page = readFileSync(join(ROOT, '..', 'src', 'pages', 'PerformanceSettings.jsx'), 'utf8')
  assert.ok(page.includes("SectionEditor") && page.includes("'rules'") && page.includes("'advanced'"))
  assert.ok(page.includes('Business Rules'))
  ok('PerformanceSettings.jsx now drives the SectionEditor behind Business Rules / Advanced tabs')

  for (const f of ['SectionEditor.jsx', 'RulesBuilder.jsx', 'ReorderList.jsx', 'editors.jsx', 'controls.jsx']) {
    const p = join(ROOT, '..', 'src', 'components', 'performance', f)
    assert.ok(existsSync(p), `${f} must exist`)
  }
  ok('performance components all present (SectionEditor / RulesBuilder / ReorderList / editors / controls)')

  const pkg = JSON.parse(readFileSync(join(ROOT, '..', 'package.json'), 'utf8'))
  assert.ok(pkg.scripts && pkg.scripts['test:rules-builder'], 'package.json must expose test:rules-builder')
  ok('package.json exposes "test:rules-builder"')
}

console.log(`\n✔ ${passed} assertions passed`)