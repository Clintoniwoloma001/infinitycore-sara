// -----------------------------------------------------------------------------
// Offer and payroll remuneration normalisation.
//
// Payroll stores an employee's base salary and allocated components monthly.
// The offer document presents the same package annually, so this module is the
// boundary between those two representations.  The persisted snapshot keeps
// both the source values and the calculated totals for audit/version history.
// -----------------------------------------------------------------------------

export const PAY_COMPONENTS = [
  { key: 'basic', label: 'Basic Pay' },
  { key: 'housing', label: 'Housing Allowance' },
  { key: 'transport', label: 'Transport Allowance' },
  { key: 'furniture', label: 'Furniture Allowance' },
  { key: 'medical', label: 'Medical Allowance' },
  { key: 'dressing', label: 'Dressing Allowance' },
  { key: 'utility', label: 'Utility Allowance' },
  { key: 'lunch', label: 'Lunch Allowance' },
  { key: 'telephone', label: 'Telephone Allowance' },
  { key: 'education', label: 'Education Allowance' },
]

export const COA_COMPONENTS = [{ key: 'coa', label: 'COA / Other Allowances' }]

export const BENEFIT_COMPONENTS = [
  { key: 'leave_allowance', label: 'Leave Allowance' },
  { key: 'thirteenth_month', label: '13th Month / Annual Bonus' },
  { key: 'other_benefit', label: 'Other Benefits' },
]

export const SOCIAL_COMPONENTS = [
  { key: 'pension', label: 'Employer Pension Contribution' },
  { key: 'hmo', label: 'Health Insurance / HMO' },
  { key: 'group_life', label: 'Group Life Insurance' },
  { key: 'other_social', label: 'Other Employer Contributions' },
]

const round2 = (value) => Math.round(Number(value || 0) * 100) / 100
const num = (value) => {
  const result = Number(value)
  return Number.isFinite(result) && result > 0 ? result : 0
}

const GROUPS = new Set(['pay', 'coa', 'benefit', 'social'])

function normaliseCustom(items = []) {
  if (!Array.isArray(items)) return []
  return items.map((item, index) => ({
    id: item?.id || `custom-${index + 1}`,
    label: String(item?.label || item?.name || 'Other component').trim(),
    group: GROUPS.has(item?.group) ? item.group : 'pay',
    amount: num(item?.amount ?? item?.annual_amount ?? item?.value),
    basis: item?.basis === 'monthly' ? 'monthly' : item?.basis === 'percentage' ? 'percentage' : 'annual',
    rate: num(item?.rate),
    enabled: item?.enabled !== false,
    cashable: item?.cashable !== false,
    include_in_guaranteed: item?.include_in_guaranteed !== false,
    include_in_cost: item?.include_in_cost !== false,
  })).filter((item) => item.label)
}

export function emptyRemuneration(input = {}) {
  const source = input || {}
  const makeMap = (components, key) => Object.fromEntries(
    components.map((component) => [component.key, num(source?.[key]?.[component.key])])
  )

  return {
    annual_salary: num(source.annual_salary ?? source.annual_gross),
    monthly_salary: num(source.monthly_salary ?? source.monthly_gross),
    mid_month_salary: num(source.mid_month_salary),
    end_month_salary: num(source.end_month_salary ?? source.month_end_salary),
    pay: makeMap(PAY_COMPONENTS, 'pay'),
    coa: makeMap(COA_COMPONENTS, 'coa'),
    benefit: makeMap(BENEFIT_COMPONENTS, 'benefit'),
    social: makeMap(SOCIAL_COMPONENTS, 'social'),
    custom: normaliseCustom(source.custom || source.custom_components),
    config: {
      mid_month_ratio: Number.isFinite(Number(source?.config?.mid_month_ratio))
        ? Math.max(0, Math.min(1, Number(source.config.mid_month_ratio)))
        : (Number.isFinite(Number(source.mid_month_ratio)) ? Math.max(0, Math.min(1, Number(source.mid_month_ratio))) : 0.5),
    },
  }
}

function componentValue(item, baseAnnual) {
  if (!item?.enabled) return 0
  if (item.basis === 'percentage') return round2(baseAnnual * num(item.rate ?? item.amount) / 100)
  return round2(item.basis === 'monthly' ? num(item.amount) * 12 : num(item.amount))
}

function customRows(items, group, baseAnnual) {
  return items
    .filter((item) => item.group === group && item.enabled)
    .map((item) => ({
      item,
      value: componentValue(item, baseAnnual),
    }))
    .filter(({ value }) => value > 0)
}

function fixedRows(components, values) {
  return components
    .filter((component) => num(values?.[component.key]) > 0)
    .map((component) => ({ label: component.label, value: num(values[component.key]), key: component.key }))
}

function addGroup(rows, label, entries) {
  if (!entries.length) return
  rows.push({ label, value: null, tone: 'group' })
  entries.forEach((entry) => rows.push(entry))
}

