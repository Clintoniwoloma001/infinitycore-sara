// ============================================================================
// Audit department + Automation Command Centre (Phase 71)
// ============================================================================
// Every call is a SECURITY DEFINER RPC. The Audit register, the findings
// workflow, the derived automation percentages and the reminder jobs all live
// in Postgres, so the browser cannot invent a completion percentage or a
// closed finding.
import { supabase } from '../supabaseClient'

const unwrap = (data, error, fallback) => {
  if (error) {
    const message = error.message || String(error)
    const detail = message.split(/:(.+)/s).slice(1).join(':').trim() || message
    const err = new Error(detail)
    err.raw = message
    err.code = (message.split(':')[0] || '').trim()
    throw err
  }
  return data ?? fallback
}

export const auditService = {
  // ---- Regulatory monitoring -------------------------------------------
  async listRegulatory({ status = null, ownerId = null } = {}) {
    const { data, error } = await supabase.rpc('list_regulatory_items', {
      p_status: status, p_owner_id: ownerId,
    })
    return unwrap(data, error, { items: [], summary: {} })
  },

  async saveRegulatory(item) {
    const { data, error } = await supabase.rpc('upsert_regulatory_item', {
      p_id: item.id ?? null,
      p_name: item.name,
      p_due_date: item.dueDate,
      p_process_owner_employee_id: item.processOwnerEmployeeId || null,
      p_lead_time_days: item.leadTimeDays ?? 14,
      p_status: item.status ?? 'pending',
      p_description: item.description || null,
      p_filed_reference: item.filedReference || null,
      p_notes: item.notes || null,
    })
    return unwrap(data, error, {})
  },

  // ---- Findings --------------------------------------------------------
  async listFindings({ status = null, ownerId = null, department = null } = {}) {
    const { data, error } = await supabase.rpc('list_audit_findings', {
      p_status: status, p_owner_id: ownerId, p_department: department,
    })
    return unwrap(data, error, { findings: [], summary: {} })
  },

  async createFinding(f) {
    const { data, error } = await supabase.rpc('create_audit_finding', {
      p_title: f.title,
      p_process_owner_employee_id: f.processOwnerEmployeeId || null,
      p_department: f.department || null,
      p_severity: f.severity ?? 'medium',
      p_description: f.description || null,
      p_due_date: f.dueDate || null,
      p_reference: f.reference || null,
    })
    return unwrap(data, error, {})
  },

  async advanceFinding(id, toStatus, closeoutNotes = null) {
    const { data, error } = await supabase.rpc('advance_audit_finding', {
      p_finding_id: id, p_to_status: toStatus, p_closeout_notes: closeoutNotes,
    })
    return unwrap(data, error, {})
  },

  // ---- Automation Command Centre --------------------------------------
  async portfolio() {
    const { data, error } = await supabase.rpc('get_automation_portfolio')
    return unwrap(data, error, { departments: [], items: [], active_workflows: [] })
  },

  async setItemStatus(itemKey, status, note = null) {
    const { data, error } = await supabase.rpc('set_automation_item_status', {
      p_item_key: itemKey, p_status: status, p_note: note,
    })
    return unwrap(data, error, {})
  },

  // ---- Phase 72: the three audit workspaces ----------------------------
  //
  // All three are SECURITY DEFINER RPCs that decide the caller's audience
  // THEMSELVES: get_audit_command_center() refuses anyone who is not the Head
  // of Audit, get_my_department_audit() reads the caller's OWN department from
  // their profiles row, and get_audit_workspace() requires audit department
  // membership. The navigation menu only decides what is offered; these RPCs
  // are what actually refuse the request.
  async commandCenter() {
    const { data, error } = await supabase.rpc('get_audit_command_center')
    return unwrap(data, error, {})
  },

  async myDepartmentAudit() {
    const { data, error } = await supabase.rpc('get_my_department_audit')
    return unwrap(data, error, {})
  },

  // The obligation register - the imported source data plus the reminder /
  // escalation configuration. Restricted to Head of Audit command-centre
  // readers by the RPC itself.
  async obligationRegister(status = null) {
    const { data, error } = await supabase.rpc('get_audit_obligation_register', {
      p_status: status,
    })
    return unwrap(data, error, { obligations: [], summary: {} })
  },

  async activateObligation(obligationId, status) {
    // Validation gate: an obligation leaves 'draft' only when a Head of Audit
    // confirms the statutory deadline, so imported historical dates never go
    // live unverified.
    const { data, error } = await supabase.rpc('set_audit_obligation_status', {
      p_obligation_id: obligationId, p_status: status,
    })
    return unwrap(data, error, {})
  },

  async runReminderSweep() {
    const { data, error } = await supabase.rpc('audit_obligation_reminder_sweep')
    return unwrap(data, error, {})
  },

  // ---- Phase 73: the canonical obligation read model ----------------------
  //
  // audit_obligation_states() is the ONE derived rollup (assignment count,
  // completion %, outstanding persons, SLA state, board lifecycle). It is not
  // executable by a browser: get_audit_obligation_overview() is the scoped,
  // audited gate in front of it, and get_audit_workspace() uses the same
  // rollup internally, so every screen reports the same numbers.
  async obligationOverview(status = null) {
    const { data, error } = await supabase.rpc('get_audit_obligation_overview', {
      p_status: status,
    })
    return unwrap(data, error, { obligations: [], summary: {} })
  },

  async workspace() {
    const { data, error } = await supabase.rpc('get_audit_workspace')
    return unwrap(data, error, {})
  },

  async slaSnapshot() {
    const { data, error } = await supabase.rpc('audit_sla_snapshot')
    return unwrap(data, error, {})
  },

  // ---- Phase 72: obligation writes --------------------------------------
  async createObligation(f) {
    const { data, error } = await supabase.rpc('create_audit_obligation', {
      p_reference: f.reference,
      p_title: f.title,
      p_description: f.description || null,
      p_instructions: f.instructions || null,
      p_obligation_type: f.obligationType || 'regulatory_return',
      p_department: f.department || 'audit',
      p_accountable_owner_user_id: f.accountableOwnerId || null,
      p_reporting_period: f.reportingPeriod || null,
      p_source_document: f.sourceDocument || null,
      p_source_reference: f.sourceReference || null,
      p_issue_date: f.issueDate || null,
      p_acknowledgement_deadline: f.acknowledgementDeadline || null,
      p_submission_deadline: f.submissionDeadline || null,
      p_review_deadline: f.reviewDeadline || null,
      p_priority: f.priority || 'medium',
      p_risk_rating: f.riskRating || 'medium',
      p_requires_acknowledgement: f.requiresAcknowledgement !== false,
      p_requires_submission: f.requiresSubmission !== false,
      p_required_documents: f.requiredDocuments || [],
      p_recurrence_rule: f.recurrenceRule || null,
    })
    return unwrap(data, error, {})
  },

  // ---- Phase 72c: obligation edits + status actions ----------------------
  //
  // update_audit_obligation is the single write path for editing an obligation
  // and (optionally) moving its status in the SAME call, so the Command
  // Centre's Activate saves the Head of Audit's edits and activates as one
  // decision rather than two. Every field is optional: a null means "leave
  // this alone", which is what lets Pause / Send back / Delete send nothing
  // but p_status.
  //
  // The status values below are the ones the obligations table ALREADY carries
  // ('draft','active','paused','archived','closed') - none is invented here.
  // "Send back" intentionally reuses 'draft', which the register already
  // displays as "Awaiting validation", and "Delete" reuses 'archived' rather
  // than a hard delete that would cascade away the assignments and
  // submissions.
  async updateObligation(obligationId, fields = {}) {
    const f = fields || {}
    const { data, error } = await supabase.rpc('update_audit_obligation', {
      p_obligation_id: obligationId,
      p_reference: f.reference ?? null,
      p_title: f.title ?? null,
      p_description: f.description ?? null,
      p_instructions: f.instructions ?? null,
      p_obligation_type: f.obligationType ?? null,
      p_department: f.department ?? null,
      p_accountable_owner_user_id: f.accountableOwnerId ?? null,
      p_reporting_period: f.reportingPeriod ?? null,
      p_source_document: f.sourceDocument ?? null,
      p_source_reference: f.sourceReference ?? null,
      p_issue_date: f.issueDate ?? null,
      p_acknowledgement_deadline: f.acknowledgementDeadline ?? null,
      p_submission_deadline: f.submissionDeadline ?? null,
      p_review_deadline: f.reviewDeadline ?? null,
      p_priority: f.priority ?? null,
      p_risk_rating: f.riskRating ?? null,
      p_requires_acknowledgement: f.requiresAcknowledgement ?? null,
      p_requires_submission: f.requiresSubmission ?? null,
      p_required_documents: f.requiredDocuments ?? null,
      p_recurrence_rule: f.recurrenceRule ?? null,
      p_next_occurrence: f.nextOccurrence ?? null,
      p_reminder_lead_days: f.reminderLeadDays ?? null,
      p_reminder_interval_days: f.reminderIntervalDays ?? null,
      p_escalation_role: f.escalationRole ?? null,
      p_escalation_delay_days: f.escalationDelayDays ?? null,
      p_status: f.status ?? null,
    })
    return unwrap(data, error, {})
  },

  async issueObligation(obligationId, userId, acknowledgementDeadline, submissionDeadline) {
    const { data, error } = await supabase.rpc('issue_audit_obligation', {
      p_obligation_id: obligationId,
      p_assigned_user_id: userId,
      p_acknowledgement_deadline: acknowledgementDeadline || null,
      p_submission_deadline: submissionDeadline || null,
    })
    return unwrap(data, error, {})
  },

  // Issue ONE obligation to SEVERAL responsible persons in a single atomic
  // call. Re-issuing the same people is a no-op (on conflict do nothing), so a
  // retry can never duplicate an assignment or reset someone's live progress.
  async assignObligationUsers(obligationId, userIds, acknowledgementDeadline, submissionDeadline) {
    const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean)
    const { data, error } = await supabase.rpc('audit_assign_obligation_users', {
      p_obligation_id: obligationId,
      p_user_ids: ids,
      p_acknowledgement_deadline: acknowledgementDeadline || null,
      p_submission_deadline: submissionDeadline || null,
    })
    return unwrap(data, error, {})
  },

  async acknowledgeAssignment(assignmentId) {
    const { data, error } = await supabase.rpc('acknowledge_audit_obligation', {
      p_assignment_id: assignmentId,
    })
    return unwrap(data, error, {})
  },

  async submitResponse(assignmentId, { payload = {}, files = [], isFinal = true } = {}) {
    const { data, error } = await supabase.rpc('submit_audit_response', {
      p_assignment_id: assignmentId,
      p_payload: payload,
      p_files: files,
      p_is_final: isFinal,
    })
    return unwrap(data, error, {})
  },

  async reviewSubmission(submissionId, decision, correctionReason = null, fields = []) {
    const { data, error } = await supabase.rpc('review_audit_submission', {
      p_submission_id: submissionId,
      p_decision: decision,
      p_correction_reason: correctionReason,
      p_correction_fields: fields,
    })
    return unwrap(data, error, {})
  },

  // ---- Phase 73: live refresh ---------------------------------------------
  //
  // Every screen renders SERVER state, so a card moves when the ROWS move -
  // never from optimistic local state. One channel per component, coalesced to
  // a single refetch per burst, and removed on unmount so a closed page cannot
  // keep a subscription open.
  //
  // RLS still applies to realtime delivery, so a caller only receives the
  // changes their policies already permit; this narrows nothing and widens
  // nothing.
  subscribeToObligationChanges(onChange, { debounceMs = 250 } = {}) {
    if (typeof onChange !== 'function') return () => {}
    let pending = null
    const fire = () => {
      pending = null
      onChange()
    }
    const schedule = () => {
      if (pending !== null) return
      pending = setTimeout(fire, debounceMs)
    }
    let channel = null
    try {
      channel = supabase
        .channel('audit-obligations-live')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'audit_obligations' }, schedule)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'audit_obligation_assignments' }, schedule)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'audit_submissions' }, schedule)
        .subscribe()
    } catch {
      return () => {}
    }
    return () => {
      if (pending !== null) clearTimeout(pending)
      pending = null
      try { supabase.removeChannel(channel) } catch { /* already gone */ }
    }
  },
}

