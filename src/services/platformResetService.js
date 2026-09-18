import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'

// ------------------------------------------------------------------
// Platform Reset Service — Super Admin only.
// Mirrors schema_phase44_platform_reset.sql RPCs. Every RPC re-checks
// the actor role server-side (SECURITY DEFINER), so the UI guard is a
// convenience, not the authority.
// ------------------------------------------------------------------

export const RESET_AREAS = [
  { key: 'attendance', label: 'Attendance', description: 'Clock-in records, events, exceptions, issues, corrections, biometric enrollments and WebAuthn challenges.' },
  { key: 'leave', label: 'Leave', description: 'Leave requests, approvals and balances.' },
  { key: 'onboarding', label: 'Onboarding', description: 'Onboarding submissions, links, corrections, events, guarantor and fidelity bond records and account invites.' },
  { key: 'recruitment', label: 'Recruitment', description: 'Jobs, candidates, interviews, assessments, attempts and offer letters.' },
  { key: 'performance', label: 'Performance', description: 'Appraisals, appraisal periods, performance metrics, results and adjustments.' },
  { key: 'work', label: 'Work & KPIs', description: 'Tasks, task reports, targets, work plans, KPI assignments and submissions.' },
  { key: 'chat', label: 'Chat & Messages', description: 'Chat messages, threads, channels, groups and all message activity (reads, reactions, attachments).' },
  { key: 'notifications', label: 'Notifications', description: 'In-app notification feed.' },
  { key: 'payroll', label: 'Payroll', description: 'Payroll rows, push requests/approvals/events, employment letters and salary packages/snapshots.' },
  { key: 'bankone', label: 'BankOne', description: 'BankOne transactions, import batches/rows and employee BankOne identifiers.' },
  { key: 'medical', label: 'Medical Screening', description: 'Screenings, referrals, amendments, events and medical documents.' },
  { key: 'audit', label: 'Audit Logs', description: 'Platform audit logs and SARA audit logs. Resetting clears the evidence trail.' },
  { key: 'support', label: 'Support', description: 'Support cases.' },
  { key: 'data', label: 'Data & Imports', description: 'Import jobs/records/batches, data quality and hierarchy exceptions, org reassignment history and integration sync data.' },
  { key: 'banking', label: 'Banking', description: 'Loan applications, loans, repayments, transaction relationships/history and reconciliation cases. Customer master records are kept.' },
]

const DELETE_ENTITIES = [
  { key: 'attendance_record', label: 'Attendance record' },
  { key: 'attendance_event', label: 'Attendance event' },
  { key: 'attendance_exception', label: 'Attendance exception (late reason)' },
  { key: 'attendance_issue', label: 'Attendance issue' },
  { key: 'leave_request', label: 'Leave request' },
  { key: 'onboarding_submission', label: 'Onboarding submission' },
  { key: 'onboarding_correction', label: 'Onboarding correction' },
  { key: 'guarantor_verification', label: 'Guarantor verification' },
  { key: 'fidelity_verification', label: 'Fidelity bond verification' },
  { key: 'chat_message', label: 'Chat message' },
  { key: 'notification', label: 'Notification' },
  { key: 'kpi_submission', label: 'KPI submission' },
  { key: 'task_report', label: 'Task progress report' },
  { key: 'work_plan', label: 'Work plan' },
  { key: 'payroll_row', label: 'Payroll row' },
  { key: 'employment_letter', label: 'Employment letter' },
  { key: 'medical_screening', label: 'Medical screening' },
  { key: 'audit_log', label: 'Audit log entry' },
  { key: 'bankone_transaction', label: 'BankOne transaction' },
  { key: 'loan_application', label: 'Loan application' },
  { key: 'loan', label: 'Loan' },
  { key: 'repayment', label: 'Repayment' },
  { key: 'support_case', label: 'Support case' },
  { key: 'customer', label: 'Customer record' },
]

export const platformResetService = {
  RESET_AREAS,
  DELETE_ENTITIES,

  async getCounts(areas = RESET_AREAS.map((a) => a.key)) {
    const { data, error } = await supabase.rpc('platform_reset_counts', { p_areas: areas })
    if (error) throw error
    return data || { areas: {}, total: 0 }
  },

  async resetAreas(areas) {
    const { data, error } = await supabase.rpc('platform_reset_areas', { p_areas: areas })
    if (error) throw error
    logAction({
      action: 'PLATFORM_RESET_AREAS',
      entityType: 'Platform',
      details: `Reset areas: ${areas.join(', ')} — ${data?.removed ?? 0} rows removed`,
      severity: 'high',
    })
    return data
  },

  async resetAll() {
    const { data, error } = await supabase.rpc('platform_reset_all')
    if (error) throw error
    logAction({
      action: 'PLATFORM_RESET_FULL',
      entityType: 'Platform',
      details: `Full platform reset — ${data?.removed ?? 0} rows removed`,
      severity: 'high',
    })
    return data
  },

  async deleteRecord(entity, id) {
    const { data, error } = await supabase.rpc('platform_delete_record', { p_entity: entity, p_id: id })
    if (error) throw error
    logAction({
      action: 'PLATFORM_RECORD_DELETE',
      entityType: entity,
      entityId: String(id),
      details: `Deleted ${entity} record ${id}`,
      severity: 'high',
    })
    return data
  },
}

export default platformResetService