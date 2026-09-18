import { supabase } from '../supabaseClient'

// ------------------------------------------------------------------
// Public career service — candidate side of the HR lifecycle.
// All reads/writes go through the token-gated SECURITY DEFINER RPCs in
// schema_phase41 (the candidate's key is the 256-bit token, never stored —
// only its md5() hash is, matching the onboarding-link model).
// ------------------------------------------------------------------

export const careerService = {
  // ---- Public job board -------------------------------------------------

  async listPublishedJobs() {
    const { data, error } = await supabase.rpc('public_get_published_jobs')
    if (error) throw error
    return data || []
  },

  async getJobByToken(token) {
    const { data, error } = await supabase.rpc('public_get_job_by_token', { p_token: token })
    if (error) throw error
    return data?.[0] || null
  },

  async checkDuplicateApplication() {
    // Duplicate detection is enforced server-side inside public_apply_for_job
    // (single source of truth) — no client-side table reads from public pages.
    return false
  },

  // Upload a CV under career/cvs/... (anonymous insert policy).
  async uploadCV(file, folder = 'anon') {
    const safeName = file.name.replace(/[^\w.\- ]+/g, '_')
    const filePath = `cvs/${folder}/${Date.now()}-${safeName}`
    const { data, error } = await supabase.storage.from('career').upload(filePath, file, {
      contentType: file.type || 'application/octet-stream',
    })
    if (error) throw error
    return { path: data?.path || filePath, name: file.name, size: file.size, mime: file.type }
  },

  // Submit an application. application may include full_name*, email*,
  // phone, current_company, years_experience, cover_letter, education[],
  // work_experience[], skills[], certifications[], candidate_references[].
  async apply(jobToken, application, cv) {
    const { data, error } = await supabase.rpc('public_apply_for_job', {
      p_job_token: jobToken,
      p_application: application,
      p_cv_path: cv?.path || null,
      p_cv_name: cv?.name || null,
      p_cv_size: cv?.size || null,
      p_cv_mime: cv?.mime || null,
    })
    if (error) throw error
    return data // { ok, candidate_id, portal_token, job_url }
  },

  // ---- Candidate portal (token-gated) ----------------------------------

  async getPortal(token) {
    const { data, error } = await supabase.rpc('public_get_candidate_portal', { p_token: token })
    if (error) throw error
    return data
  },

  // ---- Assessments (token-gated) ---------------------------------------

  async getAssessment(token) {
    const { data, error } = await supabase.rpc('public_get_assessment_by_token', { p_token: token })
    if (error) throw error
    return data
  },

  async startAttempt(token) {
    const { data, error } = await supabase.rpc('public_start_assessment_attempt', { p_token: token })
    if (error) throw error
    return data
  },

  async saveAnswer(token, attemptId, questionId, answer) {
    const { data, error } = await supabase.rpc('public_save_assessment_answer', {
      p_token: token,
      p_attempt_id: attemptId,
      p_question_id: questionId,
      p_answer: answer,
    })
    if (error) throw error
    return data
  },

  async recordEvent(token, attemptId, eventType, metadata = {}) {
    const { data, error } = await supabase.rpc('public_record_assessment_event', {
      p_token: token,
      p_attempt_id: attemptId,
      p_event_type: eventType,
      p_metadata: metadata,
    })
    if (error) throw error
    return data
  },

  async submitAttempt(token, attemptId, answers) {
    const { data, error } = await supabase.rpc('public_submit_assessment_attempt', {
      p_token: token,
      p_attempt_id: attemptId,
      p_answers: answers,
    })
    if (error) throw error
    return data
  },

  async requestRetake(token, attemptId, reason) {
    const { data, error } = await supabase.rpc('public_request_assessment_retake', {
      p_token: token,
      p_attempt_id: attemptId,
      p_reason: reason,
    })
    if (error) throw error
    return data
  },

  // ---- Offers (token-gated) ---------------------------------------------

  async getOffer(token) {
    const { data, error } = await supabase.rpc('public_get_offer_by_token', { p_token: token })
    if (error) throw error
    return data
  },

  async respondToOffer(token, decision, signature = null, metadata = {}) {
    const { data, error } = await supabase.rpc('public_respond_to_offer', {
      p_token: token,
      p_decision: decision,
      p_signature: signature,
      p_metadata: metadata,
    })
    if (error) throw error
    return data
  },

  // ---- Link builders ----------------------------------------------------

  buildJobUrl(jobToken) { return `${window.location.origin}${window.location.pathname}#/careers/jobs/${jobToken}` },
  buildAssessmentUrl(inviteToken) { return `${window.location.origin}${window.location.pathname}#/careers/assessment/${inviteToken}` },
  buildOfferUrl(offerToken) { return `${window.location.origin}${window.location.pathname}#/careers/offer/${offerToken}` },
  buildPortalUrl(portalToken) { return `${window.location.origin}${window.location.pathname}#/careers/portal/${portalToken}` },
}

export default careerService