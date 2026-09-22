import { supabase } from '../supabaseClient'
import { rpcWithRetry } from './rpcHelper'

// ------------------------------------------------------------------
// HR Organisation Service — Phase 26 bank-master organisational data.
// Reads: RLS-guarded SELECT policies (event-based grants).
// Writes: SECURITY DEFINER RPCs only; the frontend is never trusted.
// ------------------------------------------------------------------

function checkOk(data, name) {
  if (data && typeof data === 'object' && 'ok' in data && data.ok === false) {
    throw new Error(data.error || data.message || `${name} failed`)
  }
  return data
}

async function orgRpc(name, args) {
  try {
    const data = await rpcWithRetry(() => supabase.rpc(name, args))
    return data
  } catch (err) {
    if (err?.code === 'PGRST202') {
      throw new Error(
        `The organisation function (${name}) is not available in the database yet. ` +
          'Please run the phase 26 migration (`schema_phase26_hr_master_data.sql`) in Supabase, then retry.'
      )
    }
    throw err
  }
}

async function orgRpcOk(name, args) {
  const data = await orgRpc(name, args)
  return checkOk(data, name)
}

export const hrOrganisationService = {
  // Rollup card numbers for the HR Organisation screen.
  async getSummary() {
    return orgRpc('list_org_summary', {})
  },

  async listDepartments() {
    const { data, error } = await supabase
      .from('departments')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
    if (error) throw error
    return data || []
  },

  async listDesignations() {
    const { data, error } = await supabase
      .from('designations')
      .select('*')
      .order('department', { ascending: true })
      .order('title', { ascending: true })
    if (error) throw error
    return data || []
  },

  async listRoleMappings() {
    const { data, error } = await supabase
      .from('designation_role_mappings')
      .select('*')
      .order('designation_title', { ascending: true })
    if (error) throw error
    return data || []
  },

  async listBranches() {
    const { data, error } = await supabase
      .from('branches')
      .select('*')
      .order('branch_name', { ascending: true })
    if (error) throw error
    return data || []
  },

  async listAreas() {
    const { data, error } = await supabase
      .from('areas')
      .select('*, manager_employee:manager_employee_id(full_name)')
      .order('area_code', { ascending: true })
    if (error) throw error
    return data || []
  },

  async resolveSystemRole(designationTitle) {
    return orgRpc('resolve_system_role_for_designation', { p_designation_title: designationTitle })
  },

  async assignAreaManager(areaCode, employeeId, reason) {
    return orgRpcOk('assign_area_manager', { p_area_code: areaCode, p_employee_id: employeeId, p_reason: reason || null })
  },

  async assignBranchManager(branchId, employeeId, reason) {
    return orgRpcOk('assign_branch_manager', { p_branch_id: branchId, p_employee_id: employeeId, p_reason: reason || null })
  },

  async getAreaBranches(areaId) {
    const { data, error } = await supabase
      .from('branch_area_assignments')
      .select('branch_id')
      .eq('area_id', areaId)
      .eq('is_current', true)
    if (error) throw error
    return (data || []).map((r) => r.branch_id)
  },

  async setAreaBranches(areaId, branchIds, reason) {
    return orgRpcOk('set_area_branches', { p_area_id: areaId, p_branch_ids: branchIds, p_reason: reason || null })
  },

  async getAreaManagerKpi(employeeId, weekStart = null) {
    return orgRpc('get_area_manager_location_kpi', { p_employee_id: employeeId, p_week_start: weekStart || null })
  },

  async recordImportBatch(batchKey, counts = {}) {
    return orgRpcOk('record_staff_import_batch', {
      p_batch_key: batchKey,
      p_total_rows: counts.totalRows || 0,
      p_imported_rows: counts.importedRows || 0,
      p_matched_rows: counts.matchedRows || 0,
      p_notes: counts.notes || null,
    })
  },

  async listSupervisors(employeeId) {
    let q = supabase
      .from('employee_supervisors')
      .select('*, employee:employee_id(full_name, department), supervisor:supervisor_employee_id(full_name, department, position)')
    if (employeeId) q = q.eq('employee_id', employeeId)
    const { data, error } = await q.order('level', { ascending: true })
    if (error) throw error
    return data || []
  },

  async upsertEmployeeSupervisor({ employeeId, supervisorEmployeeId, level = 1, supervisorTitle, source = 'hr_organisation' }) {
    return orgRpcOk('upsert_employee_supervisor', {
      p_employee_id: employeeId,
      p_supervisor_employee_id: supervisorEmployeeId,
      p_level: level,
      p_supervisor_title: supervisorTitle || null,
      p_source: source,
    })
  },

  async deleteEmployeeSupervisor(id) {
    return orgRpcOk('delete_employee_supervisor', { p_id: id })
  },

  async resolveHierarchyException(exceptionId, resolution = 'resolved', supervisorEmployeeId = null) {
    return orgRpcOk('resolve_hierarchy_exception', {
      p_exception_id: exceptionId,
      p_resolution: resolution,
      p_supervisor_employee_id: supervisorEmployeeId,
    })
  },

  async resolveDataQualityException(exceptionId, resolution = 'resolved') {
    return orgRpcOk('resolve_data_quality_exception', { p_exception_id: exceptionId, p_resolution: resolution })
  },

  // Correct a branch-based data-quality exception and auto-resolve it.
  // action: 'correct_single' | 'split'.
  async correctDataQualityException({ exceptionId, action, newValue, newValues, staffAssignments, reason }) {
    return orgRpcOk('correct_data_quality_exception', {
      p_exception_id: exceptionId,
      p_action: action,
      p_new_value: newValue || null,
      p_new_values: Array.isArray(newValues) && newValues.length ? newValues : null,
      p_staff_assignments: Array.isArray(staffAssignments) && staffAssignments.length
        ? staffAssignments
        : null,
      p_reason: reason || null,
    })
  },

  async upsertDepartment({ code, name, sortOrder = 0, id }) {
    return orgRpcOk('upsert_department', {
      p_code: code,
      p_name: name,
      p_sort_order: sortOrder,
      p_id: id || null,
    })
  },

  async deleteDepartment(id) {
    return orgRpcOk('delete_department', { p_id: id })
  },

  async assignEmployeeDepartment(employeeId, departmentName, reason) {
    return orgRpcOk('assign_employee_department', {
      p_employee_id: employeeId,
      p_department_name: departmentName,
      p_reason: reason || null,
    })
  },

  async listBranchAreaAssignments() {
    const { data, error } = await supabase
      .from('branch_area_assignments')
      .select('*, branch:branch_id(branch_name), area:area_id(area_code, area_name)')
      .order('is_current', { ascending: false })
    if (error) throw error
    return data || []
  },

  async listHierarchyExceptions() {
    const { data, error } = await supabase
      .from('hierarchy_exceptions')
      .select('*, employee:employee_id(full_name)')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async listDataQualityExceptions() {
    const { data, error } = await supabase
      .from('data_quality_exceptions')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  // Detail population for a single scorecard. The card predicate matches the
  // summary exactly, so the drawer count always equals the card count.
  async getPopulation(cardKey) {
    const data = await orgRpc('list_org_population', { p_card: cardKey })
    if (data?.error) throw new Error(data.error)
    return data?.rows || []
  },

  // HR bulk confirmation with server-side authorisation + audit trail.
  async confirmEmployees(employeeIds, reason) {
    const ids = (employeeIds || []).filter(Boolean)
    if (ids.length === 0) throw new Error('Select at least one employee to confirm.')
    return orgRpc('confirm_employees', { p_employee_ids: ids, p_reason: reason || 'HR confirmation' })
  },

  async listImportedBatches() {
    const { data, error } = await supabase
      .from('staff_import_batches')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },
}

export default hrOrganisationService