// Convert the structured offer input into the ordered table shown in the PDF.
export function computeRemuneration(input = {}) {
  const source = emptyRemuneration(input)
  const custom = source.custom

  const initialFixedPay = fixedRows(PAY_COMPONENTS, source.pay)
  const initialFixedCoa = fixedRows(COA_COMPONENTS, source.coa)
  const initialFixedBenefits = fixedRows(BENEFIT_COMPONENTS, source.benefit)
  const initialFixedSocial = fixedRows(SOCIAL_COMPONENTS, source.social)
  const explicitAnnual = num(source.annual_salary)
  const explicitMonthly = num(source.monthly_salary)
  const fixedPayTotal = initialFixedPay.reduce((sum, row) => sum + row.value, 0)
  const fixedCoaTotal = initialFixedCoa.reduce((sum, row) => sum + row.value, 0)
  const customPayBeforeBase = customRows(custom, 'pay', explicitAnnual || explicitMonthly * 12)
  const customCoa = customRows(custom, 'coa', explicitAnnual || explicitMonthly * 12)
  const componentPayTotal = fixedPayTotal + customPayBeforeBase.reduce((sum, row) => sum + row.value, 0)

  // If a component schedule exists, it is authoritative. Otherwise an annual
  // or monthly gross entry is converted into the Basic Pay line.
  const payTotalA = componentPayTotal > 0
    ? componentPayTotal
    : (explicitAnnual > 0 ? explicitAnnual : explicitMonthly * 12)
  const baseAnnual = payTotalA

  // Percentage custom components are based on annual base pay, so calculate
  // them again after the authoritative base is known.
  const customPay = customRows(custom, 'pay', baseAnnual)
  const customCoaRows = customRows(custom, 'coa', baseAnnual)
  const payTotal = fixedPayTotal + customPay.filter(({ item }) => item.include_in_guaranteed).reduce((sum, row) => sum + row.value, 0)
  const coaTotal = fixedCoaTotal + customCoaRows.filter(({ item }) => item.include_in_guaranteed).reduce((sum, row) => sum + row.value, 0)
  const totalPayA = payTotal > 0 ? payTotal : payTotalA

  const monthlyGross = explicitMonthly > 0 && componentPayTotal === 0
    ? explicitMonthly
    : round2((totalPayA + coaTotal) / 12)
  const annualGross = componentPayTotal > 0
    ? round2(totalPayA + coaTotal)
    : round2(monthlyGross * 12)
  const midRatio = source.config.mid_month_ratio
  const midMonth = num(source.mid_month_salary) > 0
    ? num(source.mid_month_salary)
    : round2(monthlyGross * midRatio)
  const monthEnd = num(source.end_month_salary) > 0
    ? num(source.end_month_salary)
    : round2(monthlyGross - midMonth)

  const customBenefitRows = customRows(custom, 'benefit', baseAnnual)
  const customSocialRows = customRows(custom, 'social', baseAnnual)
  const benefitEntries = [
    ...initialFixedBenefits.map((row) => ({ ...row, annual: true, cashable: row.key !== 'leave_allowance' })),
    ...customBenefitRows.map(({ item, value }) => ({ label: item.label, value, key: item.id, cashable: item.cashable, include_in_guaranteed: item.include_in_guaranteed, note: item.cashable ? '' : 'non-cashable' })),
  ]
  const socialEntries = [
    ...initialFixedSocial.map((row) => ({ ...row, annual: true, cashable: false })),
    ...customSocialRows.map(({ item, value }) => ({ label: item.label, value, key: item.id, cashable: false, include_in_cost: item.include_in_cost, note: 'non-cashable' })),
  ]
  const benefitTotal = benefitEntries.reduce((sum, row) => sum + (row.include_in_guaranteed === false ? 0 : row.value), 0)
  const socialTotal = socialEntries.reduce((sum, row) => sum + (row.include_in_cost === false ? 0 : row.value), 0)
  const guaranteed = round2(totalPayA + coaTotal + benefitTotal)
  const totalCost = round2(guaranteed + socialTotal)

  const rows = []
  const payEntries = [
    ...initialFixedPay.map((row) => ({ label: `${row.label} - per annum`, value: row.value })),
    ...customPay.map(({ item, value }) => ({ label: `${item.label} - per annum`, value, note: item.cashable ? '' : 'non-cashable' })),
  ]
  if (!payEntries.length && totalPayA > 0) payEntries.push({ label: 'Basic Pay - per annum', value: totalPayA })
  addGroup(rows, 'BASE PAY', payEntries)
  rows.push({ label: 'TOTAL PAY (A)', value: round2(totalPayA), tone: 'total', tag: 'A' })

  const coaEntries = [
    ...initialFixedCoa.map((row) => ({ label: `${row.label} - per annum`, value: row.value })),
    ...customCoaRows.map(({ item, value }) => ({ label: `${item.label} - per annum`, value, note: item.cashable ? '' : 'non-cashable' })),
  ]
  addGroup(rows, 'COA / OTHER ALLOWANCES', coaEntries)
  rows.push({ label: 'Mid-Month Payable', value: midMonth, tone: 'row' })
  rows.push({ label: 'Month-End Payable', value: monthEnd, tone: 'row' })
  rows.push({ label: 'TOTAL PAY (A+B)', value: round2(totalPayA + coaTotal), tone: 'total', tag: 'A+B' })

  addGroup(rows, 'OTHER BENEFITS', benefitEntries.map((entry) => ({
    label: `${entry.label} - per annum`, value: entry.value, note: entry.note || (!entry.cashable ? 'non-cashable' : ''),
  })))
  if (benefitEntries.length) rows.push({ label: 'TOTAL OTHER BENEFITS (C)', value: benefitTotal, tone: 'total', tag: 'C' })
  rows.push({ label: 'GUARANTEED PAY (A+B+C)', value: guaranteed, tone: 'grandtotal', tag: 'A+B+C' })

  addGroup(rows, 'SOCIAL COSTS - NOT CASHABLE', socialEntries.map((entry) => ({
    label: `${entry.label} - per annum`, value: entry.value, note: 'non-cashable',
  })))
  if (socialEntries.length) rows.push({ label: 'TOTAL SOCIAL COSTS (D)', value: socialTotal, tone: 'total', tag: 'D' })
  rows.push({ label: 'TOTAL COST TO COMPANY (A+B+C+D)', value: totalCost, tone: 'grandtotal', tag: 'A+B+C+D' })

  return {
    rows,
    totals: {
      total_pay_a: round2(totalPayA),
      total_b: round2(totalPayA + coaTotal),
      benefit_total: round2(benefitTotal),
      guaranteed_pay: guaranteed,
      social_total: round2(socialTotal),
      total_cost_to_company: totalCost,
      annual_gross: annualGross,
      monthly_gross: monthlyGross,
      mid_month: midMonth,
      month_end: monthEnd,
    },
    snapshot: {
      ...source,
      annual_salary: annualGross,
      monthly_salary: monthlyGross,
      mid_month_salary: midMonth,
      end_month_salary: monthEnd,
      mid_month_ratio: midRatio,
      totals: {
        total_pay_a: round2(totalPayA),
        total_b: round2(totalPayA + coaTotal),
        benefit_total: round2(benefitTotal),
        guaranteed_pay: guaranteed,
        social_total: round2(socialTotal),
        total_cost_to_company: totalCost,
        annual_gross: annualGross,
        monthly_gross: monthlyGross,
        mid_month: midMonth,
        month_end: monthEnd,
      },
    },
  }
}

