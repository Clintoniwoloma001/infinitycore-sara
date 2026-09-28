// ============================================================================
// Task B Phase 3 - role/department smart navigation
// ============================================================================
// Behavioural tests against the REAL module, plus content guards on the wiring.
// The important property being pinned is that department filtering narrows the
// MENU only and never becomes the security boundary.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEPARTMENTS, ROLE_DEPARTMENT, UNRESTRICTED_ROLES,
  departmentsForRole, isSharedOnly, filterSectionsByDepartment,
} from '../src/config/navigationConfig.js'
import { ROLES } from '../src/constants/roles.js'
// navigation.jsx is JSX, which plain Node cannot import, so the wiring into it
// is asserted from source below rather than executed.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

let n = 0
const check = (name, fn) => { fn(); n++; console.log('  ok - ' + name) }

// A stand-in for the real groups, so the filter can be tested in isolation.
const GROUPS = [
  { section: 'Mine', department: null },
  { section: 'HR', department: DEPARTMENTS.HR },
  { section: 'Audit', department: DEPARTMENTS.AUDIT },
  { section: 'Risk', department: DEPARTMENTS.RISK },
  { section: 'Admin', department: DEPARTMENTS.ADMIN },
  { section: 'Operations', department: DEPARTMENTS.OPERATIONS },
  { section: 'Finance', department: DEPARTMENTS.FINANCE },
  { section: 'Executive', department: DEPARTMENTS.EXECUTIVE },
]
const names = (groups) => groups.map((g) => g.section)

console.log('\nShared access')
check('every role keeps the shared group', () => {
  for (const role of Object.values(ROLES)) {
    const out = filterSectionsByDepartment(GROUPS, { role })
    assert.ok(out.some((g) => g.section === 'Mine'), `${role} lost the shared group`)
  }
})

check('a plain employee sees only shared tabs', () => {
  assert.deepEqual(names(filterSectionsByDepartment(GROUPS, { role: ROLES.STAFF })), ['Mine'])
  assert.equal(isSharedOnly(ROLES.STAFF), true)
})

console.log('\nDepartment scoping')
check('HR roles see HR, not Audit or Risk', () => {
  for (const role of [ROLES.HEAD_OF_HUMAN_RESOURCES, ROLES.HR_OFFICER]) {
    const out = names(filterSectionsByDepartment(GROUPS, { role }))
    assert.ok(out.includes('HR'), `${role} should see HR`)
    assert.ok(!out.includes('Audit'), `${role} must not see Audit`)
    assert.ok(!out.includes('Risk'), `${role} must not see Risk`)
  }
})

check('Head of Audit sees Audit, not HR', () => {
  const out = names(filterSectionsByDepartment(GROUPS, { role: ROLES.HEAD_OF_AUDIT }))
  assert.ok(out.includes('Audit'))
  assert.ok(!out.includes('HR'))
})

check('Head of Risk and Legal share the Risk workspace', () => {
  for (const role of [ROLES.HEAD_OF_RISK_COMPLIANCE, ROLES.HEAD_OF_LEGAL]) {
    const out = names(filterSectionsByDepartment(GROUPS, { role }))
    assert.ok(out.includes('Risk'), `${role} should see Risk`)
    assert.ok(!out.includes('HR'), `${role} must not see HR`)
  }
})

check('Head of E-Business maps to its own department', () => {
  assert.deepEqual(departmentsForRole(ROLES.HEAD_OF_E_BUSINESS), [DEPARTMENTS.E_BUSINESS])
})

check('front-line roles land in Operations', () => {
  for (const role of [ROLES.BRANCH_MANAGER, ROLES.AREA_MANAGER, ROLES.LOAN_OFFICER,
    ROLES.RELATIONSHIP_MANAGER, ROLES.CUSTOMER_SERVICE]) {
    assert.deepEqual(departmentsForRole(role), [DEPARTMENTS.OPERATIONS], role)
  }
})

console.log('\nUnrestricted access')
check('Super Admin and Admin see every group', () => {
  for (const role of UNRESTRICTED_ROLES) {
    assert.equal(filterSectionsByDepartment(GROUPS, { role }).length, GROUPS.length, role)
  }
})

