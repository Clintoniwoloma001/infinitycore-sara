import { supabase } from '../supabaseClient'
import { generateToken, md5Hex } from './onboardingService'
import { logAction } from './supabaseService'

// Builds the public guarantor verification URL (hash-routed, same as onboarding)
export function buildGuarantorUrl(token) {
  return `${window.location.origin}${window.location.pathname}#/guarantor-verification/${token}`
}

export const guarantorVerificationService = {
  // HR creates a verification record + secure link for a guarantor
  async createVerification({ onboardingLinkId, employeeId, submissionId, guarantorName, guarantorEmail, guarantorRelationship }) {
    if (!guarantorName) throw new Error('Guarantor name is required.')
    if (!guarantorEmail) throw new Error('Guarantor email is required.')
    const token = generateToken()
    const tokenHash = md5Hex(token)
    const { data, error } = await supabase
      .from('guarantor_verifications')
      .insert({
        onboarding_link_id: onboardingLinkId || null,
        employee_id: employeeId || null,
        submission_id: submissionId || null,
        guarantor_name: guarantorName,
        guarantor_email: guarantorEmail,
        guarantor_relationship: guarantorRelationship || null,
        token_hash: tokenHash,
        status: 'link_sent',
      })
      .select()
      .single()
    if (error) throw error
    logAction({ action: 'GUARANTOR_LINK_CREATED', entityType: 'GuarantorVerification', entityId: data.id, details: `Guarantor verification link created for ${guarantorName}` })
    return { ...data, rawToken: token, url: buildGuarantorUrl(token) }
  },

  // HR lists all verification records
  async listVerifications() {
    const { data, error } = await supabase
      .from('guarantor_verifications')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  // Get verification details via RPC (anon accessible, token-scoped)
  async getDetails(token) {
    const { data, error } = await supabase.rpc('get_guarantor_verification_details', { p_token: token })
    if (error) throw error
    return data
  },

  // Upload a document to Supabase Storage under guarantor/<token-hash>/
  async uploadDocument({ token, file, documentType }) {
    const tokenHash = md5Hex(token)
    const safeName = file.name.replace(/[^\w.\- ]+/g, '_')
    const filePath = `guarantor/${tokenHash}/${Date.now()}-${safeName}`
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('documents')
      .upload(filePath, file)
    if (uploadError) throw uploadError
    return {
      document_type: documentType,
      file_name: file.name,
      file_path: filePath,
      file_size: file.size,
      mime_type: file.type,
    }
  },

  // Submit the completed verification form (anon, via RPC)
  async submit(token, payload) {
    const { data, error } = await supabase.rpc('submit_guarantor_verification', { p_token: token, p_payload: payload })
    if (error) throw error
    return data
  },

  // HR requests field-level corrections (via RPC)
  async requestCorrection(verificationId, corrections) {
    const { data, error } = await supabase.rpc('request_guarantor_correction', { p_verification_id: verificationId, p_corrections: corrections })
    if (error) throw error
    return data
  },

  // Guarantor submits corrected values (anon, via RPC)
  async submitCorrection(token, corrections) {
    const { data, error } = await supabase.rpc('submit_guarantor_correction', { p_token: token, p_corrections: corrections })
    if (error) throw error
    return data
  },

  // HR approves a single correction (via RPC)
  async approveCorrection(correctionId) {
    const { data, error } = await supabase.rpc('approve_guarantor_correction', { p_correction_id: correctionId })
    if (error) throw error
    return data
  },

  // HR rejects a single correction (via RPC)
  async rejectCorrection(correctionId) {
    const { data, error } = await supabase.rpc('reject_guarantor_correction', { p_correction_id: correctionId })
    if (error) throw error
    return data
  },

  // HR approves the entire guarantor verification (via RPC)
  async approveVerification(verificationId) {
    const { data, error } = await supabase.rpc('approve_guarantor_verification', { p_verification_id: verificationId })
    if (error) throw error
    return data
  },

  // HR approves the onboarding — activates the employee (via RPC)
  async approveOnboarding(submissionId) {
    const { data, error } = await supabase.rpc('approve_onboarding', { p_submission_id: submissionId })
    if (error) throw error
    return data
  },

  // HR rejects the onboarding (via RPC)
  async rejectOnboarding(submissionId, reason) {
    const { data, error } = await supabase.rpc('reject_onboarding', { p_submission_id: submissionId, p_reason: reason })
    if (error) throw error
    return data
  },

  // HR adds an employee to a payroll period (via RPC)
  async addToPayroll(employeeId, periodLabel, salary) {
    const { data, error } = await supabase.rpc('add_employee_to_payroll', { p_employee_id: employeeId, p_period_label: periodLabel, p_salary: salary })
    if (error) throw error
    return data
  },

  // HR lists corrections for a verification
  async listCorrections(verificationId) {
    const { data, error } = await supabase
      .from('guarantor_corrections')
      .select('*')
      .eq('guarantor_verification_id', verificationId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  // HR lists onboarding events for a verification
  async listEvents(verificationId) {
    const { data, error } = await supabase
      .from('onboarding_events')
      .select('*')
      .or(`guarantor_verification_id.eq.${verificationId}`)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  // HR lists verifications for a specific employee
  async listVerificationsForEmployee(employeeId) {
    const { data, error } = await supabase
      .from('guarantor_verifications')
      .select('*')
      .eq('employee_id', employeeId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  // HR lists guarantor documents for a verification
  async listGuarantorDocuments(verificationId) {
    const { data, error } = await supabase
      .from('guarantor_documents')
      .select('*')
      .eq('guarantor_verification_id', verificationId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  // Get a signed URL for viewing a document securely
  async getSignedUrl(filePath, expiresIn = 3600) {
    const { data, error } = await supabase.storage
      .from('documents')
      .createSignedUrl(filePath, expiresIn)
    if (error) throw error
    return data.signedUrl
  },
}

export default guarantorVerificationService
