import { supabase } from '../supabaseClient'

// ------------------------------------------------------------------
// User Invitation Service — Phase 26.
// Client-side read helpers; bulk invites go server-side through the
// `invite-employees` Edge Function so service-role keys never reach
// the browser.
// ------------------------------------------------------------------

export const userInvitationService = {
  // Employees without an auth account (user_id is null).
  async listUninvited() {
    const { data, error } = await supabase
      .from('employees')
      .select('id, full_name, email, department, position, staff_id, branch')
      .is('user_id', null)
      .not('email', 'is', null)
      .order('full_name', { ascending: true })
    if (error) throw error
    return data || []
  },

  // Historical invite records.
  async listInvites(limit = 100) {
    const { data, error } = await supabase
      .from('employee_account_invites')
      .select('*, employee:employee_id(full_name, staff_id)')
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

  async resolveRole(designationTitle) {
    const { data, error } = await supabase.rpc('resolve_system_role_for_designation', {
      p_designation_title: designationTitle,
    })
    if (error) throw error
    return data
  },
}

export default userInvitationService