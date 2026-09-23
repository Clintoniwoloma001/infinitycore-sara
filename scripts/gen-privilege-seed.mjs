/**
 * gen-privilege-seed.mjs
 *
 * Generates the catalog role-permission seed block used by the granular
 * privilege migration. Reads the launch-frontend role matrix
 * (src/constants/roles.js → ROLE_PERMISSIONS) so the granular engine's
 * "no override" baseline EXACTLY mirrors today's role-based access, then
 * adds the granular keys and their legacy-equivalent baselines.
 *
 * Output goes to stdout and is spliced into the migration at the marker:
 *
 *   -- BEGIN GENERATED PRIVILEGE SEED --
 *   ...emitted SQL...
 *   -- END GENERATED PRIVILEGE SEED --
 *
 * Run: node scripts/gen-privilege-seed.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const rolesSrc = readFileSync(join(root, 'src', 'constants', 'roles.js'), 'utf8')

// Pull ROLE_PERMISSIONS straight out of the source (ESM import is fragile
// because of .jsx-react-free file — we use a tiny regex eval instead).
function extractObject(body, name) {
  const re = new RegExp(`export const ${name} = ({[\\s\\S]*?})\\n`, 'm')
  const m = body.match(re)
  if (!m) throw new Error(`cannot find ${name}`)
  // ROLE_PERMISSIONS uses computed keys [ROLES.X] — inject ROLES so eval works.
  const ROLES = Object.fromEntries(
    [...body.matchAll(/([A-Z][A-Z_]+):\s*'([a-z_]+)'/g)].map((mm) => [mm[1], mm[2]])
  )
  return Function('ROLES', `return ${m[1]}`)(ROLES)
}

const ROLE_PERMISSIONS = extractObject(rolesSrc, 'ROLE_PERMISSIONS')

// ---------------------------------------------------------------------------
// Granular keys that do NOT yet exist in the legacy matrix. Each maps to the
// legacy key(s) that currently imply it, so the baseline grant set keeps
// every role exactly as capable as it is today. Special groups:
//   __ALL__                      → all 18 roles
//   __ALL_NON_CUSTOMER__         → all roles except customer
//   __HEAD_MANAGEMENT__          → head roles + branch/area managers + admin/super
// ---------------------------------------------------------------------------
const GRANULAR = [
  // Attendance
  ['attendance.view', 'hr.attendance.self', false],
  ['attendance.clock_in', 'hr.attendance.self', false],
  ['attendance.clock_out', 'hr.attendance.self', false],
  ['attendance.history', 'hr.attendance.self', false],
  ['attendance.records.view', 'hr.attendance.manage', false],
  ['attendance.records.edit', 'hr.attendance.manage', false],
  ['attendance.records.export', 'hr.attendance.manage', false],
  ['attendance.manage.view', 'hr.attendance.manage', false],
  ['attendance.manage.edit', 'hr.attendance.manage', false],
  ['attendance.audit.view', 'hr.attendance.manage', false],
  ['attendance.bindings.view', 'hr.attendance.manage', false],
  ['attendance.bindings.unbind', 'hr.attendance.manage', false],
  ['attendance.settings.edit', 'attendance.config.manage', false],
  ['attendance.geofence.edit', 'attendance.config.manage', false],
  ['attendance.devices.view', 'attendance.terminal', false],
  ['attendance.devices.manage', 'attendance.terminal', false],
  ['attendance.devices.unbind', 'attendance.terminal', false],
  // Payroll
  ['payroll.view', 'hr.payroll.read|payroll.manage', false],
  ['payroll.salary.view', 'hr.payroll.read|payroll.manage', true],
  ['payroll.salary.edit', 'payroll.manage', true],
  ['payroll.run', 'payroll.manage|payroll.push', false],
  ['payroll.export', 'hr.payroll.read|payroll.push', false],
  // Performance / appraisals
  ['performance.view', 'performance.read', false],
  ['performance.edit', 'performance.manage', false],
  ['performance.settings', 'performance.manage', false],
  ['appraisal.view', 'appraisal.read', false],
  ['appraisal.edit', 'appraisal.manage', false],
  // Messaging / communications
  ['messaging.view', '__ALL_NON_CUSTOMER__', false],
  ['messaging.send', '__ALL_NON_CUSTOMER__', false],
  ['messaging.attachments.upload', '__ALL__', false],
  ['communications.announce', '__HEAD_MANAGEMENT__', false],
  ['communications.broadcast', 'admin.manage_users', false],
  // SARA
  ['sara.use', '__ALL__', false],
  ['sara.reports', 'reports.read', false],
  ['sara.admin_actions', 'admin.manage_users', false],
  // Administration
  ['administration.users.view', 'admin.manage_users', false],
  ['administration.users.edit', 'admin.manage_users', false],
  ['administration.users.suspend', 'admin.manage_users', false],
  ['administration.users.configure', 'admin.manage_users', false],
  ['administration.users.manage_privileges', 'admin.manage_users', false],
  ['administration.roles.view', 'admin.manage_users', false],
  ['administration.roles.edit', 'admin.manage_users', false],
  ['administration.privileges.view', 'admin.manage_users', false],
  ['administration.privileges.manage', 'admin.manage_users', false],
  ['administration.audit.view', 'admin.view_audit', false],
  ['administration.settings.view', 'admin.manage_config|hr.settings.manage', false],
  ['administration.settings.edit', 'admin.manage_config|hr.settings.manage', false],
  ['administration.platform.reset', 'admin.platform.reset', true],
  // HR leave
  ['hr.leave.view', 'hr.attendance.self', false],
  ['hr.leave.request', 'hr.attendance.self', false],
  ['hr.leave.approve', 'hr.leave.manage', false],
]

const ALL_ROLES = Object.keys(ROLE_PERMISSIONS)
const NON_CUSTOMER_ROLES = ALL_ROLES.filter((r) => r !== 'customer')
const HEAD_MANAGEMENT_ROLES = [
  'super_admin', 'admin', 'head_of_business', 'head_of_operations', 'head_of_e_business',
  'financial_controller', 'head_of_risk_compliance', 'head_of_legal', 'head_of_audit',
  'head_of_human_resources', 'branch_manager', 'area_manager',
]

// ---------------------------------------------------------------------------
// Catalog metadata: module label + per-key description/sensitivity marker.
// ---------------------------------------------------------------------------
const MODULE_LABELS = {
  customers: 'Customers',
  loans: 'Loans',
  documents: 'Documents',
  hr: 'HR',
  support: 'Support',
  admin: 'Administration (legacy)',
  branches: 'Branches',
  reports: 'Reports',
  bankone: 'BankOne',
  reconciliation: 'Reconciliation',
  performance: 'Performance',
  appraisal: 'Appraisals',
  hr_config: 'HR Configuration',
  hr_org: 'HR Organisation',
  workforce: 'Workforce Intelligence',
  attendance: 'Attendance',
  payroll: 'Payroll',
  messaging: 'Messaging',
  communications: 'Communications',
  sara: 'SARA',
  training: 'Training',
  medical: 'Medical Screening',
  work: 'Work & KPIs',
  settings: 'Settings',
  users: 'Users',
  administration: 'Administration',
  leave: 'Leave',
  data: 'Data Import',
}

const SENSITIVE = new Set([
  'payroll.salary.view',
  'payroll.salary.edit',
  'administration.platform.reset',
  'employees.salary',
  'employees.bank_account',
  'employees.bvn',
  'employees.nin',
])

// ---------------------------------------------------------------------------
// Build the union key set (existing + granular) and the role → keys baseline.
// ---------------------------------------------------------------------------
const baseline = {}
for (const role of ALL_ROLES) baseline[role] = [...(ROLE_PERMISSIONS[role] || [])]

function expandGroup(group) {
  if (group === '__ALL__') return ALL_ROLES
  if (group === '__ALL_NON_CUSTOMER__') return NON_CUSTOMER_ROLES
  if (group === '__HEAD_MANAGEMENT__') return HEAD_MANAGEMENT_ROLES
  return group.split('|')
}

for (const [key, legacy, sensitive] of GRANULAR) {
  const sourceKeys = expandGroup(legacy)
  const roles = new Set()
  if (legacy.startsWith('__')) {
    for (const role of sourceKeys) roles.add(role)
  } else {
    for (const sk of sourceKeys) {
      for (const role of ALL_ROLES) {
        if (ROLE_PERMISSIONS[role].includes(sk)) roles.add(role)
      }
    }
  }
  for (const role of roles) {
    if (!baseline[role].includes(key)) baseline[role].push(key)
  }
  if (sensitive) SENSITIVE.add(key)
}

const allKeys = Object.keys(baseline).flatMap((r) => baseline[r])
const keySet = [...new Set(allKeys)].sort()

// ---------------------------------------------------------------------------
// Emit catalog INSERTs + role-permission seed calls.
// ---------------------------------------------------------------------------
function moduleOf(key) {
  const seg = key.split('.')
  const legacyMap = {
    admin: 'administration', data: 'data', hr: 'hr', hr_config: 'hr_config',
    hr_org: 'hr_org', workforce: 'workforce', users: 'users',
  }
  if (legacyMap[seg[0]]) return legacyMap[seg[0]]
  return seg[0]
}
function resourceOf(key) {
  const seg = key.split('.')
  return seg.length >= 3 ? seg[1] : seg[0]
}
function actionOf(key) {
  const seg = key.split('.')
  return seg[seg.length - 1]
}
function slug(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}
function describe(key) {
  const seg = key.split('.')
  const res = resourceOf(key)
  const moduleLabel = MODULE_LABELS[moduleOf(key)] || moduleOf(key)
  const actionLabel = actionOf(key).replace(/_/g, ' ')
  return `${capital(actionLabel)} on ${res === seg[0] ? moduleLabel : res.replace(/_/g, ' ')} (${key})`
}
function capital(s) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const lines = []
lines.push('-- BEGIN GENERATED PRIVILEGE SEED --')

for (const key of keySet) {
  lines.push(`select public.seed_permission('${key}', '${describe(key).replace(/'/g, "''")}', '${moduleOf(key)}', '${resourceOf(key)}', '${actionOf(key)}', ${SENSITIVE.has(key) ? 'true' : 'false'}, '${moduleOf(key)}');`)
}

for (const role of ALL_ROLES) {
  for (const key of baseline[role]) {
    lines.push(`select public.seed_role_permission('${role}', '${key}');`)
  }
}

lines.push('-- END GENERATED PRIVILEGE SEED --')

process.stdout.write(lines.join('\n') + '\n')
process.stderr.write(`GEN: ${keySet.length} catalog keys, role matrix ${Object.values(baseline).reduce((a, r) => a + r.length, 0)} assignments\n`)