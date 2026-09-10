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
  LayoutDashboard,
  Link2,
  ListChecks,
  ScrollText,
  Settings,
  ShieldCheck,
  Star,
  Target,
  TrendingUp,
  UserCheck,
  UserCog,
  Users,
  Wallet,
  Monitor,
} from 'lucide-react'
import { PERMISSIONS } from '../constants/permissions'

export const routeConfig = [
  {
    section: 'Core Banking Intelligence',
    items: [
      { label: 'Dashboard', path: '/', icon: LayoutDashboard, element: 'Dashboard', permissions: [] },
      { label: 'BankOne Imports', path: '/bankone-imports', icon: Database, element: 'BankOneImportCenter', permissions: [PERMISSIONS.BANKONE_READ] },
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
      { label: 'HR Queries', path: '/hr-queries', icon: ClipboardList, element: 'HRQueries', permissions: [PERMISSIONS.HR_APPLICATIONS_READ] },
      { label: 'Appraisals', path: '/appraisals', icon: Star, element: 'Appraisals', permissions: [PERMISSIONS.HR_APPLICATIONS_READ] },
      { label: 'Attendance', path: '/attendance', icon: Clock3, element: 'Attendance', permissions: [PERMISSIONS.HR_ATTENDANCE_SELF] },
      { label: 'Attendance Mgmt', path: '/attendance-management', icon: ClipboardList, element: 'AttendanceManagement', permissions: [PERMISSIONS.HR_ATTENDANCE_MANAGE] },
      { label: 'Platform Settings', path: '/platform-settings', icon: Settings, element: 'PlatformSettings', permissions: [PERMISSIONS.HR_SETTINGS_MANAGE] },
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
      { label: 'Attendance Terminal', path: '/attendance-terminal', icon: Monitor, element: 'AttendanceTerminal', permissions: [] },
    ],
  },
  {
    section: 'Work',
    items: [
      { label: 'My Work', path: '/my-work', icon: ListChecks, element: 'MyWork', permissions: [] },
      { label: 'Work Management', path: '/work-management', icon: Target, element: 'WorkManagement', permissions: [PERMISSIONS.HR_APPLICATIONS_READ] },
    ],
  },
]

export const protectedRoutes = routeConfig.flatMap((group) => group.items)

export function canAccessRoute(route, auth) {
  if (!auth?.user || !auth?.profile) return false
  if (auth.role === 'super_admin') return true

  // If the user has a per-user access profile, check it first.
  // The access profile stores module keys that match route paths.
  if (auth.accessModules && auth.accessModules.length > 0) {
    // Map route paths to module keys
    const moduleKey = route.path === '/' ? 'dashboard' : route.path.replace(/^\//, '').replace(/-/g, '_')
    const moduleKeyDash = route.path === '/' ? 'dashboard' : route.path.replace(/^\//, '')
    // Check both dash and underscore variants, plus the raw path
    if (auth.accessModules.includes(moduleKey) || auth.accessModules.includes(moduleKeyDash) || auth.accessModules.includes(route.path)) {
      return true
    }
    // If access modules are defined but this route isn't in them, deny
    // unless the user also has the role-based permission
    if (!route.permissions?.length) return false
  }

  if (!route.permissions?.length) return auth.role !== 'customer'
  return auth.hasAnyPermission(route.permissions)
}
