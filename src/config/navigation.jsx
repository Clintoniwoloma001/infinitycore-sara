import React from 'react'
import {
  BarChart3,
  BriefcaseBusiness,
  Building2,
  CalendarCheck,
  CalendarDays,
  CalendarRange,
  MapPin,
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
  Crown,
  Mic,
} from 'lucide-react'
import { PERMISSIONS } from '../constants/permissions'
import { DEPARTMENTS } from './navigationConfig'

export const routeConfig = [
  {
    section: 'Core Banking Intelligence',
    items: [
      { label: 'Dashboard', path: '/', icon: LayoutDashboard, element: 'Dashboard', permissions: [] },
      { label: 'Director Intelligence', path: '/director', icon: Crown, element: 'DirectorDashboard', permissions: [PERMISSIONS.DIRECTOR_EXECUTIVE_READ] },
      { label: 'My Profile', path: '/profile', icon: UserCircle, element: 'Profile', permissions: [] },
      { label: 'Messages', path: '/chat', icon: MessageSquare, element: 'MessagesPage', permissions: [] },
      { label: 'Comm Admin', path: '/communication-admin', icon: Landmark, element: 'CommunicationAdmin', permissions: [PERMISSIONS.ADMIN_MANAGE_USERS] },
      { label: 'BankOne Imports', path: '/bankone-imports', icon: Database, element: 'BankOneImportCenter', permissions: [PERMISSIONS.BANKONE_READ] },
      { label: 'Portfolio Import Review', path: '/bankone-portfolio-review', icon: ShieldCheck, element: 'BankOneImportReview', permissions: [PERMISSIONS.BANKONE_READ] },
      { label: 'BankOne Integration', path: '/bankone-integration', icon: Building2, element: 'BankOneIntegration', permissions: [PERMISSIONS.BANKONE_READ] },
    ],
  },
  {
    section: 'Employee 360',
    department: DEPARTMENTS.HR,
    items: [
      { label: 'Employees', path: '/employees', icon: UserCheck, element: 'Employees', permissions: [PERMISSIONS.HR_APPLICATIONS_READ] },
      { label: 'Leave Requests', path: '/leave-requests', icon: CalendarDays, element: 'LeaveRequests', permissions: [] },
      { label: 'Leave Balances', path: '/leave-balances', icon: ListChecks, element: 'LeaveBalances', permissions: [PERMISSIONS.HR_LEAVE_MANAGE] },
      { label: 'Leave Planner', path: '/leave-planner', icon: CalendarRange, element: 'LeaveSchedulePlanner', permissions: [PERMISSIONS.LEAVE_SCHEDULE_VIEW] },
      { label: 'Attendance Mgmt', path: '/attendance-management', icon: ClipboardList, element: 'AttendanceManagement', permissions: [PERMISSIONS.HR_ATTENDANCE_MANAGE] },
      { label: 'Attendance Terminal', path: '/attendance-terminal', icon: Monitor, element: 'AttendanceTerminal', permissions: [PERMISSIONS.ATTENDANCE_TERMINAL] },
    ],
  },
  {
    section: 'Performance',
    department: DEPARTMENTS.HR,
    items: [
      { label: 'Performance', path: '/performance', icon: TrendingUp, element: 'Performance', permissions: [PERMISSIONS.PERFORMANCE_READ] },
      { label: 'MPR Report', path: '/mpr-performance', icon: BarChart3, element: 'MprPerformance', permissions: [PERMISSIONS.PERFORMANCE_READ] },
      { label: 'PIP', path: '/performance-improvement-plans', icon: TrendingDown, element: 'PerformanceImprovementPlans', permissions: [PERMISSIONS.HR_APPLICATIONS_READ] },
      { label: 'Performance Settings', path: '/performance-settings', icon: SlidersHorizontal, element: 'PerformanceSettings', permissions: [PERMISSIONS.PERFORMANCE_MANAGE] },
    ],
  },
  {
    section: 'HR',
    department: DEPARTMENTS.HR,
    items: [
      { label: 'HR Dashboard', path: '/hr-dashboard', icon: BriefcaseBusiness, element: 'HRDashboard', permissions: [PERMISSIONS.HR_APPLICATIONS_READ] },
      { label: 'HR Organisation', path: '/hr-organisation', icon: Network, element: 'HROrganisation', permissions: [PERMISSIONS.HR_ORG_MANAGE] },
      { label: 'Employee Master', path: '/employee-master', icon: Users, element: 'EmployeeMasterReconciliation', permissions: [PERMISSIONS.HR_ORG_MANAGE] },
      { label: 'Recruitment', path: '/recruitment', icon: Users, element: 'Recruitment', permissions: [PERMISSIONS.HR_APPLICATIONS_READ] },
      { label: 'Applications', path: '/applications', icon: Users, element: 'ApplicationManagement', permissions: [PERMISSIONS.HR_APPLICATIONS_READ] },
      { label: 'Interviews', path: '/interviews', icon: CalendarCheck, element: 'Interviews', permissions: [PERMISSIONS.HR_INTERVIEWS_SCHEDULE] },
      { label: 'Assessments', path: '/assessments', icon: ClipboardCheck, element: 'Assessments', permissions: [PERMISSIONS.HR_ASSESSMENTS_CREATE] },
      { label: 'Assessment Builder', path: '/assessment-builder', icon: ClipboardCheck, element: 'AssessmentBuilder', permissions: [PERMISSIONS.HR_ASSESSMENTS_CREATE] },
      { label: 'Onboarding', path: '/onboarding-links', icon: Link2, element: 'OnboardingLinks', permissions: [PERMISSIONS.HR_ONBOARDING_READ] },
      { label: 'HR Queries', path: '/hr-queries', icon: ClipboardList, element: 'HRQueries', permissions: [PERMISSIONS.HR_APPLICATIONS_READ] },
      { label: 'Appraisals', path: '/appraisals', icon: Star, element: 'Appraisals', permissions: [PERMISSIONS.HR_APPLICATIONS_READ] },
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
    department: DEPARTMENTS.FINANCE,
    items: [
      { label: 'Reconciliation', path: '/reconciliation', icon: ShieldCheck, element: 'Reconciliation', permissions: [PERMISSIONS.RECONCILIATION_READ] },
    ],
  },
  {
    section: 'Management',
    items: [
      { label: 'Reports', path: '/reports', icon: BarChart3, element: 'Reports', permissions: [PERMISSIONS.REPORTS_READ] },
      { label: 'Audit Logs', path: '/audit-logs', icon: ScrollText, element: 'AuditLogs', permissions: [PERMISSIONS.ADMIN_VIEW_AUDIT] },
      { label: 'Employee Tracking', path: '/employee-tracking', icon: MapPin, element: 'EmployeeTracking', permissions: [PERMISSIONS.TRACKING_VIEW], trackingGate: true },
      { label: 'User Management', path: '/users', icon: UserCog, element: 'Users', permissions: [PERMISSIONS.ADMIN_MANAGE_USERS] },
      { label: 'Access & Privileges', path: '/privileges', icon: ShieldCheck, element: 'PrivilegeManagement', permissions: [PERMISSIONS.PRIVILEGES_MANAGE] },
      { label: 'Platform Reset', path: '/platform-reset', icon: Eraser, element: 'PlatformReset', permissions: [PERMISSIONS.ADMIN_PLATFORM_RESET] },
    ],
  },
  {
    section: 'Audit & Compliance',
    department: DEPARTMENTS.AUDIT,
    items: [
      { label: 'Audit Workspace', path: '/audit', icon: ShieldCheck, element: 'Audit', permissions: [PERMISSIONS.AUDIT_MONITORING_READ] },
    ],
  },
  {
    section: 'Automation',
    items: [
      { label: 'Command Centre', path: '/automation', icon: Gauge, element: 'AutomationCommandCentre', permissions: [PERMISSIONS.AUTOMATION_PORTFOLIO_READ] },
    ],
  },
  {
    section: 'Work',
    items: [
      { label: 'My Work', path: '/my-work', icon: ListChecks, element: 'MyWork', permissions: [] },
      { label: 'Attendance', path: '/attendance', icon: Clock3, element: 'Attendance', permissions: [PERMISSIONS.HR_ATTENDANCE_SELF] },
      { label: 'Work Management', path: '/work-management', icon: Target, element: 'WorkManagement', permissions: [PERMISSIONS.HR_APPLICATIONS_READ] },
      { label: 'My Training', path: '/my-training', icon: GraduationCap, element: 'MyTraining', permissions: [] },
      { label: 'I-Meet', path: '/imeet', icon: Mic, element: 'IMeet', permissions: [] },
    ],
  },
]

export const protectedRoutes = routeConfig.flatMap((group) => group.items)

// The menu, the route guard and the SARA agent router MUST agree with each
// other, and with the database. They previously did not: this file exported its
// OWN canAccessRoute that consulted the legacy `auth.accessModules` list and
// never looked at the granular permission document (`permDoc` / `allowedKeys`).
// `config/accessControl.js` held the correct precedence model but was dead code
// — nothing imported it.
//
// That is the real cause of "Super Admin granted it but the menu still hides
// it, and refreshing does not help": Access Control writes to role_permissions /
// user_permissions, `get_my_permissions()` correctly reported the grant, and the
// menu then re-derived access from a different table entirely. A refresh re-read
// the same wrong source, so it never recovered.
//
// The fix is to have exactly ONE implementation. navigation.jsx now re-exports
// it, so every existing import site keeps working unchanged and there is no
// second decision to drift.
export { canAccessRoute } from './accessControl.js'
