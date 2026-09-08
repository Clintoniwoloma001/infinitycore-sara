import React from 'react'
import {
  BarChart3,
  BriefcaseBusiness,
  Building2,
  CalendarCheck,
  CalendarDays,
  ClipboardCheck,
  ClipboardList,
  Clock3,
  Database,
  FileSignature,
  Landmark,
  LayoutDashboard,
  Link2,
  ListChecks,
  ScrollText,
  Settings,
  ShieldCheck,
  TrendingUp,
  UserCheck,
  UserCog,
  Users,
  Wallet,
} from 'lucide-react'
import { PERMISSIONS } from '../constants/permissions'

export const routeConfig = [
  {
    section: 'Core Banking Intelligence',
    items: [
      { label: 'Dashboard', path: '/', icon: LayoutDashboard, element: 'Dashboard', permissions: [] },
      { label: 'BankOne Imports', path: '/bankone-imports', icon: Database, element: 'BankOneImportCenter', permissions: [PERMISSIONS.BANKONE_READ] },
      { label: 'Customers', path: '/customers', icon: Users, element: 'Customers', permissions: [PERMISSIONS.CUSTOMERS_READ] },
      { label: 'Loans', path: '/loans', icon: Landmark, element: 'Loans', permissions: [PERMISSIONS.LOANS_READ] },
      { label: 'Repayments', path: '/repayments', icon: Wallet, element: 'Repayments', permissions: [PERMISSIONS.LOANS_READ] },
    ],
  },
  {
    section: 'Employee 360',
    items: [
      { label: 'Employees', path: '/employees', icon: UserCheck, element: 'Employees', permissions: [PERMISSIONS.HR_APPLICATIONS_READ] },
      { label: 'Leave Requests', path: '/leave-requests', icon: CalendarDays, element: 'LeaveRequests', permissions: [] },
      { label: 'Leave Balances', path: '/leave-balances', icon: ListChecks, element: 'LeaveBalances', permissions: [PERMISSIONS.HR_LEAVE_MANAGE] },
      { label: 'Attendance', path: '/attendance', icon: Clock3, element: 'Attendance', permissions: [PERMISSIONS.HR_ATTENDANCE_SELF] },
      { label: 'Attendance Mgmt', path: '/attendance-management', icon: ClipboardList, element: 'AttendanceManagement', permissions: [PERMISSIONS.HR_ATTENDANCE_MANAGE] },
    ],
  },
  {
    section: 'Performance',
    items: [
      { label: 'Performance', path: '/performance', icon: TrendingUp, element: 'Performance', permissions: [PERMISSIONS.PERFORMANCE_READ] },
    ],
  },
  {
    section: 'HR',
    items: [
      { label: 'HR Dashboard', path: '/hr-dashboard', icon: BriefcaseBusiness, element: 'HRDashboard', permissions: [PERMISSIONS.HR_APPLICATIONS_READ] },
      { label: 'Recruitment', path: '/recruitment', icon: Users, element: 'Recruitment', permissions: [PERMISSIONS.HR_APPLICATIONS_READ] },
      { label: 'Interviews', path: '/interviews', icon: CalendarCheck, element: 'Interviews', permissions: [PERMISSIONS.HR_INTERVIEWS_SCHEDULE] },
      { label: 'Assessments', path: '/assessments', icon: ClipboardCheck, element: 'Assessments', permissions: [PERMISSIONS.HR_ASSESSMENTS_CREATE] },
      { label: 'Onboarding', path: '/onboarding-links', icon: Link2, element: 'OnboardingLinks', permissions: [PERMISSIONS.HR_ONBOARDING_READ] },
      { label: 'Offer Letters', path: '/offer-letters', icon: FileSignature, element: 'OfferLetters', permissions: [PERMISSIONS.HR_OFFER_LETTERS_READ] },
      { label: 'Payroll', path: '/payroll', icon: Wallet, element: 'Payroll', permissions: [PERMISSIONS.HR_PAYROLL_READ] },
      { label: 'Branches', path: '/branches', icon: Building2, element: 'Branches', permissions: [PERMISSIONS.BRANCHES_READ] },
      { label: 'Data Import', path: '/data-import', icon: Database, element: 'DataImport', permissions: [PERMISSIONS.DATA_IMPORT_VIEW] },
    ],
  },
  {
    section: 'Reconciliation',
    items: [
      { label: 'Reconciliation', path: '/reconciliation', icon: ShieldCheck, element: 'Reconciliation', permissions: [PERMISSIONS.RECONCILIATION_READ] },
    ],
  },
  {
    section: 'Management',
    items: [
      { label: 'Reports', path: '/reports', icon: BarChart3, element: 'Reports', permissions: [PERMISSIONS.REPORTS_READ] },
      { label: 'Audit Logs', path: '/audit-logs', icon: ScrollText, element: 'AuditLogs', permissions: [PERMISSIONS.ADMIN_VIEW_AUDIT] },
      { label: 'Settings', path: '/settings', icon: Settings, element: 'Settings', permissions: [PERMISSIONS.HR_CONFIG_MANAGE] },
      { label: 'User Management', path: '/users', icon: UserCog, element: 'Users', permissions: [PERMISSIONS.ADMIN_MANAGE_USERS] },
    ],
  },
  {
    section: 'Work',
    items: [
      { label: 'My Work', path: '/my-work', icon: ListChecks, element: 'MyWork', permissions: [] },
    ],
  },
]

export const protectedRoutes = routeConfig.flatMap((group) => group.items)

export function canAccessRoute(route, auth) {
  if (!auth?.user || !auth?.profile) return false
  if (auth.role === 'super_admin') return true
  if (!route.permissions?.length) return auth.role !== 'customer'
  return auth.hasAnyPermission(route.permissions)
}