export const REGULATORY_STATUS = {
  advance: { label: 'Advance', chip: 'bg-sky-100 text-sky-800' },
  pending: { label: 'Pending', chip: 'bg-amber-100 text-amber-800' },
  outstanding: { label: 'Outstanding', chip: 'bg-red-100 text-red-800' },
  filed: { label: 'Filed', chip: 'bg-emerald-100 text-emerald-800' },
}

export const FINDING_STATUS = {
  open: { label: 'Open', chip: 'bg-red-100 text-red-800', order: 1 },
  in_progress: { label: 'In Progress', chip: 'bg-amber-100 text-amber-800', order: 2 },
  pending_closeout: { label: 'Pending Closeout', chip: 'bg-sky-100 text-sky-800', order: 3 },
  closed: { label: 'Closed', chip: 'bg-emerald-100 text-emerald-800', order: 4 },
}

// Assignment lifecycle (audit_obligation_assignments.status). Mirrors the
// database CHECK constraint exactly.
export const ASSIGNMENT_STATUS = {
  not_started: { label: 'Not started', chip: 'bg-slate-100 text-slate-600' },
  acknowledged: { label: 'Acknowledged', chip: 'bg-sky-100 text-sky-800' },
  submitted: { label: 'Submitted', chip: 'bg-indigo-100 text-indigo-800' },
  under_review: { label: 'Under review', chip: 'bg-amber-100 text-amber-800' },
  returned_for_correction: { label: 'Returned for correction', chip: 'bg-orange-100 text-orange-800' },
  resubmitted: { label: 'Resubmitted', chip: 'bg-indigo-100 text-indigo-800' },
  accepted: { label: 'Accepted', chip: 'bg-emerald-100 text-emerald-800' },
  closed: { label: 'Closed', chip: 'bg-emerald-100 text-emerald-800' },
  rejected: { label: 'Rejected', chip: 'bg-red-100 text-red-800' },
}

