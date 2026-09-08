import { supabase } from '../supabaseClient'

// ------------------------------------------------------------------
// User Approval Service — controlled onboarding workflow.
// All privileged actions go through SECURITY DEFINER RPCs that
// enforce authorization server-side. The frontend never trusts
// itself for approval/role/access decisions.
// ------------------------------------------------------------------

export const userApprovalService = {
  // List all profiles (admin/HR only — RLS enforces)
  async listUsers() {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  // Get a single profile with access profile
  async getUser(userId) {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single()
    if (error) throw error

    const { data: access } = await supabase
      .from('user_access_profiles')
      .select('modules')
      .eq('user_id', userId)
      .single()

    const { data: audit } = await supabase
      .from('user_approval_audit')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20)

    return { profile, modules: access?.modules || [], audit: audit || [] }
  },

  // Approve a pending user — RPC enforces authorization
  async approveUser({ userId, role, department, modules }) {
    const { data, error } = await supabase.rpc('approve_user', {
      p_user_id: userId,
      p_role: role || 'customer',
      p_department: department || null,
      p_modules: modules || null,
    })
    if (error) throw error
    return data
  },

  // Reject a pending user — RPC enforces authorization
  async rejectUser({ userId, reason }) {
    const { data, error } = await supabase.rpc('reject_user', {
      p_user_id: userId,
      p_reason: reason || '',
    })
    if (error) throw error
    return data
  },

  // Suspend a user
  async suspendUser({ userId, reason }) {
    const { data, error } = await supabase.rpc('suspend_user', {
      p_user_id: userId,
      p_reason: reason || '',
    })
    if (error) throw error
    return data
  },

  // Activate a suspended/rejected user
  async activateUser(userId) {
    const { data, error } = await supabase.rpc('activate_user', {
      p_user_id: userId,
    })
    if (error) throw error
    return data
  },

  // Update user access modules
  async updateUserAccess({ userId, modules }) {
    const { data, error } = await supabase.rpc('update_user_access', {
      p_user_id: userId,
      p_modules: modules,
    })
    if (error) throw error
    return data
  },

  // Change role (goes through enforce_role_change_policy trigger)
  async changeRole(userId, role) {
    const { error } = await supabase
      .from('profiles')
      .update({ role })
      .eq('id', userId)
    if (error) throw error
  },

  // Update department
  async updateDepartment(userId, department) {
    const { error } = await supabase
      .from('profiles')
      .update({ department })
      .eq('id', userId)
    if (error) throw error
  },

  // Get audit trail for a user
  async getAuditTrail(userId) {
    const { data, error } = await supabase
      .from('user_approval_audit')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  // Get user access modules
  async getUserAccess(userId) {
    const { data, error } = await supabase
      .from('user_access_profiles')
      .select('modules')
      .eq('user_id', userId)
      .single()
    if (error && error.code !== 'PGRST116') throw error
    return data?.modules || []
  },
}

export default userApprovalService
