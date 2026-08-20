import { supabase } from '../supabaseClient'
import { leaveRequests as svc, logAction, sendDecisionEmail } from './supabaseService'
import { deductBalance, restoreBalance, currentYear } from './leaveBalanceService'

// ------------------------------------------------------------------
// Single source of truth for the approval chain. LeaveRequests.jsx,
// the notification bell, the dashboard widget, and SARA all import
// this instead of each re-declaring their own copy.
// Originator → Branch Manager → Area Manager → Head of Business → HR (final)
// ------------------------------------------------------------------
export const APPROVAL_CHAIN = [
  { role: 'branch_manager', label: 'Branch Manager' },
  { role: 'area_manager', label: 'Area Manager' },
  { role: 'head_of_business', label: 'Head of Business' },
  { role: 'hr_manager', label: 'HR (Final)' },
]

export const APPROVER_ROLES = ['admin', 'super_admin', 'branch_manager', 'area_manager', 'head_of_business', 'hr_manager', 'hr_officer']

export const currentStage = (r) => APPROVAL_CHAIN[(r.approval_level || 1) - 1]
export const isFinalStage = (r) => (r.approval_level || 1) >= APPROVAL_CHAIN.length
export const pendingAgeHours = (r) => (Date.now() - new Date(r.created_at).getTime()) / 3600000

// Can this authenticated user act on this specific request right now?
export function canActOnRequest(r, { userId, role, isAdmin }) {
  return r.status === 'pending' && r.created_by !== userId && (isAdmin || currentStage(r)?.role === role)
}

// Requests currently sitting in this user's queue.
export function myQueue(items, ctx) {
  return items.filter((r) => canActOnRequest(r, ctx))
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
// Single entry point for actually deciding on a request — approve or
// reject at whatever stage it currently sits at, cancellation-aware.
// This is the SAME logic LeaveRequests.jsx uses when a human clicks
// Approve/Reject in the UI, and it's what SARA calls after a user
// confirms a voice/text command. There is exactly one place that
// writes an approval decision to the database.
//
// `source` / `command` are for the audit trail only (e.g. source:
// 'sara_voice', command: 'approve annual leave from Lagos <=5 days').
// The actor recorded in the database is ALWAYS the authenticated
// user (approverId/approverName) — SARA is never the actor.
// ------------------------------------------------------------------
export async function executeLeaveDecision({ request, decision, comment = '', signature = null, approverId, approverName, source = 'web', command = null }) {
  if (!request || !approverId) throw new Error('Missing request or approver')
  if (request.status !== 'pending') throw new Error('This request is no longer pending.')
  if (request.created_by === approverId) throw new Error('You cannot approve your own leave request.')
  // Real gating is server-side (RLS) — this is a client-side sanity check
  // so SARA (or a stale UI) can't even attempt an obviously invalid write.

  const stage = currentStage(request)
  const finalStage = isFinalStage(request)
  const cancelling = !!request.is_cancellation

  await recordApproval({
    leave_request_id: request.id,
    stage: request.approval_level || 1,
    stage_role: stage?.role,
    stage_label: stage?.label,
    decision,
    approver_id: approverId,
    approver_name: approverName,
    comment,
    signature,
    is_cancellation: cancelling,
  })

  if (decision === 'rejected') {
    await svc.update(request.id, cancelling ? { status: 'approved', is_cancellation: false } : { status: 'rejected' })
  } else if (finalStage) {
    if (cancelling) {
      await svc.update(request.id, { status: 'cancelled', is_cancellation: false })
      if (request.leave_type !== 'unpaid') await restoreBalance(request.created_by, request.leave_type, request.days, currentYear())
    } else {
      await svc.update(request.id, { status: 'approved' })
      if (request.leave_type !== 'unpaid') await deductBalance(request.created_by, request.leave_type, request.days, currentYear())
    }
  } else {
    await svc.update(request.id, { approval_level: (request.approval_level || 1) + 1 })
  }

  const actionBase = decision === 'rejected' ? (cancelling ? 'leave_cancellation_rejected' : 'leave_rejected') : finalStage ? (cancelling ? 'leave_cancelled' : 'leave_approved') : 'leave_stage_advanced'
  await logAction({
    action: source === 'web' ? actionBase : `sara_${actionBase}`,
    entityType: 'LeaveRequest',
    entityId: request.id,
    details: `${request.employee_name} — ${stage?.label} ${decision}${cancelling ? ' (cancellation)' : ''}${source !== 'web' ? ` · via SARA (${source}) by ${approverName}${command ? ` · command: "${command}"` : ''}` : ''}`,
    userName: approverName,
    severity: source !== 'web' ? 'warning' : 'info',
  })

  try {
    const statusText = decision === 'rejected'
      ? (cancelling ? 'your cancellation request was declined — the original leave remains approved' : `rejected by ${stage?.label}`)
      : finalStage
        ? (cancelling ? 'your cancellation was approved — leave balance restored' : 'fully approved (final sign-off by HR)')
        : `approved by ${stage?.label}, now awaiting ${APPROVAL_CHAIN[request.approval_level]?.label}`
    await sendDecisionEmail({
      recipientId: request.created_by,
      subject: 'Leave request update',
      message: `Hello,\n\n${statusText}.${comment ? `\n\nComments: ${comment}` : ''}\n\n— Infinity Bank Operations`,
    })
  } catch { /* best-effort */ }

  return { finalStage, cancelling, decision }
}
