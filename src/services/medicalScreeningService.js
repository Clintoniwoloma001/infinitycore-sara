import { supabase } from '../supabaseClient'
import { generateToken, md5Hex } from './onboardingService'
import { logAction } from './supabaseService'
import { APP_URL } from '../config/siteUrl'

// ------------------------------------------------------------------
// Medical Screening / Hospital Referral service (Phase 40).
//
// Security model (mirrors onboarding/guarantor):
//   * The referral QR token is a 256-bit random secret generated HERE.
//   * Only its md5() hash is stored in `medical_referrals`.
//   * The raw token exists ONLY in HR's clipboard / the QR code on the
//     card. If HR loses it, a new referral must be issued.
//   * Public reads/submits go through token-scoped SECURITY DEFINER RPCs
//     that return the minimum disclosure — never results, BVN, NIN, or
//     document paths outside the workflow.
//   * Submitted medical results are IMMUTABLE. Corrections flow through
//     request_medical_amendment → approve_medical_amendment which creates
//     a NEW version and preserves the original.
// ------------------------------------------------------------------

export const MEDICAL_SCREENING_TYPES = [
  { value: 'pre_employment', label: 'Pre-employment Medical' },
  { value: 'periodic', label: 'Periodic Medical' },
  { value: 'fitness_for_work', label: 'Fitness for Work' },
  { value: 'medical_screening', label: 'Medical Screening' },
  { value: 'other', label: 'Other' },
]

export const MEDICAL_STATUS_LABELS = {
  draft: 'Draft',
  issued: 'Issued',
  qr_opened: 'QR Opened',
  screening_started: 'Screening Started',
  submitted: 'Submitted',
  under_review: 'Under Review',
  cleared: 'Cleared',
  cleared_with_restrictions: 'Cleared with Restrictions',
  further_review: 'Further Review',
  not_cleared: 'Not Cleared',
  revoked: 'Revoked',
}

export const MEDICAL_OUTCOME_LABELS = {
  fit_for_work: 'Fit for Work',
  fit_with_restrictions: 'Fit with Restrictions',
  further_review: 'Further Medical Review Required',
  not_cleared: 'Not Cleared',
  pending: 'Pending',
}

export const SCREENING_TYPE_LABEL = (type, other) => {
  if (type === 'other') return other || 'Other'
  return MEDICAL_SCREENING_TYPES.find((t) => t.value === type)?.label || type || '—'
}

export function buildMedicalScreeningUrl(token) {
  return `${APP_URL}${window.location.pathname}#/medical-screening/${token}`
}

async function rpcWithRetry(fn) {
  const isMissing = (err) => {
    const msg = (err?.message || '').toLowerCase()
    return msg.includes('pgrst202') || msg.includes('schema cache') || msg.includes('could not find the function')
  }
  try {
    const out = await fn()
    if (out?.error && isMissing(out.error)) {
      const retried = await fn()
      if (retried?.error) throw retried.error
      return retried
    }
    if (out?.error) throw out.error
    return out
  } catch (err) {
    if (isMissing(err)) {
      const retried = await fn()
      if (retried?.error && isMissing(retried.error)) throw retried.error
      if (retried?.error) throw retried.error
      return retried
    }
    throw err
  }
}

