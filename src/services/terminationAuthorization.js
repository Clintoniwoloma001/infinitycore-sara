// ==================================================================
// PERSONNEL TERMINATION / FIRING AUTHORIZATION — CANONICAL CLIENT GATE
//
// This is the SINGLE source of truth for "may this InfinityCore user
// terminate/archive an employee" used by the UI (Employees, Employee
// 360 / EmployeeProfile, HR Dashboard, SARA) and mirrored by the
// server-side SECURITY DEFINER RPCs (terminate_employee /
// archive_employee) and the employees_termination_guard trigger.
//
// The frontend gate is UX ONLY. The backend independently re-verifies
// the authenticated user's ACTUAL RBAC role from the session — a
// client-supplied role value is never trusted for authorization.
//
// Only these two roles may terminate/fire an employee:
//   - super_admin
//   - head_of_human_resources
// A person's job designation/title (e.g. "Head of HR") grants NOTHING.
// ==================================================================

export const PERSONNEL_TERMINATION_ROLES = ['super_admin', 'head_of_human_resources']

// Archive is a sensitive employee-lifecycle action and intentionally
// inherits the same restricted authorization model.
export const PERSONNEL_ARCHIVE_ROLES = ['super_admin', 'head_of_human_resources']

export function canTerminateEmployee(role) {
  return PERSONNEL_TERMINATION_ROLES.includes(role)
}

export function canArchiveEmployee(role) {
  return PERSONNEL_ARCHIVE_ROLES.includes(role)
}


// "Delete" (decommission) is exposed via the Employees grid and maps to the
// delete_employee RPC (archive + cancel payroll + deactivate the platform
// login). It inherits the SAME restricted authorization model so that
// termination/archive/delete never compete — the SAME two roles own all three,
// and the ZERO competing-role-systems rule holds.
export function canDeleteEmployee(role) {
  return canArchiveEmployee(role)
}

// Employee reference used for display across Employees / EmployeeProfile.
export function employeeLabel(employee) {
  return (
    employee?.employee_code ||
    employee?.employee_number ||
    employee?.staff_id ||
    'no employee ID'
  )
}

// ------------------------------------------------------------------
// ROLE TEST MATRIX — [role, UI action, backend termination, SARA]
// Used by `npm run test:termination-auth` to prove every role follows
// the same rule end-to-end. super_admin and head_of_human_resources are the ONLY
// two permitted roles; every other role is denied everywhere.
// ------------------------------------------------------------------
export const TERMINATION_ROLE_MATRIX = [
  ['super_admin', true, true, true],
  ['head_of_human_resources', true, true, true],
  ['branch_manager', false, false, false],
  ['area_manager', false, false, false],
  ['admin', false, false, false],
  ['it', false, false, false],
  ['finance', false, false, false],
  ['operations', false, false, false],
  ['credit', false, false, false],
  ['audit', false, false, false],
  ['risk', false, false, false],
  ['e-business', false, false, false],
  ['employee', false, false, false],
  ['customer', false, false, false],
]

export default {
  PERSONNEL_TERMINATION_ROLES,
  PERSONNEL_ARCHIVE_ROLES,
  canTerminateEmployee,
  canArchiveEmployee,
  employeeLabel,
  TERMINATION_ROLE_MATRIX,
}