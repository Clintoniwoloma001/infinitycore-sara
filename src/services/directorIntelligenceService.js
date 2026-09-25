import { supabase } from '../supabaseClient'
import { normalizeDirectorSnapshot } from '../domains/directorIntelligence/snapshot'

export const directorIntelligenceService = {
  async getSnapshot(filters = {}) {
    const { data, error } = await supabase.rpc('get_director_executive_snapshot', {
      p_start_date: filters.startDate || null,
      p_end_date: filters.endDate || null,
      p_department: filters.department || null,
      p_branch_id: filters.branchId || null,
      p_area: filters.area || null,
      p_role: filters.role || null,
      p_designation_id: filters.designationId || null,
      p_employee_id: filters.employeeId || null,
    })
    if (error) throw error
    return normalizeDirectorSnapshot(data)
  },

  async getEmployee(employeeId) {
    const { data, error } = await supabase.rpc('get_director_employee_detail', {
      p_employee_id: employeeId,
    })
    if (error) throw error
    return data
  },
}

export default directorIntelligenceService
