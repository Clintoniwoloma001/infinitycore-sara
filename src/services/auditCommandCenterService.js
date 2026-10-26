import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'

const unwrap = (data, error, fallback) => {
  if (error) {
    const message = error.message || String(error)
    const detail = message.split(/:(.+)/s).slice(1).join(':').trim() || message
    const err = new Error(detail)
    err.raw = message
    throw err
  }
  return data ?? fallback
}

export const auditCommandCenterService = {
  async listCycles() {
    const { data, error } = await supabase.rpc('list_audit_cycles')
    return unwrap(data, error, [])
  },

  async listAssignees(cycleId) {
    const { data, error } = await supabase.rpc('list_audit_command_center_assignees', {
      p_cycle_id: cycleId,
    })
    return unwrap(data, error, { assignees: [] })
  },

  // Request more info: required message; status becomes info_requested.
  // Server sends email + in-app notification; a response returns status to submitted.
  async requestMoreInfo({ assigneeId, message }) {
    if (!message || !message.trim()) throw new Error('A message is required to request more info.')
    const { data, error } = await supabase.rpc('request_audit_more_info', {
      p_assignee_id: assigneeId,
      p_message: message.trim(),
    })
    const res = unwrap(data, error, {})
    logAction({ action: 'AUDIT_INFO_REQUESTED', entityType: 'AuditAssignee', entityId: assigneeId, details: message.trim() })
    return res
  },

  async markPersonCompleted(assigneeId) {
    const { data, error } = await supabase.rpc('mark_audit_person_completed', { p_assignee_id: assigneeId })
    return unwrap(data, error, {})
  },

  async reopen(assigneeId) {
    const { data, error } = await supabase.rpc('reopen_audit_assignee', { p_assignee_id: assigneeId })
    return unwrap(data, error, {})
  },

  async markDepartmentCompleted({ cycleId, department }) {
    const { data, error } = await supabase.rpc('mark_audit_department_completed', {
      p_cycle_id: cycleId, p_department: department,
    })
    return unwrap(data, error, {})
  },

  // Mark cycle completed when all assignees are completed, or with a logged override reason.
  async markCycleCompleted({ cycleId, overrideReason = null }) {
    const { data, error } = await supabase.rpc('mark_audit_cycle_completed', {
      p_cycle_id: cycleId, p_override_reason: overrideReason,
    })
    return unwrap(data, error, {})
  },

  async rolloverNextCycle(cycleId) {
    const { data, error } = await supabase.rpc('rollover_audit_cycle', { p_cycle_id: cycleId })
    return unwrap(data, error, {})
  },

  async listUnmatchedReplies(cycleId) {
    const { data, error } = await supabase.rpc('list_audit_unmatched_replies', { p_cycle_id: cycleId })
    return unwrap(data, error, { replies: [] })
  },

  async getThread(assigneeId) {
    const { data, error } = await supabase.rpc('get_audit_assignee_thread', { p_assignee_id: assigneeId })
    return unwrap(data, error, { messages: [] })
  },

  async getSignedUrl(filePath, expiresIn = 3600) {
    if (!filePath) return null
    const { data, error } = await supabase.storage.from('documents').createSignedUrl(filePath, expiresIn)
    if (error) throw error
    return data?.signedUrl || null
  },
}

export default auditCommandCenterService
