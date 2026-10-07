import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { canAccessRoute } from '../src/config/accessControl.js'
import { GEOFENCE_ADMIN_ROLES } from '../src/constants/permissions.js'

// ---------------------------------------------------------------------------
// Geofence Settings & Management is a FIXED-audience route on both platforms.
//
// The product rule: Geofence Settings / Management belongs to Super Admin and
// Head of HR only; Employee Tracking belongs to Super Admin, Head of HR and
// the executive family (MD/CEO, Chairman, Director). Three surfaces express
// that rule and none of them may drift from the others:
//
//   1. Postgres  — is_geofence_admin() / require_geofence_admin() (42501),
//                  employee_tracking_access() baseline roles  [THE boundary]
//   2. Web       — route.roles: GEOFENCE_ADMIN_ROLES in navigation.jsx,
//                  canAccessRoute step 1b, trackingGate probe
//   3. Mobile    — canManageGeofences() / canAccessEmployeeTracking()
//
// These tests pin 2 and 3 against 1 by reading the migration source, so a
// change to the server gate that is not mirrored on a client fails here.
// ---------------------------------------------------------------------------

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

const navSource = read('../src/config/navigation.jsx')
const migration = read('../supabase/migrations/20261102000001_geofence_management_rbac.sql')
const roleGuard = read('../../infinitycore-mobile/lib/core/security/role_guard.dart')

const geofenceRoute = { path: '/geofences', roles: GEOFENCE_ADMIN_ROLES }

const authFor = (role, extra = {}) => ({
  user: { id: 'u1' },
  profile: { id: 'u1' },
  role,
  hasAnyPermission: () => false,
  ...extra,
})

const fullPermDoc = () => ({
  permDoc: { is_super_user: false, allowed: {}, denied: {} },
  allowedKeys: new Proxy({}, { get: () => ({}) }),
  deniedKeys: {},
})

let n = 0
const check = (name, fn) => {
  n += 1
  fn()
  console.log(`  ${n}. PASS  ${name}`)
}

console.log('--- the route declares a role allow-list, not a grantable permission ---')

check('navigation.jsx declares /geofences with the shared role list', () => {
  const line = navSource
    .split('\n')
    .find((l) => l.includes("path: '/geofences'"))
  assert.ok(line, '/geofences is not in routeConfig')
  assert.match(line, /roles: GEOFENCE_ADMIN_ROLES/, 'the geofence route must be role-gated')
  assert.ok(!line.includes('permissions:'),
    'no permissions array: a grantable key would advertise a route the server refuses')
})

check('the allow-list is Super Admin + Head of HR (+ the legacy spelling)', () => {
  assert.deepEqual(
    [...GEOFENCE_ADMIN_ROLES].sort(),
    ['head_of_human_resources', 'hr_manager', 'super_admin'],
  )
})

console.log('--- canAccessRoute honours the allow-list ---')

check('Super Admin may always open it', () => {
  assert.equal(canAccessRoute(geofenceRoute, authFor('super_admin')), true)
})

check('Head of HR may open it even with an empty granular document', () => {
  const auth = authFor('head_of_human_resources', {
    ...fullPermDoc(),
    accessModules: [],
  })
  assert.equal(canAccessRoute(geofenceRoute, auth), true)
})

check('the legacy hr_manager spelling may open it', () => {
  assert.equal(canAccessRoute(geofenceRoute, authFor('hr_manager')), true)
})

check('every other role is refused, even with every permission allowed', () => {
  for (const role of [
    'admin',
    'hr_officer',
    'branch_manager',
    'area_manager',
    'staff',
    'customer',
    'director',
    'md_ceo',
    'chairman',
  ]) {
    const auth = authFor(role, fullPermDoc())
    assert.equal(
      canAccessRoute(geofenceRoute, auth),
      false,
      `${role} must not reach geofence settings`,
    )
  }
})

check('an absent role fails closed', () => {
  assert.equal(canAccessRoute(geofenceRoute, authFor(undefined)), false)
  assert.equal(canAccessRoute(geofenceRoute, authFor('')), false)
})

