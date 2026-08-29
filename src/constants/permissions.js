/**
 * Permission constants for granular access control
 */

export const PERMISSIONS = {
  // Customers
  CUSTOMERS_READ: 'customers.read',
  CUSTOMERS_CREATE: 'customers.create',
  CUSTOMERS_UPDATE: 'customers.update',
  CUSTOMERS_DELETE: 'customers.delete',

  // Loans
  LOANS_READ: 'loans.read',
  LOANS_CREATE: 'loans.create',
  LOANS_ASSESS: 'loans.assess',
  LOANS_APPROVE_LOW: 'loans.approve_low',
  LOANS_APPROVE_MEDIUM: 'loans.approve_medium',
  LOANS_APPROVE_HIGH: 'loans.approve_high',
  LOANS_DISBURSE: 'loans.disburse',

  // Documents
  DOCUMENTS_UPLOAD: 'documents.upload',
  DOCUMENTS_READ: 'documents.read',
  DOCUMENTS_VERIFY: 'documents.verify',
  DOCUMENTS_DELETE: 'documents.delete',

  // HR
  HR_JOBS_CREATE: 'hr.jobs.create',
  HR_JOBS_MANAGE: 'hr.jobs.manage',
  HR_APPLICATIONS_READ: 'hr.applications.read',
  HR_APPLICATIONS_SCREEN: 'hr.applications.screen',
  HR_ASSESSMENTS_CREATE: 'hr.assessments.create',
  HR_INTERVIEWS_SCHEDULE: 'hr.interviews.schedule',
  HR_HIRE: 'hr.hire',
  HR_PAYROLL_READ: 'hr.payroll.read',
  HR_OFFER_LETTERS_READ: 'hr.offer_letters.read',
  HR_LEAVE_MANAGE: 'hr.leave.manage',
  BRANCHES_READ: 'branches.read',

  // HR platform (phase 6)
  HR_ONBOARDING_READ: 'hr.onboarding.read',
  HR_ONBOARDING_MANAGE: 'hr.onboarding.manage',
  HR_EMPLOYEE_READ: 'hr.employee.read',
  HR_EMPLOYEE_UPDATE: 'hr.employee.update',
  HR_ATTENDANCE_SELF: 'hr.attendance.self',
  HR_ATTENDANCE_MANAGE: 'hr.attendance.manage',
  PAYROLL_MANAGE: 'payroll.manage',

  // Data import & migration centre
  DATA_IMPORT_VIEW: 'data.import.view',
  DATA_IMPORT_EXECUTE: 'data.import.execute',

  // Support
  SUPPORT_CREATE: 'support.create',
  SUPPORT_READ: 'support.read',
  SUPPORT_RESOLVE: 'support.resolve',

  // Admin
  ADMIN_MANAGE_USERS: 'admin.manage_users',
  ADMIN_VIEW_AUDIT: 'admin.view_audit',
  ADMIN_MANAGE_CONFIG: 'admin.manage_config',

  // Reports
  REPORTS_READ: 'reports.read',
}

// Permission categories for organization
export const PERMISSION_CATEGORIES = {
  customers: 'Customers',
  loans: 'Loans',
  documents: 'Documents',
  hr: 'HR & Recruitment',
  support: 'Support',
  admin: 'Administration',
  branches: 'Branches',
  reports: 'Reports',
}
