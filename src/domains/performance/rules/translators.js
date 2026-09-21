// ------------------------------------------------------------------
// PER-SECTION TRANSLATORS.
// Each translator knows how to:
//   fromConfig(value)  → editable draft (business-shaped)
//   toConfig(draft)    → the SAME machine-readable JSON shape stored in
//                        performance_config (round-trips exactly)
//   validate(draft)    → human-readable errors
//   describe(draft)    → deterministic natural-language lines
//   summarize(value)   → human-readable change-history lines
//
// This is the ONLY place business logic knowledge for configuration
// wraps the engine's stored format. The calculation engine itself is
// untouched — it keeps reading the saved config.
// ------------------------------------------------------------------

import {
  MPR_COMPONENTS,
  OPERATORS,
  formatNaira,
} from './registry.js'
import { formatValue, describeCondition, describeRule } from './format.js'
import {
  parseNumber,
  validateNumericRows,
  validateMinMaxRows,
  overlapErrors,
  sumField,
  findRuleOverlaps,
  bonusEntryFromRule,
  bonusRuleFromEntry,
  ruleInterval,
} from './validate.js'

const BONUS_ALLOWED_OPERATORS = ['greater_than_or_equal', 'less_than_or_equal', 'between']

const asRows = (value) => (Array.isArray(value) ? value : [])
const numOrNull = (v) => {
  if (v === '' || v === null || v === undefined) return null
  const n = parseNumber(v)
  return n
}

const nairaLine = (v) => formatNaira(v ?? 0)

// Human range: "0% – 4%", "1 – 90 days", "91 days – no upper limit".
// unit { plural, singular } (percent unit = { plural:'%' }).
function rangeTxt(lo, hi, unit = {}, openLabel = 'no upper limit') {
  const txt = (v, defaultValue) => {
    if (v === null || v === '') return defaultValue
    const suffix = v === 1 && unit.singular ? unit.singular : unit.plural || ''
    return `${v}${suffix}`
  }
  return `${txt(lo, '?')} – ${txt(hi, openLabel)}`
}
const fmtBand = (lo, hi, suffix) => rangeTxt(numOrNull(lo), numOrNull(hi), { plural: suffix })

const PCT = { plural: '%' }
const DAYS = { singular: ' day', plural: ' days' }
const SCORE = { plural: '' }

// --------------------------------------------------------------- utility
function rowEditorOptions(extra = []) {
  // Preserve any custom components that already exist in a saved config.
  const present = new Set(extra.map((c) => String(c).toUpperCase()))
  const all = [...MPR_COMPONENTS, ...[...present].filter((c) => !MPR_COMPONENTS.some((m) => m.key === c)).map((c) => ({ key: c, label: title(c) }))]
  return all
}

