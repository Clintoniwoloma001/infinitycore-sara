import { supabase } from '../supabaseClient'

/**
 * Support Case Service - Manages customer support tickets
 */

export const supportCaseService = {
  /**
   * List support cases with filters
   */
  async list(filters = {}) {
    let query = supabase.from('support_cases').select('*')

    if (filters.customerId) {
      query = query.eq('customer_id', filters.customerId)
    }
    if (filters.assignedTo) {
      query = query.eq('assigned_to', filters.assignedTo)
    }
    if (filters.status) {
      query = query.eq('status', filters.status)
    }
    if (filters.priority) {
      query = query.eq('priority', filters.priority)
    }
    if (filters.category) {
      query = query.eq('issue_category', filters.category)
    }

    query = query
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false })

    const { data, error } = await query
    if (error) throw error
    return data
  },

  /**
   * Get a single support case
   */
  async getById(id) {
    const { data, error } = await supabase
      .from('support_cases')
      .select('*')
      .eq('id', id)
      .single()
    if (error) throw error
    return data
  },

  /**
   * Create a new support case
   */
  async create(caseData) {
    const { user } = await supabase.auth.getUser()
    const { data, error } = await supabase
      .from('support_cases')
      .insert([
        {
          ...caseData,
          created_by: user.id,
        },
      ])
      .select()

    if (error) throw error
    return data[0]
  },

  /**
   * Update a support case
   */
  async update(id, updates) {
    const { data, error } = await supabase
      .from('support_cases')
      .update(updates)
      .eq('id', id)
      .select()

    if (error) throw error
    return data[0]
  },

  /**
   * Assign a case to staff
   */
  async assign(caseId, staffId) {
    return this.update(caseId, {
      assigned_to: staffId,
      status: 'assigned',
    })
  },

  /**
   * Resolve a case
   */
  async resolve(caseId, resolution, notes = '') {
    return this.update(caseId, {
      status: 'resolved',
      resolution: resolution,
      completion_notes: notes,
    })
  },

  /**
   * Close a case
   */
  async close(caseId) {
    return this.update(caseId, {
      status: 'closed',
      closed_date: new Date().toISOString(),
    })
  },

  /**
   * Get case statistics
   */
  async getStats() {
    const { data, error } = await supabase
      .from('support_cases')
      .select('status, priority, breached')

    if (error) throw error

    return {
      total: data.length,
      open: data.filter((c) => c.status === 'open').length,
      assigned: data.filter((c) => c.status === 'assigned').length,
      inProgress: data.filter((c) => c.status === 'in_progress').length,
      critical: data.filter((c) => c.priority === 'critical').length,
      breached: data.filter((c) => c.breached).length,
    }
  },
}
