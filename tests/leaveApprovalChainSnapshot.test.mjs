// ===========================================================================
// Leave approval chain + snapshot routing — structural guarantees.
//
// The BEHAVIOURAL proof is tests/acceptance/leave_approval_chain.sql, which
// runs the ten real-organisation scenarios against a live Postgres (two
// isolated branches, real managers, real HoB per area, MD, Head Office).
// Run it with:  npm run test:leave-chain-db
//
// This file guards what a content check can catch without a database: the
// resolver contract, the absence of arbitrary fallbacks, RLS, the exactly-once
// guarantees, and the frontend wiring.
// ===========================================================================
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const routing = read('supabase/migrations/20260930000001_leave_approval_snapshot_and_routing.sql')
const chain = read('supabase/migrations/20260930000002_leave_approval_chain_and_actions.sql')
const service = read('src/services/leaveChainService.js')
const scenarios = read('tests/acceptance/leave_approval_chain.sql')

describe('routing resolver (20260930000001)', () => {
  test('keeps the pre-migration approver_id alias in the payload', () => {
    // CRITICAL REGRESSION GUARD. get_leave_approval_chain_for_employee,
    // get_leave_workflow_chain_for_employee and _leave_stage_approver_ids all
    // read ->>'approver_id'. The workflow builder `continue`s (dropping the
    // stage entirely) when it is absent, which silently collapses every chain.
    assert.match(routing, /'approver_id',\s*v_user_id/)
    assert.match(routing, /LEGACY ALIAS - DO NOT REMOVE/)
  })

  test('resolves both the profile id and the employee id for every approver', () => {
    assert.match(routing, /'approver_user_id', v_user_id, 'approver_employee_id', v_emp_id/)
    // Branch manager must resolve the employee row, not just the profile.
    assert.match(routing, /left join public\.employees e on e\.user_id = p\.id/)
  })

  test('Head of Business is never an arbitrary profile', () => {
    // The old helper fell back to "any active head_of_business profile limit 1".
    assert.ok(
      !/where role = 'head_of_business' and status = 'active'[\s\S]{0,80}limit 1/i.test(routing),
      'the arbitrary head_of_business profile fallback must be gone',
    )
    assert.match(routing, /create table if not exists public\.leave_business_heads/)
    assert.match(routing, /where bh\.area_id = v_area and bh\.is_active/)
    assert.match(routing, /where bh\.area_id is null and bh\.is_active/)
  })

  test('at most one Head of Business per area and one bank-wide default', () => {
    assert.match(routing, /uq_leave_business_heads_area[\s\S]*?where is_active and area_id is not null/)
    assert.match(routing, /uq_leave_business_heads_bank[\s\S]*?where is_active and area_id is null/)
  })

  test('MD/CEO detection uses the stable designation relationship', () => {
    assert.match(routing, /join public\.designations d on d\.id = e\.designation_id/)
    // Free-text position matching must not be the primary signal any more.
    assert.ok(
      !/upper\(btrim\(e\.position\)\) in \('MD'/i.test(routing),
      'free-text MD title matching must be gone',
    )
  })

  test('every stage reports an actionable issue instead of guessing', () => {
    const issues = routing.match(/'resolved', false/g) || []
    assert.ok(issues.length >= 5, `expected several unresolved branches, saw ${issues.length}`)
    assert.match(routing, /HR action required/)
  })

  test('the snapshot table is protected by RLS with no client write path', () => {
    assert.match(routing, /alter table public\.leave_approval_stages enable row level security/)
    assert.match(routing, /create policy "leave_approval_stages read"/)
    assert.match(routing, /revoke insert, update, delete on public\.leave_approval_stages from anon, authenticated/)
  })

  test('original dates are backfilled additively and never overwritten', () => {
    assert.match(routing, /original_start_date = coalesce\(original_start_date, start_date\)/)
    assert.match(routing, /where original_start_date is null/)
  })

  test('a rejected stage can never exist without a reason', () => {
    assert.match(routing, /status <> 'rejected' or \(rejection_reason is not null/)
  })
})

describe('chain builder + actions (20260930000002)', () => {
  test('exposes the documented RPC surface', () => {
    for (const fn of [
      'public.leave_route_for_employee(',
      'public.build_leave_approval_chain(',
      'public.get_leave_approval_timeline(',
      'public.submit_leave_request(',
      'public.act_on_leave_stage(',
      'public.repair_leave_approval_stage(',
    ]) {
      assert.ok(chain.includes(fn), `missing ${fn}`)
    }
  })

  test('the chain is built once and locked against re-resolution', () => {
    assert.match(chain, /if v_req\.chain_locked and not coalesce\(p_force, false\) then/)
    assert.match(chain, /return public\.get_leave_approval_timeline\(p_request_id\)/)
    assert.match(chain, /chain_locked = true/)
  })

  test('the three routes match the agreed organisation rules', () => {
    // MD: Head of HR only.
    const mdBlock = chain.slice(chain.indexOf("'route', 'md'"), chain.indexOf("'route', 'head_office'"))
    assert.match(mdBlock, /head_of_human_resources/)
    assert.ok(!mdBlock.includes('branch_manager'), 'MD must not route through a branch manager')
    // Head office: department head, HoB, HoHR.
    const hoBlock = chain.slice(chain.indexOf("'route', 'head_office'"), chain.indexOf("'route', 'branch'"))
    for (const s of ['head_of_department', 'head_of_business', 'head_of_human_resources']) {
      assert.ok(hoBlock.includes(s), `head office route missing ${s}`)
    }
    // Branch: branch manager, area manager, HoB, HoHR.
    const brBlock = chain.slice(chain.indexOf("'route', 'branch'"))
    for (const s of ['branch_manager', 'area_manager', 'head_of_business', 'head_of_human_resources']) {
      assert.ok(brBlock.includes(s), `branch route missing ${s}`)
    }
  })

  test('actions are exactly-once: rows are locked and the stage must be current', () => {
    assert.match(chain, /from public\.leave_requests where id = p_request_id for update/)
    assert.match(chain, /and status = 'current'[\s\S]{0,160}?for update/)
    assert.match(chain, /There is no approval stage awaiting action on this request/)
  })

  test('self-approval and cross-branch action are refused', () => {
    assert.match(chain, /if v_req\.created_by = v_actor then[\s\S]{0,90}own leave request/)
    assert.match(chain, /v_stage\.approver_user_id is distinct from v_actor/)
  })

  test('rejection and return require a reason', () => {
    assert.match(chain, /p_action in \('rejected','returned'\)[\s\S]{0,240}?raise exception/)
  })

  test('RAISE messages avoid the %s pluralisation trap', () => {
    // '%s' on a text argument appends a plural "s" ("rejecteds"). The codebase
    // already hit this, so the guard is: no "raise exception ... %s".
    const bad = chain.split('\n').filter((l) => /raise exception.*%s/.test(l))
    assert.deepEqual(bad, [], `use a bare '%' placeholder, not '%s': ${bad.join(' | ')}`)
  })

  test('the balance is deducted once, on final approval only', () => {
    assert.match(chain, /EXACTLY ONCE/)
    assert.match(chain, /used_days = used_days \+ v_req\.days/)
    const finalIdx = chain.indexOf('if v_final then')
    const deductIdx = chain.indexOf('used_days = used_days + v_req.days')
    assert.ok(finalIdx > -1 && deductIdx > finalIdx, 'deduction must follow the final-approval guard')
  })

  test('original dates are never overwritten by an approver modification', () => {
    assert.match(chain, /dates_modified = true/)
    const modBlock = chain.slice(
      chain.indexOf('if p_new_start is not null or p_new_end is not null then'),
      chain.indexOf('set status   = p_action::text'),
    )
    assert.ok(!/original_start_date\s*=/.test(modBlock), 'must not rewrite the original period')
  })

  test('an unresolved first stage blocks the chain instead of bypassing a level', () => {
    // Silently promoting stage 2 would let a branch request be approved with
    // no Branch Manager sign-off.
    assert.match(chain, /and stage_order = 1 and status = 'pending'/)
  })

  test('the write RPCs are revoked from anon', () => {
    for (const fn of ['build_leave_approval_chain', 'act_on_leave_stage',
      'submit_leave_request', 'repair_leave_approval_stage']) {
      assert.ok(
        chain.includes(`revoke all on function public.${fn}`),
        `${fn} must be revoked from anon`,
      )
    }
  })

  test('both migrations are transaction wrapped and additive', () => {
    for (const src of [routing, chain]) {
      assert.match(src, /^begin;/m)
      assert.match(src, /^commit;/m)
      assert.ok(!/drop table/i.test(src), 'no table may be dropped')
    }
    assert.match(chain, /on conflict \(leave_request_id, stage_order\) do update/)
    assert.match(routing, /add column if not exists/)
  })
})

describe('frontend service wiring', () => {
  test('calls the same RPCs and re-implements no routing', () => {
    for (const rpc of [
      'submit_leave_request',
      'get_leave_approval_timeline',
      'leave_route_for_employee',
      'act_on_leave_stage',
      'repair_leave_approval_stage',
    ]) {
      assert.ok(service.includes(rpc), `service must call ${rpc}`)
    }
    // No client-side approver picking.
    assert.ok(!/from\('branches'\)/.test(service), 'must not read branches directly')
    assert.ok(!/head_of_business'\s*:\s*true/.test(service), 'must not hardcode an approver')
  })

  test('exposes the helpers the UI needs to render the timeline', () => {
    for (const helper of ['isConfigIncomplete', 'currentStage', 'unassignedStages',
      'isOverdue', 'datesDiffer']) {
      assert.ok(service.includes(`export const ${helper}`), `missing ${helper}`)
    }
  })
})

describe('behavioural scenario suite', () => {
  test('covers all ten required real-organisation scenarios', () => {
    for (let i = 1; i <= 10; i++) {
      assert.ok(new RegExp(`-- S${i}\\.`).test(scenarios), `scenario S${i} missing`)
    }
  })

  test('runs inside a transaction that is always rolled back', () => {
    assert.match(scenarios, /^begin;/m)
    assert.match(scenarios, /rollback;\s*$/)
  })

  test('uses real organisation rows, not mocked resolvers', () => {
    for (const t of ['public.branches', 'public.branch_area_assignments',
      'public.leave_business_heads', 'public.employee_supervisors']) {
      assert.ok(scenarios.includes(`insert into ${t}`), `fixture missing ${t}`)
    }
  })
})

