import { supabase } from '../supabaseClient'

// ------------------------------------------------------------------
// User Invitation Service — Phase 26.
// Client-side read helpers; bulk invites go server-side through the
// `invite-employees` Edge Function so service-role keys never reach
// the browser.
// ------------------------------------------------------------------

export const userInvitationService = {
  // Resolve the master-data labels stored separately from employees. The
  // employee text fields remain the source of truth; these labels only fill
  // gaps where an employee has a foreign key but no copied display value.
  async enrichEmployeeLocations(employees) {
    const rows = employees || []
    const employeeIds = rows.map((employee) => employee.id).filter(Boolean)
    const branchIds = [...new Set(rows.map((employee) => employee.branch_id).filter(Boolean))]
    const [{ data: branches }, { data: assignments }, { data: supervisorRows }] = await Promise.all([
      branchIds.length ? supabase.from('branches').select('id, branch_name, branch_code').in('id', branchIds) : { data: [] },
      branchIds.length ? supabase.from('branch_area_assignments').select('branch_id, area_id').in('branch_id', branchIds).eq('is_current', true) : { data: [] },
      employeeIds.length ? supabase.from('employee_supervisors').select('employee_id, supervisor_employee_id, level').in('employee_id', employeeIds) : { data: [] },
    ])

    const branchById = Object.fromEntries((branches || []).map((branch) => [branch.id, branch]))
    const areaIds = [...new Set((assignments || []).map((assignment) => assignment.area_id).filter(Boolean))]
    const { data: areas } = areaIds.length
      ? await supabase.from('areas').select('id, area_code, area_name').in('id', areaIds)
      : { data: [] }
    const areaById = Object.fromEntries((areas || []).map((area) => [area.id, area]))
    const areaByBranch = Object.fromEntries((assignments || []).map((assignment) => [assignment.branch_id, areaById[assignment.area_id]]))
    const supervisorIds = [...new Set((supervisorRows || []).map((row) => row.supervisor_employee_id).filter(Boolean))]
    const { data: supervisorEmployees } = supervisorIds.length
      ? await supabase.from('employees').select('id, full_name, position, employee_code, employee_number, staff_id').in('id', supervisorIds)
      : { data: [] }
    const supervisorById = Object.fromEntries((supervisorEmployees || []).map((employee) => [employee.id, employee]))
    const supervisorByEmployee = {}
    ;(supervisorRows || []).forEach((row) => {
      const supervisor = supervisorById[row.supervisor_employee_id]
      if (!supervisor) return
      if (!supervisorByEmployee[row.employee_id] || row.level < supervisorByEmployee[row.employee_id].level) {
        supervisorByEmployee[row.employee_id] = { ...supervisor, level: row.level }
      }
    })

    return rows.map((employee) => {
      const branch = branchById[employee.branch_id]
      const area = areaByBranch[employee.branch_id]
      const supervisor = supervisorByEmployee[employee.id]
      return {
        ...employee,
        branch_name: branch?.branch_name || null,
        branch_code: branch?.branch_code || null,
        resolved_branch: employee.branch || branch?.branch_name || null,
        resolved_area: employee.area || area?.area_name || area?.area_code || null,
        supervisor_name: supervisor?.full_name || null,
        supervisor_title: supervisor?.position || null,
      }
    })
  },

  // Employees without a valid linked profile/auth account. Rows without an
  // email remain visible so HR gets a correction message instead of silently
  // losing the employee from the picker. Stale `user_id` references and orphaned
  // auth accounts are treated as eligible for reconciliation rather than as a
  // completed account.
  async listUninvited() {
    const { data, error } = await supabase
      .from('employees')
      .select('*')
      .eq('is_archived', false)
      .order('full_name', { ascending: true })
    if (error) throw error

    const rows = data || []
    const userIds = [...new Set(rows.map((employee) => employee.user_id).filter(Boolean))]
    let profilesByUserId = {}

    if (userIds.length) {
      const { data: profilesData } = await supabase
        .from('profiles')
        .select('id, email, employee_id, status')
        .in('id', userIds)
      ;(profilesData || []).forEach((profile) => {
        profilesByUserId[profile.id] = profile
      })
    }

    const eligible = rows.filter((employee) => {
      if (!employee.user_id) return true
      const profile = profilesByUserId[employee.user_id]
      if (!profile) return true
      if (String(profile.email || '').trim().toLowerCase() !== String(employee.email || '').trim().toLowerCase()) return true
      if (profile.employee_id && profile.employee_id !== employee.id) return true
      return false
    })

    try {
      return await this.enrichEmployeeLocations(eligible)
    } catch {
      return eligible
    }
  },

  // Historical invite records.
  async listInvites(limit = 100) {
    const { data, error } = await supabase
      .from('employee_account_invites')
      .select('*, employee:employee_id(full_name, staff_id, email, department, branch, area)')
      .order('invited_at', { ascending: false })
      .limit(limit)
    if (error) throw error
    return data || []
  },

  // Bulk invite via server-side Edge Function.
  // Returns { ok, results: [{employee_id, result, email?, error?, auth_user_id?}] }
  async inviteEmployees(employeeIds, intendedRole, reason) {
    const { data, error } = await supabase.functions.invoke('invite-employees', {
      body: {
        employee_ids: employeeIds,
        intended_role: intendedRole || 'staff',
        reason: reason || null,
      },
    })
    if (error) throw error
    return data
  },

  async resendInvitation(employeeId, intendedRole = 'staff', reason = null) {
    const { data, error } = await supabase.functions.invoke('invite-employees', {
      body: {
        employee_ids: [employeeId],
        intended_role: intendedRole,
        reason,
        resend: true,
      },
    })
    if (error) throw error
    return data
  },

  async resolveRole(designationTitle) {
    const { data, error } = await supabase.rpc('resolve_system_role_for_designation', {
      p_designation_title: designationTitle,
    })
    if (error) throw error
    return data
  },
}

export default userInvitationService
