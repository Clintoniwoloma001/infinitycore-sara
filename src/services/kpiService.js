import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'
import { sendInAppNotification } from './notificationService'

export const kpiService = {
  async list(filters = {}) {
    let query = supabase.from('employee_kpis').select('*')
    if (filters.employeeId) query = query.eq('employee_id', filters.employeeId)
    if (filters.managerId) query = query.eq('manager_id', filters.managerId)
    if (filters.status) query = query.eq('status', filters.status)
    if (filters.quarter) query = query.eq('quarter', filters.quarter)
    query = query.order('created_at', { ascending: false })
    const { data, error } = await query
    if (error) throw error
    return data || []
  },

  async create(payload) {
    const { data, error } = await supabase.from('employee_kpis').insert(payload).select().single()
    if (error) throw error
    logAction({ action: 'KPI_CREATED', entityType: 'KPI', entityId: data.id, details: `KPI "${payload.kpi_name}" created for ${payload.employee_name || 'employee'}` })
    if (payload.employee_id) {
      const { data: emp } = await supabase.from('employees').select('user_id').eq('id', payload.employee_id).single()
      if (emp?.user_id) {
        sendInAppNotification({ userId: emp.user_id, title: 'New KPI Assigned', message: `A new KPI has been set: ${payload.kpi_name}`, link: '#/my-work', type: 'kpi' }).catch(() => {})
      }
    }
    return data
  },

  async update(id, updates) {
    const { data, error } = await supabase.from('employee_kpis').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', id).select().single()
    if (error) throw error
    logAction({ action: 'KPI_UPDATED', entityType: 'KPI', entityId: id, details: 'KPI updated' })
    return data
  },

  // Calculate achievement percentage for a single KPI
  calcAchievement(kpi) {
    if (!kpi || !kpi.target_value || Number(kpi.target_value) === 0) return 0
    return Math.round((Number(kpi.actual_value || 0) / Number(kpi.target_value)) * 1000) / 10
  },

  // Calculate weighted score across multiple KPIs
  calcWeightedScore(kpis) {
    if (!kpis || kpis.length === 0) return 0
    const totalWeight = kpis.reduce((sum, k) => sum + Number(k.weight || 0), 0)
    if (totalWeight === 0) return 0
    const weightedSum = kpis.reduce((sum, k) => {
      const achievement = this.calcAchievement(k) / 100
      return sum + achievement * Number(k.weight || 0)
    }, 0)
    return Math.round((weightedSum / totalWeight) * 1000) / 10
  },
}

export default kpiService
