import assert from 'node:assert/strict'
import { canAccessRoute } from '../src/config/accessControl.js'

// ---------------------------------------------------------------------------
// Access Control: the menu must be driven by the SAME document the database
// authorizes with.
//
// The reported symptom was: Super Admin grants a menu permission, the affected
// user still cannot see the menu, and refreshing does not help. The cause was an
// ordering bug in canAccessRoute — a legacy `user_access_profiles` row was
// consulted BEFORE the granular permission document, and returned false for any
// route without a `permissions` array. So a grant could never unlock those
// routes no matter what the server said.
//
// These tests pin the precedence model and, critically, the regression itself.
// ---------------------------------------------------------------------------

const routeWithPerm = { path: '/employees', permissions: ['employees.read'] }
const routeNoPerm = { path: '/self-service', permissions: [] }

const base = {
  user: { id: 'u1' },
  profile: { id: 'u1' },
  role: 'staff',
}

// A user with a legacy access-profile row — the situation that used to break.
const withLegacyRow = { ...base, accessModules: ['dashboard', 'leave'] }

console.log('--- the reported bug: a grant must win over a legacy module list ---')
{
  // The granular engine has granted employees.read...
  const auth = {
    ...withLegacyRow,
    permDoc: { is_super_user: false, allowed: { 'employees.read': {} }, denied: {} },
    allowedKeys: { 'employees.read': {} },
    deniedKeys: {},
  }
  assert.equal(
    canAccessRoute(routeWithPerm, auth),
    true,
    'a granular grant must show the menu even when a legacy accessModules row exists',
  )
}
{
  // ...and then revoked it.
  const auth = {
    ...withLegacyRow,
    permDoc: { is_super_user: false, allowed: {}, denied: { 'employees.read': {} } },
    allowedKeys: {},
    deniedKeys: { 'employees.read': {} },
  }
  assert.equal(
    canAccessRoute(routeWithPerm, auth),
    false,
    'a granular deny must hide the menu immediately',
  )
}

console.log('--- precedence: deny beats allow beats legacy beats role matrix ---')
{
  // Deny must beat an allow for a *different* required permission, because the
  // route requires ALL of its permissions to be free of denial.
  const auth = {
    ...base,
    permDoc: {
      is_super_user: false,
      allowed: { 'a.read': {} },
      denied: { 'b.read': {} },
    },
    allowedKeys: { 'a.read': {} },
    deniedKeys: { 'b.read': {} },
  }
  assert.equal(
    canAccessRoute({ path: '/x', permissions: ['a.read', 'b.read'] }, auth),
    false,
    'an explicit deny on any required permission must hide the route',
  )
}
{
  // The engine answering "no" must NOT fall through to the hard-coded role
  // matrix, or the menu would advertise something the server refuses to serve.
  const auth = {
    ...base,
    permDoc: { is_super_user: false, allowed: {}, denied: {} },
    allowedKeys: {},
    deniedKeys: {},
    hasAnyPermission: () => true, // the legacy matrix would say yes
  }
  assert.equal(
    canAccessRoute(routeWithPerm, auth),
    false,
    'when the granular engine denies, the legacy matrix must not override it',
  )
}
{
  // A route with no declared permission stays visible to staff, unchanged.
  const auth = {
    ...withLegacyRow,
    permDoc: { is_super_user: false, allowed: {}, denied: {} },
    allowedKeys: {},
    deniedKeys: {},
  }
  assert.equal(
    canAccessRoute(routeNoPerm, auth),
    true,
    'a route that declares no permission must not be affected by the fix',
  )
}
{
  // ...but customers still must not see it.
  const auth = {
    ...base,
    role: 'customer',
    permDoc: { is_super_user: false, allowed: {}, denied: {} },
    allowedKeys: {},
    deniedKeys: {},
  }
  assert.equal(
    canAccessRoute(routeNoPerm, auth),
    false,
    'customers must not see unpermissioned routes',
  )
}

console.log('--- super_admin and the legacy fallback are preserved ---')
{
  const auth = {
    ...withLegacyRow,
    role: 'super_admin',
    permDoc: { is_super_user: true, allowed: {}, denied: { 'employees.read': {} } },
    allowedKeys: {},
    deniedKeys: { 'employees.read': {} },
  }
  assert.equal(
    canAccessRoute(routeWithPerm, auth),
    true,
    'super_admin bypasses every check, including an explicit deny',
  )
}
{
  // Engine not deployed: the legacy path must still work, or the app would lock
  // everyone out in an environment that has not run the granular migration.
  const auth = { ...withLegacyRow, permDoc: null, hasAnyPermission: () => false }
  assert.equal(
    canAccessRoute({ path: '/leave', permissions: ['hr.leave.manage'] }, auth),
    true,
    'the legacy accessModules path must still work when permDoc is absent',
  )
  assert.equal(
    canAccessRoute(routeWithPerm, auth),
    false,
    'legacy path must still deny a module that is not listed',
  )
}

console.log('--- signed out sees nothing ---')
{
  assert.equal(canAccessRoute(routeWithPerm, { ...base, user: null }), false)
  assert.equal(canAccessRoute(routeWithPerm, {}), false)
}

console.log('access control precedence: all assertions passed')
