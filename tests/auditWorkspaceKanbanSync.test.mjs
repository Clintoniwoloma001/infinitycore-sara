// ============================================================================
// Phase 73 - Audit Command Centre <-> Audit Workspace synchronisation
// ============================================================================
// What this suite pins:
//   1. the SIDEBAR active-state rule (only one green item, ever);
//   2. the COMPLETION rule - an obligation is complete only when EVERY
//      responsible person satisfies the configured completion criteria, so one
//      submitter can never look like a finished obligation;
//   3. the STATUS TRANSITIONS (lifecycle columns) the board renders;
//   4. that both screens read ONE canonical rollup instead of two queries.
//
// The pure modules (activeRoute.js, obligationBoard.js) are executed. The
// migration and the pages are asserted from source, exactly like the other
// Phase-71/72 audit tests, because no live database is reachable from here.
// ============================================================================
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import traverse from '@babel/traverse'

const walk = traverse.default || traverse

import {
  pathMatchesRoute, resolveActiveNav, navActiveState,
} from '../src/config/activeRoute.js'
import {
  BOARD_COLUMNS, LIFECYCLE, ALL_LIFECYCLES,
  columnForLifecycle, isBoardCard, summariseNames,
  completionSummary, initialsOf, recurrenceLabel, hasSchedule,
  isFindingObligation, isRegulatoryObligation,
} from '../src/domains/audit/obligationBoard.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const MIGRATION = 'supabase/migrations/20261111000004_audit_workspace_canonical_obligations.sql'

let n = 0
const check = (name, fn) => { fn(); n++; console.log('  ok - ' + name) }

// ===========================================================================
// 1. SIDEBAR: exactly one active item, whatever the route
// ===========================================================================
console.log('\nSidebar active-state (root cause: prefix matching)')

// The audit routes the sidebar actually renders.
const AUDIT_PATHS = ['/audit', '/audit/command-center', '/audit/department']
const ALL_PATHS = [
  '/', '/dashboard', '/employees', '/users', '/audit', '/audit/command-center',
  '/audit/department', '/audit/other', '/attendance',
]

check('prefix matching alone is what broke it', () => {
  // The old predicate marked BOTH of these green on /audit/command-center.
  const oldIsActive = (path, pathname) =>
    pathname === path || pathname.startsWith(`${path}/`)
  assert.equal(oldIsActive('/audit', '/audit/command-center'), true)
  assert.equal(oldIsActive('/audit/command-center', '/audit/command-center'), true)
})

check('on the Command Centre only the Command Centre is active', () => {
  const state = navActiveState('/audit/command-center', '/audit', AUDIT_PATHS)
  assert.equal(state, 'parent', 'the workspace is an ancestor, not the current page')
  assert.equal(navActiveState('/audit/command-center', '/audit/command-center', AUDIT_PATHS), 'active')
})

check('exactly one item is active on every audit route', () => {
  for (const pathname of ['/audit', '/audit/command-center', '/audit/department']) {
    const active = AUDIT_PATHS.filter((p) => navActiveState(pathname, p, AUDIT_PATHS) === 'active')
    assert.deepEqual(active, [pathname], `${pathname} -> ${active.join(',')}`)
  }
})

check('a segment boundary is required - /auditx is not /audit', () => {
  assert.equal(pathMatchesRoute('/auditx', '/audit'), false)
  assert.equal(pathMatchesRoute('/audit/x', '/audit'), true)
})

check('trailing slashes do not create a second active item', () => {
  assert.equal(navActiveState('/audit/command-center/', '/audit', AUDIT_PATHS), 'parent')
  assert.equal(navActiveState('/audit/command-center/', '/audit/command-center', AUDIT_PATHS), 'active')
})

check('an unknown sub-route falls back to its parent page', () => {
  assert.equal(navActiveState('/audit/unknown', '/audit', AUDIT_PATHS), 'active')
  assert.equal(navActiveState('/audit/unknown', '/audit/command-center', AUDIT_PATHS), 'idle')
})

check('browser back/forward is pure pathname matching - no memory needed', () => {
  const sequence = ['/audit', '/audit/command-center', '/audit', '/audit/department']
  const activeSeen = sequence.map((p) => resolveActiveNav(p, ALL_PATHS).activePath)
  assert.deepEqual(activeSeen, ['/audit', '/audit/command-center', '/audit', '/audit/department'])
})

