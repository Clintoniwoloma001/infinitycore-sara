import { supabase } from '../supabaseClient'

// ------------------------------------------------------------------
// Work Management Service — Tasks, KPIs, Targets, Work Plans,
// and Report submissions for the HR/Management Work Center.
// ------------------------------------------------------------------

export const workManagementService = {
  // ==================== TASKS ====================

  async listTasks(filters = {}) {
    let query = supabase.from('tasks').select('*')

    if (filters.assignedTo) query = query.eq('assigned_to', filters.assignedTo)
    if (filters.status) query = query.eq('status', filters.status)
    if (filters.priority) query = query.eq('priority', filters.priority)
    if (filters.department) query = query.eq('department', filters.department)
    if (filters.assignmentType) query = query.eq('assignment_type', filters.assignmentType)

    query = query.order('created_at', { ascending: false })
    const { data, error } = await query
    if (error) throw error
    return data || []
  },

  async createTask(payload) {
    const { data, error } = await supabase
      .from('tasks')
      .insert([payload])
      .select()
      .single()
    if (error) throw error
    return data
  },

  async updateTask(id, updates) {
    const { data, error } = await supabase
      .from('tasks')
      .update(updates)
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return data
  },

  async getTaskReports(taskId) {
    const { data, error } = await supabase
      .from('task_progress_reports')
      .select('*')
      .eq('task_id', taskId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async submitTaskReport(payload) {
    const { data, error } = await supabase
      .from('task_progress_reports')
      .insert([payload])
      .select()
      .single()
    if (error) throw error
    return data
  },

  async reviewTaskReport(reportId, { status, comment }) {
    const { data, error } = await supabase
      .from('task_progress_reports')
      .update({
        status,
        review_comment: comment,
        reviewed_by: (await supabase.auth.getUser()).data.user?.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', reportId)
      .select()
      .single()
    if (error) throw error
    return data
  },

  // ==================== KPIs ====================

  async listKpis({ activeOnly = false } = {}) {
    let query = supabase.from('kpi_definitions').select('*').order('created_at', { ascending: false })
    if (activeOnly) query = query.eq('is_active', true)
    const { data, error } = await query
    if (error) throw error
    return data || []
  },

  async createKpi(payload) {
    const { data, error } = await supabase
      .from('kpi_definitions')
      .insert([payload])
      .select()
      .single()
    if (error) throw error
    return data
  },

  async updateKpi(id, updates) {
    const { data, error } = await supabase
      .from('kpi_definitions')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return data
  },

  async deleteKpi(id) {
    const { error } = await supabase.from('kpi_definitions').delete().eq('id', id)
    if (error) throw error
  },

  // ==================== KPI ASSIGNMENTS ====================

  async listKpiAssignments(kpiId) {
    const { data, error } = await supabase
      .from('kpi_assignments')
      .select('*')
      .eq('kpi_id', kpiId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async assignKpi(payload) {
    const { data, error } = await supabase
      .from('kpi_assignments')
      .insert([payload])
      .select()
      .single()
    if (error) throw error
    return data
  },

  async deleteKpiAssignment(id) {
    const { error } = await supabase.from('kpi_assignments').delete().eq('id', id)
    if (error) throw error
  },

  // Get KPIs assigned to a specific user
  async getMyKpis(userId) {
    const { data, error } = await supabase
      .from('kpi_assignments')
      .select('*, kpi_definitions(*)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  // ==================== KPI SUBMISSIONS ====================

  async listKpiSubmissions(kpiId) {
    const { data, error } = await supabase
      .from('kpi_submissions')
      .select('*')
      .eq('kpi_id', kpiId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async submitKpiProgress(payload) {
    const { data, error } = await supabase
      .from('kpi_submissions')
      .insert([payload])
      .select()
      .single()
    if (error) throw error
    return data
  },

  async reviewKpiSubmission(submissionId, { status, comment }) {
    const { data, error } = await supabase
      .from('kpi_submissions')
      .update({
        status,
        review_comment: comment,
        reviewed_by: (await supabase.auth.getUser()).data.user?.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', submissionId)
      .select()
      .single()
    if (error) throw error
    return data
  },

  // Get my KPI submissions
  async getMyKpiSubmissions(userId) {
    const { data, error } = await supabase
      .from('kpi_submissions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  // ==================== WORK PLANS ====================

  async listWorkPlans(filters = {}) {
    let query = supabase.from('work_plans').select('*')
    if (filters.userId) query = query.eq('user_id', filters.userId)
    if (filters.status) query = query.eq('status', filters.status)
    query = query.order('created_at', { ascending: false })
    const { data, error } = await query
    if (error) throw error
    return data || []
  },

  async createWorkPlan(payload) {
    const { data, error } = await supabase
      .from('work_plans')
      .insert([payload])
      .select()
      .single()
    if (error) throw error
    return data
  },

  async updateWorkPlan(id, updates) {
    const { data, error } = await supabase
      .from('work_plans')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return data
  },

  async deleteWorkPlan(id) {
    const { error } = await supabase.from('work_plans').delete().eq('id', id)
    if (error) throw error
  },

  // ==================== DEPARTMENTS / BRANCHES ====================

  async listDepartments() {
    // Reuse existing departments from employees table (distinct values)
    const { data, error } = await supabase
      .from('employees')
      .select('department')
      .not('department', 'is', null)
      .neq('department', '')
    if (error) throw error
    const depts = [...new Set((data || []).map((d) => d.department))]
    return depts
  },

  async listBranches() {
    const { data, error } = await supabase
      .from('branches')
      .select('name')
      .order('name')
    if (error) throw error
    return (data || []).map((b) => b.name)
  },

  async listUsersForAssignment() {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, full_name, role, status')
      .eq('status', 'active')
      .order('full_name')
    if (error) throw error
    return data || []
  },

  // ==================== ATTENDANCE CONFIG ====================

  async getAttendanceConfig() {
    const { data, error } = await supabase
      .from('attendance_config')
      .select('*')
      .eq('id', 1)
      .single()
    if (error && error.code !== 'PGRST116') throw error
    return data
  },

  async updateAttendanceConfig(updates) {
    const { data, error } = await supabase
      .from('attendance_config')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', 1)
      .select()
      .single()
    if (error) throw error
    return data
  },
}

export default workManagementService