export const medicalScreeningService = {
  // ---- Issuing ----

  async createReferral({
    candidateId = null,
    employeeId = null,
    subjectName,
    subjectIdentifier,
    subjectPosition,
    subjectDepartment,
    subjectBranch,
    screeningType = 'pre_employment',
    otherScreeningType = '',
    hospitalId = null,
    hospitalName = '',
    expiresAt = null,
    notes = '',
    status = 'issued',
  }) {
    const token = generateToken()
    const tokenHash = md5Hex(token)
    const { data, error } = await supabase.rpc('create_medical_referral', {
      p_token_hash: tokenHash,
      p_candidate_id: candidateId,
      p_employee_id: employeeId,
      p_subject_name: subjectName || null,
      p_subject_identifier: subjectIdentifier || null,
      p_subject_position: subjectPosition || null,
      p_subject_department: subjectDepartment || null,
      p_subject_branch: subjectBranch || null,
      p_screening_type: screeningType,
      p_other_screening_type: otherScreeningType || null,
      p_hospital_id: hospitalId,
      p_hospital_name: hospitalName || null,
      p_expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
      p_notes: notes || null,
      p_status: status,
    })
    if (error) throw new Error(error.message)
    return { ...(data || {}), rawToken: token, url: buildMedicalScreeningUrl(token) }
  },

  async backfillLinkedScreening(employeeId) {
    const { data, error } = await supabase.rpc('backfill_medical_screening_links', { p_employee_id: employeeId })
    if (error) throw new Error(error.message)
    return data
  },

  // ---- Public portal ----

  async getDetails(token) {
    const { data, error } = await supabase.rpc('get_medical_referral_details', { p_token: token })
    if (error) throw new Error(error.message)
    return data
  },

  async uploadDocument({ token, file, documentType = 'other' }) {
    const tokenHash = md5Hex(token)
    const safeName = file.name.replace(/[^\w.\- ]+/g, '_')
    const filePath = `medical/${tokenHash}/${Date.now()}-${safeName}`
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('documents')
      .upload(filePath, file, { contentType: file.type || 'application/octet-stream' })
    if (uploadError) throw new Error(uploadError.message)
    return {
      document_type: documentType,
      file_name: file.name,
      file_path: uploadData?.path || filePath,
      file_size: file.size,
      mime_type: file.type || 'application/octet-stream',
    }
  },

  async submit(token, payload) {
    const { data, error } = await supabase.rpc('submit_medical_screening', { p_token: token, p_payload: payload })
    if (error) throw new Error(error.message)
    return data
  },

  async begin(token) {
    const { data, error } = await supabase.rpc('begin_medical_screening', { p_token: token })
    if (error) throw new Error(error.message)
    return data
  },

  async notifyExpiring() {
    const { data, error } = await supabase.rpc('notify_expiring_medical_referrals')
    if (error) return null
    return data
  },

  // ---- HR: review workbench ----

  async getResult(referralId) {
    const { data, error } = await supabase.rpc('get_medical_screening_result', { p_referral_id: referralId })
    if (error) throw new Error(error.message)
    return data
  },

  async setStatus(referralId, status, note = '') {
    const { data, error } = await supabase.rpc('set_medical_referral_status', {
      p_referral_id: referralId,
      p_status: status,
      p_note: note || null,
    })
    if (error) throw new Error(error.message)
    return data
  },

  async revoke(referralId, reason = '') {
    const { data, error } = await supabase.rpc('set_medical_referral_status', {
      p_referral_id: referralId,
      p_status: 'revoked',
      p_note: reason || 'Revoked by HR',
    })
    if (error) throw new Error(error.message)
    return data
  },

  async extendExpiry(referralId, expiresAt) {
    const { data, error } = await supabase.rpc('extend_medical_referral_expiry', {
      p_referral_id: referralId,
      p_expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
    })
    if (error) throw new Error(error.message)
    return data
  },

  // ---- Amendments (immutability protocol) ----

  async requestAmendment(screeningId, reason) {
    const { data, error } = await supabase.rpc('request_medical_amendment', {
      p_screening_id: screeningId,
      p_reason: reason,
    })
    if (error) throw new Error(error.message)
    return data
  },

  async approveAmendment(amendmentId, payload) {
    const { data, error } = await supabase.rpc('approve_medical_amendment', {
      p_amendment_id: amendmentId,
      p_payload: payload,
    })
    if (error) throw new Error(error.message)
    return data
  },

  async rejectAmendment(amendmentId, reason = '') {
    const { data, error } = await supabase.rpc('reject_medical_amendment', {
      p_amendment_id: amendmentId,
      p_reason: reason || null,
    })
    if (error) throw new Error(error.message)
    return data
  },

  // ---- HR configuration ----

  async getConfig(configKey) {
    const { data, error } = await supabase.rpc('get_medical_config', { p_config_key: configKey })
    if (error) throw new Error(error.message)
    return data
  },

  async listConfig() {
    const { data, error } = await supabase.from('medical_screening_config').select('*')
    if (error) throw error
    return data || []
  },

  async upsertConfig(configKey, value) {
    const { data, error } = await supabase.rpc('upsert_medical_config', {
      p_config_key: configKey,
      p_config_value: value,
    })
    if (error) throw new Error(error.message)
    return data
  },

  // ---- HR queries (RLS-scoped) ----

  async listReferrals() {
    let query = supabase.from('medical_referrals').select('*')
    const { data, error } = await query.order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async listScreenings(referralId) {
    let query = supabase.from('medical_screenings').select('*').order('version', { ascending: false })
    if (referralId) query = query.eq('referral_id', referralId)
    const { data, error } = await query
    if (error) throw error
    return data || []
  },

  async listEvents(referralId) {
    const { data, error } = await supabase
      .from('medical_screening_events')
      .select('*')
      .eq('referral_id', referralId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async listAmendments(screeningId) {
    let query = supabase.from('medical_screening_amendments').select('*').order('requested_at', { ascending: false })
    if (screeningId) query = query.eq('screening_id', screeningId)
    const { data, error } = await query
    if (error) throw error
    return data || []
  },

  async listDocuments(referralId) {
    let query = supabase.from('medical_documents').select('*').order('created_at', { ascending: false })
    if (referralId) query = query.eq('referral_id', referralId)
    const { data, error } = await query
    if (error) throw error
    return data || []
  },

  async listHospitalProviders() {
    const { data, error } = await supabase.from('hospital_providers').select('*').order('name', { ascending: true })
    if (error) throw error
    return data || []
  },

  async upsertHospitalProvider(provider) {
    const { data, error } = await supabase.from('hospital_providers').upsert(provider).select().single()
    if (error) throw error
    logAction({
      action: 'HOSPITAL_PROVIDER_SAVED',
      entityType: 'HospitalProvider',
      entityId: data.id,
      details: `Hospital provider saved: ${data.name}`,
    })
    return data
  },

  async getSignedUrl(filePath, expiresIn = 3600) {
    const { data, error } = await supabase.storage
      .from('documents')
      .createSignedUrl(filePath, expiresIn)
    if (error) throw error
    return data?.signedUrl || null
  },

  // ---- Derived metrics for the HR dashboard ----

  async getStats() {
    let referrals = []
    try { referrals = await this.listReferrals() } catch { referrals = [] }
    let screenings = []
    try { screenings = await this.listScreenings() } catch { screenings = [] }
    const now = new Date()
    const expiringSoon = referrals.filter((r) =>
      r.status === 'issued' && r.expires_at && new Date(r.expires_at) > now &&
      new Date(r.expires_at) - now < 7 * 24 * 60 * 60 * 1000
    )
    return {
      pending: referrals.filter((r) => ['draft', 'issued'].includes(r.status)).length,
      issued: referrals.filter((r) => r.status === 'issued').length,
      inProgress: referrals.filter((r) => ['qr_opened', 'screening_started'].includes(r.status)).length,
      submitted: referrals.filter((r) => r.status === 'submitted').length,
      underReview: referrals.filter((r) => r.status === 'under_review').length,
      cleared: referrals.filter((r) => ['cleared', 'cleared_with_restrictions'].includes(r.status)).length,
      furtherReview: referrals.filter((r) => r.status === 'further_review').length,
      notCleared: referrals.filter((r) => r.status === 'not_cleared').length,
      revoked: referrals.filter((r) => r.status === 'revoked').length,
      expiringSoon: expiringSoon.length,
      total: referrals.length,
      screenings: screenings.length,
    }
  },
}

export default medicalScreeningService
