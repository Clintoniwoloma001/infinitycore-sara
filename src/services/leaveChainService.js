// ===========================================================================
// Leave approval chain service — the single client entry point for the
// database-owned approval chain.
//
// All routing, authorization, stage advancement, balance movement and audit
// live in the Postgres RPCs, so the web app and the Flutter app call the SAME
// functions and neither re-implements any of it. Nothing here decides who
// approves anything.
// ===========================================================================
import { supabase } from '../supabaseClient'
import { rpcWithRetry } from './rpcHelper'

/** Surface the server's own wording; never invent a fallback message. */
function unwrap(data, error) {
  if (error) {
    const raw = error.message || String(error)
    // Postgres prefixes the message with the SQLSTATE; keep the human part.
    const detail = raw.split(/:(.+)/s).slice(1).join(':').trim() || raw
    const err = new Error(detail)
    err.raw = raw
    err.code = (raw.split(':')[0] || '').trim()
    throw err
  }
  return data
}

/** Normalise anything thrown (Postgres, PGRST202, TypeError) to one shape. */
const surface = (err) => {
  if (err instanceof Error) return err
  return new Error(String(err))
}

export const leaveChainService = {
  /**
   * Submit a request. The row and its chain snapshot are written in one
   * transaction server-side, so a request can never exist without a chain.
   * @returns {Promise<{ok, request_id, days, route, config_status, issues}>}
   */
  async submit({ employeeId, leaveType, start, end, reason }) {
    return rpcWithRetry(() => supabase.rpc('submit_leave_request', {
      p_employee_id: employeeId,
      p_leave_type: leaveType || 'annual',
      p_start: start,
      p_end: end,
      p_reason: reason || null,
    }))
  },

  /** The stored snapshot for one request. Never re-resolves. */
  async timeline(requestId) {
    try {
      const { data, error } = await supabase.rpc('get_leave_approval_timeline', {
        p_request_id: requestId,
      })
      return unwrap(data, error)
    } catch (err) {
      throw surface(err)
    }
  },

  /** Which route this employee's request would take (preview only). */
  async previewRoute(employeeId) {
    try {
      const { data, error } = await supabase.rpc('leave_route_for_employee', {
        p_employee_id: employeeId,
      })
      return unwrap(data, error)
    } catch (err) {
      throw surface(err)
    }
  },

  /**
   * Act on the CURRENT stage. Exactly-once server-side: a duplicate call fails
   * the current-stage check rather than advancing or double-deducting.
   *
   * @param action 'approved' | 'rejected' | 'returned'
   * @param dates  optional { start, end, note } to modify the period
   */
  async act({ requestId, action, comment, reason, dates }) {
    return rpcWithRetry(() => supabase.rpc('act_on_leave_stage', {
      p_request_id: requestId,
      p_action: action,
      p_comment: comment || null,
      p_rejection_reason: reason || null,
      p_new_start: dates?.start || null,
      p_new_end: dates?.end || null,
      p_modification_note: dates?.note || null,
    }))
  },

  /** HR assigns an approver to an unassigned stage so a request can resume. */
  async repairStage({ stageId, approverUserId, reason }) {
    return rpcWithRetry(() => supabase.rpc('repair_leave_approval_stage', {
      p_stage_id: stageId,
      p_approver_user_id: approverUserId,
      p_reason: reason,
    }))
  },
}

// --- Presentation helpers (pure, no network) --------------------------------

/** True when HR still has configuration work to do on this request. */
export const isConfigIncomplete = (timeline) => timeline?.config_status === 'incomplete'

/** The one stage a request is waiting on, if any. */
export const currentStage = (timeline) =>
  (timeline?.stages || []).find((s) => s.status === 'current') || null

/** Stages HR must repair before the chain can move. */
export const unassignedStages = (timeline) =>
  (timeline?.stages || []).filter((s) => s.status === 'unassigned')

export const isOverdue = (stage) => Boolean(stage?.sla_breached)

/** Did an approver change the dates? Shows "original vs final". */
export const datesDiffer = (timeline) => {
  if (!timeline) return false
  return timeline.original_start_date !== timeline.start_date
    || timeline.original_end_date !== timeline.end_date
}
