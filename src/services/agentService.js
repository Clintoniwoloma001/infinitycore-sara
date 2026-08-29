import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'
import { parseSaraCommand } from './saraCommandParser'
import { analyzeIntent, canExecuteIntent } from './saraNlu'
import { myQueue as computeMyQueue, currentStage, executeLeaveDecision } from './leaveApprovalsService'
import { LEAVE_TYPE_LABELS } from './leaveBalanceService'
import { countRows } from './saraStats'
import { protectedRoutes, canAccessRoute } from '../config/navigation'

// ------------------------------------------------------------------
// AGENTIC ARCHITECTURE (conceptual):
//
//   CHANNELS (web / voice / email / whatsapp)
//        -> SARA INTERFACE
//        -> COMMAND INTERPRETER   (saraNlu.js: deterministic + server NLU)
//        -> INTENT / CRITERIA
//        -> AUTHORIZATION ENGINE  (caller role/permissions/pool — never SARA)
//        -> CONFIRMATION ENGINE   (matches -> ask -> confirm)
//        -> APPROVAL SERVICE      (leaveApprovalsService.executeLeaveDecision)
//        -> SUPABASE
//        -> AUDIT LOG             (logAction, tagged source: sara_*)
//        -> NOTIFICATION / RESPONSE
//
// CHANNEL != AUTHORITY. Every call below runs under the authenticated
// user's own id/role — passed in explicitly by the caller, never
// inferred, and never elevated by SARA itself. No synthetic record is
// ever created by this layer: writes go through business services only.
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
    const needle = String(filters.employee).toLowerCase()
    matches = matches.filter((r) => r.employee_name?.toLowerCase().includes(needle))
  }
  if (filters.leave_type) matches = matches.filter((r) => r.leave_type === filters.leave_type)
  if (typeof filters.max_days === 'number') matches = matches.filter((r) => r.days <= filters.max_days)
  if (typeof filters.min_days === 'number') matches = matches.filter((r) => r.days >= filters.min_days)
  if (typeof filters.exact_days === 'number') matches = matches.filter((r) => r.days === filters.exact_days)
  if (filters.employee && filters.all) {
    // "all of X's requests" — still scoped to the authenticated pool.
    matches = matches.filter((r) => String(r.employee_name || '').toLowerCase().includes(String(filters.employee).toLowerCase()))
  }
  if (filters.branch) {
    const needle = String(filters.branch).toLowerCase()
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

// Level-2 NAVIGATION. SARA only ever opens pages the authenticated user
// is already allowed to reach — it reuses routeConfig + canAccessRoute,
// the exact same gates as the sidebar, so it can never bypass access.
export function resolveNavigationTarget(target, ctx) {
  const needle = String(target || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
  if (!needle) return null
  const matches = protectedRoutes
    .filter((r) => r.path !== '/')
    .filter((r) => r.label.toLowerCase().includes(needle) || r.path.includes(needle) || needle.includes(r.label.toLowerCase()))
  if (matches.length === 0) return null
  // Respect the user's real access — same function the sidebar uses.
  const authView = {
    user: ctx.userId ? { id: ctx.userId } : null,
    profile: { id: ctx.userId || '' },
    role: ctx.role,
    isAdmin: ctx.isAdmin,
    hasAnyPermission: (perms) => (ctx.isAdmin ? true : (ctx.permissions || []).some((p) => perms.includes(p))),
  }
  const accessible = matches.find((r) => canAccessRoute(r, authView))
  return accessible ? { route: accessible.path, label: accessible.label } : { denied: true }
}

async function dashboardSummary(ctx) {
  const [customers, pendingLoans, pendingRepayments] = await Promise.all([
    countRows('customers', null, ctx),
    countRows('loan_applications', { status: 'pending' }, ctx),
    countRows('repayments', { status: 'pending' }, ctx),
  ])
  return { customers, pendingLoans, pendingRepayments }
}

function joinCounts(label, value) {
  return value === null ? null : `${label} ${value}`
}

// pool: the caller's actionable queue (already computed via useMyLeaveApprovals) —
// SARA only ever touches requests the authenticated user is actually
// authorized to act on right now.
export async function runSaraCommand({ command, pool, ctx }) {
  const parsed = ctx?.intent || await analyzeIntent(command, ctx)

  // Fast authorization gate before anything else. Blocks write intents
  // for users whose permission set cannot satisfy them.
  if (parsed.blocked === 'permission' || (isWriteIntent(parsed.intent) && (!canExecuteIntent(parsed.intent, ctx)))) {
    return { type: 'text', message: "I can't do that with your current permissions. Approving or rejecting leave requires leave management rights — please use the Leave Requests page instead." }
  }

  switch (parsed.intent) {
    case 'ROLE_CHANGE_DENIED':
      return { type: 'text', message: "I can't change your role. Role elevation requires an authorized administrator using User Management." }

    case 'HELP':
      return { type: 'text', message: 'Try: "show my pending leave approvals", "how many leave approvals do I have", "approve John\'s leave", "open employees", "what requires my attention?", or "approve annual leave from Lagos that are 5 days or less".' }

    case 'NAVIGATE': {
      const nav = resolveNavigationTarget(parsed.filters.target, ctx)
      if (!nav) return { type: 'text', message: "I couldn't find a page matching that. Try \"open employees\" or \"go to reports\"." }
      if (nav.denied) return { type: 'text', message: "I can't open that page — your current permissions don't include it." }
      return { type: 'navigate', route: nav.route, message: `Opening ${nav.label}.` }
    }

    case 'COUNT_PENDING':
      return { type: 'text', message: pool.length === 0 ? "You have no pending leave approvals." : `You have ${pool.length} pending leave approval${pool.length === 1 ? '' : 's'}.` }

    case 'SHOW_PENDING':
      return pool.length === 0
        ? { type: 'text', message: "You have no pending leave approvals." }
        : { type: 'list', message: `You have ${pool.length} pending request${pool.length === 1 ? '' : 's'}.`, requests: pool }

    case 'PENDING_LOANS': {
      if (!ctx?.permissions?.includes('loans.read')) {
        return { type: 'text', message: "I don't have permission to read loan applications for your role." }
      }
      const pendingLoans = await countRows('loan_applications', { status: 'pending' }, ctx)
      return { type: 'text', message: pendingLoans === null ? "You have no pending loan applications." : `You have ${pendingLoans} pending loan application${pendingLoans === 1 ? '' : 's'}.` }
    }

    case 'DASHBOARD_SUMMARY': {
      const s = await dashboardSummary(ctx)
      const parts = [
        joinCounts('customers', s.customers),
        joinCounts('pending loan applications', s.pendingLoans),
        joinCounts('pending repayments', s.pendingRepayments),
      ].filter(Boolean)
      const leaveBit = pool.length > 0
        ? ` and ${pool.length} leave request${pool.length === 1 ? ' is' : 's are'} waiting on your approval`
        : ''
      if (parts.length === 0) return { type: 'text', message: `Here's your summary: nothing to report right now${leaveBit ? ' — ' + leaveBit.replace(/^ and /, '') : '.'}` }
      return { type: 'text', message: `Here's your operational summary: ${parts.join(', ')}${leaveBit}.` }
    }

    case 'PENDING_ATTENTION': {
      const s = await dashboardSummary(ctx)
      const bits = []
      if (pool.length > 0) bits.push(`${pool.length} leave approval${pool.length === 1 ? '' : 's'} waiting on you`)
      if (s.pendingLoans) bits.push(`${s.pendingLoans} pending loan application${s.pendingLoans === 1 ? '' : 's'}`)
      if (s.pendingRepayments) bits.push(`${s.pendingRepayments} pending repayment${s.pendingRepayments === 1 ? '' : 's'}`)
      return bits.length === 0
        ? { type: 'text', message: "You're all caught up, boss. Nothing needs your attention right now." }
        : { type: 'text', message: `What needs your attention: ${bits.join(', ')}.` }
    }

    case 'APPROVE_LEAVE':
    case 'REJECT_LEAVE': {
      const decision = parsed.intent === 'APPROVE_LEAVE' ? 'approved' : 'rejected'
      const matches = await matchLeaveRequests(pool, parsed.filters)
      if (matches.length === 0) {
        return { type: 'text', message: "I couldn't find a matching leave request in your queue." }
      }
      if (matches.length > 1 && parsed.filters.employee && !parsed.filters.all) {
        // Ambiguous single-employee reference — never guess.
        return { type: 'text', message: `I found ${matches.length} matching employees. Please be more specific — for example include the branch or leave type.` }
      }
      return {
        type: 'confirm',
        decision,
        matches,
        intent: parsed.intent,
        filters: parsed.filters,
        message: matches.length === 1
          ? `I found one pending request:\n${describeRequest(matches[0])}\n\n${decision === 'approved' ? 'Approve' : 'Reject'} this request?`
          : `I found ${matches.length} matching requests:\n${matches.map(describeRequest).join('\n')}\n\nWould you like me to ${decision === 'approved' ? 'approve' : 'reject'} these ${matches.length} requests?`,
      }
    }

    default:
      return { type: 'text', message: "I didn't catch that. Try \"show my pending leave approvals\", \"what requires my attention?\", or \"help\"." }
  }
}

function isWriteIntent(intent) {
  return ['APPROVE_LEAVE', 'REJECT_LEAVE'].includes(intent)
}

// Executes a previously-confirmed bulk/single decision. `ctx` carries the
// authenticated user's own identity — this is who the database records
// as the approver, never SARA. Emits one consolidated SARA audit event.
export async function executeConfirmedDecision({ matches, decision, ctx, command, intent = null }) {
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
  const okCount = results.filter((r) => r.ok).length
  const failedCount = results.length - okCount
  try {
    await logAction({
      action: `sara_${decision}_bulk`,
      entityType: 'LeaveRequest',
      entityId: matches.length === 1 ? matches[0].id : '',
      details: JSON.stringify({
        intent: intent || (decision === 'approved' ? 'APPROVE_LEAVE' : 'REJECT_LEAVE'),
        criteria: 'voice/text command',
        records: matches.length,
        confirmation: 'VOICE_CONFIRMED',
        result: failedCount === 0 ? 'SUCCESS' : `${okCount}/${results.length}`,
        via: ctx.method === 'voice' ? 'sara_voice' : 'sara_text',
      }),
      userName: ctx.approverName,
      severity: failedCount === 0 ? 'warning' : 'high',
    })
  } catch { /* audit is best-effort */ }
  return results
}

// Kept here (not just in LeaveRequests.jsx) so SARA and the notification
// bell can independently derive "what's actionable for me right now"
// from a freshly-loaded list, without re-deriving the rule elsewhere.
export function actionableQueue(items, { userId, role, isAdmin }) {
  return computeMyQueue(items, { userId, role, isAdmin })
}

export { currentStage }

export { parseSaraCommand }