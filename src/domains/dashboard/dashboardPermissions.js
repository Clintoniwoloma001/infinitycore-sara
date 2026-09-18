import { ROLES } from '../../constants/roles'

const MANAGEMENT_ROLES = new Set([
  ROLES.SUPER_ADMIN,
  ROLES.ADMIN,
  ROLES.HR_MANAGER,
  ROLES.HR_OFFICER,
  ROLES.BRANCH_MANAGER,
  ROLES.AREA_MANAGER,
  ROLES.HEAD_OF_BUSINESS,
  ROLES.OPERATIONS_MANAGER,
])

const ORGANIZATION_FILTER_ROLES = new Set([
  ROLES.SUPER_ADMIN,
  ROLES.ADMIN,
  ROLES.HR_MANAGER,
  ROLES.HR_OFFICER,
])

export function getDashboardPermissions(auth, employee = null) {
  const actualRole = auth?.actualRole || auth?.profile?.role || ROLES.STAFF
  const position = String(employee?.position || employee?.designation || '').trim().toUpperCase()
  const executivePosition = position === 'MD' || position === 'MD/CEO'

  return {
    actualRole,
    canViewManagement: MANAGEMENT_ROLES.has(actualRole) || executivePosition,
    canFilterOrganization: ORGANIZATION_FILTER_ROLES.has(actualRole) || executivePosition,
    canViewHrIntelligence: [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.HR_MANAGER, ROLES.HR_OFFICER].includes(actualRole),
    executivePosition,
  }
}

export default getDashboardPermissions