function title(s) {
  return String(s || '')
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

const stableStringify = (value) =>
  JSON.stringify(
    value,
    (k, v) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.keys(v)
            .sort()
            .reduce((acc, key) => {
              acc[key] = v[key]
              return acc
            }, {})
        : v
  )

const isDirty = (a, b) => stableStringify(a) !== stableStringify(b)

// ------------------------------------------------------------ translators
export const translators = {
  // ---- MPR COMPONENTS --------------------------------------------
  'mpr.components': {
    key: 'mpr.components',
    label: 'MPR Component Weights',
    editable: true,
    fromConfig: (value) => asRows(value).map((row) => ({ component: String(row.component || ''), weight: String(numOrNull(row.weight) ?? '') })),
    toConfig: (draft) =>
      (draft.rows || draft).map((row) => ({
        component: String(row.component || '').trim().toUpperCase(),
        weight: parseNumber(row.weight),
      })),
    validate(draft) {
      const rows = draft.rows || draft
      const errors = []
      if (rows.length === 0) errors.push('Add at least one MPR component.')
      rows.forEach((row, i) => {
        if (!String(row.component || '').trim()) errors.push(`Row ${i + 1}: choose a component.`)
        const w = parseNumber(row.weight)
        if (w === null) errors.push(`Row ${i + 1}: weight must be a number.`)
        else if (w < 0 || w > 100) errors.push(`Row ${i + 1}: weight must be between 0% and 100%.`)
      })
      const total = sumField(rows, 'weight')
      if (rows.length > 0 && Math.abs(100 - total) > 0.001) {
        errors.push(`Component weights must total 100% (currently ${Math.round(total * 100) / 100}%).`)
      }
      return errors
    },
    describe(draft) {
      const rows = draft.rows || draft
      const parts = rows.map((r) => `${title(r.component)} ${numOrNull(r.weight)}%`).join(' + ')
      return [`MPR = ${parts}${rows.length ? ` · total ${Math.round(sumField(rows, 'weight') * 100) / 100}%` : ''}`]
    },
    summarize(value) {
      return [`MPR = ${(asRows(value).map((r) => `${title(r.component)} ${numOrNull(r.weight)}%`).join(' + ') || '—')}`]
    },
    mprComponentsField: () => rowEditorOptions(),
  },

  // ---- PAR SCORE BANDS -------------------------------------------
  'mpr.par_bands': {
    key: 'mpr.par_bands',
    label: 'PAR Score Bands',
    editable: true,
    fromConfig: (value) =>
      asRows(value).map((row) => ({ min_pct: numOrNull(row.min_pct), max_pct: numOrNull(row.max_pct), score: String(numOrNull(row.score) ?? '') })),
    toConfig: (draft) =>
      (draft.rows || draft).map((row) => ({
        min_pct: parseNumber(row.min_pct),
        max_pct: parseNumber(row.max_pct),
        score: parseNumber(row.score),
      })),
    validate(draft) {
      const rows = draft.rows || draft
      return [
        ...validateNumericRows(rows, [{ key: 'min_pct', label: 'minimum PAR', required: true, min: 0 }]),
        ...validateNumericRows(rows, [{ key: 'score', label: 'score', required: true, min: 0 }]),
        ...validateMinMaxRows(rows, { minField: 'min_pct', maxField: 'max_pct', minLabel: 'minimum PAR', maxLabel: 'maximum PAR' }),
        ...overlapErrors(rows, { minField: 'min_pct', maxField: 'max_pct', labelField: null, rowLabel: 'band' }),
      ]
    },
    describe(draft) {
      const rows = draft.rows || draft
      if (rows.length === 0) return ['No PAR score bands configured.']
      return rows.map((r, i) => `${fmtBand(r.min_pct, r.max_pct, '%')} → ${numOrNull(r.score)} points`)
    },
    summarize(value) {
      const rows = asRows(value)
      return rows.length
        ? [`${rows.length} bands`].concat(rows.map((r, i) => `${i + 1}. ${fmtBand(r.min_pct, r.max_pct, '%')} → ${numOrNull(r.score)} points`))
        : ['No PAR score bands configured.']
    },
  },

  // ---- LOAN AGEING -----------------------------------------------
  'mpr.loan_ageing': {
    key: 'mpr.loan_ageing',
    label: 'Loan Ageing Classification',
    editable: true,
    fromConfig: (value) =>
      asRows(value).map((row) => ({ classification: String(row.classification || ''), min_days: numOrNull(row.min_days), max_days: numOrNull(row.max_days) })),
    toConfig: (draft) =>
      (draft.rows || draft).map((row) => ({
        classification: String(row.classification || '').trim(),
        min_days: parseNumber(row.min_days),
        max_days: parseNumber(row.max_days),
      })),
    validate(draft) {
      const rows = draft.rows || draft
      const errors = [
        ...validateNumericRows(rows, [{ key: 'min_days', label: 'minimum days', required: true, min: 0 }]),
        ...validateMinMaxRows(rows, { minField: 'min_days', maxField: 'max_days', minLabel: 'minimum days', maxLabel: 'maximum days' }),
        ...overlapErrors(rows, { minField: 'min_days', maxField: 'max_days', labelField: 'classification', rowLabel: 'bucket' }),
      ]
      rows.forEach((row, i) => {
        if (!String(row.classification || '').trim()) errors.push(`Row ${i + 1}: classification is required.`)
      })
      return errors
    },
    describe(draft) {
      const rows = draft.rows || draft
      return rows.map((r) => `${title(r.classification)}: ${rangeTxt(numOrNull(r.min_days), numOrNull(r.max_days), DAYS)}`)
    },
    summarize(value) {
      return asRows(value).map((r) => `${title(r.classification)}: ${rangeTxt(numOrNull(r.min_days), numOrNull(r.max_days), DAYS)}`)
    },
  },

  // ---- PERFORMANCE GRADES ----------------------------------------
  'grades.performance': {
    key: 'grades.performance',
    label: 'Performance Grades',
    editable: true,
    fromConfig: (value) =>
      asRows(value).map((row) => ({ letter: String(row.letter || ''), grade: String(row.grade || ''), min_score: numOrNull(row.min_score), max_score: numOrNull(row.max_score) })),
    toConfig: (draft) =>
      (draft.rows || draft).map((row) => ({
        grade: String(row.grade || '').trim().toUpperCase(),
        min_score: parseNumber(row.min_score),
        max_score: parseNumber(row.max_score),
        letter: String(row.letter || '').trim().toUpperCase(),
      })),
    validate(draft) {
      const rows = draft.rows || draft
      const errors = [
        ...validateNumericRows(rows, [
          { key: 'min_score', label: 'minimum score', required: true, min: 0, max: 100 },
          { key: 'max_score', label: 'maximum score', required: true, min: 0, max: 100 },
        ]),
        ...validateMinMaxRows(rows, { minField: 'min_score', maxField: 'max_score', minLabel: 'minimum score', maxLabel: 'maximum score' }),
        ...overlapErrors(rows, { minField: 'min_score', maxField: 'max_score', labelField: 'letter', rowLabel: 'grade' }),
      ]
      rows.forEach((row, i) => {
        if (!String(row.grade || '').trim()) errors.push(`Row ${i + 1}: grade name is required.`)
        if (!String(row.letter || '').trim()) errors.push(`Row ${i + 1}: letter is required.`)
      })
      return errors
    },
    describe(draft) {
      const rows = draft.rows || draft
      return rows.map((r) => `${String(r.letter || '—')} · ${title(r.grade)} — ${rangeTxt(numOrNull(r.min_score), numOrNull(r.max_score), SCORE)}`)
    },
    summarize(value) {
      return asRows(value).map((r) => `${String(r.letter || '—')} · ${title(r.grade)} — ${rangeTxt(numOrNull(r.min_score), numOrNull(r.max_score), SCORE)}`)
    },
    // Preserve source gaps: coverage is informational only.
  },

  // ---- MOBILITY ALLOWANCE ----------------------------------------
  'mobility.allowance_bands': {
    key: 'mobility.allowance_bands',
    label: 'Mobility Allowance Bands',
    editable: true,
    fromConfig: (value) =>
      asRows(value).map((row) => ({ category: String(row.category || ''), min_portfolio: numOrNull(row.min_portfolio), max_portfolio: numOrNull(row.max_portfolio), allowance: String(numOrNull(row.allowance) ?? '') })),
    toConfig: (draft) =>
      (draft.rows || draft).map((row) => ({
        category: String(row.category || '').trim(),
        min_portfolio: parseNumber(row.min_portfolio),
        max_portfolio: parseNumber(row.max_portfolio),
        allowance: parseNumber(row.allowance),
      })),
    validate(draft) {
      const rows = draft.rows || draft
      const errors = [
        ...validateNumericRows(rows, [
          { key: 'min_portfolio', label: 'minimum portfolio', required: true, min: 0 },
          { key: 'allowance', label: 'allowance', required: true, min: 0 },
        ]),
        ...validateMinMaxRows(rows, { minField: 'min_portfolio', maxField: 'max_portfolio', minLabel: 'minimum portfolio', maxLabel: 'maximum portfolio' }),
        ...overlapErrors(rows, { minField: 'min_portfolio', maxField: 'max_portfolio', labelField: 'category', rowLabel: 'tier' }),
      ]
      rows.forEach((row, i) => {
        if (!String(row.category || '').trim()) errors.push(`Row ${i + 1}: tier name is required.`)
      })
      return errors
    },
    describe(draft) {
      const rows = draft.rows || draft
      return rows.map((r) => `${title(r.category)}: ${nairaLine(r.min_portfolio)} – ${r.max_portfolio === null ? 'no upper limit' : nairaLine(r.max_portfolio)} → ${nairaLine(r.allowance)} / month`)
    },
    summarize(value) {
      return asRows(value).map((r) => `${title(r.category)}: ${nairaLine(r.min_portfolio)} – ${r.max_portfolio === null ? 'no upper limit' : nairaLine(r.max_portfolio)} → ${nairaLine(r.allowance)} / month`)
    },
  },

  // ---- PRODUCTIVITY BONUS ----------------------------------------
  'bonus.productivity': {
    key: 'bonus.productivity',
    label: 'Productivity Bonus',
    editable: true,
    fromConfig(value) {
      const cfg = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
      const monthly = Array.isArray(cfg.monthly_frequency_designations) ? cfg.monthly_frequency_designations : []
      const quarterly = Array.isArray(cfg.quarterly_frequency_designations) ? cfg.quarterly_frequency_designations : []
      const seen = new Set()
      const frequency = []
      ;[...monthly.map((d) => ({ designation: String(d).trim(), frequency: 'monthly' })), ...quarterly.map((d) => ({ designation: String(d).trim(), frequency: 'quarterly' }))].forEach((row) => {
        if (!row.designation) return
        if (seen.has(row.designation.toUpperCase())) return
        seen.add(row.designation.toUpperCase())
        frequency.push(row)
      })
      return {
        eligible: Array.isArray(cfg.eligible_designations) ? cfg.eligible_designations.map((d) => String(d).trim()).filter(Boolean) : [],
        waitMonths: cfg.eligibility_wait_months == null ? '' : String(cfg.eligibility_wait_months),
        frequency,
        rules: (Array.isArray(cfg.bonus_scale) ? cfg.bonus_scale : []).map((entry) => bonusRuleFromEntry(entry)),
      }
    },
    toConfig(draft) {
      const eligible = (draft.eligible || []).slice()
      const rows = draft.frequency || []
      const monthly = rows.filter((r) => r.frequency === 'monthly').map((r) => r.designation)
      const quarterly = rows.filter((r) => r.frequency !== 'monthly').map((r) => r.designation)
      const rules = draft.rules || []
      const bonus_scale = rules.map((rule) => (rule.unsupported && rule.raw ? rule.raw : bonusEntryFromRule(rule))).filter(Boolean)
      const waitMonths = parseNumber(draft.waitMonths)
      const cfg = {
        eligible_designations: eligible,
        monthly_frequency_designations: monthly,
        quarterly_frequency_designations: quarterly,
        eligibility_wait_months: waitMonths === null ? null : waitMonths,
        bonus_scale,
      }
      return cfg
    },
    validate(draft) {
      const errors = []
      if (!Array.isArray(draft.eligible) || draft.eligible.length === 0) {
        errors.push('Select at least one eligible designation.')
      }
      const w = parseNumber(draft.waitMonths)
      if (w === null || w < 0) {
        errors.push('Eligibility waiting period must be a number of months (0 or more).')
      }
      if (!Array.isArray(draft.frequency) || draft.frequency.length === 0) {
        errors.push('Add at least one designation to the payment frequency matrix.')
      }
      const freqSeen = new Set()
      draft.frequency.forEach((row, i) => {
        if (!String(row.designation || '').trim()) {
          errors.push(`Frequency row ${i + 1}: choose a designation.`)
          return
        }
        const key = row.designation.toUpperCase()
        if (freqSeen.has(key)) errors.push(`Frequency row ${i + 1}: "${row.designation}" is assigned twice — each designation can have one frequency.`)
        freqSeen.add(key)
        if (!['monthly', 'quarterly'].includes(row.frequency)) errors.push(`Frequency row ${i + 1}: choose a frequency.`)
      })
      const rules = draft.rules || []
      if (rules.length === 0) errors.push('Add at least one productivity bonus rule.')
      rules.forEach((rule, idx) => {
        const n = idx + 1
        if (rule.unsupported) {
          errors.push(`Rule ${n} uses a saved format this editor cannot represent — it is preserved but should be reviewed in Advanced mode.`)
          return
        }
        const conds = (rule.when && rule.when.conditions) || []
        if (conds.length === 0) {
          errors.push(`Rule ${n}: add a qualifying condition.`)
          return
        }
        if (conds.length > 1) {
          errors.push(`Rule ${n}: the productivity bonus supports a single MPR-score range as its qualifying condition (${conds.length} conditions were given).`)
        }
        const cond = conds[0]
        if (cond.variable !== 'mpr_pct') {
          errors.push(`Rule ${n}: only the MPR Score variable can qualify a productivity bonus tier today.`)
        }
        if (!BONUS_ALLOWED_OPERATORS.includes(cond.operator)) {
          errors.push(`Rule ${n}: MPR tiers use "is at least", "is at most" or "is between" to keep bonus ranges exclusive.`)
        }
        const v = parseNumber(cond.value)
        const v2 = parseNumber(cond.value2)
        if (v === null) errors.push(`Rule ${n}: a valid MPR percentage is required.`)
        else if (cond.operator === 'between' && v2 === null) errors.push(`Rule ${n}: the upper bound of the MPR range is required.`)
        if (v !== null && (v < 0 || v > 100)) errors.push(`Rule ${n}: MPR is a percentage between 0 and 100.`)
        const pct = parseNumber(rule.then && rule.then.value)
        if (pct === null || pct < 0) errors.push(`Rule ${n}: the bonus percentage of gross salary must be 0 or more.`)
        if (rule.then && rule.then.action && rule.then.action !== 'productivity_bonus') {
          errors.push(`Rule ${n}: the stored bonus model only supports the productivity bonus action.`)
        }
      })
      return errors.concat(findRuleOverlaps(rules).map((o) => o.message))
    },
    describe(draft, options) {
      const lines = []
      const rules = draft.rules || []
      rules.forEach((rule, i) => lines.push(`Rule ${i + 1}: ${describeRule(rule, options)}`))
      lines.push(`Eligible designations: ${draft.eligible.length ? draft.eligible.map(title).join(', ') : '—'}`)
      lines.push(`Employees become eligible after ${draft.waitMonths === '' ? '—' : `${draft.waitMonths} months`}.`)
      const freq = draft.frequency || []
      lines.push(freq.length ? `Payment frequency: ${freq.map((r) => `${title(r.designation)} → ${r.frequency === 'monthly' ? 'Monthly' : 'Quarterly'}`).join(' · ')}` : 'No payment frequency configured.')
      return lines
    },
    summarize(value) {
      const draft = this.fromConfig(value)
      return this.describe(draft)
    },
  },

  // ---- PRODUCTIVITY QUALIFICATION --------------------------------
  'bonus.qualification': {
    key: 'bonus.qualification',
    label: 'Productivity Qualification Criteria',
    editable: true,
    fromConfig(value) {
      const cfg = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
      return {
        mpr_min: cfg.mpr_min == null ? '' : String(cfg.mpr_min),
        mpr_max: cfg.mpr_max == null ? '' : String(cfg.mpr_max),
        par_pct: cfg.par_pct == null ? '' : String(cfg.par_pct),
        new_staff_par_pct: cfg.new_staff_par_pct == null ? '' : String(cfg.new_staff_par_pct),
        portfolio_achievement_pct: cfg.portfolio_achievement_pct == null ? '' : String(cfg.portfolio_achievement_pct),
        sme_par_max_days: cfg.sme_par_max_days == null ? '' : String(cfg.sme_par_max_days),
      }
    },
    toConfig(draft) {
      const buildCriteria = (d) => [
        `MPR score between ${parseNumber(d.mpr_min)} and ${parseNumber(d.mpr_max)} points`,
        `PAR ≤ ${parseNumber(d.par_pct)}% (new staff PAR ≤ ${parseNumber(d.new_staff_par_pct)}%)`,
        `${parseNumber(d.portfolio_achievement_pct)}% portfolio achievement`,
        `SME PAR no more than ${parseNumber(d.sme_par_max_days)} days`,
      ]
      return {
        par_pct: parseNumber(draft.par_pct),
        new_staff_par_pct: parseNumber(draft.new_staff_par_pct),
        mpr_min: parseNumber(draft.mpr_min),
        mpr_max: parseNumber(draft.mpr_max),
        portfolio_achievement_pct: parseNumber(draft.portfolio_achievement_pct),
        sme_par_max_days: parseNumber(draft.sme_par_max_days),
        criteria: buildCriteria(draft),
      }
    },
    validate(draft) {
      const errors = []
      const fields = [
        { key: 'mpr_min', label: 'Minimum MPR' },
        { key: 'mpr_max', label: 'Maximum MPR' },
        { key: 'par_pct', label: 'PAR' },
        { key: 'new_staff_par_pct', label: 'New staff PAR' },
        { key: 'portfolio_achievement_pct', label: 'Portfolio achievement' },
        { key: 'sme_par_max_days', label: 'SME PAR (days)' },
      ]
      fields.forEach((f) => {
        const v = parseNumber(draft[f.key])
        if (v === null) errors.push(`${f.label} must be a number.`)
        else if (v < 0) errors.push(`${f.label} must be 0 or more.`)
      })
      const lo = parseNumber(draft.mpr_min)
      const hi = parseNumber(draft.mpr_max)
      if (lo !== null && hi !== null && hi < lo) errors.push('Maximum MPR must not be below minimum MPR.')
      const par = parseNumber(draft.par_pct)
      const nspar = parseNumber(draft.new_staff_par_pct)
      if (par !== null && nspar !== null && nspar > par) errors.push('New staff PAR must be tighter than (or equal to) the general PAR.')
      return errors
    },
    describe(draft) {
      const n = (v) => (v === '' || v === null ? '—' : String(v))
      return [
        `MPR must be between ${n(draft.mpr_min)}% and ${n(draft.mpr_max)}%.`,
        `PAR must be at most ${n(draft.par_pct)}%.`,
        `New-staff PAR must be at most ${n(draft.new_staff_par_pct)}%.`,
        `Portfolio achievement must be ${n(draft.portfolio_achievement_pct)}%.`,
        `SME PAR must be no more than ${n(draft.sme_par_max_days)} days past due.`,
        'All criteria must hold simultaneously.',
      ]
    },
    summarize(value) {
      return this.describe(this.fromConfig(value))
    },
  },

  // ---- PERFORMANCE SANCTIONS -------------------------------------
  'sanctions.performance': {
    key: 'sanctions.performance',
    label: 'Performance Sanctions',
    editable: true,
    fromConfig: (value) =>
      asRows(value).map((row) => ({
        month: row.month === null || row.month === undefined || row.month === '' ? '' : String(row.month),
        mpr_threshold_pct: row.mpr_threshold_pct === null || row.mpr_threshold_pct === undefined || row.mpr_threshold_pct === '' ? '' : String(row.mpr_threshold_pct),
        sanction: String(row.sanction || ''),
        bonus_forfeit_pct: String(numOrNull(row.bonus_forfeit_pct) ?? ''),
      })),
    toConfig: (draft) =>
      (draft.rows || draft).map((row) => ({
        month: parseNumber(row.month),
        mpr_threshold_pct: parseNumber(row.mpr_threshold_pct),
        sanction: String(row.sanction || '').trim(),
        bonus_forfeit_pct: parseNumber(row.bonus_forfeit_pct),
      })),
    validate(draft) {
      const rows = draft.rows || draft
      const errors = [
        // Threshold and forfeiture are optional: the end-of-progression step
        // legitimately has neither.
        ...validateNumericRows(rows, [
          { key: 'mpr_threshold_pct', label: 'MPR threshold', required: false, allowBlank: true, min: 0, max: 100 },
          { key: 'bonus_forfeit_pct', label: 'bonus forfeiture', required: false, allowBlank: true, min: 0, max: 100 },
        ]),
      ]
      rows.forEach((row, i) => {
        if (!String(row.sanction || '').trim()) errors.push(`Row ${i + 1}: describe the sanction / HR recommendation.`)
        const m = parseNumber(row.month)
        if (m !== null && m < 1) errors.push(`Row ${i + 1}: occurrence must be 1 or more (or leave blank for the end-of-progression step).`)
      })
      const months = rows.map((r) => parseNumber(r.month)).filter((m) => m !== null)
      for (let i = 1; i < months.length; i++) {
        if (months[i] <= months[i - 1]) {
          errors.push('Sanction steps must be in ascending occurrence order.')
          break
        }
      }
      return errors
    },
    describe(draft) {
      const rows = draft.rows || draft
      const lines = []
      rows.forEach((row, i) => {
        const step = row.month === '' || row.month === null ? 'Final step' : `${ordinal(parseNumber(row.month))} occurrence`
        const threshold = row.mpr_threshold_pct === '' || row.mpr_threshold_pct === null ? 'any MPR' : `MPR ≤ ${parseNumber(row.mpr_threshold_pct)}%`
        const forfeit = row.bonus_forfeit_pct === '' || row.bonus_forfeit_pct === null ? 'no bonus forfeiture' : `${parseNumber(row.bonus_forfeit_pct)}% bonus forfeiture`
        lines.push(`${step} (${threshold}): ${row.sanction || '—'} — ${forfeit}.`)
      })
      lines.push('Every step creates an HR recommendation only — consequential employment action requires authorized human approval and is fully audited.')
      return lines
    },
    summarize(value) {
      return this.describe(this.fromConfig(value))
    },
  },

  // ---- REGULATORY REFERENCE VALUES -------------------------------
  'regulatory.reference_values': {
    key: 'regulatory.reference_values',
    label: 'Regulatory Reference Values',
    editable: true,
    fromConfig: (value) =>
      asRows(value).map((row) => ({ metric: String(row.metric || ''), value: row.value == null ? '' : row.value, unit: String(row.unit || '%') })),
    toConfig: (draft) =>
      (draft.rows || draft).map((row) => {
        const raw = row.value
        const numeric = parseNumber(raw)
        const value = typeof raw === 'number' ? raw : numeric !== null ? numeric : String(raw || '').trim()
        return { metric: String(row.metric || '').trim(), value, unit: String(row.unit || '%').trim() }
      }),
    validate(draft) {
      const rows = draft.rows || draft
      const errors = []
      rows.forEach((row, i) => {
        if (!String(row.metric || '').trim()) errors.push(`Row ${i + 1}: metric name is required.`)
        if (String(row.value ?? '') === '' && row.value !== 0) errors.push(`Row ${i + 1}: reference value is required.`)
        if (!['%', 'ratio'].includes(String(row.unit || ''))) errors.push(`Row ${i + 1}: unit must be % or ratio.`)
      })
      return errors
    },
    describe(draft) {
      const rows = draft.rows || draft
      return rows.map((r) => `${title(r.metric)}: reference value ${r.unit === 'ratio' ? r.value : formatValue(r.value, 'percent')}`)
    },
    summarize(value) {
      return asRows(value).map((r) => `${title(r.metric)}: reference value ${String(r.unit) === 'ratio' ? r.value : formatValue(r.value, 'percent')}`)
    },
  },

  // ---- BANKONE PERFORMANCE ENGINE (info only) --------------------
  'bankone.performance_engine': {
    key: 'bankone.performance_engine',
    label: 'BankOne Performance Engine',
    editable: false,
    fromConfig: (value) => ({
      foundationOnly: !!(value && value.foundation_only),
      note: (value && value.note) || 'No note.',
    }),
    toConfig: () => null,
    validate: () => [],
    describe(draft) {
      return [draft.foundationOnly ? 'BankOne feeds are not yet wired — foundation configuration only. No API data is simulated.' : draft.note]
    },
    summarize(value) {
      return this.describe(this.fromConfig(value))
    },
  },
}

// ------------------------------------------------------------- fallback
export const fallbackTranslator = {
  key: '',
  label: 'Configuration',
  editable: true,
  fromConfig: (value) => value,
  toConfig: (value) => value,
  validate: () => [],
  describe: () => [],
  summarize: (value) => [typeof value === 'string' ? value : JSON.stringify(value, null, 2)],
}

export function getTranslator(configKey) {
  return translators[configKey] || { ...fallbackTranslator, key: configKey }
}

// ------------------------------------------------------------- helpers
function ordinal(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return n
  const s = ['th', 'st', 'nd', 'rd']
  const m = v % 100
  return `${v}${s[(m - 20) % 10] || s[m] || s[0]}`
}

export { isDirty, OPERATORS, parseNumber, describeCondition, ruleInterval }