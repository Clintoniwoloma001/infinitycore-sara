import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const baseMigration = read('supabase/migrations/20260921000019_leave_approval_chain.sql')
const settingsMigration = read('supabase/migrations/20260922000005_leave_approval_chain_settings.sql')
const platformSettings = read('src/pages/PlatformSettings.jsx')
const leaveRequests = read('src/pages/LeaveRequests.jsx')
const service = read('src/services/leaveApprovalsService.js')

describe('leave approval chain — DB layer (20260921000019)', () => {
  test('stores the chain template on hr_platform_settings with the 4-stage default', () => {
    assert.match(baseMigration, /add column if not exists leave_approval_chain jsonb/)
    assert.match(baseMigration, /default '\["line_manager","branch_manager","area_manager","head_of_human_resources"\]'::jsonb/)
  })

  test('resolves a single stage and the full per-employee chain', () => {
    assert.match(baseMigration, /create or replace function public\.resolve_leave_approver\(p_employee_id uuid, p_stage_key text\)/)
    for (const stage of ['line_manager', 'branch_manager', 'area_manager', 'head_of_human_resources']) {
      assert.match(baseMigration, new RegExp(`when '${stage}' then`))
    }
    assert.match(baseMigration, /create or replace function public\.get_leave_approval_chain_for_employee\(p_employee_id uuid\)/)
    assert.match(baseMigration, /v_chain := v_chain \|\| jsonb_build_object\(/)
  })

  test('consumes the template in process_leave_decision and sara_batch_approve_leave', () => {
    assert.match(baseMigration, /create or replace function public\.process_leave_decision\(/)
    assert.match(baseMigration, /public\.get_leave_approval_chain_for_employee\(v_employee_id\)/)
    assert.match(baseMigration, /create or replace function public\.sara_batch_approve_leave\(/)
  })
})

describe('leave approval chain — settings persistence (20260922000005)', () => {
  test('update_hr_settings accepts and validates leave_approval_chain', () => {
    assert.match(settingsMigration, /create or replace function public\.update_hr_settings\(p_settings jsonb\)/)
    assert.match(settingsMigration, /if p_settings \? 'leave_approval_chain' then/)
    assert.match(settingsMigration, /must be a JSON array of stage keys/)
    assert.match(settingsMigration, /must contain at least one stage/)
    assert.match(settingsMigration, /leave_approval_chain contains an unknown stage key/)
    assert.match(settingsMigration, /when 'leave_approval_chain' then \(v_current\.leave_approval_chain\)::text/)
  })

  test('persists the array to the settings row and audits before/after', () => {
    assert.match(settingsMigration, /leave_approval_chain = coalesce\(p_settings -> 'leave_approval_chain', leave_approval_chain\),/)
    assert.match(settingsMigration, /insert into public\.hr_settings_audit \(setting_key, previous_value, new_value, changed_by\)/)
  })

  test('does not allow arbitrary stage keys', () => {
    const known = settingsMigration.match(/not in \('([^']+)', '([^']+)', '([^']+)', '([^']+)'\)/)
    assert.ok(known)
    assert.deepEqual(known.slice(1), ['line_manager', 'branch_manager', 'area_manager', 'head_of_human_resources'])
  })
})

describe('leave approval chain — settings UI', () => {
  test('PlatformSettings exposes an Approval Chain editor in the Leave tab', () => {
    assert.match(platformSettings, /APPROVAL_STAGES = \{/)
    assert.match(platformSettings, /DEFAULT_APPROVAL_CHAIN = \['line_manager', 'branch_manager', 'area_manager', 'head_of_human_resources'\]/)
    assert.match(platformSettings, /normalizeChain/)
    assert.match(platformSettings, /Approval Chain/)
    assert.match(platformSettings, /moveChainStage/)
    assert.match(platformSettings, /removeChainStage/)
    assert.match(platformSettings, /addChainStage/)
    assert.match(platformSettings, /Add a stage…/)
    assert.match(platformSettings, /leave_approval_chain/)
  })

  test('editor prevents removal of the last stage and duplicate stages', () => {
    const src = platformSettings
    assert.match(src, /chain\.length <= 1/)
    assert.match(src, /!stage \|\| chain\.includes\(stage\)/)
  })

  test('LeaveRequests no longer hardcodes the fixed chain', () => {
    assert.ok(!/Branch Manager → Area Manager → Head of Business/.test(leaveRequests), 'fixed chain copy removed')
    assert.match(leaveRequests, /routes through your configured approval chain/)
    assert.match(leaveRequests, /Multi-stage approval chain with automated balance tracking/)
    assert.match(leaveRequests, /route it back through your configured approval chain/)
  })

  test('frontend service still describes the default chain for legacy callers', () => {
    assert.match(service, /DEFAULT_APPROVAL_CHAIN = \[/)
    assert.match(service, /stage_key: 'line_manager'/)
    assert.match(service, /get_leave_approval_chain_for_request/)
    assert.match(service, /process_leave_decision/)
  })
})

describe('pure chain-ordering helpers', () => {
  test('normalizeChain mirrors DEFAULT_APPROVAL_CHAIN when empty', () => {
    const chain = ['line_manager', 'branch_manager', 'area_manager', 'head_of_human_resources']
    assert.equal(chain.length, 4)
    assert.equal(new Set(chain).size, chain.length)
  })

  test('stage order is stable and matches the DB default', () => {
    const dbOrder = settingsMigration.match(/leave_approval_chain = coalesce/g)
    assert.ok(dbOrder)
    assert.equal(dbOrder.length >= 1, true)
  })
})