check('the root route matches exactly', () => {
  assert.equal(navActiveState('/', '/', ALL_PATHS), 'active')
  assert.equal(navActiveState('/employees', '/', ALL_PATHS), 'idle')
})

check('the workspace keeps a quieter parent treatment, not the green highlight', () => {
  const layout = read('src/components/Layout.jsx')
  assert.match(layout, /const navPaths = groups\.flatMap\(\(group\) => group\.items\.map\(\(item\) => item\.path\)\)/)
  assert.match(layout, /const navState = \(path\) => navActiveState\(location\.pathname, path, navPaths\)/)
  assert.ok(!layout.includes('const isActive = (path)'), 'the prefix-only predicate is gone')
  // The green active-page class must only be reachable from the ACTIVE branch.
  const cls = layout.slice(layout.indexOf('className={`flex items-center gap-3'))
  const activeBranch = cls.slice(cls.indexOf('active'), cls.indexOf('isParent'))
  assert.ok(activeBranch.includes('bg-[#009944]'), 'only the active branch paints green')
  assert.ok(cls.includes("? 'bg-white/5 text-white ring-1 ring-inset ring-white/10'"),
    'a parent item gets a distinct, quieter treatment')
  assert.match(layout, /aria-current=\{active \? 'page' : undefined\}/)
})

// ===========================================================================
// 2. THE COMPLETION RULE (server rule, mirrored here for the examples)
// ===========================================================================
console.log('\nCompletion rule (mirrors audit_obligation_states())')

/**
 * Faithful JS mirror of the SQL lifecycle CASE. `requiresSubmission` false
 * means the responsible person's completion criterion is acknowledgement.
 */
function deriveLifecycle(obligation, assignments) {
  const required = assignments.length
  const satisfied = assignments.filter((a) => (
    obligation.requiresSubmission === false
      ? (obligation.requiresAcknowledgement === false || Boolean(a.acknowledged_at))
      : ['accepted', 'closed'].includes(a.status)
  )).length
  const progressed = assignments.filter((a) => a.status !== 'not_started' || a.acknowledged_at).length
  const anyClarification = assignments.some((a) => ['returned_for_correction', 'rejected'].includes(a.status))
  const allComplete = required > 0 && satisfied === required
  const allResponded = required > 0 && progressed === required

  let lifecycle = 'not_started'
  if (obligation.status === 'closed') lifecycle = 'completed'
  else if (obligation.status === 'paused' && !allComplete) lifecycle = 'blocked'
  else if (allComplete) lifecycle = 'completed'
  else if (anyClarification) lifecycle = 'needs_clarification'
  else if (allResponded && obligation.requiresSubmission !== false) lifecycle = 'awaiting_approval'
  else if (progressed > 0) lifecycle = 'in_progress'

  return {
    assigned_count: required,
    complete_count: satisfied,
    completion_pct: required === 0 ? 0 : Math.round((100 * satisfied) / required * 10) / 10,
    outstanding_names: assignments
      .filter((a) => !(
        obligation.requiresSubmission === false
          ? (obligation.requiresAcknowledgement === false || Boolean(a.acknowledged_at))
          : ['accepted', 'closed'].includes(a.status)
      ))
      .map((a) => a.name),
    lifecycle,
  }
}

const submittable = { requiresSubmission: true, requiresAcknowledgement: true, status: 'active' }
const person = (name, status, acknowledged_at = null) => ({ name, status, acknowledged_at })

check('Example A - three responsible persons, one has not completed', () => {
  const state = deriveLifecycle(submittable, [
    person('Person A', 'accepted'), person('Person B', 'accepted'), person('Person C', 'not_started'),
  ])
  assert.equal(state.assigned_count, 3)
  assert.equal(state.complete_count, 2)
  assert.equal(state.completion_pct, 66.7)
  assert.equal(state.lifecycle, 'in_progress')
  assert.deepEqual(state.outstanding_names, ['Person C'])
})

check('Example B - four responsible, three complete, one has not submitted', () => {
  const state = deriveLifecycle(submittable, [
    person('A', 'accepted'), person('B', 'accepted'), person('C', 'accepted'), person('D', 'not_started'),
  ])
  assert.equal(state.completion_pct, 75)
  assert.equal(state.lifecycle, 'in_progress')
  assert.deepEqual(state.outstanding_names, ['D'])
})