export function formatMoney(value, currency = null) {
  const cfg = {
    symbol: '₦',
    position: 'prefix',
    decimals: 2,
    ...(currency || {}),
  }
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: cfg.decimals,
    maximumFractionDigits: cfg.decimals,
  }).format(Number(value || 0))
  return cfg.position === 'suffix' ? `${formatted} ${cfg.symbol}` : `${cfg.symbol}${formatted}`
}

// Older offers only carry annual/monthly salary columns. Keep them renderable
// while using the payroll convention that an employee salary is monthly.
export function remunerationFromLegacy(offer = {}) {
  const annual = num(offer.annual_salary)
  const monthly = num(offer.monthly_salary) || (annual > 0 ? round2(annual / 12) : num(offer.salary))
  const annualBasic = annual > 0 ? annual : round2(monthly * 12)
  return emptyRemuneration({
    annual_salary: annualBasic,
    monthly_salary: monthly,
    mid_month_salary: offer.mid_month_salary,
    end_month_salary: offer.end_month_salary,
    pay: { basic: annualBasic },
  })
}

// Map the existing employee salary packages into the offer document shape.
// Package amounts are monthly because that is how payroll calculates them.
export function remunerationFromPayroll(employee = {}, packages = []) {
  const keyFor = (name = '') => {
    const value = String(name).toLowerCase()
    return PAY_COMPONENTS.find((component) => value.includes(component.key))?.key || null
  }
  const pay = { basic: num(employee.basic_salary || employee.salary) * 12 }
  const custom = []
  ;(packages || []).filter((packageRow) => packageRow.active !== false).forEach((packageRow) => {
    const component = packageRow.payroll_salary_components || packageRow.snapshot || {}
    const name = component.name || 'Other allowance'
    const monthlyAmount = num(packageRow.amount)
    const annualAmount = round2(monthlyAmount * 12)
    const key = keyFor(name)
    if (key && key !== 'basic') pay[key] = annualAmount
    else if (component.component_type === 'allowance') custom.push({
      label: name,
      group: 'pay',
      amount: annualAmount,
      basis: 'annual',
      cashable: true,
      include_in_guaranteed: true,
      include_in_cost: true,
    })
  })
  return emptyRemuneration({
    annual_salary: round2(num(employee.salary) * 12),
    monthly_salary: num(employee.salary),
    pay,
    custom,
  })
}

export default {
  PAY_COMPONENTS,
  COA_COMPONENTS,
  BENEFIT_COMPONENTS,
  SOCIAL_COMPONENTS,
  emptyRemuneration,
  computeRemuneration,
  formatMoney,
  remunerationFromLegacy,
  remunerationFromPayroll,
}
