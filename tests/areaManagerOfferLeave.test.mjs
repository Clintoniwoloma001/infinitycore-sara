import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const root = process.cwd()
const read = (p) => readFileSync(join(root, p), 'utf8')

describe('Phase 4 — Area Manager multi-branch clock-in', () => {
  const sql = read('supabase/migrations/20260921000017_area_manager_multi_branch.sql')

  it('defines get_area_manager_area_branches helper', () => {
    assert(sql.includes('create or replace function public.get_area_manager_area_branches'))
  })

  it('patches attendance_validate_location for area managers', () => {
    assert(sql.includes('create or replace function public.attendance_validate_location'))
    assert(sql.includes('v_is_area_manager'))
    assert(sql.includes('v_area_branch_ids'))
    assert(sql.includes("'is_area_manager'"))
  })

  it('adds set_area_branches RPC', () => {
    assert(sql.includes('create or replace function public.set_area_branches'))
    assert(sql.includes('AREA_BRANCHES_UPDATED'))
  })

  it('adds get_area_manager_location_kpi RPC', () => {
    assert(sql.includes('create or replace function public.get_area_manager_location_kpi'))
    assert(sql.includes('visited_branches'))
    assert(sql.includes('total_assigned_branches'))
  })
})

describe('Phase 5 — Offer-letter access control', () => {
  const sql = read('supabase/migrations/20260921000018_offer_letter_access_control.sql')

  it('defines accepted-offer preview RPC', () => {
    assert(sql.includes('create or replace function public.public_get_accepted_offer_by_portal_token'))
    assert(sql.includes("status = 'accepted'"))
  })
})

describe('Phase 6 — Configurable leave approval chain', () => {
  const sql = read('supabase/migrations/20260921000019_leave_approval_chain.sql')

  it('adds leave_approval_chain setting', () => {
    assert(sql.includes('leave_approval_chain jsonb'))
    assert(sql.includes('line_manager'))
    assert(sql.includes('head_of_human_resources'))
  })

  it('defines approver resolution helpers', () => {
    assert(sql.includes('create or replace function public.resolve_leave_approver'))
    assert(sql.includes('create or replace function public.get_leave_approval_chain_for_employee'))
    assert(sql.includes('create or replace function public.get_leave_approval_chain_for_request'))
  })

  it('rewrites sara_batch_approve_leave to use the chain', () => {
    assert(sql.includes('create or replace function public.sara_batch_approve_leave'))
    assert(sql.includes('public.get_leave_approval_chain_for_employee'))
  })

  it('adds process_leave_decision RPC', () => {
    assert(sql.includes('create or replace function public.process_leave_decision'))
    assert(sql.includes('p_signature'))
  })

  it('adds approval_chain column to leave_requests', () => {
    assert(sql.includes('add column if not exists approval_chain jsonb'))
  })
})

describe('Frontend wiring', () => {
  it('HR Organisation service exposes area branch helpers', () => {
    const js = read('src/services/hrOrganisationService.js')
    assert(js.includes('getAreaBranches'))
    assert(js.includes('setAreaBranches'))
    assert(js.includes('getAreaManagerKpi'))
  })

  it('Candidate portal can preview accepted offer', () => {
    const js = read('src/pages/careers/CandidatePortal.jsx')
    assert(js.includes('getAcceptedOffer'))
    assert(js.includes('Preview accepted offer letter'))
    assert(js.includes('AcceptedOfferPreview'))
  })

  it('Leave approvals service uses dynamic chain', () => {
    const js = read('src/services/leaveApprovalsService.js')
    assert(js.includes('DEFAULT_APPROVAL_CHAIN'))
    assert(js.includes('get_leave_approval_chain_for_request'))
    assert(js.includes('process_leave_decision'))
  })

  it('LeaveRequests loads chains', () => {
    const js = read('src/pages/LeaveRequests.jsx')
    assert(js.includes('loadApprovalChainsForRequests'))
    assert(js.includes('chainsByRequest'))
  })
})
