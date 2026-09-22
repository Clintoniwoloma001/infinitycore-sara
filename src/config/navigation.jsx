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
  TrendingDown,
  UserCheck,
  UserCog,
  Users,
  Wallet,
  Monitor,
  UserCircle,
  MessageSquare,
  Network,
  SlidersHorizontal,
  Stethoscope,
  Landmark,
  Eraser,
  GraduationCap,
  Gauge,
} from 'lucide-react'
import { PERMISSIONS } from '../constants/permissions'

export const routeConfig = [
  {
    section: 'Core Banking Intelligence',
    items: [
      { label: 'Dashboard', path: '/', icon: LayoutDashboard, element: 'Dashboard', permissions: [] },
      { label: 'My Profile', path: '/profile', icon: UserCircle, element: 'Profile', permissions: [] },
      { label: 'Messages', path: '/chat', icon: MessageSquare, element: 'MessagesPage', permissions: [] },
      { label: 'Comm Admin', path: '/communication-admin', icon: Landmark, element: 'CommunicationAdmin', permissions: [PERMISSIONS.ADMIN_MANAGE_USERS] },
      { label: 'BankOne Imports', path: '/bankone-imports', icon: Database, element: 'BankOneImportCenter', permissions: [PERMISSIONS.BANKONE_READ] },
      { label: 'BankOne Integration', path: '/bankone-integration', icon: Building2, element: 'BankOneIntegration', permissions: [PERMISSIONS.BANKONE_READ] },
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
      { label: 'Attendance Terminal', path: '/attendance-terminal', icon: Monitor, element: 'AttendanceTerminal', permissions: [PERMISSIONS.ATTENDANCE_TERMINAL] },
    ],
  },
  {
    section: 'Performance',
    items: [
      { label: 'Performance', path: '/performance', icon: TrendingUp, element: 'Performance', permissions: [PERMISSIONS.PERFORMANCE_READ] },
      { label: 'Performance Settings', path: '/performance-settings', icon: SlidersHorizontal, element: 'PerformanceSettings', permissions: [PERMISSIONS.PERFORMANCE_MANAGE] },
    ],
  },
  {
    section: 'HR',
    items: [
      { label: 'HR Dashboard', path: '/hr-dashboard', icon: BriefcaseBusiness, element: 'HRDashboard', permissions: [PERMISSIONS.HR_APPLICATIONS_READ] },
      { label: 'HR Organisation', path: '/hr-organisation', icon: Network, element: 'HROrganisation', permissions: [PERMISSIONS.HR_ORG_MANAGE] },
      { label: 'Recruitment', path: '/recruitment', icon: Users, element: 'Recruitment', permissions: [PERMISSIONS.HR_APPLICATIONS_READ] },
      { label: 'Applications', path: '/applications', icon: Users, element: 'ApplicationManagement', permissions: [PERMISSIONS.HR_APPLICATIONS_READ] },
      { label: 'Interviews', path: '/interviews', icon: CalendarCheck, element: 'Interviews', permissions: [PERMISSIONS.HR_INTERVIEWS_SCHEDULE] },
      { label: 'Assessments', path: '/assessments', icon: ClipboardCheck, element: 'Assessments', permissions: [PERMISSIONS.HR_ASSESSMENTS_CREATE] },
      { label: 'Assessment Builder', path: '/assessment-builder', icon: ClipboardCheck, element: 'AssessmentBuilder', permissions: [PERMISSIONS.HR_ASSESSMENTS_CREATE] },
      { label: 'Onboarding', path: '/onboarding-links', icon: Link2, element: 'OnboardingLinks', permissions: [PERMISSIONS.HR_ONBOARDING_READ] },
      { label: 'HR Queries', path: '/hr-queries', icon: ClipboardList, element: 'HRQueries', permissions: [PERMISSIONS.HR_APPLICATIONS_READ] },
      { label: 'Appraisals', path: '/appraisals', icon: Star, element: 'Appraisals', permissions: [PERMISSIONS.HR_APPLICATIONS_READ] },
      { label: 'PIP', path: '/performance-improvement-plans', icon: TrendingDown, element: 'PerformanceImprovementPlans', permissions: [PERMISSIONS.HR_APPLICATIONS_READ] },
      { label: 'Medical Screening', path: '/medical-management', icon: Stethoscope, element: 'MedicalManagement', permissions: [PERMISSIONS.MEDICAL_READ] },
      { label: 'Offer Letters', path: '/offer-letters', icon: FileSignature, element: 'OfferLetters', permissions: [PERMISSIONS.HR_OFFER_LETTERS_READ] },
      { label: 'Payroll', path: '/payroll', icon: Wallet, element: 'Payroll', permissions: [PERMISSIONS.HR_PAYROLL_READ] },
      { label: 'Salary Structure', path: '/salary-structure', icon: Wallet, element: 'SalaryStructure', permissions: [PERMISSIONS.HR_PAYROLL_READ] },
      { label: 'Payroll & BankOne', path: '/payroll-bankone', icon: Wallet, element: 'PayrollBankOne', permissions: [PERMISSIONS.PAYROLL_PUSH] },
      { label: 'Settings', path: '/settings', icon: Settings, element: 'Settings', permissions: [PERMISSIONS.HR_SETTINGS_MANAGE] },
      { label: 'Data Import', path: '/data-import', icon: Database, element: 'DataImport', permissions: [PERMISSIONS.DATA_IMPORT_VIEW] },
      { label: 'Training & Development', path: '/training', icon: GraduationCap, element: 'Training', permissions: [PERMISSIONS.HR_TRAINING_READ] },
      { label: 'Man-Hour Intelligence', path: '/man-hour-intelligence', icon: Gauge, element: 'ManHourIntelligence', permissions: [PERMISSIONS.WORKFORCE_MANHOUR_READ] },
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
      { label: 'User Management', path: '/users', icon: UserCog, element: 'Users', permissions: [PERMISSIONS.ADMIN_MANAGE_USERS] },
      { label: 'Platform Reset', path: '/platform-reset', icon: Eraser, element: 'PlatformReset', permissions: [PERMISSIONS.ADMIN_PLATFORM_RESET] },
    ],
  },
  {
    section: 'Work',
    items: [
      { label: 'My Work', path: '/my-work', icon: ListChecks, element: 'MyWork', permissions: [] },
      { label: 'Work Management', path: '/work-management', icon: Target, element: 'WorkManagement', permissions: [PERMISSIONS.HR_APPLICATIONS_READ] },
      { label: 'My Training', path: '/my-training', icon: GraduationCap, element: 'MyTraining', permissions: [] },
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
