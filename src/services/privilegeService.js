import { supabase } from '../supabaseClient'

// ------------------------------------------------------------------
// Privilege Management Service — centralized granular authorization.
// All mutations go through SECURITY DEFINER RPCs that enforce the
// holder rule + delegation authority server-side. The frontend only
// renders options the server will accept.
// ------------------------------------------------------------------

export const privilegeService = {
  // Self / authority
  async getMyPermissions() {
    const { data, error } = await supabase.rpc('get_my_permissions')
    if (error) throw error
    return data
  },
  async getPrivilegeAuthority() {
    const { data, error } = await supabase.rpc('get_privilege_authority')
    if (error) throw error
    return data
  },
  async getEpoch() {
    const { data, error } = await supabase.rpc('get_permission_epoch')
    if (error) throw error
    return data
  },

  // Catalog / maps (privilege-manager gated)
  async searchPermissions({ module = null, search = null } = {}) {
    const { data, error } = await supabase.rpc('search_permissions', {
      p_module: module,
      p_search: search,
    })
    if (error) throw error
    return data || []
  },
  async getRolePermissionMap() {
    const { data, error } = await supabase.rpc('get_role_permission_map')
    if (error) throw error
    return data || {}
  },
  async getUserPermissionsMap(userId) {
    const { data, error } = await supabase.rpc('get_user_permissions_map', { p_user_id: userId })
    if (error) throw error
    return data || []
  },
  async getPermissionsStateForUser(userId) {
    const { data, error } = await supabase.rpc('get_permissions_state_for_user', { p_user_id: userId })
    if (error) throw error
    return data
  },
  async listSensitiveFields() {
    const { data, error } = await supabase.rpc('list_sensitive_fields')
    if (error) throw error
    return data || []
  },
  async listDelegations() {
    const { data, error } = await supabase.rpc('list_delegations')
    if (error) throw error
    return data || []
  },
  async getPermissionAudit({ limit = 200, targetType = null, targetKey = null } = {}) {
    const { data, error } = await supabase.rpc('get_permission_audit', {
      p_limit: limit,
      p_target_type: targetType,
      p_target_key: targetKey,
    })
    if (error) throw error
    return data || []
  },

  // Role-level grants
  async grantRolePermission({ roleName, permissionKey, reason, scopeType = 'global' }) {
    const { data, error } = await supabase.rpc('grant_role_permission', {
      p_role_name: roleName,
      p_permission_key: permissionKey,
      p_reason: reason,
      p_scope_type: scopeType,
    })
    if (error) throw error
    return data
  },
  async revokeRolePermission({ roleName, permissionKey, reason }) {
    const { data, error } = await supabase.rpc('revoke_role_permission', {
      p_role_name: roleName,
      p_permission_key: permissionKey,
      p_reason: reason,
    })
    if (error) throw error
    return data
  },

  // User-level overrides (allow/deny)
  async setUserPermission({ userId, permissionKey, effect, reason, scopeType = 'global' }) {
    const { data, error } = await supabase.rpc('set_user_permission', {
      p_user_id: userId,
      p_permission_key: permissionKey,
      p_effect: effect,
      p_reason: reason,
      p_scope_type: scopeType,
    })
    if (error) throw error
    return data
  },
  async clearUserPermission({ userId, permissionKey, reason }) {
    const { data, error } = await supabase.rpc('clear_user_permission', {
      p_user_id: userId,
      p_permission_key: permissionKey,
      p_reason: reason,
    })
    if (error) throw error
    return data
  },

  // Field-level visibility rules
  async setFieldRule({ targetType, targetKey, tableName, columnName, effect, reason }) {
    const { data, error } = await supabase.rpc('set_field_rule', {
      p_target_type: targetType,
      p_target_key: targetKey,
      p_table_name: tableName,
      p_column_name: columnName,
      p_effect: effect,
      p_reason: reason,
    })
    if (error) throw error
    return data
  },
  async clearFieldRule({ targetType, targetKey, tableName, columnName, reason }) {
    const { data, error } = await supabase.rpc('clear_field_rule', {
      p_target_type: targetType,
      p_target_key: targetKey,
      p_table_name: tableName,
      p_column_name: columnName,
      p_reason: reason,
    })
    if (error) throw error
    return data
  },

  // Delegation (super_admin only)
  async setDelegation({ granteeType, granteeKey, module, maxScope, reason }) {
    const { data, error } = await supabase.rpc('set_delegation', {
      p_grantee_type: granteeType,
      p_grantee_key: granteeKey,
      p_module: module,
      p_max_scope: maxScope,
      p_reason: reason,
    })
    if (error) throw error
    return data
  },
  async revokeDelegation({ granteeType, granteeKey, module, reason }) {
    const { data, error } = await supabase.rpc('revoke_delegation', {
      p_grantee_type: granteeType,
      p_grantee_key: granteeKey,
      p_module: module,
      p_reason: reason,
    })
    if (error) throw error
    return data
  },
}

export default privilegeService