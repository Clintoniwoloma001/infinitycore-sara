// ===========================================================================
// Effective access resolution — the SINGLE place a decision is made.
//
// WHY THIS IS ITS OWN MODULE
// `navigation.jsx` cannot be imported by a plain node test (node has no JSX
// loader), and this file holds the one decision every screen depends on, so it
// must be testable on its own. It is pure: no React, no JSX, no I/O.
//
// The problem this fixes
// The menu used to consult a legacy `user_access_profiles` row BEFORE the
// granular permission document, and returned false for any route that declared
// no `permissions` array. So when such a row existed, Super Admin could grant a
// module in Access Control, the server's `get_my_permissions()` would correctly
// report it as allowed, and the menu would still hide it — the menu was reading a
// different table than Access Control writes to. Refreshing changed nothing,
// because a refresh re-read the same wrong source.
//
// THE PRECEDENCE MODEL (deterministic, and identical on Web and Flutter)
//   1. super_admin                    -> allow everything
//   2. explicit granular DENY         -> deny     (beats every allow below)
//   3. explicit granular ALLOW        -> allow
//   4. legacy per-user accessModules  -> fallback, ONLY when permDoc is absent
//   5. legacy role permission matrix  -> fallback, ONLY when permDoc is absent
//
// Steps 4 and 5 exist for environments that have not run the granular
// migration. When `permDoc` IS present it is the document the database itself
// authorizes with, so the menu must agree with it and must not override it with
// a hard-coded matrix.
// ===========================================================================

/**
 * May `auth` open `route`?
 *
 * @param {{path: string, permissions?: string[]}} route
 * @param {object} auth the useAuth() context value
 * @returns {boolean}
 */
export function canAccessRoute(route, auth) {
  if (!auth?.user || !auth?.profile) return false

  // Employee Tracking is authorized DYNAMICALLY. The static `tracking.view` key
  // is granted to the Super Admin by the baseline, but it cannot express a
  // time-boxed grant to one person or one role, so consulting it alone would
  // either hide the menu from legitimate grantees or show it to everyone. The
  // server already answers this question exactly — employee_tracking_access() —
  // and useAuth caches that answer as `trackingAccess`.
  //
  // It is consulted BEFORE the generic steps below because those steps reason
  // about the granular document, which knows nothing about tracking grants. A
  // `null` probe (still loading, or the RPC failed) means "not authorized":
  // failing closed keeps the menu hidden rather than flashing it open.
  if (route.trackingGate) {
    return auth.trackingAccess?.can_view === true
  }

  if (auth.role === 'super_admin') return true

  const required = route.permissions || []

  // 2. An explicit DENY beats everything below it. Checked against the route's
  //    own `deniedKeys`; super_admin already returned above.
  if (required.length && auth.deniedKeys) {
    if (required.some((p) => auth.deniedKeys[p])) return false
  }

  // 3. The granular document is authoritative when the engine is deployed.
  if (auth.permDoc && !auth.permDoc.is_super_user) {
    if (!required.length) {
      // Nothing is required, so the document has no key to allow or deny. This
      // route is visible to any authenticated non-customer, unchanged.
      return auth.role !== 'customer'
    }
    if (auth.allowedKeys && required.some((p) => auth.allowedKeys[p])) return true
    // The engine answered and said no. Falling through to the legacy matrix
    // would advertise a route the server will refuse to serve.
    return false
  }

  // 4. Legacy per-user module list, fallback only.
  if (auth.accessModules && auth.accessModules.length > 0) {
    const stripped = route.path === '/' ? '' : route.path.replace(/^\//, '')
    const moduleKey = route.path === '/' ? 'dashboard' : stripped.replace(/-/g, '_')
    const moduleKeyDash = route.path === '/' ? 'dashboard' : stripped
    if (
      auth.accessModules.includes(moduleKey) ||
      auth.accessModules.includes(moduleKeyDash) ||
      auth.accessModules.includes(route.path)
    ) {
      return true
    }
    if (!required.length) return false
  }

  // 5. Legacy role matrix, fallback only.
  if (!required.length) return auth.role !== 'customer'
  return auth.hasAnyPermission(required)
}

/**
 * Flatten `routeConfig` into the routes a Super Admin can grant or revoke.
 * Returns the existing `protectedRoutes` shape, so existing consumers are
 * unaffected.
 */
export function flattenRoutes(routeConfig) {
  return routeConfig.flatMap((group) => group.items)
}