// SLA states, all derived server-side (never computed in the browser, so the
// UI, the reminder job and the Command Centre cannot disagree).
export const SLA_STATE = {
  closed: { label: 'Closed', chip: 'bg-emerald-100 text-emerald-800' },
  not_due: { label: 'Not due', chip: 'bg-slate-100 text-slate-600' },
  not_issued: { label: 'Awaiting issue', chip: 'bg-slate-50 text-slate-500 ring-1 ring-slate-200' },
  overdue: { label: 'Overdue', chip: 'bg-red-100 text-red-800' },
  due_today: { label: 'Due today', chip: 'bg-amber-100 text-amber-800' },
  due_soon: { label: 'Due soon', chip: 'bg-amber-50 text-amber-700' },
  upcoming: { label: 'Upcoming', chip: 'bg-slate-100 text-slate-600' },
}

export const SUBMISSION_STATUS = {
  draft: { label: 'Draft', chip: 'bg-slate-100 text-slate-600' },
  submitted: { label: 'Submitted', chip: 'bg-indigo-100 text-indigo-800' },
  under_review: { label: 'Under review', chip: 'bg-amber-100 text-amber-800' },
  returned_for_correction: { label: 'Returned for correction', chip: 'bg-orange-100 text-orange-800' },
  resubmitted: { label: 'Resubmitted', chip: 'bg-indigo-100 text-indigo-800' },
  accepted: { label: 'Accepted', chip: 'bg-emerald-100 text-emerald-800' },
  closed: { label: 'Closed', chip: 'bg-emerald-100 text-emerald-800' },
  rejected: { label: 'Rejected', chip: 'bg-red-100 text-red-800' },
}

export const OBLIGATION_TYPE = {
  audit_finding: 'Audit finding',
  regulatory_return: 'Regulatory return',
  regulatory_circular: 'Regulatory circular',
  compliance_declaration: 'Compliance declaration',
  evidence_request: 'Evidence request',
  corrective_action: 'Corrective action',
  custom: 'Custom',
}

export const AUTOMATION_STATUS = {
  not_started: { label: 'Not Started', chip: 'bg-slate-100 text-slate-600' },
  in_progress: { label: 'In Progress', chip: 'bg-amber-100 text-amber-800' },
  live: { label: 'Live', chip: 'bg-emerald-100 text-emerald-800' },
}

const fmtDate = (d) => (d
  ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric',
  })
  : '—')

export { fmtDate }
