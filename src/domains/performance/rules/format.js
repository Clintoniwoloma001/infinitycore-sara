// ------------------------------------------------------------------
// Deterministic natural-language rendering of rules and conditions.
// No AI, no generated prose — every sentence is produced from the
// structured rule object through the registry. Used for both the live
// rule previews and the human-readable change history.
// ------------------------------------------------------------------

import { ACTIONS, OPERATORS, UNITS, VARIABLE_MAP, variable } from './registry.js'

export function titleCase(s) {
  return String(s || '')
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((w) => (w.length <= 2 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ')
}

export function formatValue(value, unitKey) {
  const unit = UNITS[unitKey]
  if (!unit) return String(value ?? '')
  return unit.format(value)
}

// A condition is { variable, operator, value, value2?, unit? }.
export function describeCondition(cond, options = {}) {
  if (!cond) return ''
  const meta = VARIABLE_MAP[cond.variable] || variable(cond.variable)
  const label = meta.label || titleCase(cond.variable)
  const op = OPERATORS[cond.operator]
  if (!op) return `${label} <unknown operator>`
  const unitKey = cond.unit || meta.unitKey
  const fmt = (v) => formatEnumValue(cond.variable, v, meta, options) || formatValue(v, unitKey)

  if (op.needsTwoValues) {
    return `${label} ${op.label} ${fmt(cond.value)} and ${fmt(cond.value2)}`
  }
  return `${label} ${op.label} ${fmt(cond.value)}`
}

function formatEnumValue(variableKey, value, meta, options = {}) {
  if (!meta || (meta.valueType !== 'enum' && meta.valueType !== 'boolean')) return null
  if (meta.valueType === 'boolean') return value ? 'Active' : 'Inactive'
  const opts = options[meta.optionsType] || []
  const found = opts.find((o) => {
    const raw = typeof o === 'object' ? o.value : o
    return String(raw).toLowerCase() === String(value).toLowerCase()
  })
  if (found) return typeof found === 'object' ? found.label : titleCase(String(found))
  return titleCase(String(value))
}

// A rule is { when: { mode:'all'|'any', conditions:[...] }, then:{ action, value, unit } }.
export function describeRule(rule, options = {}) {
  if (!rule) return ''
  if (rule.unsupported) {
    return 'This saved rule uses a format the current editor cannot represent — it is preserved unchanged.'
  }
  const conditions = (rule.when && rule.when.conditions) || []
  if (conditions.length === 0) return 'Add at least one condition before saving.'
  const join = rule.when.mode === 'any' ? ' OR ' : ' AND '
  const condText = conditions.map((c) => describeCondition(c, options)).join(join)
  const action = ACTIONS[rule.then && rule.then.action]
  if (!action) return `When ${condText}, then <unsupported action>`
  return `When ${condText}, ${action.phrase(rule.then)}.`
}

export function describeConditionsSummary(conditions, options = {}) {
  return (conditions || []).map((c) => describeCondition(c, options))
}