check('a customer gets the shared group only', () => {
  assert.deepEqual(names(filterSectionsByDepartment(GROUPS, { role: ROLES.CUSTOMER })), ['Mine'])
})

console.log('\nSafety of the department signal')
check('a free-text department cannot grant access it does not map to', () => {
  // `employees.department` is free text and may hold an executive title or a
  // typo. It may refine the role mapping but must never invent access.
  assert.deepEqual(
    names(filterSectionsByDepartment(GROUPS, { role: ROLES.STAFF, department: 'MD/CEO' })),
    ['Mine'], 'an executive title in department granted HR access')
  assert.deepEqual(
    names(filterSectionsByDepartment(GROUPS, { role: ROLES.STAFF, department: 'Human Resources' })),
    ['Mine'], 'an unmapped department string granted HR access')
})

check('a matching department refines the role mapping', () => {
  const out = names(filterSectionsByDepartment(GROUPS, { role: ROLES.STAFF, department: 'audit' }))
  assert.ok(out.includes('Audit'))
})

check('an unknown role is shared-only, never unrestricted', () => {
  assert.deepEqual(
    names(filterSectionsByDepartment(GROUPS, { role: 'not_a_real_role' })), ['Mine'])
})

console.log('\nIt is a UX layer, not the security boundary')
const navSrc = read('src/config/navigation.jsx')
const cfgSrc = read('src/config/navigationConfig.js')
const appSrc = read('src/App.jsx')
const layoutSrc = read('src/components/Layout.jsx')

check('the permission filter still runs on every item', () => {
  assert.ok(layoutSrc.includes('filterSectionsByDepartment'), 'department filter not applied')
  assert.ok(layoutSrc.includes('canAccessRoute'), 'permission filter was dropped')
  assert.match(navSrc, /export function canAccessRoute/)
  assert.match(navSrc, /if \(!auth\?\.user \|\| !auth\?\.profile\) return false/)
})

check('routes are still guarded at the router, not only in the sidebar', () => {
  assert.match(appSrc, /<Protected>/)
  assert.match(appSrc, /ProtectedModule/)
})

check('the config documents that it is not a security boundary', () => {
  assert.match(cfgSrc, /NOT A SECURITY BOUNDARY/)
  assert.match(cfgSrc, /RLS policies/)
})

console.log('\nReal route config')
// routeConfig is JSX, so the tagged groups are parsed from source rather than
// imported. This still fails loudly if a tag is added or removed.
const navSource = read('src/config/navigation.jsx')
const taggedGroups = [...navSource.matchAll(/section: '([^']+)',\s*\n\s*department: DEPARTMENTS\.([A-Z_]+)/g)]
  .map((m) => ({ section: m[1], key: m[2] }))
const taggedNames = taggedGroups.map((g) => g.section)

check('only clearly-departmental groups are tagged', () => {
  // An untagged group is shared. Mis-tagging HIDES a module from people who
  // need it, so the untagged set is asserted deliberately.
  assert.ok(taggedNames.includes('HR'), 'HR group should be tagged')
  assert.ok(taggedNames.includes('Audit & Compliance'), 'Audit group should be tagged')
  assert.ok(!taggedNames.includes('Management'),
    'Management is mixed-purpose and must stay shared until split')
  assert.ok(!taggedNames.includes('Core Banking Intelligence'),
    'Core is shared: hiding it from an employee would be wrong')
})

check('every tagged group maps to a real department key', () => {
  for (const g of taggedGroups) {
    assert.ok(Object.values(DEPARTMENTS).includes(g.key.toLowerCase()),
      `${g.section} -> unknown department ${g.key}`)
  }
})

check('every role in the catalog has an explicit mapping decision', () => {
  for (const role of Object.values(ROLES)) {
    assert.ok(role in ROLE_DEPARTMENT,
      `${role} missing from ROLE_DEPARTMENT - it would silently fall back to shared-only`)
  }
})

console.log('\nAll ' + n + ' checks passed.')

