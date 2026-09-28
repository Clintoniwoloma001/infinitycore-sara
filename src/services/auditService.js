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