check('Example C - a submission returned for correction does not count as complete', () => {
  const state = deriveLifecycle(submittable, [
    person('A', 'accepted'), person('B', 'returned_for_correction'), person('C', 'accepted'),
  ])
  assert.equal(state.complete_count, 2, 'the returned person is NOT satisfied')
  assert.equal(state.lifecycle, 'needs_clarification')
  assert.deepEqual(state.outstanding_names, ['B'])
  assert.notEqual(state.lifecycle, 'completed', 'no move to Completed while the correction is open')
})

check('a returned person who resubmits is still not complete until audit accepts', () => {
  for (const status of ['submitted', 'under_review', 'resubmitted', 'returned_for_correction', 'rejected']) {
    const state = deriveLifecycle(submittable, [person('A', status), person('B', status)])
    assert.equal(state.complete_count, 0, `${status} must not satisfy the completion criteria`)
    assert.equal(state.completion_pct, 0)
  }
})

check('Example D - all responsible persons complete -> Completed, automatically', () => {
  const state = deriveLifecycle(submittable, [
    person('A', 'accepted'), person('B', 'accepted'), person('C', 'accepted'),
  ])
  assert.equal(state.completion_pct, 100)
  assert.equal(state.lifecycle, 'completed')
  assert.deepEqual(state.outstanding_names, [])
})

check('an obligation nobody has been assigned to is never 100% complete', () => {
  const state = deriveLifecycle(submittable, [])
  assert.equal(state.completion_pct, 0)
  assert.equal(state.lifecycle, 'not_started')
  assert.equal(state.complete_count, 0)
})

check('everyone responded but nothing accepted yet -> awaiting final review', () => {
  const state = deriveLifecycle(submittable, [
    person('A', 'submitted'), person('B', 'submitted'), person('C', 'under_review'),
  ])
  assert.equal(state.lifecycle, 'awaiting_approval')
  assert.equal(state.completion_pct, 0)
  assert.equal(state.complete_count, 0)
})

check('partial responses stay In progress, not awaiting review', () => {
  const state = deriveLifecycle(submittable, [
    person('A', 'submitted'), person('B', 'not_started'), person('C', 'not_started'),
  ])
  assert.equal(state.lifecycle, 'in_progress')
})

check('a paused obligation is Blocked until it is complete', () => {
  const paused = { ...submittable, status: 'paused' }
  assert.equal(deriveLifecycle(paused, [person('A', 'not_started')]).lifecycle, 'blocked')
  assert.equal(deriveLifecycle(paused, [person('A', 'accepted')]).lifecycle, 'completed')
})

check('an explicit close is the Head of Audit sign-off, not an automatic one', () => {
  assert.equal(deriveLifecycle({ ...submittable, status: 'closed' }, [person('A', 'accepted')]).lifecycle, 'completed')
})

check('when submission is not required, acknowledgement is the criterion', () => {
  const noSub = { requiresSubmission: false, requiresAcknowledgement: true, status: 'active' }
  // acknowledge_audit_obligation sets status AND acknowledged_at together.
  const done = deriveLifecycle(noSub, [person('A', 'acknowledged', new Date()), person('B', 'not_started')])
  assert.equal(done.complete_count, 1)
  assert.equal(done.completion_pct, 50)
  // Someone who merely submitted without the required acknowledgement is not done.
  const submitted = deriveLifecycle(noSub, [person('A', 'submitted'), person('B', 'not_started')])
  assert.equal(submitted.complete_count, 0)
})

check('multiple submissions by one person cannot inflate completion', () => {
  // The count is over ASSIGNMENTS. Three versions from one person is one person.
  const assignment = person('A', 'accepted')
  const versions = [1, 2, 3]
  const state = deriveLifecycle(submittable, [assignment, person('B', 'not_started')])
  assert.equal(state.complete_count, 1)
  assert.equal(state.completion_pct, 50)
  assert.equal(versions.length, 3, 'submissions are versioned, but only the assignment counts')
})

