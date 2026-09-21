// ------------------------------------------------------------------
// Performance Rules Builder — BUSINESS VARIABLE REGISTRY.
// Single source of truth for every variable, operator, action and unit
// the rule UIs can reference. Components never hard-code business
// strings; they read from here. Variables that exist in the wider data
// model but are NOT yet consumable by the performance engine are kept
// in the catalog with `available:false` so nobody can build a rule the
// engine could never evaluate.
//
// Strictly a configuration-layer concern. It describes what can be
// configured, it never computes MPR/PAR/bonuses.
// ------------------------------------------------------------------

// --------------------------------------------------------------- units
// A unit is how a raw number is rendered/written. Value columns in the
// stored config always keep the NORMALISED number — formatting happens
// here and only for display.
export const UNITS = {
  percent: { key: 'percent', label: 'Percentage', suffix: '%', format: (v) => `${trimNumber(v)}%` },
  percent_of_gross_salary: { key: 'percent_of_gross_salary', label: '% of Gross Salary', suffix: '% of Gross Salary', format: (v) => `${trimNumber(v)}% of gross salary` },
  naira: { key: 'naira', label: 'Naira', prefix: '₦', format: formatNaira },
  count: { key: 'count', label: 'Count', suffix: '', format: (v) => trimNumber(v) },
  employees: { key: 'employees', label: 'Employees', suffix: 'employees', format: (v) => `${trimNumber(v)} employees` },
  months: { key: 'months', label: 'Months', suffix: 'months', format: (v) => `${trimNumber(v)} months` },
  days: { key: 'days', label: 'Days', suffix: 'days', format: (v) => `${trimNumber(v)} days` },
  points: { key: 'points', label: 'Points', suffix: 'points', format: (v) => `${trimNumber(v)} points` },
  ratio: { key: 'ratio', label: 'Ratio', suffix: '', format: (v) => String(v ?? '') },
  yes_no: { key: 'yes_no', label: 'Yes / No', suffix: '', format: (v) => (v ? 'Yes' : 'No') },
}

function trimNumber(n) {
  const v = Number(n ?? 0)
  return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : String(n ?? '')
}

