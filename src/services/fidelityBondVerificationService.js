import { supabase } from '../supabaseClient'
import { generateToken, md5Hex } from './onboardingService'
import { logAction } from './supabaseService'

// Builds the public fidelity bond verification URL (hash-routed, same as onboarding)
export function buildFidelityUrl(token) {
  return `${window.location.origin}${window.location.pathname}#/fidelity-verification/${token}`
}

export const fidelityBondVerificationService = {
  // HR creates a verification record + secure link for a fidelity bond surety
  async createVerification({ onboardingLinkId, employeeId, submissionId, bondId, suretyName, suretyEmail, suretyRelationship }) {
    if (!suretyName) throw new Error('Surety name is required.')
    if (!suretyEmail) throw new Error('Surety email is required.')
    const token = generateToken()
    const tokenHash = md5Hex(token)
    const { data, error } = await supabase
      .from('fidelity_bond_verifications')
      .insert({
        onboarding_link_id: onboardingLinkId || null,
        employee_id: employeeId || null,
        submission_id: submissionId || null,
        bond_id: bondId || null,
        surety_name: suretyName,
        surety_email: suretyEmail,
        surety_relationship: suretyRelationship || null,
        token_hash: tokenHash,
        status: 'link_sent',
      })
      .select()
      .single()
    if (error) throw error
    logAction({ action: 'FIDELITY_LINK_CREATED', entityType: 'FidelityBondVerification', entityId: data.id, details: `Fidelity bond verification link created for ${suretyName}` })
    return { ...data, rawToken: token, url: buildFidelityUrl(token) }
  },

  // HR lists all fidelity bond verification records
  async listVerifications() {
    const { data, error } = await supabase
      .from('fidelity_bond_verifications')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  // HR lists verifications for a specific submission or employee
  async listVerificationsForSubmission(submissionId) {
    const { data, error } = await supabase
      .from('fidelity_bond_verifications')
      .select('*')
      .eq('submission_id', submissionId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async listVerificationsForEmployee(employeeId) {
    const { data, error } = await supabase
      .from('fidelity_bond_verifications')
      .select('*')
      .eq('employee_id', employeeId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  // Surety opens the secure token link (anon, via RPC)
  async getDetails(token) {
    const { data, error } = await supabase.rpc('get_fidelity_verification_details', { p_token: token })
    if (error) throw error
    return data
  },

  // Upload a document to Supabase Storage under fidelity/<token-hash>/
  async uploadDocument({ token, file, documentType }) {
    const tokenHash = md5Hex(token)
    const safeName = file.name.replace(/[^\w.\- ]+/g, '_')
    const filePath = `fidelity/${tokenHash}/${Date.now()}-${safeName}`
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

  // Surety submits the completed verification form (anon, via RPC)
  async submit(token, payload) {
    const { data, error } = await supabase.rpc('submit_fidelity_verification', { p_token: token, p_payload: payload })
    if (error) throw error
    return data
  },

  // HR approves the verification (via RPC)
  async approveVerification(verificationId) {
    const { data, error } = await supabase.rpc('approve_fidelity_verification', { p_verification_id: verificationId })
    if (error) throw error
    return data
  },

  // HR rejects the verification (via RPC)
  async rejectVerification(verificationId, reason) {
    const { data, error } = await supabase.rpc('reject_fidelity_verification', { p_verification_id: verificationId, p_reason: reason })
    if (error) throw error
    return data
  },

  // HR lists fidelity bond documents for a verification
  async listDocuments(verificationId) {
    const { data, error } = await supabase
      .from('fidelity_bond_documents')
      .select('*')
      .eq('fidelity_verification_id', verificationId)
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

  // HR lists onboarding events mentioning a verification
  async listEvents(verificationId) {
    const { data, error } = await supabase
      .from('onboarding_events')
      .select('*')
      .eq('fidelity_verification_id', verificationId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },
}

export default fidelityBondVerificationService