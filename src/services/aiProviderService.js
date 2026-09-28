import { supabase } from '../supabaseClient'

// Every read goes through a role-gated RPC. The provider catalog table is not
// exposed to the client directly, and no secret is ever sent to the browser:
// provider keys live as Edge Function secrets and are only reported as
// "configured" / "missing" booleans.
const unwrap = (data) => (typeof data === 'string' ? JSON.parse(data) : data) || {}

export const aiProviderService = {
  /** The committed chain: primary provider, then ordered fallbacks, then the rules engine. */
  async getChain() {
    const { data, error } = await supabase.rpc('ai_provider_chain')
    if (error) throw error
    return unwrap(data)
  },

  /** The full catalog: id, label, kind, capabilities, model catalogue, enabled flag. */
  async getCatalog() {
    const { data, error } = await supabase.rpc('ai_provider_chain')
    if (error) throw error
    return unwrap(data)
  },

  /** Every workflow SARA can answer, with the model pinned to it (if any). */
  async getFeatures() {
    const { data, error } = await supabase.rpc('ai_features')
    if (error) throw error
    return unwrap(data)
  },

  /**
   * Live health: circuit state, rolling latency, call/failure counts and the
   * last error for every provider in the chain.
   */
  async getHealth() {
    const { data, error } = await supabase.rpc('get_ai_provider_health_report')
    if (error) throw error
    return unwrap(data)
  },

  /** Persist the routing configuration. The server validates, audits and requires a reason. */
  async save({ primary, fallbacks, modelSelection, timeoutMs, failoverEnabled, reason }) {
    const { data, error } = await supabase.rpc('save_ai_provider_settings', {
      p_primary_provider: primary,
      p_fallback_providers: fallbacks,
      p_model_selection: modelSelection || {},
      p_timeout_ms: timeoutMs ?? null,
      p_failover_enabled: failoverEnabled ?? null,
      p_reason: reason,
    })
    if (error) throw error
    return unwrap(data)
  },

  /** Re-close a tripped circuit by hand. */
  async resetCircuit(providerId) {
    const { data, error } = await supabase.rpc('reset_ai_provider_circuit', { p_provider_id: providerId })
    if (error) throw error
    return unwrap(data)
  },
}

export default aiProviderService
