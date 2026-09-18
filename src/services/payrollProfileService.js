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
}

export default payrollProfileService