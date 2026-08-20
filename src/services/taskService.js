import { supabase } from '../supabaseClient'

/**
 * Task Service - Manages My Work queue
 * Tasks are work items assigned to staff members
 */

export const taskService = {
  /**
   * List tasks with filters
   */
  async list(filters = {}) {
    let query = supabase.from('tasks').select('*')

    if (filters.assignedTo) {
      query = query.eq('assigned_to', filters.assignedTo)
    }
    if (filters.status) {
      query = query.eq('status', filters.status)
    }
    if (filters.priority) {
      query = query.eq('priority', filters.priority)
    }
    if (filters.entityType) {
      query = query.eq('entity_type', filters.entityType)
    }
    if (filters.taskType) {
      query = query.eq('task_type', filters.taskType)
    }

    query = query
      .order('priority', { ascending: false })
      .order('due_date', { ascending: true })

    const { data, error } = await query
    if (error) throw error
    return data
  },

  /**
   * Get a single task by ID
   */
  async getById(id) {
    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', id)
      .single()
    if (error) throw error
    return data
  },

  /**
   * Create a new task
   */
  async create(task) {
    const { data, error } = await supabase
      .from('tasks')
      .insert([task])
      .select()
    if (error) throw error
    return data[0]
  },

  /**
   * Update a task
   */
  async update(id, updates) {
    const { data, error } = await supabase
      .from('tasks')
      .update(updates)
      .eq('id', id)
      .select()
    if (error) throw error
    return data[0]
  },

  /**
   * Mark a task as complete
   */
  async complete(id, notes = '') {
    return this.update(id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      completion_notes: notes,
    })
  },

  /**
   * Get statistics for a user's tasks
   */
  async getStats(userId) {
    const { data, error } = await supabase
      .from('tasks')
      .select('status, priority')
      .eq('assigned_to', userId)
    if (error) throw error

    const stats = {
      total: data.length,
      pending: data.filter((t) => t.status === 'pending').length,
      inProgress: data.filter((t) => t.status === 'in_progress').length,
      critical: data.filter((t) => t.priority === 'critical').length,
      overdue: 0, // Will calculate based on due_date
    }

    return stats
  },

  /**
   * Auto-create a task from an entity (loan, customer, etc)
   */
  async createFromEntity(entityType, entityId, customData = {}) {
    const defaults = {
      entity_type: entityType,
      entity_id: entityId,
      status: 'pending',
      priority: 'normal',
      task_type: 'review',
      ...customData,
    }

    return this.create(defaults)
  },
}
