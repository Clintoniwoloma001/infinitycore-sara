import { supabase } from '../supabaseClient'
import { normalizeDirectorSnapshot } from '../domains/directorIntelligence/snapshot'
import { rpcWithRetry } from '../services/rpcHelper'

// Director Intelligence RPCs (Phase 2). All numeric cards + ranks live ONLY in
// these server functions; the browser renders what the server returns.
// Security + search_path are set inside each function; this client just forwards
// the plain arguments the RPCs declare.

export const directorIntelligenceService = {
  // --- Scorecards (bank-level + scope) ---
  async getScorecards(startDate, endDate, areaManagerIds, departmentIds, positionIds) {
    const { data, error } = await rpcWithRetry(() =>
      supabase.rpc('director_scorecards', {
        p_start: startDate || null,
        p_end: endDate || null,
        p_area_manager_ids: areaManagerIds || null,
        p_department_ids: departmentIds || null,
        p_positions: positionIds || null,
      })
    )
    if (error) throw error
    return data || {}
  },

  // --- Branch breakdown (bank + filter scope) ---
  async getBranchBreakdown(startDate, endDate, branchIds, areaIds, departmentIds, positionIds) {
    const { data, error } = await rpcWithRetry(() =>
      supabase.rpc('director_branch_breakdown', {
        p_start: startDate || null,
        p_end: endDate || null,
        p_branch_ids: branchIds || null,
        p_area_ids: areaIds || null,
        p_department_ids: departmentIds || null,
        p_positions: positionIds || null,
      })
    )
    if (error) throw error
    return data || {}
  },

  // --- Branch staff table (one branch) ---
  async getBranchStaff(
    branchId,
    startDate,
    endDate,
    departmentIds,
    positionIds,
    search,
    sortBy = 'overall_score',
    sortDir = 'desc'
  ) {
    const { data, error } = await rpcWithRetry(() =>
      supabase.rpc('director_branch_staff', {
        p_branch_id: branchId,
        p_start: startDate || null,
        p_end: endDate || null,
        p_departments: departmentIds || null,
        p_positions: positionIds || null,
        p_search: search || null,
        p_sort_by: sortBy,
        p_sort_dir: sortDir,
      })
    )
    if (error) throw error
    return data || {}
  },

  // --- Top/bottom staff (bank + filter scope) ---
  async getTopStaff(startDate, endDate, branchIds, areaIds, departmentIds, positionIds, n = 5) {
    const { data, error } = await rpcWithRetry(() =>
      supabase.rpc('director_top_staff', {
        p_start: startDate || null,
        p_end: endDate || null,
        p_branch_ids: branchIds || null,
        p_area_ids: areaIds || null,
        p_department_ids: departmentIds || null,
        p_positions: positionIds || null,
        p_n: n,
      })
    )
    if (error) throw error
    return data || {}
  },

  // --- Legacy exec snapshot (kept for backward compat) ---
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