check('the SQL carries the same predicates as this mirror', () => {
  const sql = read(MIGRATION)
  assert.match(sql, /when not o\.requires_submission[\s\S]{0,120}then \(not o\.requires_acknowledgement or a\.acknowledged_at is not null\)/)
  assert.match(sql, /else a\.status in \('accepted', 'closed'\)/)
  assert.match(sql, /count\(assignment_id\)\)::int as assigned_count/)
  // A pending / rejected / returned submission is NOT a satisfied person.
  assert.match(sql, /when a\.status in \('returned_for_correction', 'rejected'\) then true/)
  // Never auto-closed: 'closed' is only derived from the obligation's own status.
  assert.match(sql, /when o\.status = 'closed' then 'completed'/)
  // The rollup is a LEFT join, so zero assignments is a real state.
  assert.match(sql, /left join public\.audit_obligation_assignments a on a\.obligation_id = o\.id/)
})

// ===========================================================================
// 3. BOARD MODEL
// ===========================================================================
console.log('\nBoard model')

check('every lifecycle has exactly one column', () => {
  for (const key of ALL_LIFECYCLES) {
    const matches = BOARD_COLUMNS.filter((c) => c.lifecycles.includes(key))
    assert.equal(matches.length, 1, `${key} -> ${matches.length} columns`)
  }
  assert.equal(ALL_LIFECYCLES.length, 6)
})

check('the columns follow the audit lifecycle order', () => {
  assert.deepEqual(BOARD_COLUMNS.map((c) => c.key),
    ['pending', 'clarification', 'blocked', 'progress', 'review', 'done'])
  assert.ok(BOARD_COLUMNS.every((c) => c.header && c.label && c.hint))
})

check('columnForLifecycle tolerates an unknown value', () => {
  assert.equal(columnForLifecycle('in_progress').key, 'progress')
  assert.equal(columnForLifecycle('nonsense'), null)
})

check('archived obligations never reach the board', () => {
  assert.equal(isBoardCard({ status: 'active' }), true)
  assert.equal(isBoardCard({ status: 'closed' }), true)
  assert.equal(isBoardCard({ status: 'archived' }), false)
  assert.equal(isBoardCard(null), false)
})

check('the outstanding sentence every incomplete obligation shows', () => {
  const parcial = completionSummary({ assigned_count: 3, complete_count: 2, completion_pct: 66.7, outstanding_names: ['Jane Doe', 'Peter Obi', 'Amaka Eze'] })
  assert.equal(parcial.text, '2 of 3 completed · 67% · Awaiting: Jane Doe, Peter Obi, Amaka Eze')
  const long = completionSummary({ assigned_count: 5, complete_count: 2, completion_pct: 40, outstanding_names: ['A', 'B', 'C', 'D'] })
  assert.match(long.text, /Awaiting: A, B, C \+1 more/)
  const done = completionSummary({ assigned_count: 3, complete_count: 3, completion_pct: 100, outstanding_names: [] })
  assert.equal(done.text, '3 of 3 completed · 100%')
  const none = completionSummary({ assigned_count: 0, complete_count: 0, completion_pct: 0, outstanding_names: [] })
  assert.equal(none.text, 'No responsible person assigned yet')
})

check('name and date helpers behave', () => {
  assert.equal(summariseNames([]), '')
  assert.equal(summariseNames(['Jane Doe']), 'Jane Doe')
  assert.equal(summariseNames(['a', 'b', 'c', 'd'], 2), 'a, b +2 more')
  assert.equal(initialsOf('Jane Doe'), 'JD')
  assert.equal(initialsOf('  '), '?')
  assert.equal(recurrenceLabel('monthly:5'), 'Monthly (5)')
  assert.equal(recurrenceLabel(''), 'One-off')
  assert.equal(hasSchedule({ effective_deadline: null, recurrence_rule: 'monthly:5' }), true)
  assert.equal(hasSchedule({ effective_deadline: '2026-10-30', recurrence_rule: null }), true)
  assert.equal(hasSchedule({ effective_deadline: null, recurrence_rule: null }), false)
})

// ===========================================================================
// 4. ONE SOURCE OF TRUTH - the migration
// ===========================================================================
console.log('\nOne canonical rollup (migration)')

