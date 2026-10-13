// ============================================================================
// Sidebar route matching - pure, testable, no React.
// ============================================================================
// WHY THIS MODULE EXISTS
// The sidebar used to mark an item active when
//   location.pathname === path || location.pathname.startsWith(path + '/')
// which is a PREFIX test. /audit is a prefix of /audit/command-center, so the
// "Audit Workspace" item AND the "Audit Command Centre" item were both painted
// with the same green active-page highlight at the same time. Any nested family
// of routes (/x, /x/y, /x/z) has the same defect.
//
// The rule here is ROUTE-AWARE rather than substring-based: the navigation item
// whose path is the LONGEST matching prefix of the current pathname is the one
// active PAGE. A shorter ancestor of that page gets a separate, deliberately
// quieter 'parent' treatment - it never reuses the active-page highlight, so
// exactly one item is ever highlighted green.
//
// Kept as a plain ESM module with no React or router imports so the matching
// rule can be unit-tested by plain Node (tests/smartNavigation.test.mjs).
// ============================================================================

/** Strip trailing slashes so '/audit/' and '/audit' are the same route. */
const normalise = (p) => {
  const s = String(p || '').replace(/\/+$/, '')
  return s === '' ? '/' : s
}

/**
 * Does `path` match `pathname`? Exact match, or a path prefix that ends on a
 * segment boundary ('/audit' matches '/audit/x' but never '/auditx').
 */
export function pathMatchesRoute(pathname, path) {
  const target = normalise(path)
  const current = normalise(pathname)
  if (target === '/') return current === '/'
  return current === target || current.startsWith(`${target}/`)
}

/**
 * Resolve which navigation entry is the current page, given the FULL set of
 * navigation paths the sidebar can show.
 *
 * @returns {{activePath: string|null, parentPath: string|null, chain: string[]}}
 *   activePath - the longest matching navigation path (the active page)
 *   parentPath - its closest ancestor navigation path, if any
 *   chain      - every ancestor navigation path, shortest first
 */
export function resolveActiveNav(pathname, paths = []) {
  const current = normalise(pathname)
  let best = null
  for (const raw of paths) {
    if (!raw) continue
    if (!pathMatchesRoute(current, raw)) continue
    const p = normalise(raw)
    if (best === null || p.length > best.length) best = p
  }
  if (best === null) return { activePath: null, parentPath: null, chain: [] }

  const chain = paths
    .map(normalise)
    .filter((p) => p !== best && p !== '/' && best.startsWith(`${p}/`))
    .sort((a, b) => a.length - b.length)

  return { activePath: best, parentPath: chain[chain.length - 1] || null, chain }
}

/**
 * The highlight state for one navigation item: 'active' (this page),
 * 'parent' (an ancestor of this page - deliberately quieter) or 'idle'.
 */
export function navActiveState(pathname, path, paths = []) {
  const target = normalise(path)
  const { activePath, parentPath } = resolveActiveNav(pathname, paths)
  if (target === activePath) return 'active'
  if (target === parentPath) return 'parent'
  return 'idle'
}