check('the allow-list does not weaken routes that have no roles gate', () => {
  const open = { path: '/attendance', permissions: ['hr.attendance.self'] }
  const staff = authFor('staff', {
    accessModules: ['attendance'],
    hasAnyPermission: (perms) => perms.includes('hr.attendance.self'),
  })
  assert.equal(canAccessRoute(open, staff), true, 'roles must be opt-in per route')
})

console.log('--- Employee Tracking keeps its dynamic gate (grants still work on web) ---')

const trackingRoute = { path: '/employee-tracking', trackingGate: true, permissions: ['tracking.view'] }

check('a live server answer of can_view=true opens the menu for any role', () => {
  const grantee = authFor('branch_manager', { trackingAccess: { can_view: true } })
  assert.equal(canAccessRoute(trackingRoute, grantee), true,
    'the web must keep admitting a delegated tracking grantee')
})

check('a null or failed probe fails closed', () => {
  for (const probe of [null, undefined, {}, { can_view: false }]) {
    const auth = authFor('super_admin', { trackingAccess: probe })
    assert.equal(canAccessRoute(trackingRoute, auth), false,
      'the menu must stay hidden while the server has not answered')
  }
})

check('the static tracking.view permission alone never opens the menu', () => {
  const auth = authFor('hr_officer', {
    ...fullPermDoc(),
    hasAnyPermission: (perms) => perms.includes('tracking.view'),
  })
  assert.equal(canAccessRoute(trackingRoute, auth), false)
})

console.log('--- server, web and mobile declare the same audiences ---')

check('the web allow-list matches public.is_geofence_admin()', () => {
  const helper = migration.match(
    /select p\.role in \(([^)]+)\)/,
  )
  assert.ok(helper, 'is_geofence_admin() role list not found in the migration')
  const sqlRoles = helper[1].split(',').map((r) => r.trim().replace(/'/g, '')).sort()
  assert.deepEqual([...GEOFENCE_ADMIN_ROLES].sort(), sqlRoles)
})

check('mobile canManageGeofences() gates the same roles as the web', () => {
  const body = roleGuard.match(/bool canManageGeofences\(String role\) => const \[([^\]]*)\]/)
  assert.ok(body, 'canManageGeofences() not found in role_guard.dart')
  const dartRoles = [...body[1].matchAll(/AppRoles\.(\w+)/g)].map((m) => m[1])
  const expected = ['superAdmin', 'headOfHumanResources', 'hrManager']
  assert.deepEqual(dartRoles.sort(), expected.sort())
})

check('mobile canAccessEmployeeTracking() matches the server baseline roles', () => {
  const mobile = roleGuard.match(
    /bool canAccessEmployeeTracking\(String role\) => const \[([^\]]*)\]/,
  )
  assert.ok(mobile, 'canAccessEmployeeTracking() not found in role_guard.dart')
  const dartRoles = [...mobile[1].matchAll(/AppRoles\.(\w+)/g)].map((m) => m[1])

  const server = migration.match(
    /if v_role in \(([^)]+)\) then/,
  )
  assert.ok(server, 'employee_tracking_access() baseline list not found in the migration')
  const sqlRoles = server[1].split(',').map((r) => r.trim().replace(/'/g, ''))
  // Super Admin short-circuits ABOVE the baseline list (via: super_admin,
  // can_manage: true), so the server's full viewer set is baseline + Super
  // Admin — which is exactly what the mobile predicate declares.
  if (!sqlRoles.includes('super_admin')) sqlRoles.push('super_admin')

  // Dart uses camelCase, SQL snake_case; compare on snake_case.
  const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
  assert.deepEqual(dartRoles.map(snake).sort(), sqlRoles.sort(),
    'the mobile nav gate and the server baseline must admit the same roles')
})

check('mobile and web both keep the Head-of-HR rename tolerance', () => {
  assert.ok(GEOFENCE_ADMIN_ROLES.includes('hr_manager'))
  assert.match(roleGuard, /AppRoles\.hrManager,/)
})

console.log(`\nAll ${n} checks passed.`)
