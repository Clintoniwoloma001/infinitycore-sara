import { supabase } from '../supabaseClient'
import { rpcWithRetry } from './rpcHelper'

// ------------------------------------------------------------------
// Performance Configuration Service — Phase 26.
// Presentation-derived MPR/PAR/grades/mobility/bonus/sanctions values
// stored as versioned JSON config items. Reads inherit the phase-26
// RLS select policy; writes go through SECURITY DEFINER RPCs that
// require super_admin/admin/hr_manager and write an audit trail.
// ------------------------------------------------------------------

async function configRpc(name, args) {
  try {
    const data = await rpcWithRetry(() => supabase.rpc(name, args))
    return data
  } catch (err) {
    if (err?.code === 'PGRST202') {
      throw new Error(
        `The performance configuration function (${name}) is not available in the database yet. ` +
          'Please run the phase 26 migration (`schema_phase26_hr_master_data.sql`) in Supabase, then retry.'
      )
    }
    throw err
  }
}

export const performanceConfigService = {
  // { sections: [{ code, label, description, sort_order, is_active, items: [...] }] }
  async list() {
    return configRpc('list_performance_config', {})
  },

  async save(key, value, reason) {
    return configRpc('save_performance_config', {
      p_key: key,
      p_value: value,
      p_reason: reason || null,
    })
  },

  // Reset one key, one section, or everything (key wins over section).
  async reset(key, section) {
    return configRpc('reset_performance_config', {
      p_key: key || null,
      p_section: section || null,
    })
  },

  async listAudit(limit = 100) {
    const { data, error } = await supabase
      .from('performance_config_audit')
      .select('*')
      .order('changed_at', { ascending: false })
      .limit(limit)
    if (error) throw error
    return data || []
  },
}

export default performanceConfigService