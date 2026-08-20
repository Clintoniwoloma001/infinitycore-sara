import { supabase } from '../supabaseClient'
import { parseSaraCommand } from './saraCommandParser'
import { myQueue as computeMyQueue, currentStage, executeLeaveDecision } from './leaveApprovalsService'
import { LEAVE_TYPE_LABELS } from './leaveBalanceService'

// ------------------------------------------------------------------
// AGENTIC ARCHITECTURE (conceptual):
//
//   CHANNELS (web / voice / email / whatsapp)
//        -> SARA INTERFACE
//        -> COMMAND INTERPRETER   (saraCommandParser.js)
//        -> INTENT / CRITERIA
//        -> AUTHORIZATION ENGINE  (the caller's role/isAdmin — never SARA)
//        -> CONFIRMATION ENGINE   (this file: matches -> ask -> confirm)
//        -> APPROVAL SERVICE      (leaveApprovalsService.executeLeaveDecision)
//        -> SUPABASE
//        -> AUDIT LOG             (logAction, tagged source: sara_*)
//        -> NOTIFICATION / RESPONSE
//
// CHANNEL != AUTHORITY. Every call below runs under the authenticated
// user's own id/role — passed in explicitly by the caller, never
// inferred, and never elevated by SARA itself.
//
// For the MVP only the "web" channel (this browser session) is wired
// end-to-end. A future WhatsApp channel would call the exact same
// runSaraCommand() function after establishing verified identity
// server-side (e.g. a Supabase Edge Function mapping a verified phone
// number to an existing auth.users id) — it must NOT accept a bare
// phone number as identity.
// ------------------------------------------------------------------

let employeeBranchCache = null
async function branchForUserId(userId) {
  if (!employeeBranchCache) {
    try {
      const { data } = await supabase.from('employees').select('user_id, branch')
      employeeBranchCache = new Map((data || []).filter((e) => e.user_id).map((e) => [e.user_id, e.branch]))
    } catch {
      employeeBranchCache = new Map()
    }
  }
  return employeeBranchCache.get(userId) || null
}

async function matchLeaveRequests(pool, filters) {
  let matches = pool
  if (filters.employee) {
    const needle = filters.employee.toLowerCase()
    matches = matches.filter((r) => r.employee_name?.toLowerCase().includes(needle))
  }
  if (filters.leave_type) matches = matches.filter((r) => r.leave_type === filters.leave_type)
  if (typeof filters.max_days === 'number') matches = matches.filter((r) => r.days <= filters.max_days)
  if (typeof filters.min_days === 'number') matches = matches.filter((r) => r.days >= filters.min_days)
  if (typeof filters.exact_days === 'number') matches = matches.filter((r) => r.days === filters.exact_days)
  if (filters.branch) {
    const needle = filters.branch.toLowerCase()
    const withBranch = []
    for (const r of matches) {
      const branch = await branchForUserId(r.created_by)
      if (branch && branch.toLowerCase().includes(needle)) withBranch.push(r)
    }
    matches = withBranch
  }
  return matches
}

function describeRequest(r) {
  return `${r.employee_name} — ${LEAVE_TYPE_LABELS[r.leave_type] || r.leave_type} — ${r.days} day(s)`
}

// pool: the caller's actionable queue (already computed via useMyLeaveApprovals) —
// SARA only ever touches requests the authenticated user is actually
// authorized to act on right now.
export async function runSaraCommand({ command, pool, ctx }) {
  const parsed = parseSaraCommand(command)

  switch (parsed.intent) {
    case 'ROLE_CHANGE_DENIED':
      return { type: 'text', message: "I can't change your role. Role elevation requires an authorized administrator using User Management." }

    case 'HELP':
      return { type: 'text', message: 'Try: "show my pending leave approvals", "how many leave approvals do I have", "approve John\'s leave", or "approve annual leave from Lagos that are 5 days or less".' }

    case 'COUNT_PENDING':
      return { type: 'text', message: pool.length === 0 ? "You have no pending leave approvals." : `You have ${pool.length} pending leave approval${pool.length === 1 ? '' : 's'}.` }

    case 'SHOW_PENDING':
      return pool.length === 0
        ? { type: 'text', message: "You have no pending leave approvals." }
        : { type: 'list', message: `You have ${pool.length} pending request${pool.length === 1 ? '' : 's'}.`, requests: pool }

    case 'APPROVE_LEAVE':
    case 'REJECT_LEAVE': {
      const decision = parsed.intent === 'APPROVE_LEAVE' ? 'approved' : 'rejected'
      const matches = await matchLeaveRequests(pool, parsed.filters)
      if (matches.length === 0) {
        return { type: 'text', message: "I couldn't find a matching leave request in your queue." }
      }
      if (matches.length > 1 && parsed.filters.employee) {
        // Ambiguous single-employee reference — never guess.
        return { type: 'text', message: `I found ${matches.length} matching employees. Please be more specific — for example include the branch or leave type.` }
      }
      return {
        type: 'confirm',
        decision,
        matches,
        message: matches.length === 1
          ? `I found one pending request:\n${describeRequest(matches[0])}\n\n${decision === 'approved' ? 'Approve' : 'Reject'} this request?`
          : `I found ${matches.length} matching requests:\n${matches.map(describeRequest).join('\n')}\n\nWould you like me to ${decision === 'approved' ? 'approve' : 'reject'} these ${matches.length} requests?`,
      }
    }

    default:
      return { type: 'text', message: "I didn't catch that. Try \"show my pending leave approvals\" or \"help\"." }
  }
}

// Executes a previously-confirmed bulk/single decision. `ctx` carries the
// authenticated user's own identity — this is who the database records
// as the approver, never SARA.
export async function executeConfirmedDecision({ matches, decision, ctx, command }) {
  const results = []
  for (const request of matches) {
    try {
      await executeLeaveDecision({
        request,
        decision,
        comment: `${decision === 'approved' ? 'Approved' : 'Rejected'} via SARA (${ctx.method || 'text'}) command.`,
        signature: `SARA-ASSISTED — authorized by ${ctx.approverName}`,
        approverId: ctx.approverId,
        approverName: ctx.approverName,
        source: ctx.method === 'voice' ? 'sara_voice' : 'sara_text',
        command,
      })
      results.push({ id: request.id, ok: true })
    } catch (e) {
      results.push({ id: request.id, ok: false, error: e?.message })
    }
  }
  return results
}

// Kept here (not just in LeaveRequests.jsx) so SARA and the notification
// bell can independently derive "what's actionable for me right now"
// from a freshly-loaded list, without re-deriving the rule elsewhere.
export function actionableQueue(items, { userId, role, isAdmin }) {
  return computeMyQueue(items, { userId, role, isAdmin })
}

export { currentStage }
