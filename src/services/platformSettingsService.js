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

  async getAuditTrail(limit = 50) {
    const { data, error } = await supabase
      .from('hr_settings_audit')
      .select('*, profiles!changed_by(full_name)')
      .order('changed_at', { ascending: false })
      .limit(limit)
    if (error) throw error
    return data || []
  },
}

export default platformSettingsService
