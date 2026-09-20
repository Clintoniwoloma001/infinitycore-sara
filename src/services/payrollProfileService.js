import { supabase } from '../supabaseClient'

// ------------------------------------------------------------------
// Payroll profile service — salary components, employee packages and
// the monthly breakdown engine (pension + consolidated relief + PAYE
// bands, matching compute_payroll semantics).
//
// All writes are SECURITY DEFINER RPCs; reads are RLS-guarded rows.
// employees.salary is the MONTHLY gross (annual = x12).
// ------------------------------------------------------------------

export const payrollProfileService = {
  // ---- Components --------------------------------------------------------

  async listComponents() {
    const { data, error } = await supabase.from('payroll_salary_components').select('*').order('name', { ascending: true })
    if (error) throw error
    return data || []
  },

  async upsertComponent(comp) {
    const { data, error } = await supabase.rpc('upsert_salary_component', {
      p_comp: {
        name: comp.name || '',
        component_type: comp.component_type || 'allowance',
        basis: comp.basis || 'percentage',
        rate: Number(comp.rate || 0),
        taxable: comp.taxable !== undefined ? !!comp.taxable : true,
        recurring: comp.recurring !== undefined ? !!comp.recurring : true,
        payment_schedule: comp.payment_schedule || 'both',
        category: comp.category || 'other',
        active: comp.active !== undefined ? !!comp.active : true,
      },
    })
    if (error) throw error
    return data
  },

  async setComponentActive(componentId, active) {
    const { data, error } = await supabase
      .from('payroll_salary_components')
      .update({ active, updated_at: new Date().toISOString() })
      .eq('id', componentId)
      .select()
      .single()
    if (error) throw error
    return data
  },

  // ---- Employee packages -------------------------------------------------

  async listPackages(employeeId) {
    const { data, error } = await supabase
      .from('employee_salary_packages')
      .select('*, payroll_salary_components(name, component_type, basis, taxable, payment_schedule, category)')
      .eq('employee_id', employeeId)
      .order('created_at', { ascending: true })
    if (error) throw error
    return data || []
  },

  async assignComponent(employeeId, componentId, amount = null, rate = null) {
    const { data, error } = await supabase.rpc('assign_employee_salary_component', {
      p_employee_id: employeeId,
      p_component_id: componentId,
      p_amount: amount != null ? Number(amount) : null,
      p_rate: rate != null ? Number(rate) : null,
    })
    if (error) throw error
    return data
  },

  async removeComponent(employeeId, componentId) {
    const { data, error } = await supabase.rpc('remove_employee_salary_component', {
      p_employee_id: employeeId,
      p_component_id: componentId,
    })
    if (error) throw error
    return data
  },

  // ---- Breakdown + snapshots --------------------------------------------

  async calculateBreakdown(employeeId, periodLabel = null) {
    const { data, error } = await supabase.rpc('calculate_employee_salary_breakdown', {
      p_employee_id: employeeId,
      p_period_label: periodLabel,
    })
    if (error) throw error
    return data // { ok, employee_id, period_label, breakdown }
  },

  async listSnapshots(employeeId) {
    const { data, error } = await supabase
      .from('employee_salary_snapshots')
      .select('*')
      .eq('employee_id', employeeId)
      .order('calc_timestamp', { ascending: false })
    if (error) throw error
    return data || []
  },

  // ---- Payroll Master compensation (Phase 63) -----------------------------

  // Single-call bundle used by the Payroll Master editor and the
  // Employee 360 Payroll tab. Returns basic + active packages + CURRENT
  // snapshot from one SECURITY DEFINER RPC.
  async getEmployeeCompensation(employeeId) {
    const { data, error } = await supabase.rpc('get_employee_compensation', {
      p_employee_id: employeeId,
    })
    if (error) throw error
    return data
  },

  // Save compensation. Server-side only (super_admin/admin/hr_manager),
  // reason required, audited to audit_logs. Inputs:
  //   basic        – monthly basic salary
  //   allowances   – [{ name?, component_id?, category?, amount }]
  //   deductions   – [{ name?, component_id?, amount }]
  //   reason       – required (>= 5 chars)
  async upsertEmployeeCompensation({ employeeId, basic, allowances = [], deductions = [], reason = '' }) {
    const { data, error } = await supabase.rpc('upsert_employee_compensation', {
      p_employee_id: employeeId,
      p_basic: Number(basic || 0),
      p_allowances: allowances,
      p_deductions: deductions,
      p_reason: reason,
    })
    if (error) throw error
    return data // { ok, employee_id, period_label, breakdown }
  },

  // Derived-totals preview, NO writes. Mirrors the exact breakdown the
  // saved compensation will persist (shared _salary_breakdown engine).
  async previewCompensation({ employeeId, basic, allowances = [], deductions = [] }) {
    const { data, error } = await supabase.rpc('preview_employee_compensation', {
      p_employee_id: employeeId,
      p_basic: Number(basic || 0),
      p_allowances: allowances,
      p_deductions: deductions,
    })
    if (error) throw error
    return data.breakdown || data
  },
}

export default payrollProfileService