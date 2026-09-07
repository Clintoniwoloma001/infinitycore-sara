import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'

export const hrQueryService = {
  async list() {
    const { data, error } = await supabase
      .from('hr_queries')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async listForEmployee(employeeId) {
    const { data, error } = await supabase
      .from('hr_queries')
      .select('*')
      .eq('employee_id', employeeId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async create(payload) {
    const { data, error } = await supabase
      .from('hr_queries')
      .insert({
        ...payload,
        status: payload.status || 'ISSUED',
        issued_at: payload.status === 'ISSUED' || !payload.status ? new Date().toISOString() : null,
      })
      .select()
      .single()
    if (error) throw error
    logAction({ action: 'HR_QUERY_CREATED', entityType: 'HRQuery', entityId: data.id, details: `Query "${payload.query_title}" created for ${payload.employee_name || 'employee'}` })
    return data
  },

  async update(id, updates) {
    const { data, error } = await supabase
      .from('hr_queries')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    logAction({ action: 'HR_QUERY_UPDATED', entityType: 'HRQuery', entityId: id, details: `Query updated — status: ${updates.status || 'unchanged'}` })
    return data
  },

  async respond(id, response, hrComments) {
    const { data, error } = await supabase
      .from('hr_queries')
      .update({
        response,
        hr_comments: hrComments,
        response_date: new Date().toISOString(),
        status: 'RESPONDED',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    logAction({ action: 'HR_QUERY_RESPONDED', entityType: 'HRQuery', entityId: id, details: 'Query response recorded' })
    return data
  },

  async resolve(id) {
    const { data, error } = await supabase
      .from('hr_queries')
      .update({ status: 'RESOLVED', updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    logAction({ action: 'HR_QUERY_RESOLVED', entityType: 'HRQuery', entityId: id, details: 'Query resolved' })
    return data
  },

  async close(id) {
    const { data, error } = await supabase
      .from('hr_queries')
      .update({ status: 'CLOSED', updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    logAction({ action: 'HR_QUERY_CLOSED', entityType: 'HRQuery', entityId: id, details: 'Query closed' })
    return data
  },
}

export default hrQueryService
