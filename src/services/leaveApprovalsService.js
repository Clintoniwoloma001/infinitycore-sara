import { supabase } from '../supabaseClient'
import { logAction, sendDecisionEmail } from './supabaseService'
import { rpcWithRetry } from './rpcHelper'

// ------------------------------------------------------------------
// Configurable leave approval chain.
// Default: employee → Line Manager → Branch Manager → Area Manager → Head of Human Resources.
// Missing stages are skipped per employee (resolved server-side).
// ------------------------------------------------------------------
export const DEFAULT_APPROVAL_CHAIN = [
  { stage_key: 'line_manager', label: 'Line Manager', role: 'line_manager' },
  { stage_key: 'branch_manager', label: 'Branch Manager', role: 'branch_manager' },
  { stage_key: 'area_manager', label: 'Area Manager', role: 'area_manager' },
  { stage_key: 'head_of_human_resources', label: 'Head of Human Resources', role: 'head_of_human_resources' },
]

export const APPROVAL_CHAIN = DEFAULT_APPROVAL_CHAIN // backwards-compat alias
export const APPROVER_ROLES = ['admin', 'super_admin', 'branch_manager', 'area_manager', 'head_of_business', 'head_of_human_resources', 'hr_officer', 'line_manager']

export async function getApprovalChainForRequest(request) {
  if (request?.approval_chain && Array.isArray(request.approval_chain)) {
    return request.approval_chain
  }
  if (!request?.id) return DEFAULT_APPROVAL_CHAIN
  const { data, error } = await supabase.rpc('get_leave_approval_chain_for_request', { p_request_id: request.id })
  if (error) throw error
  return data || DEFAULT_APPROVAL_CHAIN
}

export async function loadApprovalChainsForRequests(requests) {
  const out = {}
  await Promise.all(
    (requests || []).map(async (r) => {
      try {
        out[r.id] = await getApprovalChainForRequest(r)
      } catch {
        out[r.id] = DEFAULT_APPROVAL_CHAIN
      }
    })
  )
  return out
}

export const currentStage = (r, chain) => {
  const c = chain && chain.length ? chain : DEFAULT_APPROVAL_CHAIN
  return c[(r.approval_level || 1) - 1]
}
export const isFinalStage = (r, chain) => {
  const c = chain && chain.length ? chain : DEFAULT_APPROVAL_CHAIN
  return (r.approval_level || 1) >= c.length
}
export const pendingAgeHours = (r) => (Date.now() - new Date(r.created_at).getTime()) / 3600000

// Can this authenticated user act on this specific request right now?
export function canActOnRequest(r, { userId, role, isAdmin }, chain) {
  if (r.status !== 'pending' || r.created_by === userId) return false
  if (isAdmin) return true
  const stage = currentStage(r, chain)
  if (!stage) return false
  // Directly resolved approver (e.g. line manager employee user).
  if (stage.approver_id && stage.approver_id === userId) return true
  // Role-based match.
  if (stage.stage_key === role) return true
  // HR roles can act at any stage.
  if (role === 'head_of_human_resources' || role === 'hr_officer' || role === 'admin' || role === 'super_admin') return true
  return false
}

// Requests currently sitting in this user's queue.
export function myQueue(items, ctx, chainsByRequest = {}) {
  return items.filter((r) => canActOnRequest(r, ctx, chainsByRequest[r.id]))
}

export async function listApprovalsFor(leaveRequestIds) {
  if (!leaveRequestIds || leaveRequestIds.length === 0) return {}
  const { data, error } = await supabase
    .from('leave_approvals')
    .select('*')
    .in('leave_request_id', leaveRequestIds)
    .order('created_at', { ascending: true })
  if (error) throw error
  const byRequest = {}
  for (const row of data || []) {
    byRequest[row.leave_request_id] = byRequest[row.leave_request_id] || []
    byRequest[row.leave_request_id].push(row)
  }
  return byRequest
}

export async function recordApproval(record) {
  const { data, error } = await supabase.from('leave_approvals').insert(record).select().single()
  if (error) throw error
  return data
}

// ------------------------------------------------------------------
// Single entry point for actually deciding on a request.
// Calls the backend process_leave_decision RPC so the configurable
// chain, approver resolution, balance updates, and notifications are
// all handled in one SECURITY DEFINER function.
// ------------------------------------------------------------------
export async function executeLeaveDecision({ request, decision, comment = '', signature = null, approverId, approverName, source = 'web', command = null }) {
  if (!request || !approverId) throw new Error('Missing request or approver')

  const result = await rpcWithRetry(() => supabase.rpc('process_leave_decision', {
    p_request_id: request.id,
    p_decision: decision,
    p_comment: comment || null,
    p_signature: signature || null,
  }))
  if (!result?.ok) throw new Error('Failed to process leave decision')

  const stageLabel = result.stage_label || currentStage(request)?.label || 'Approver'
  const finalStage = result.final
  const cancelling = result.cancellation

  const actionBase = decision === 'rejected'
    ? (cancelling ? 'leave_cancellation_rejected' : 'leave_rejected')
    : finalStage
      ? (cancelling ? 'leave_cancelled' : 'leave_approved')
      : 'leave_stage_advanced'

  await logAction({
    action: source === 'web' ? actionBase : `sara_${actionBase}`,
    entityType: 'LeaveRequest',
    entityId: request.id,
    details: `${request.employee_name} — ${stageLabel} ${decision}${cancelling ? ' (cancellation)' : ''}${source !== 'web' ? ` · via SARA (${source}) by ${approverName}${command ? ` · command: "${command}"` : ''}` : ''}`,
    userName: approverName,
    severity: source !== 'web' ? 'warning' : 'info',
  })

  try {
    const statusText = decision === 'rejected'
      ? (cancelling ? 'your cancellation request was declined — the original leave remains approved' : `rejected by ${stageLabel}`)
      : finalStage
        ? (cancelling ? 'your cancellation was approved — leave balance restored' : 'fully approved (final sign-off by HR)')
        : `approved by ${stageLabel}, now awaiting the next approver`
    await sendDecisionEmail({
      recipientId: request.created_by,
      subject: 'Leave request update',
      message: `Hello,\n\n${statusText}.${comment ? `\n\nComments: ${comment}` : ''}\n\n— Infinity Microfinance Bank Operations`,
    })
  } catch { /* best-effort */ }

  return { finalStage, cancelling, decision }
}
