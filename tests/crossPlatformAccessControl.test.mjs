// ============================================================================
// CROSS-PLATFORM ACCESS CONTROL — SINGLE SOURCE OF TRUTH
// ============================================================================
// Regression guard for the reported production bug:
//
//   "Super Admin grants a menu permission. The user still cannot see it, and
//    refreshing the browser does not help."
//
// THE ROOT CAUSE (previously invisible to the test suite)
// accessControl.js held the CORRECT precedence model and had its own passing
// tests. But config/navigation.jsx exported a SECOND, different canAccessRoute
// that consulted the legacy `auth.accessModules` list and never looked at
// permDoc/allowedKeys at all.
//
// Layout.jsx (the menu), App.jsx (the route guard) and agentService.js (SARA's
// agent router) all imported from config/navigation. So the function under test
// was dead code and the untested duplicate ran in production. Access Control
// writes to role_permissions/user_permissions, get_my_permissions() correctly
// reported the grant — and the menu then re-derived access from a different
// table. A refresh re-read the same wrong source, which is exactly why it never
// recovered.
//
// These assertions are structural because navigation.jsx contains JSX, which
// plain node cannot import. They assert the WIRING, which is what was broken.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')
const read = (rel) => fs.readFileSync(path.join(src, rel), 'utf8')

console.log('--- there is exactly ONE access-control decision ---')
{
  const nav = read('config/navigation.jsx')
  assert.match(
    nav,
    /export\s*\{\s*canAccessRoute\s*\}\s*from\s*['"]\.\/accessControl\.js['"]/,
    'navigation.jsx must RE-EXPORT canAccessRoute from accessControl.js',
  )
  assert.doesNotMatch(
    nav,
    /export\s+function\s+canAccessRoute/,
    'navigation.jsx must not define a second canAccessRoute — one decision, one place',
  )
}

console.log('--- the menu, the route guard and SARA all consume that one decision ---')
for (const rel of ['components/Layout.jsx', 'App.jsx', 'services/agentService.js']) {
  const text = read(rel)
  const m = text.match(/import\s*\{[^}]*\bcanAccessRoute\b[^}]*\}\s*from\s*['"]([^'"]+)['"]/)
  assert.ok(m, `${rel} must import canAccessRoute`)
  assert.match(
    m[1],
    /config\/navigation(\.jsx)?$/,
    `${rel} must import from config/navigation, got ${m[1]}`,
  )
}

console.log('--- a grant propagates without a re-login ---')
{
  const auth = read('hooks/useAuth.jsx')
  assert.match(auth, /postgres_changes/, 'useAuth must subscribe to permission changes')
  for (const t of ['user_permissions', 'role_permissions']) {
    assert.ok(auth.includes(t), `useAuth must watch ${t}`)
  }
  // Nothing is cached in localStorage/sessionStorage, so a refresh cannot
  // resurrect a stale permission set.
  assert.doesNotMatch(
    auth,
    /(localStorage|sessionStorage)\.(get|set)Item\([^)]*perm/i,
    'effective permissions must not be cached in web storage',
  )
}

console.log('--- realtime publication is declared in a migration ---')
{
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../supabase/migrations')
  const sql = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n')

  assert.match(
    sql,
    /alter publication supabase_realtime add table public\.user_permissions/,
    'user_permissions must be in the realtime publication or the subscription delivers nothing',
  )
  assert.match(
    sql,
    /alter publication supabase_realtime add table public\.role_permissions/,
    'role_permissions must be in the realtime publication',
  )
  assert.match(
    sql,
    /replica identity full/,
    'a revoke (DELETE) must be deliverable to the client',
  )
}

console.log('--- the decision itself still matches the documented precedence ---')
{
  const { canAccessRoute } = await import('../src/config/accessControl.js')
  const base = { user: { id: 'u1' }, profile: { id: 'u1' }, role: 'staff' }
  const route = { path: '/employees', permissions: ['employees.read'] }

  // The reported case: a legacy accessModules row exists, and it does NOT list
  // employees. A granular grant must still show the menu.
  const granted = {
    ...base,
    accessModules: ['dashboard', 'leave'],
    permDoc: { is_super_user: false, allowed: { 'employees.read': {} }, denied: {} },
    allowedKeys: { 'employees.read': {} },
    deniedKeys: {},
  }
  assert.equal(
    canAccessRoute(route, granted),
    true,
    'a granular grant must win over a legacy accessModules list',
  )

  // Revoked: an explicit deny must beat the allow.
  const revoked = {
    ...base,
    permDoc: { is_super_user: false, allowed: {}, denied: { 'employees.read': {} } },
    allowedKeys: {},
    deniedKeys: { 'employees.read': {} },
  }
  assert.equal(
    canAccessRoute(route, revoked),
    false,
    'an explicit user/role deny must beat everything below it',
  )

  // Signed out sees nothing.
  assert.equal(canAccessRoute(route, { role: 'staff' }), false, 'signed out must be denied')
}

console.log('cross-platform access control: all assertions passed')
