/**
 * Department-name hygiene.
 *
 * `employees.department` and `departments.name` are free text in the hosted
 * schema, so executive TITLES (MD/CEO, Chairman, Director…) get typed into the
 * department field by data-entry staff. They are roles, not cost/report
 * centres, so they must never be offered in a "Department" picker.
 *
 * This module is the ONE place that decides what is not a department. Every
 * department option list (Users approval, HR Organisation, Work Management,
 * Dashboard / Training / Man-Hour / Attendance filters, Director intelligence)
 * runs through it. It is a presentation-layer filter only — it never rewrites
 * stored employee data, so no record is silently destroyed.
 */

// Canonical (upper-cased, whitespace-collapsed) titles that are roles.
export const NON_DEPARTMENT_VALUES = Object.freeze([
  'MD',
  'M.D',
  'M.D.',
  'MD/CEO',
  'MD, CEO',
  'MD & CEO',
  'MD / CEO',
  'CEO',
  'MANAGING DIRECTOR',
  'MANAGING DIRECTOR/CEO',
  'CHAIRMAN',
  'CHAIRMAN/CEO',
  'DIRECTOR',
  'BOARD',
  'BOARD OF DIRECTORS',
])

const NON_DEPARTMENT_SET = new Set(NON_DEPARTMENT_VALUES)

/** Normalize a raw department/title for comparison only (never for storage). */
export function normalizeDepartmentName(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase()
}

/** True when the value is an executive title/role, i.e. NOT a department. */
export function isRoleLikeDepartment(value) {
  const normalized = normalizeDepartmentName(value)
  if (!normalized) return false
  return NON_DEPARTMENT_SET.has(normalized)
}

/**
 * Remove role-like titles from a list of department options. Accepts plain
 * strings or `{ name }` / `{ id }` objects (dashboard RPC option shapes) and
 * always returns the same shape it was given. The caller keeps sorting.
 */
export function filterDepartmentOptions(options) {
  if (!Array.isArray(options)) return []
  return options.filter((option) => {
    if (option == null) return false
    const name = typeof option === 'string' ? option : (option.name ?? option.id ?? option.value)
    // Blank entries are never rendered as a selectable option either.
    if (normalizeDepartmentName(name) === '') return false
    return !isRoleLikeDepartment(name)
  })
}

/**
 * Value to persist for a department field: role-like titles are dropped so a
 * new approval never writes "MD/CEO" back into the department column. A real
 * department is passed through untouched (trimmed only).
 */
export function cleanDepartmentValue(value) {
  const raw = String(value == null ? '' : value).trim()
  if (!raw) return ''
  return isRoleLikeDepartment(raw) ? '' : raw
}

export default filterDepartmentOptions
