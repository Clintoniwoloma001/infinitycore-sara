import { supabase } from '../supabaseClient'

export const platformSettingsService = {
  async get() {
    const { data, error } = await supabase
      .from('hr_platform_settings')
      .select('*')
      .eq('id', 1)
      .single()
    if (error) throw error
    return data
  },

  async update(settings) {
    const { data, error } = await supabase.rpc('update_hr_settings', {
      p_settings: settings,
    })
    if (error) throw error
    return data
  },

  async updateCurrency(payload) {
    const { data, error } = await supabase.rpc('update_platform_currency', {
      p_currency: payload,
    })
    if (error) throw error
    return data
  },

  async getAuditTrail(limit = 50) {
    const { data, error } = await supabase
      .from('hr_settings_audit')
      .select('*')
      .order('changed_at', { ascending: false })
      .limit(limit)
    if (error) throw error
    const rows = data || []
    // hr_settings_audit.changed_by references auth.users, not profiles, so the
    // actor name is resolved with a second lookup rather than an embed.
    const ids = [...new Set(rows.map((r) => r.changed_by).filter(Boolean))]
    if (ids.length === 0) return rows
    const { data: profs } = await supabase
      .from('profiles')
      .select('id, full_name, email')
      .in('id', ids)
    const byId = new Map((profs || []).map((p) => [p.id, p]))
    return rows.map((r) => ({ ...r, profiles: byId.get(r.changed_by) || null }))
  },
}

export default platformSettingsService
