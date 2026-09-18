import { supabase } from '../supabaseClient'

// ------------------------------------------------------------------
// Screening service — SARA AI screening + rule-based fallback.
//
// AI runs server-side via the `sara-candidate-analysis` edge function
// (OPENAI_API_KEY stays in function secrets). If AI is unavailable the
// service exposes runManual() (hr_run_manual_screening RPC) so HR work
// never blocks on AI. Every decision is advisory — HR is the decision
// maker and records it with hr_set_screening_decision.
// ------------------------------------------------------------------

const EDGE = 'sara-candidate-analysis'

async function invoke(payload) {
  const { data, error } = await supabase.functions.invoke(EDGE, { body: payload })
  if (error) throw error
  return data
}

export const screeningService = {
  // ---- Configuration -----------------------------------------------------

  async listConfigs(jobId) {
    const { data, error } = await supabase
      .from('hr_screening_configs')
      .select('*')
      .eq('job_id', jobId)
      .order('version', { ascending: false })
    if (error) throw error
    return data || []
  },

  async getActiveConfig(jobId) {
    if (!jobId) return null
    const { data, error } = await supabase
      .from('hr_screening_configs')
      .select('*')
      .eq('job_id', jobId)
      .eq('active', true)
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return data
  },

  async saveConfig(jobId, config) {
    const weights = config.weights || {}
    const total = Object.values(weights).reduce((sum, value) => sum + Number(value || 0), 0)
    if (Math.round(total * 100) / 100 !== 100) {
      throw new Error(`Recruitment criteria weights must total 100 (currently ${total}).`)
    }
    const { data, error } = await supabase.rpc('upsert_screening_config', {
      p_job_id: jobId,
      p_config: {
        weights,
        min_overall: Number(config.min_overall || 60),
        min_components: config.min_components || {},
        mandatory_requirements: config.mandatory_requirements || [],
        preferred_requirements: config.preferred_requirements || [],
        required_qualifications: config.required_qualifications || [],
        required_certifications: config.required_certifications || [],
        required_skills: config.required_skills || [],
        preferred_skills: config.preferred_skills || [],
        criteria_notes: config.criteria_notes || null,
        assessment_threshold: config.assessment_threshold != null ? Number(config.assessment_threshold) : null,
        experience_threshold: Number(config.experience_threshold || 2),
        assessment_flag_tolerance: Number(config.assessment_flag_tolerance || 0),
      },
    })
    if (error) throw error
    return data // { ok, version }
  },

  // ---- Results -----------------------------------------------------------

  async listResults(filters = {}) {
    let query = supabase.from('candidate_screening_results').select('*')
    if (filters.jobId) query = query.eq('job_id', filters.jobId)
    if (filters.candidateId) query = query.eq('candidate_id', filters.candidateId)
    query = query.order('created_at', { ascending: false })
    const { data, error } = await query
    if (error) throw error
    return data || []
  },

  // ---- Runs --------------------------------------------------------------

  async runManual(candidateIds, jobId) {
    const { data, error } = await supabase.rpc('hr_run_manual_screening', {
      p_candidate_ids: candidateIds,
      p_job_id: jobId,
    })
    if (error) throw error
    return data // { ok, candidates }
  },

  // AI screening for one candidate. cvText is optional (CV body extraction
  // happens upstream — the function falls back to cover letter + skills).
  async runAI({ candidateId, jobId, cvText = null }) {
    const result = await invoke({
      action: 'screen_candidate',
      candidate_id: candidateId,
      job_id: jobId,
      cv_text: cvText || null,
    })
    return result
  },

  async aiAvailable() {
    try {
      const result = await invoke({ action: 'screen_candidate', candidate_id: '00000000-0000-0000-0000-000000000000', job_id: null })
      return result?.error !== 'ai_not_configured'
    } catch {
      return false
    }
  },

  async setDecision(resultId, decision, notes = null) {
    const { data, error } = await supabase.rpc('hr_set_screening_decision', {
      p_result_id: resultId,
      p_decision: decision,
      p_notes: notes,
    })
    if (error) throw error
    return data
  },
}

export default screeningService
