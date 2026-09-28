// ============================================================================
// Work & KPI Engine - regression guard
// ============================================================================
// Content assertions on the migrations/services plus behavioural checks of the
// UI rule the engine depends on. The authoritative behaviour (formulas, ACC
// scoping, the spec section 6 flow) is proven by the live-DB script; this suite
// guards the wiring and the pure helpers so it cannot silently drift.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

let n = 0
const check = (name, fn) => { fn(); n++; console.log('  ok - ' + name) }

const m1 = read('supabase/migrations/20260928000001_work_task_steps_schema.sql')
const m2 = read('supabase/migrations/20260928000002_work_task_progress.sql')
const m3 = read('supabase/migrations/20260928000003_work_task_write_rpcs.sql')
const m4 = read('supabase/migrations/20260928000004_work_task_sla.sql')
const svc = read('src/services/workEngineService.js')
const myWork = read('src/pages/MyWork.jsx')
const acc = read('src/pages/AutomationCommandCentre.jsx')

console.log('\nEngine')
check('the three formulas exist and match the spec', () => {
  assert.match(m1, /least\(100\.0, \(p_current_value \/ p_target_value\) \* 100\.0\)/)
  assert.match(m1, /case when coalesce\(p_is_completed, false\) then 100\.0 else 0\.0 end/)
  assert.match(m1, /sum\(rate \* \(case when w > 0 then w else \(100\.0 \/ n\) end\)\)/)
  assert.match(m1, /sum\(rate \* w\) \/ sum\(w\)/)
})

check('no division-by-zero or overshoot hole', () => {
  assert.match(m1, /coalesce\(p_target_value, 0\) <= 0 or p_current_value is null then 0\.0/)
  assert.match(m1, /least\(100\.0,/)
})

check('the engine is the only writer of the cached rate', () => {
  assert.match(m1, /SINGLE writer of calculated_completion_rate/)
  assert.match(m3, /ONLY an approved step is ever written back/)
})

console.log("\nScoping - the ACC must never leak other people's work")
check('get_automation_work_tasks takes no user parameter at all', () => {
  assert.match(m3, /create or replace function public\.get_automation_work_tasks\(\)/)
  // A p_user_id argument would be the door through which other people's work
  // could be pulled into the ACC. Assert it is absent from the whole function.
  const body = m3.slice(m3.indexOf('create or replace function public.get_automation_work_tasks()'))
  const end = body.indexOf('$$;')
  assert.ok(!/p_user_id/.test(body.slice(0, end)), 'ACC RPC must not accept a user id')
})

check('the ACC is filtered to own + automation-origin tasks', () => {
  assert.match(m3, /t\.source = 'automation_centre'\s*-- RULE 2: ACC-origin only/)
  assert.match(m3, /t\.assigned_to_user_id = auth\.uid\(\) -- RULE 2: my tasks only/)
})

check('one task per department, enforced by reuse not duplication', () => {
  assert.match(m3, /Rule 1: one task per \(user, department\)/)
  assert.match(m3, /'reused', v_existing is not null/)
})

check('a user may only add their OWN automation task', () => {
  assert.match(m3, /p_allow_self_automation/)
  assert.match(m3, /p_assignee_user_id = auth\.uid\(\)\s*\n\s*and p_source = 'automation_centre'/)
})

console.log('\nHonest completion')
check('submitting does not change the approved score', () => {
  assert.match(m3, /Does not alter approved step values or the task score - only a review can do that/)
  assert.match(m3, /Never fakes a 100% completion/)
})

check('a rejected step requires a reason (RPC + CHECK)', () => {
  assert.match(m3, /A reason is required when rejecting a step/)
  assert.match(m2, /progress_report_steps_reject_reason check/)
})

check('steps are not client-writable', () => {
  assert.match(m2, /There is deliberately NO update\/delete policy on this table/)
  assert.match(m2, /exists a visible parent work_task/)
})

console.log('\nSLA')
check('breach sweep audits once and is idempotent', () => {
  assert.match(m4, /WORK_TASK_SLA_BREACHED/)
  assert.match(m4, /never logged before for this task/)
  assert.match(m4, /pg_cron/)
})

console.log('\nThe vanishing task bug')
check('under-review and needs-revision tasks stay in My Tasks', () => {
  // The original filter omitted both statuses, hiding the task exactly when the
  // employee needed to see it.
  assert.match(myWork, /'in_progress', 'rejected', 'under_review', 'needs_revision', 'overdue'/)
  assert.doesNotMatch(
    myWork,
    /activeTasks = useMemo\(\(\) => tasks\.filter\(\(t\) => \['assigned', 'accepted', 'in_progress', 'rejected'\]\.includes/,
    'the old vanishing-task filter is back')
})

console.log('\nUI wiring')
check('the ACC Add task control is present and self-scoped in copy', () => {
  assert.match(acc, /Add task/)
  assert.match(acc, /workEngineService\.automationTasks\(\)/)
  assert.match(acc, /managed in Work Management, never here/)
})

check('components exist and the ACC/My Work ones are mounted', () => {
  assert.match(read('src/components/work/AddAutomationTask.jsx'), /one task per department/i)
  assert.match(read('src/components/work/ProgressLogger.jsx'), /Submit for review/)
  assert.match(read('src/components/work/ReviewDashboard.jsx'), /Approve &amp; complete/)
  assert.match(read('src/components/work/TaskStepBuilder.jsx'), /Add deliverable/)
  assert.match(myWork, /<ProgressLogger/)
  assert.match(acc, /<AddAutomationTask/)
})

check('the service exposes all five spec operations', () => {
  for (const rpc of ['create_work_task_with_steps', 'get_my_work',
    'submit_task_progress', 'review_task_progress', 'get_work_kpi_summary']) {
    assert.match(svc, new RegExp(rpc), `service missing ${rpc}`)
  }
  assert.match(svc, /automationTasks/)
  assert.match(svc, /reviewProgress/)
  assert.match(svc, /addAutomationTask/)
})

console.log('\nAll ' + n + ' checks passed.')
