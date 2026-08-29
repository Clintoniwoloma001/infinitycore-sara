import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'

// ------------------------------------------------------------------
// Payroll — periods drive the run; the payroll table holds per-employee
// items computed by the compute_payroll RPC (SECURITY DEFINER).
//
// Workflow on the period: DRAFT → CALCULATED → REVIEW → APPROVED →
// PROCESSED → PAID (backward transitions are not offered in the UI).
// ------------------------------------------------------------------

const TRANSITIONS = {
  calculated: ['draft'],
  review: ['calculated'],
  approved: ['review'],
  processed: ['approved'],
  paid: ['processed', 'approved'],
  cancelled: ['draft', 'calculated', 'review', 'approved', 'processed'],
}

function canTransition(from, to) {
  if (!TRANSITIONS[to]) return false
  return (TRANSITIONS[to] || []).includes(from)
}

export const payrollService = {
  async listPeriods() {
    const { data, error } = await supabase
      .from('payroll_periods')
      .select('*')
      .order('period_label', { ascending: false })
    if (error) throw error
    return data || []
  },

  async createPeriod({ periodLabel, startDate, endDate, notes }) {
    if (!periodLabel) throw new Error('Period label is required.')
    const { data: { user }, error: userError } = await supabase.auth.getUser()
    if (userError) throw userError
    const { data, error } = await supabase
      .from('payroll_periods')
      .insert({
        period_label: periodLabel,
        start_date: startDate || null,
        end_date: endDate || null,
        notes,
        created_by: user?.id,
        status: 'draft',
      })
      .select()
      .single()
    if (error) throw error
    logAction({ action: 'PAYROLL_PERIOD_CREATED', entityType: 'PayrollPeriod', entityId: data.id, details: `Payroll period ${periodLabel} created` })
    return data
  },

  async compute(periodId) {
    const { data, error } = await supabase.rpc('compute_payroll', { p_period_id: periodId })
    if (error) throw error
    return data
  },

  async advance(period, nextStatus) {
    if (period.status !== nextStatus) {
      if (!canTransition(period.status, nextStatus)) {
        throw new Error(`Cannot move a "${period.status}" period to "${nextStatus}".`)
      }
    }
    const { data: { user }, error: userError } = await supabase.auth.getUser()
    if (userError) throw userError
    const patch = { status: nextStatus, updated_at: new Date().toISOString() }
    if (nextStatus === 'approved') {
      patch.approved_by = user?.id
      patch.approved_at = new Date().toISOString()
    }
    if (nextStatus === 'processed') patch.processed_at = new Date().toISOString()
    if (nextStatus === 'paid') patch.paid_at = new Date().toISOString()

    const { data, error } = await supabase
      .from('payroll_periods')
      .update(patch)
      .eq('id', period.id)
      .select()
      .single()
    if (error) throw error

    // Keep the per-employee items in sync at PAID/CANCELLED milestones.
    if (nextStatus === 'paid') {
      await supabase
        .from('payroll')
        .update({ status: 'paid', updated_at: new Date().toISOString() })
        .eq('payroll_period', period.period_label)
        .in('status', ['calculated', 'approved', 'review'])
    }
    if (nextStatus === 'cancelled') {
      await supabase
        .from('payroll')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('payroll_period', period.period_label)
        .in('status', ['calculated', 'approved', 'review', 'draft'])
    }
    logAction({ action: 'PAYROLL_STATUS', entityType: 'PayrollPeriod', entityId: period.id, details: `Period ${period.period_label} → ${nextStatus}` })
    return data
  },

  async itemsForPeriod(periodLabel) {
    const { data, error } = await supabase
      .from('payroll')
      .select('*')
      .eq('payroll_period', periodLabel)
      .order('employee_name', { ascending: true })
    if (error) throw error
    return data || []
  },

  async getConfig() {
    const { data, error } = await supabase
      .from('payroll_config')
      .select('*')
      .eq('id', 1)
      .maybeSingle()
    if (error) throw error
    return data
  },

  async updateConfig(config) {
    const { data: { user }, error: userError } = await supabase.auth.getUser()
    if (userError) throw userError
    const { data, error } = await supabase
      .from('payroll_config')
      .update({ config, updated_by: user?.id, updated_at: new Date().toISOString() })
      .eq('id', 1)
      .select()
      .single()
    if (error) throw error
    logAction({ action: 'PAYROLL_CONFIG_UPDATED', entityType: 'PayrollConfig', entityId: '1', details: 'Payroll calculation settings updated' })
    return data
  },
}

export default payrollService