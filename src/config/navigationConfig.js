// ============================================================================
// CENTRAL NAVIGATION CONFIG  (Task B, Phase 3)
// ============================================================================
// THE single source of truth for which navigation groups a user sees.
//
// WHY THIS FILE EXISTS
// Navigation used to be one flat, static list filtered only by permission, so
// every role saw a near-identical menu. This file adds the missing dimension -
// DEPARTMENT - and keeps the mapping declarative so it can be mirrored by the
// Flutter app instead of being re-guessed on a second platform.
//
// SECURITY: this is a UX LAYER, NOT A SECURITY BOUNDARY.
// Hiding a menu item is a convenience. The real boundaries are the RLS policies
// and the SECURITY DEFINER RPCs, each of which re-checks the caller's role on
// every call. A user who hand-types a URL for a module their department does not
// own still gets refused by the server. Nothing here may ever be treated as the
// thing that protects a record.
//
// MIRRORING FOR MOBILE: Flutter should copy ROLE_DEPARTMENT verbatim rather than
// inventing its own mapping; if the two ever disagree, this file is correct.
// The explicit .js extension is required so this module can be imported by the
// plain-Node test runner as well as by Vite (which would also accept it).
import { ROLES } from '../constants/roles.js'

// ---------------------------------------------------------------------------
// Department keys. Deliberately NOT the free-text `employees.department`
// (see constants/departments.js - that field contains executive titles and is
// typed by data-entry staff, so it cannot be trusted as a routing key). Role is
// the reliable signal; department is only ever a refinement.
// ---------------------------------------------------------------------------
export const DEPARTMENTS = {
  HR: 'hr',
  AUDIT: 'audit',
  RISK: 'risk',
  ADMIN: 'admin',
  OPERATIONS: 'operations',
  E_BUSINESS: 'e_business',
  FINANCE: 'finance',
  EXECUTIVE: 'executive',
}

/** Roles deliberately shown everything, regardless of department. */
export const UNRESTRICTED_ROLES = [ROLES.SUPER_ADMIN, ROLES.ADMIN]

// ---------------------------------------------------------------------------
// Role -> department. This is the whole mapping, in one readable table.
// ---------------------------------------------------------------------------
export const ROLE_DEPARTMENT = {
  // Leadership is not scoped to one department; it may inspect any of them.
  [ROLES.SUPER_ADMIN]: Object.values(DEPARTMENTS),
  [ROLES.ADMIN]: Object.values(DEPARTMENTS),
  [ROLES.MD_CEO]: [DEPARTMENTS.EXECUTIVE],
  [ROLES.CHAIRMAN]: [DEPARTMENTS.EXECUTIVE],
  [ROLES.DIRECTOR]: [DEPARTMENTS.EXECUTIVE],

  // Human Resources
  [ROLES.HEAD_OF_HUMAN_RESOURCES]: [DEPARTMENTS.HR],
  [ROLES.HR_OFFICER]: [DEPARTMENTS.HR],

  // Audit & Compliance
  [ROLES.HEAD_OF_AUDIT]: [DEPARTMENTS.AUDIT],

  // Risk, Compliance & Legal
  [ROLES.HEAD_OF_RISK_COMPLIANCE]: [DEPARTMENTS.RISK],
  [ROLES.HEAD_OF_LEGAL]: [DEPARTMENTS.RISK],

  // Admin & Corporate Services
  [ROLES.HEAD_OF_BUSINESS]: [DEPARTMENTS.ADMIN],
  [ROLES.HEAD_OF_OPERATIONS]: [DEPARTMENTS.OPERATIONS],

  // E-Business
  [ROLES.HEAD_OF_E_BUSINESS]: [DEPARTMENTS.E_BUSINESS],

  // Finance
  [ROLES.FINANCIAL_CONTROLLER]: [DEPARTMENTS.FINANCE],

  // Front line - their own world, plus the shared tabs.
  [ROLES.AREA_MANAGER]: [DEPARTMENTS.OPERATIONS],
  [ROLES.BRANCH_MANAGER]: [DEPARTMENTS.OPERATIONS],
  [ROLES.LOAN_OFFICER]: [DEPARTMENTS.OPERATIONS],
  [ROLES.RELATIONSHIP_MANAGER]: [DEPARTMENTS.OPERATIONS],
  [ROLES.CUSTOMER_SERVICE]: [DEPARTMENTS.OPERATIONS],

  // Everyone else is a plain employee: shared tabs only.
  [ROLES.STAFF]: [],
  [ROLES.CUSTOMER]: [],
}

/** The departments a user belongs to. Empty means "shared tabs only". */
export function departmentsForRole(role) {
  if (!role) return []
  if (UNRESTRICTED_ROLES.includes(role)) return Object.values(DEPARTMENTS)
  return ROLE_DEPARTMENT[role] || []
}

/** True when the user has no departmental workspace. */
export function isSharedOnly(role) {
  return departmentsForRole(role).length === 0
}

/**
 * The groups of `routeConfig` a user may see.
 *
 * A pure filter, so it is testable without a React tree and so the identical
 * predicate can be mirrored by mobile. A group is kept when EITHER it has no
 * `department` (a shared group), or the user's departments include it.
 *
 * This runs BEFORE the existing permission filter, not instead of it - the two
 * compose, and the permission check remains the stricter of the two.
 *
 * @param {Array} sections  the static groups from navigation.jsx
 * @param {{role: string, department?: string|null}} auth
 */
export function filterSectionsByDepartment(sections, auth) {
  const { role, department } = auth || {}
  if (UNRESTRICTED_ROLES.includes(role)) return sections

  const mine = new Set(departmentsForRole(role))
  // A stored department may refine the role mapping but never replaces it,
  // since the column is free text and may hold an executive title instead.
  if (department) {
    const normalised = String(department).trim().toLowerCase().replace(/[\s-]+/g, '_')
    if (Object.values(DEPARTMENTS).includes(normalised)) mine.add(normalised)
  }

  return sections.filter((group) => {
    if (!group.department) return true
    return mine.has(group.department)
  })
}

/** True when a section belongs to a department (i.e. is not shared). */
export function isDepartmental(group) {
  return !!group?.department
}

