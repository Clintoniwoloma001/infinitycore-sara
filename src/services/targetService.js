import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'
import { sendInAppNotification } from './notificationService'

export const targetService = {
  async list(filters = {}) {
    let query = supabase.from('targets').select('*')
    if (filters.employeeId) query = query.eq('employee_id', filters.employeeId)
    if (filters.managerId) query = query.eq('manager_id', filters.managerId)
    if (filters.status) query = query.eq('status', filters.status)
    query = query.order('created_at', { ascending: false })
    const { data, error } = await query
    if (error) throw error
    return data || []
  },

  async create(payload) {
    const { data, error } = await supabase.from('targets').insert(payload).select().single()
    if (error) throw error
    logAction({ action: 'TARGET_ASSIGNED', entityType: 'Target', entityId: data.id, details: `Target "${payload.title}" assigned to ${payload.employee_name || 'employee'}` })
    if (payload.employee_id) {
      const { data: emp } = await supabase.from('employees').select('user_id').eq('id', payload.employee_id).single()
      if (emp?.user_id) {
        sendInAppNotification({ userId: emp.user_id, title: 'New Target Assigned', message: `You have a new target: ${payload.title}`, link: '#/my-work', type: 'target' }).catch(() => {})
      }
    }
    return data
  },

  async update(id, updates) {
    const { data, error } = await supabase.from('targets').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', id).select().single()
    if (error) throw error
    logAction({ action: 'TARGET_UPDATED', entityType: 'Target', entityId: id, details: 'Target updated' })
    return data
  },

  async updateProgress(id, currentValue) {
    const target = await this.list().then((all) => all.find((t) => t.id === id))
    if (!target) throw new Error('Target not found')
    const progress = target.target_value > 0 ? Math.min(100, Math.round((Number(currentValue) / Number(target.target_value)) * 100)) : 0
    const status = progress >= 100 ? 'achieved' : 'active'
    const { data, error } = await supabase.from('targets')
      .update({ current_value: currentValue, status, updated_at: new Date().toISOString() })
      .eq('id', id).select().single()
    if (error) throw error
    logAction({ action: 'TARGET_PROGRESS_UPDATED', entityType: 'Target', entityId: id, details: `Progress: ${progress}%` })
    return { ...data, progress }
  },

  calcProgress(target) {
    if (!target || !target.target_value || Number(target.target_value) === 0) return 0
    return Math.min(100, Math.round((Number(target.current_value || 0) / Number(target.target_value)) * 100))
  },
}

export default targetService
