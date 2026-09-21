// ------------------------------------------------------------------
// Rule/range/weight validation used by every translator. All validation
// is pure so it can be unit-tested headlessly and reused across editors.
// A "row" is a plain object with numeric min/max fields; max may be
// null/undefined to mean "no upper bound" (except when the schema fixes
// it closed).
// ------------------------------------------------------------------

export function parseNumber(value) {
  if (value === '' || value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function errorsFor(rows, validators) {
  const errors = []
  for (const check of validators || []) {
    errors.push(...(check(rows) || []))
  }
  return errors
}

// Generic numeric field checks. fieldOptions: array of
// { key, label, required, min, max, allowBlank }. Returns error strings.
export function validateNumericRows(rows, fields) {
  const errors = []
  ;(rows || []).forEach((row, i) => {
    fields.forEach((f) => {
      const v = parseNumber(row[f.key])
      const blank = row[f.key] === '' || row[f.key] === null || row[f.key] === undefined
      if (f.required && blank) {
        errors.push(`Row ${i + 1}: ${f.label} is required.`)
        return
      }
      if (blank && f.allowBlank) return
      if (v === null) {
        if (!f.allowBlank) errors.push(`Row ${i + 1}: ${f.label} must be a number.`)
        return
      }
      if (f.min !== undefined && v < f.min) errors.push(`Row ${i + 1}: ${f.label} must be at least ${f.min}.`)
      if (f.max !== undefined && v > f.max) errors.push(`Row ${i + 1}: ${f.label} must be at most ${f.max}.`)
    })
  })
  return errors
}

// min/max pair validation per row: min <= max; max may be blank (open).
export function validateMinMaxRows(rows, { minField, maxField, minLabel, maxLabel }) {
  const errors = []
  ;(rows || []).forEach((row, i) => {
    const lo = parseNumber(row[minField])
    const hi = parseNumber(row[maxField])
    const hiBlank = row[maxField] === '' || row[maxField] === null || row[maxField] === undefined
    if (lo === null) return // reported by validateNumericRows
    if (hiBlank) return // open-ended upper bound is allowed
    if (hi === null) return
    if (hi < lo) {
      errors.push(`Row ${i + 1}: ${maxLabel} must not be below ${minLabel}.`)
    }
  })
  return errors
}

// Detect overlapping [min,max] intervals (inclusive). max null ⇒ +inf.
// Returns [{rowA,rowB,labelA,labelB,message}] for the renderer.
export function findRangeOverlaps(rows, { minField, maxField, labelField, rowLabel = 'row' }) {
  const entries = (rows || [])
    .map((row, i) => ({
      row,
      i,
      lo: parseNumber(row[minField]),
      hi: parseNumber(row[maxField]),
      name: labelField ? String(row[labelField] || `#${i + 1}`) : `#${i + 1}`,
    }))
    .filter((e) => e.lo !== null)
    .sort((a, b) => a.lo - b.lo)

  const overlaps = []
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]
      const b = entries[j]
      if (a.hi !== null && b.lo > a.hi) break // sorted by lo: no later entry can overlap
      overlaps.push({
        rowA: a.i,
        rowB: b.i,
        message: `${rowLabel} "${a.name}" (${a.lo}–${a.hi === null ? '∞' : a.hi}) overlaps ${rowLabel} "${b.name}" (${b.lo}–${b.hi === null ? '∞' : b.hi}).`,
      })
    }
  }
  return overlaps
}

export function overlapErrors(rows, opts) {
  return findRangeOverlaps(rows, opts).map((o) => o.message)
}

// Sum a numeric field across rows (used for MPR weights).
export function sumField(rows, field) {
  return (rows || []).reduce((sum, r) => sum + (parseNumber(r[field]) || 0), 0)
}

// ------------------------------------------------------------------
// Productivity bonus rules — range exclusivity.
// Each rule conditions[0] (when it is an MPR closed-range condition)
// yields an interval. Rules are evaluated top-to-bottom (first match
// wins), so an overlap between two intervals changes the outcome.
// ------------------------------------------------------------------
export function ruleInterval(rule) {
  const cond = (rule && rule.when && rule.when.conditions && rule.when.conditions[0]) || null
  if (!cond || cond.variable !== 'mpr_pct') return null
  switch (cond.operator) {
    case 'greater_than_or_equal':
      return { lo: parseNumber(cond.value), hi: null }
    case 'less_than_or_equal':
      return { lo: null, hi: parseNumber(cond.value) }
    case 'between':
      return { lo: parseNumber(cond.value), hi: parseNumber(cond.value2) }
    default:
      return null
  }
}

export function findRuleOverlaps(rules) {
  const weighted = rules.map((rule, i) => ({ rule, i, interval: ruleInterval(rule) }))
  const numeric = weighted.filter((w) => w.interval && w.interval.lo !== null)
  const overlaps = []
  for (let a = 0; a < numeric.length; a++) {
    for (let b = a + 1; b < numeric.length; b++) {
      const A = numeric[a]
      const B = numeric[b]
      const x = A.interval
      const y = B.interval
      const bLo = y.lo !== null ? y.lo : -Infinity
      const isOverlap =
        (x.hi === null || bLo <= x.hi) && (y.hi === null || x.lo <= y.hi)
      if (isOverlap) {
        overlaps.push({
          ruleA: A.i + 1,
          ruleB: B.i + 1,
          message: `Productivity Bonus Rule ${A.i + 1} and Rule ${B.i + 1} overlap. Please adjust the ranges before saving.`,
        })
      }
    }
  }
  return overlaps
}

// Convert a bonus rule back to the stored band entry {min,max,pct}.
export function bonusEntryFromRule(rule) {
  if (!rule || rule.unsupported) return null
  const cond = rule.when && rule.when.conditions && rule.when.conditions[0]
  const entry = { percent_of_gross: parseNumber(rule.then && rule.then.value) || 0 }
  if (!cond) return entry
  switch (cond.operator) {
    case 'greater_than_or_equal':
    case 'greater_than':
      entry.min_mpr_pct = parseNumber(cond.value)
      break
    case 'less_than_or_equal':
    case 'less_than':
      entry.max_mpr_pct = parseNumber(cond.value)
      break
    case 'between':
      entry.min_mpr_pct = parseNumber(cond.value)
      entry.max_mpr_pct = parseNumber(cond.value2)
      break
    case 'equals':
      entry.min_mpr_pct = parseNumber(cond.value)
      entry.max_mpr_pct = parseNumber(cond.value)
      break
    default:
      return null
  }
  return entry
}

// Build a rule object from a stored bonus_scale entry.
export function bonusRuleFromEntry(entry) {
  const then = { action: 'productivity_bonus', value: parseNumber(entry.percent_of_gross) || 0, unit: 'percent_of_gross_salary' }
  if (entry.min_mpr_pct == null && entry.max_mpr_pct == null) {
    return { unsupported: true, raw: entry, then }
  }
  const conditions = []
  if (entry.min_mpr_pct != null && entry.max_mpr_pct != null) {
    conditions.push({ variable: 'mpr_pct', operator: 'between', value: parseNumber(entry.min_mpr_pct), value2: parseNumber(entry.max_mpr_pct), unit: 'percent' })
  } else if (entry.min_mpr_pct != null) {
    conditions.push({ variable: 'mpr_pct', operator: 'greater_than_or_equal', value: parseNumber(entry.min_mpr_pct), unit: 'percent' })
  } else {
    conditions.push({ variable: 'mpr_pct', operator: 'less_than_or_equal', value: parseNumber(entry.max_mpr_pct), unit: 'percent' })
  }
  return { when: { mode: 'all', conditions }, then }
}