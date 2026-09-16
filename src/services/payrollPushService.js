import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'
import { downloadCsv, downloadExcel } from '../lib/csv'

// ------------------------------------------------------------------
// Payroll → BankOne.
//
// Reuses the existing payroll engine (payroll / payroll_periods /
// payroll_config / compute_payroll) and the Phase 15 BankOne integration
// (integration_connections / integration_outbound_queue). This service only
// orchestrates the payroll-specific request → signature → HR approval →
// BankOne push chain; every privileged step is validated server-side by the
// phase33 RPCs.
// ------------------------------------------------------------------

export const PUSH_STATUS = {
  draft: { label: 'Draft', color: 'slate' },
  calculated: { label: 'Calculated', color: 'blue' },
  pending_hr_approval: { label: 'Pending HR Approval', color: 'amber' },
  approved: { label: 'Approved', color: 'emerald' },
  sent_to_bankone: { label: 'Sent to BankOne', color: 'violet' },
  confirmed: { label: 'Confirmed', color: 'emerald' },
  rejected: { label: 'Rejected', color: 'rose' },
  correction_required: { label: 'Correction Required', color: 'rose' },
  cancelled: { label: 'Cancelled', color: 'slate' },
}

function newKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `push-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

// BankOne manual-upload column mapping. Only payroll-authorised fields.
export const BANKONE_COLUMNS = [
  { key: 'staff_identifier', label: 'Staff ID' },
  { key: 'employee_name', label: 'Employee Name' },
  { key: 'bank_name', label: 'Bank Name' },
  { key: 'account_name', label: 'Account Name' },
  { key: 'account_number', label: 'Account Number' },
  { key: 'bank_sort_code', label: 'Sort Code' },
  { key: 'amount', label: 'Amount' },
  { key: 'period_label', label: 'Period' },
  { key: 'narration', label: 'Narration' },
]

export function masterToBankOneRows(master, periodLabel) {
  return (master || []).map((m) => ({
    staff_identifier: m.employee_code || '',
    employee_name: m.employee_name,
    bank_name: m.bank_name || '',
    account_name: m.account_name || m.employee_name,
    account_number: m.account_number || '',
    bank_sort_code: m.bank_sort_code || '',
    amount: Number(m.salary || 0) + Number(m.allowances || 0),
    period_label: periodLabel || '',
    narration: `Salary ${periodLabel || ''}`.trim(),
  }))
}

export function calculationToBankOneRows(calculation, periodLabel) {
  const employees = calculation?.employees || []
  return employees.map((e) => ({
    staff_identifier: e.employee_id ? String(e.employee_id).slice(0, 8) : '',
    employee_name: e.employee_name,
    bank_name: '',
    account_name: e.employee_name,
    account_number: '',
    bank_sort_code: '',
    amount: e.net_pay,
    period_label: periodLabel || calculation?.period_label || '',
    narration: `Salary ${periodLabel || ''}`.trim(),
  }))
}

export const payrollPushService = {
  async configState() {
    const { data, error } = await supabase.rpc('payroll_bankone_config_state')
    if (error) throw error
    return data || { state: 'NOT_CONFIGURED' }
  },

  async listMaster() {
    const { data, error } = await supabase.rpc('list_payroll_master')
    if (error) throw error
    return data || []
  },

  async preview(periodLabel) {
    const { data, error } = await supabase.rpc('preview_payroll_push', { p_period_label: periodLabel })
    if (error) throw error
    return data
  },

  async createRequest(periodLabel) {
    const key = newKey()
    const { data, error } = await supabase.rpc('create_payroll_push_request', {
      p_period_label: periodLabel,
      p_idempotency_key: key,
    })
    if (error) throw error
    await logAction({ action: 'PAYROLL_PUSH_CREATED', entityType: 'PayrollPushRequest', entityId: data?.id, details: `Payroll push prepared for ${periodLabel}` }).catch(() => {})
    return data
  },

  async submit(requestId, signature) {
    const { data, error } = await supabase.rpc('submit_payroll_push_request', { p_request_id: requestId, p_signature: signature })
    if (error) throw error
    return data
  },

  async approve(requestId, signature) {
    const { data, error } = await supabase.rpc('approve_payroll_push_request', { p_request_id: requestId, p_signature: signature })
    if (error) throw error
    return data
  },

  async reject(requestId, reason) {
    const { data, error } = await supabase.rpc('reject_payroll_push_request', { p_request_id: requestId, p_reason: reason })
    if (error) throw error
    return data
  },

  async resubmit(requestId, signature) {
    const { data, error } = await supabase.rpc('resubmit_payroll_push_request', { p_request_id: requestId, p_signature: signature })
    if (error) throw error
    return data
  },

  async send(requestId) {
    const { data, error } = await supabase.rpc('send_payroll_push_to_bankone', { p_request_id: requestId })
    if (error) throw error
    return data
  },

  async listRequests() {
    const { data, error } = await supabase
      .from('payroll_push_requests')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async getRequest(requestId) {
    const { data, error } = await supabase
      .from('payroll_push_requests')
      .select('*')
      .eq('id', requestId)
      .maybeSingle()
    if (error) throw error
    return data || null
  },

  async listApprovals(requestId) {
    const { data, error } = await supabase
      .from('payroll_push_approvals')
      .select('*')
      .eq('request_id', requestId)
      .order('created_at', { ascending: true })
    if (error) throw error
    return data || []
  },

  async listEvents(requestId) {
    const { data, error } = await supabase
      .from('payroll_push_events')
      .select('*')
      .eq('request_id', requestId)
      .order('created_at', { ascending: true })
    if (error) throw error
    return data || []
  },

  downloadMasterCsv(master, periodLabel) {
    downloadCsv(`payroll-master-${periodLabel || 'all'}.csv`, masterToBankOneRows(master, periodLabel), BANKONE_COLUMNS)
  },
  downloadMasterExcel(master, periodLabel) {
    downloadExcel(`payroll-master-${periodLabel || 'all'}.xls`, masterToBankOneRows(master, periodLabel), BANKONE_COLUMNS)
  },
  downloadPushCsv(request) {
    const rows = calculationToBankOneRows(request?.calculation, request?.period_label)
    downloadCsv(`bankone-payroll-${request?.period_label || 'request'}.csv`, rows, BANKONE_COLUMNS)
  },
  downloadPushExcel(request) {
    const rows = calculationToBankOneRows(request?.calculation, request?.period_label)
    downloadExcel(`bankone-payroll-${request?.period_label || 'request'}.xls`, rows, BANKONE_COLUMNS)
  },
}

export default payrollPushService