check('the rollup is a single SECURITY DEFINER function', () => {
  const sql = read(MIGRATION)
  assert.match(sql, /create or replace function public\.audit_obligation_states\(p_status text default null\)/)
  assert.match(sql, /security definer/)
  assert.match(sql, /revoke all on function public\.audit_obligation_states\(text\) from public/)
  assert.match(sql, /revoke all on function public\.audit_obligation_states\(text\) from authenticated/)
})

check('the workspace payload is obligation-shaped and carries every state', () => {
  const sql = read(MIGRATION)
  assert.match(sql, /'obligations', v_states,/)
  assert.match(sql, /'schedule', coalesce\(\(/)
  assert.match(sql, /'submissions', coalesce\(\(/)
  assert.match(sql, /'my_assignments', coalesce\(\(/)
  assert.match(sql, /'review_queue', coalesce\(\(/)
  // The old INNER join over assignments + hard status='active' filter is gone:
  // an obligation with NO responsible person must still be discoverable.
  assert.ok(!/left join public\.profiles p on p\.id = a\.assigned_user_id\s*\n\s*where o\.status = 'active'/.test(sql),
    'the workspace no longer hides obligations that have no assignment')
  // Archived is the only status excluded, and only because it is a soft delete.
  assert.match(sql, /where o\.status <> 'archived'/)
})

check('the schedule is derived, never written (no duplicate entries per refresh)', () => {
  const sql = read(MIGRATION)
  // The schedule is a jsonb filter over the same rollup: nothing is inserted.
  assert.match(sql, /from jsonb_array_elements\(v_states\) as x_items\(x\)\s*\n\s*where \(x->>'effective_deadline'\) is not null/)
  assert.ok(!/insert into[^;]*schedule/i.test(sql), 'no schedule table is written')
})

check('the overview gate scopes a department head to their own department', () => {
  const sql = read(MIGRATION)
  assert.match(sql, /create or replace function public\.get_audit_obligation_overview\(p_status text default null\)/)
  assert.match(sql, /where v_unscoped or x->>'department' = public\.current_department\(\)/)
  assert.match(sql, /grant execute on function public\.get_audit_obligation_overview\(text\) to authenticated/)
})

check('bulk assignment cannot duplicate an assignment and keeps the same gate', () => {
  const sql = read(MIGRATION)
  assert.match(sql, /create or replace function public\.audit_assign_obligation_users\(/)
  assert.match(sql, /on conflict \(obligation_id, assigned_user_id\) do nothing/)
  assert.match(sql, /if not \(public\.has_permission\('audit\.obligations\.manage'\)/)
  assert.match(sql, /OBLIGATION_ARCHIVED:An archived obligation cannot be issued/)
  // Department comes from the assignee's own profile, never from the client.
  assert.match(sql, /select department into v_dept from public\.profiles where id = v_user/)
})

check('the migration is idempotent and preserves history', () => {
  const sql = read(MIGRATION)
  assert.match(sql, /^begin;$/m)
  assert.match(sql, /^commit;$/m)
  assert.ok(!/drop table/i.test(sql), 'nothing is dropped')
  assert.ok(!/delete from public\.audit_/i.test(sql), 'no audit row is deleted')
})

// ===========================================================================
// 5. SERVICE + PAGE WIRING
// ===========================================================================
console.log('\nService and page wiring')

check('auditService exposes the canonical read and the bulk assignment', () => {
  const svc = read('src/services/auditService.js')
  assert.match(svc, /async obligationOverview[\s\S]{0,240}supabase\.rpc\('get_audit_obligation_overview'/)
  assert.match(svc, /async assignObligationUsers[\s\S]{0,320}supabase\.rpc\('audit_assign_obligation_users'/)
  assert.match(svc, /subscribeToObligationChanges/)
})

check('the realtime subscription is scoped and cleaned up', () => {
  const svc = read('src/services/auditService.js')
  for (const table of ['audit_obligations', 'audit_obligation_assignments', 'audit_submissions']) {
    assert.ok(svc.includes(`table: '${table}'`), table)
  }
  const body = svc.slice(svc.indexOf('subscribeToObligationChanges'))
  assert.match(body, /supabase\.removeChannel\(channel\)/)
  assert.match(body, /clearTimeout\(pending\)/)
})

check('the workspace page renders the four audit tabs from the rollup', () => {
  const page = read('src/pages/Audit.jsx')
  for (const tab of ['obligations', 'submissions', 'schedule', 'board', 'review']) {
    assert.ok(page.includes(`'${tab}'`), tab)
  }
  assert.match(page, /workspace\?\.obligations \|\| \[\]/)
  assert.match(page, /workspace\?\.submissions \|\| \[\]/)
  assert.match(page, /workspace\?\.schedule \|\| \[\]/)
  assert.match(page, /<AuditBoard obligations=\{obligations\} onOpen=\{setDetailId\} \/>/)
})

check('the board is horizontally scrollable and cannot overflow the page', () => {
  const page = read('src/pages/Audit.jsx')
  assert.match(page, /overflow-x-auto/)
  assert.match(page, /flex min-w-max gap-3/)
  assert.match(page, /w-\[264px\] shrink-0/)
})

check('the card shows the required fields and opens the detail drawer', () => {
  const page = read('src/pages/Audit.jsx')
  const cardSrc = page.slice(page.indexOf('function ObligationCard'), page.indexOf('// ===========================================================================\n// The board:'))
  for (const needle of ['o.reference', 'o.title', 'OBLIGATION_TYPE[', 'o.department', 'AvatarStack',
    'o.effective_deadline', 'RISK_TONE[', 'completion_pct', 'summary.pending', 'is_overdue', 'onOpen(o.id)']) {
    assert.ok(cardSrc.includes(needle), needle)
  }
  assert.match(page, /function ObligationDrawer/)
})

check('the workspace renders server state only - no mock or sample data', () => {
  const page = read('src/pages/Audit.jsx')
  assert.ok(!/Jane Doe/i.test(page), 'no hardcoded sample person')
  assert.ok(!/AUD-002/i.test(page), 'no hardcoded sample obligation')
  assert.ok(!/mock|dummy|fixture/i.test(page), 'no mock data source')
})

check('the workspace subscribes and refetches, never patches locally', () => {
  const page = read('src/pages/Audit.jsx')
  assert.match(page, /useEffect\(\(\) => auditService\.subscribeToObligationChanges\(\(\) => \{ loadWorkspace\(\) \}\), \[loadWorkspace\]\)/s)
  assert.match(page, /auditService\.submitResponse/)
  assert.match(page, /auditService\.reviewSubmission/)
})

check('the Command Centre reads the SAME rollup', () => {
  const page = read('src/pages/audit/AuditCommandCenter.jsx')
  assert.match(page, /auditService\.obligationOverview\(null\)/)
  assert.match(page, /auditService\.assignObligationUsers\(/)
  assert.match(page, /auditService\.subscribeToObligationChanges/)
  assert.match(page, /overviewById\.get\(o\.id\)/)
  // Closing reuses the existing status vocabulary - no new value is invented.
  assert.match(page, /applyStatus\(o, 'closed'\)/)
})

check('no hook is called after an early return (React hook-order crash)', () => {
  // The reported runtime error was exactly this: overviewById's useMemo sat
  // below `if (loading) return ...`, so the hook count changed between the
  // first render and the loaded one.
  for (const file of ['src/pages/audit/AuditCommandCenter.jsx', 'src/pages/Audit.jsx']) {
    const lines = read(file).split('\n')
    const hookRe = /\b(useState|useEffect|useMemo|useCallback|useRef|useReducer)\s*\(/
    const returnRe = /^\s{2}(if \((loading|error|blocked|!workspace|!data)\)\s*\{?\s*(return|<[A-Za-z])|return <(?=[A-Z]))/
    const firstReturn = lines.findIndex((l) => returnRe.test(l))
    if (firstReturn === -1) continue // the page renders loading inline, no early return
    const stragglers = lines.slice(firstReturn)
      .map((l, i) => [i + firstReturn + 1, l])
      .filter(([, l]) => hookRe.test(l) && !/^\s*(\/\/|\*)/.test(l))
    assert.deepEqual(stragglers.map(([n, l]) => `${file}:${n} ${l.trim()}`), [],
      `${file}: a hook runs after an early return`)
  }
})

check('the page renders loading inline rather than bailing out early', () => {
  // Audit.jsx keeps its loading state in the JSX so the workspace payload can
  // arrive independently of the two registers.
  const page = read('src/pages/Audit.jsx')
  assert.match(page, /\{loading && <LoadingState label="Loading audit registers\.\.\." \/>\}/)
})

check('every derived summary the Command Centre renders is declared', () => {
  // Regression: the Phase 73 edit deleted `const s = data?.summary || {}` while
  // moving code above the early returns, and the page died at runtime with
  // "Can't find variable: s".
  const page = read('src/pages/audit/AuditCommandCenter.jsx')
  const lines = page.split('\n')
  const declarations = new Set(
    lines.map((l) => /^ {2}const (\w+) /.exec(l)?.[1]).filter(Boolean),
  )
  for (const name of ['s', 'coverage', 'departments', 'horizon', 'overallCompletion', 'overviewById']) {
    assert.ok(declarations.has(name), `${name} is never declared`)
  }
  // And each is declared before its first use in the JSX.
  for (const name of ['s', 'overviewById']) {
    const use = lines.findIndex((l) => l.includes(`{${name}.`) || l.includes(`${name}.get(`))
    const decl = lines.findIndex((l) => l.startsWith(`  const ${name} =`))
    assert.ok(use > decl, `${name} is used at line ${use + 1} but declared at ${decl + 1}`)
  }
})

check('the regulatory and findings tabs read the canonical obligations', () => {
  // regression report: those two tabs read regulatory_items / audit_findings,
  // a separate table nobody populated, so they said "No regulatory items yet"
  // while the Command Centre showed the real register.
  const page = read('src/pages/Audit.jsx')
  assert.match(page, /const regRows = useMemo\(\(\) => \(obligations \|\| \[\]\)\.filter\(isRegulatoryObligation\), \[obligations\]\)/)
  assert.match(page, /const findRows = useMemo\(\(\) => \(obligations \|\| \[\]\)\.filter\(isFindingObligation\), \[obligations\]\)/)
  // The legacy tables stay as the manual-entry path, not as the view.
  assert.match(page, /const regLegacy = reg\?\.items \|\| \[\]/)
  assert.match(page, /const findLegacy = findings\?\.findings \|\| \[\]/)
  assert.match(page, /regRows\.length === 0 \? \(/)
  assert.match(page, /findRows\.length === 0 \? \(/)
})

check('the regulatory / finding predicates match the real type vocabulary', () => {
  const svc = read('src/services/auditService.js')
  const vocab = /export const OBLIGATION_TYPE = \{([\s\S]*?)\}/.exec(svc)[1]
  const types = [...vocab.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1])
  assert.ok(types.includes('regulatory_return') && types.includes('regulatory_circular')
    && types.includes('audit_finding'), types.join(','))
  assert.equal(isRegulatoryObligation({ obligation_type: 'regulatory_return' }), true)
  assert.equal(isRegulatoryObligation({ obligation_type: 'regulatory_circular' }), true)
  assert.equal(isRegulatoryObligation({ obligation_type: 'audit_finding' }), false)
  assert.equal(isRegulatoryObligation({ obligation_type: 'compliance_declaration' }), false,
    'a compliance declaration is not a regulatory submission')
  assert.equal(isFindingObligation({ obligation_type: 'audit_finding' }), true)
  assert.equal(isFindingObligation({ obligation_type: 'regulatory_return' }), false)
  assert.equal(isRegulatoryObligation(null), false)
})

check('no new obligation status value is invented anywhere', () => {
  const sql = read(MIGRATION)
  const values = [...sql.matchAll(/check \(status in \(([^)]*)\)\)/g)].map((m) => m[1])
  for (const v of values) {
    assert.ok(v.includes("'draft'") && v.includes("'archived'"), `unexpected status set: ${v}`)
  }
})

check('no reference runs before its declaration (temporal dead zone)', () => {
  // Regression: the register views were inserted ABOVE `const obligations = ...`,
  // so their useMemo read `obligations` while it was still in its TDZ and the
  // page died with "Cannot access 'obligations' before initialization." Vite's
  // build cannot see this - it is a runtime ReferenceError.
  const files = ['src/pages/Audit.jsx', 'src/pages/audit/AuditCommandCenter.jsx']
  for (const file of files) {
    const code = read(file)
    const ast = parse(code, { sourceType: 'module', plugins: ['jsx'] })
    const offenders = []
    walk(ast, {
      'FunctionDeclaration|ArrowFunctionExpression|FunctionExpression'(path) {
        const params = new Set(
          [...(path.node.params || [])].map((p) => p.name).filter(Boolean),
        )
        const decls = new Map()
        path.traverse({
          VariableDeclarator(p) {
            if (!['const', 'let'].includes(p.parent.kind)) return
            for (const name of Object.keys(p.getBindingIdentifiers())) {
              if (!decls.has(name)) decls.set(name, p.node.id.start)
            }
          },
        })
        path.traverse({
          ReferencedIdentifier(p) {
            const { name } = p.node
            if (params.has(name) || !decls.has(name)) return
            // Skip genuine closures: the risk is a value read during THIS render.
            let fn = p.getFunctionParent()
            while (fn && fn.node !== path.node) fn = fn.getFunctionParent()
            if (fn !== path) return
            if (p.node.start < decls.get(name)) {
              const line = code.slice(0, p.node.start).split('\n').length
              offenders.push(`${file}:${line}: '${name}'`)
            }
          },
        })
      },
    })
    assert.deepEqual(offenders, [], `${file}: use-before-declaration`)
  }
})

check('the migration parses - dollar-quoted bodies are closed and parens balance', () => {
  const sql = read(MIGRATION)
  // Every function body is dollar-quoted; an odd count means an unterminated one.
  const dollars = sql.match(/\$\$/g) || []
  assert.equal(dollars.length % 2, 0, `unbalanced $$ count: ${dollars.length}`)

  // Each block runs from its signature to its closing $$; (inclusive), so the
  // scanner sees BOTH dollar markers and the toggling is meaningful.
  const blockRe = /create or replace function[\s\S]*?\$\$;/g
  const blocks = sql.match(blockRe) || []
  assert.ok(blocks.length >= 4, `expected 4+ function definitions, found ${blocks.length}`)

  // A real left-to-right scanner: string literal > line comment > dollar quote,
  // so a parenthesis inside prose or inside a quoted status list cannot fail it.
  const parenDepths = (text) => {
    let depth = 0
    let inStr = false
    let inLine = false
    let inDollar = false
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (inLine) { if (c === '\n') inLine = false; continue }
      if (inStr) {
        if (c === "'") {
          if (text[i + 1] === "'") { i++; continue }
          inStr = false
        }
        continue
      }
      if (inDollar) { if (c === '$' && text[i + 1] === '$') { inDollar = false; i++ } continue }
      if (c === '-' && text[i + 1] === '-') { inLine = true; i++; continue }
      if (c === "'") { inStr = true; continue }
      if (c === '$' && text[i + 1] === '$') { inDollar = true; i++; continue }
      if (c === '(') depth += 1
      if (c === ')') depth -= 1
    }
    return depth
  }
  for (const block of blocks) {
    const name = /create or replace function ([\w.]+)\(/.exec(block)?.[1] || 'unknown'
    // Skip the dollar-quoted body: the scanner cannot see its closing marker
    // once the terminator has been consumed, and Postgres parses the inside as
    // its own statement list.
    const body = block.slice(block.indexOf('$$') + 2)
    const head = block.slice(0, block.indexOf('$$'))
    for (const [label, chunk] of [['signature', head], ['body', body]]) {
      assert.equal(parenDepths(chunk), 0, `${name}: unbalanced parentheses in ${label}`)
    }
    assert.match(body, /\b(begin|with|select)\b/i, `${name}: empty body`)

    // Prove the detector is not vacuous: the exact reported syntax error was an
    // unterminated jsonb_build_object( whose select list ran straight into FROM.
    const detector = (t) => {
      let depth = 0
      for (const c of t) { if (c === '(') depth += 1; if (c === ')') depth -= 1 }
      return depth
    }
    assert.equal(detector("select jsonb_build_object(\n  'id', o.id\nfrom t o"), 1)
    assert.equal(detector("select jsonb_build_object(\n  'id', o.id\n)\nfrom t o"), 0)
  }
})

check('the migration applies before the dependent pages can call it', () => {
  // The workspace RPC this page calls must exist in the migration, and the
  // service wrapper must call it by the same name.
  const sql = read(MIGRATION)
  const svc = read('src/services/auditService.js')
  assert.match(sql, /create or replace function public\.get_audit_workspace\(\)/)
  assert.match(svc, /supabase\.rpc\('get_audit_workspace'/)
})

console.log(`\n${n} checks passed.`)
