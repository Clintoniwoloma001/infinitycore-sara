import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'

export const appraisalService = {
  async list() {
    const { data, error } = await supabase
      .from('employee_appraisals')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async listForEmployee(employeeId) {
    const { data, error } = await supabase
      .from('employee_appraisals')
      .select('*')
      .eq('employee_id', employeeId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async create(payload) {
    const { data, error } = await supabase
      .from('employee_appraisals')
      .insert(payload)
      .select()
      .single()
    if (error) throw error
    logAction({ action: 'APPRAISAL_CREATED', entityType: 'Appraisal', entityId: data.id, details: `Appraisal created for ${payload.employee_name || 'employee'}` })
    return data
  },

  async update(id, updates) {
    const { data, error } = await supabase
      .from('employee_appraisals')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    logAction({ action: 'APPRAISAL_UPDATED', entityType: 'Appraisal', entityId: id, details: 'Appraisal updated' })
    return data
  },
}

export default appraisalService
