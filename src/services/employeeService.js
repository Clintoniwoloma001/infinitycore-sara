import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'

// ------------------------------------------------------------------
// Employee profiles — core record plus the phase-6 child tables
// (education, work history, guarantors, fidelity bonds).
// ------------------------------------------------------------------

const CHILD_TABLES = ['employee_education', 'employee_work_history', 'employee_guarantors', 'employee_fidelity_bonds']

export const employeeService = {
  async list() {
    const { data, error } = await supabase
      .from('employees')
      .select('*')
      .order('full_name', { ascending: true })
    if (error) throw error
    return data || []
  },

  async getById(id) {
    const { data, error } = await supabase
      .from('employees')
      .select('*')
      .eq('id', id)
      .single()
    if (error) throw error
    return data
  },

  async update(employeeId, payload) {
    const { data, error } = await supabase
      .from('employees')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', employeeId)
      .select()
      .single()
    if (error) throw error
    logAction({ action: 'EMPLOYEE_UPDATED', entityType: 'Employee', entityId: employeeId, details: 'Employee profile updated' })
    return data
  },

  async childTable(name) {
    if (!CHILD_TABLES.includes(name)) throw new Error(`Unknown child table ${name}`)
    const { data, error } = await supabase.from(name).select('*').order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async addChild(table, employeeId, payload) {
    const { data, error } = await supabase
      .from(table)
      .insert({ ...payload, employee_id: employeeId, source: 'manual' })
      .select()
      .single()
    if (error) throw error
    return data
  },

  async removeChild(table, id) {
    const { error } = await supabase.from(table).delete().eq('id', id)
    if (error) throw error
  },

  async listChildrenForEmployee(employeeId) {
    const result = {}
    for (const t of CHILD_TABLES) {
      const { data, error } = await supabase
        .from(t)
        .select('*')
        .eq('employee_id', employeeId)
        .order('created_at', { ascending: false })
      if (!error) result[t] = data || []
      else result[t] = []
    }
    return result
  },
}

export default employeeService