export function formatNaira(v) {
  const n = Number(v ?? 0)
  if (!Number.isFinite(n)) return `₦${String(v ?? '')}`
  return `₦${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

// ------------------------------------------------------------ operators
export const OPERATORS = {
  equals: { key: 'equals', label: 'is equal to', symbol: '=', needsTwoValues: false },
  not_equals: { key: 'not_equals', label: 'is not equal to', symbol: '≠', needsTwoValues: false },
  greater_than: { key: 'greater_than', label: 'is greater than', symbol: '>', needsTwoValues: false },
  greater_than_or_equal: { key: 'greater_than_or_equal', label: 'is at least', symbol: '≥', needsTwoValues: false },
  less_than: { key: 'less_than', label: 'is less than', symbol: '<', needsTwoValues: false },
  less_than_or_equal: { key: 'less_than_or_equal', label: 'is at most', symbol: '≤', needsTwoValues: false },
  between: { key: 'between', label: 'is between', symbol: '–', needsTwoValues: true },
}

// Closed-range operators — the set that maps 1:1 onto the stored
// `min_*/max_*` band model without losing exclusivity semantics.
export const CLOSED_RANGE_OPERATORS = ['greater_than_or_equal', 'less_than_or_equal', 'between']

// -------------------------------------------------------------- actions
export const ACTIONS = {
  productivity_bonus: {
    key: 'productivity_bonus',
    label: 'Productivity Bonus',
    unit: 'percent_of_gross_salary',
    description: 'Pays a productivity bonus as a percentage of the employee gross salary.',
    phrase: (then) => `the employee receives a productivity bonus equal to ${UNITS.percent_of_gross_salary.format(then.value)}`,
  },
  mobility_allowance: {
    key: 'mobility_allowance',
    label: 'Mobility Allowance',
    unit: 'naira',
    description: 'Adds a monthly mobility allowance based on the portfolio tier.',
    phrase: (then) => `the employee receives a mobility allowance of ${UNITS.naira.format(then.value)} per month`,
  },
  create_hr_review_task: {
    key: 'create_hr_review_task',
    label: 'Create HR review task',
    unit: null,
    description: 'Creates an HR review/recommendation for authorized human follow-up. Never an automatic employment action.',
    phrase: () => 'the system creates an HR review task for the employee (human-approval required)',
  },
}

// ------------------------------------------------ performance components
// Only the components the MPR model recognises. Unknown components
// already present in a saved config are preserved by the translators.
export const MPR_COMPONENTS = [
  { key: 'DISBURSEMENT', label: 'Disbursement' },
  { key: 'PAR', label: 'PAR' },
  { key: 'CASELOAD', label: 'Caseload' },
]

export const DESIGNATION_FREQUENCIES = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
]

// ------------------------------------------------------------- variables
// valueType drives the input widget; unitKey drives formatting.
// available:false ⇒ data exists somewhere in the platform but the
// performance rule engine cannot consume it yet — do not offer it.
export const VARIABLES = [
  // PERFORMANCE / MPR
  { key: 'mpr_pct', label: 'MPR Score', category: 'Performance / MPR', valueType: 'percentage', unitKey: 'percent', operators: ['equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'], available: true, description: 'The composite MPR score expressed as a percentage (0–100).' },
  { key: 'par_pct', label: 'PAR', category: 'Performance / MPR', valueType: 'percentage', unitKey: 'percent', operators: ['equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'], available: true, description: 'Portfolio at risk as a percentage of the outstanding portfolio.' },
  { key: 'disbursement_amount', label: 'Disbursement', category: 'Performance / MPR', valueType: 'currency', unitKey: 'naira', operators: ['equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'], available: true, description: 'Total amount disbursed in the period.' },
  { key: 'caseload', label: 'Caseload', category: 'Performance / MPR', valueType: 'count', unitKey: 'employees', operators: ['equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'], available: true, description: 'Number of clients an officer manages.' },
  { key: 'portfolio', label: 'Portfolio', category: 'Performance / MPR', valueType: 'currency', unitKey: 'naira', operators: ['equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'], available: true, description: 'Outstanding loan portfolio value.' },
  { key: 'portfolio_achievement_pct', label: 'Portfolio Achievement', category: 'Performance / MPR', valueType: 'percentage', unitKey: 'percent', operators: ['equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'], available: true, description: 'Portfolio delivered against target, as a percentage.' },
  { key: 'productivity_score', label: 'Productivity Score', category: 'Performance / MPR', valueType: 'score', unitKey: 'points', operators: ['equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'], available: true, description: 'The overall weighted productivity score from performance results.' },

  // LOAN / CREDIT
  { key: 'outstanding_principal', label: 'Outstanding Principal', category: 'Loan / Credit', valueType: 'currency', unitKey: 'naira', operators: ['equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'], available: false, description: 'Current outstanding principal on loans.' },
  { key: 'loan_count', label: 'Loan Count', category: 'Loan / Credit', valueType: 'count', unitKey: 'count', operators: ['equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'], available: false, description: 'Number of loans held.' },
  { key: 'days_past_due', label: 'Days Past Due', category: 'Loan / Credit', valueType: 'days', unitKey: 'days', operators: ['equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'], available: false, description: 'Days an obligation has been overdue.' },
  { key: 'disbursement_achievement_pct', label: 'Disbursement Achievement', category: 'Loan / Credit', valueType: 'percentage', unitKey: 'percent', operators: ['equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'], available: true, description: 'Disbursement delivered against target, as a percentage.' },

  // EMPLOYEE
  { key: 'designation', label: 'Designation', category: 'Employee', valueType: 'enum', unitKey: 'yes_no', operators: ['equals', 'not_equals'], available: true, optionsType: 'designation', description: 'The employee role from the designation master data.' },
  { key: 'department', label: 'Department', category: 'Employee', valueType: 'enum', unitKey: 'yes_no', operators: ['equals', 'not_equals'], available: true, optionsType: 'department', description: 'The employee department.' },
  { key: 'branch', label: 'Branch', category: 'Employee', valueType: 'enum', unitKey: 'yes_no', operators: ['equals', 'not_equals'], available: true, optionsType: 'branch', description: 'The employee branch.' },
  { key: 'area', label: 'Area', category: 'Employee', valueType: 'enum', unitKey: 'yes_no', operators: ['equals', 'not_equals'], available: true, optionsType: 'area', description: 'The employee area.' },
  { key: 'employment_status', label: 'Employment Status', category: 'Employee', valueType: 'boolean', unitKey: 'yes_no', operators: ['equals', 'not_equals'], available: true, optionsType: 'employment_status', description: 'Active / suspended / revoked employment state.' },
  { key: 'months_of_service', label: 'Months of Service', category: 'Employee', valueType: 'months', unitKey: 'months', operators: ['equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'], available: true, description: 'Full months the employee has served.' },

  // SALARY / COMPENSATION
  { key: 'gross_salary', label: 'Gross Salary', category: 'Salary / Compensation', valueType: 'currency', unitKey: 'naira', operators: ['equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'], available: true, description: 'Monthly gross compensation.' },
  { key: 'basic_salary', label: 'Basic Salary', category: 'Salary / Compensation', valueType: 'currency', unitKey: 'naira', operators: ['equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'], available: true, description: 'Monthly basic salary.' },

  // ATTENDANCE & LEAVE — in the data model, NOT yet consumable by the
  // performance rule engine. Kept in the catalog but unavailable.
  { key: 'attendance_pct', label: 'Attendance Percentage', category: 'Attendance', valueType: 'percentage', unitKey: 'percent', operators: ['equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'], available: false, description: 'Attendance records exist but are not yet wired into performance rules.' },
  { key: 'late_count', label: 'Late Count', category: 'Attendance', valueType: 'count', unitKey: 'count', operators: ['equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'], available: false, description: 'Attendance records exist but are not yet wired into performance rules.' },
  { key: 'absence_count', label: 'Absence Count', category: 'Attendance', valueType: 'count', unitKey: 'count', operators: ['equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'], available: false, description: 'Attendance records exist but are not yet wired into performance rules.' },
  { key: 'leave_balance', label: 'Leave Balance', category: 'Leave', valueType: 'days', unitKey: 'days', operators: ['equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'], available: false, description: 'Leave records exist but are not yet wired into performance rules.' },
  { key: 'leave_utilization', label: 'Leave Utilization', category: 'Leave', valueType: 'percentage', unitKey: 'percent', operators: ['equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'], available: false, description: 'Leave records exist but are not yet wired into performance rules.' },
]

export const VARIABLE_MAP = Object.fromEntries(VARIABLES.map((v) => [v.key, v]))

export const availableVariableKeys = () => VARIABLES.filter((v) => v.available).map((v) => v.key)

export function variable(key) {
  return VARIABLE_MAP[key] || { key, label: key, valueType: 'number', unitKey: 'count', operators: ['equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'], available: true, description: '' }
}