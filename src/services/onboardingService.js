import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'

// ------------------------------------------------------------------
// Digital employee onboarding — secure one-time links.
//
// If you wonder why we are using a random token + sha256 hash (rather than
// the link id): the token is a 256-bit secret that only ever exists in the
// candidate's browser (URL) and in HR's "copy link" clipboard. The database
// stores ONLY the sha256 hash, so a leaked database can never be replayed
// into the onboarding form. The candidate key is the token itself.
// ------------------------------------------------------------------

function bytesToBase64url(bytes) {
  let binary = ''
  bytes.forEach((b) => { binary += String.fromCharCode(b) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sha256Hex(text) {
  if (!crypto.subtle) {
    throw new Error('Secure token hashing is unavailable. Open this app over HTTPS (or localhost) to generate onboarding links.')
  }
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function generateToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return bytesToBase64url(bytes)
}

export function buildOnboardingUrl(token) {
  return `${window.location.origin}${window.location.pathname}#/onboarding/${token}`
}

export const onboardingService = {
  async createLink({ candidateName, candidateEmail, candidatePhone, position, department, branch, employmentType, expiresInDays = 7 }) {
    if (!candidateName) throw new Error('Candidate name is required.')
    const token = generateToken()
    const tokenHash = await sha256Hex(token)
    const expiry = new Date(Date.now() + Number(expiresInDays || 7) * 24 * 60 * 60 * 1000).toISOString()
    const { data, error } = await supabase
      .from('employee_onboarding_links')
      .insert({
        token_hash: tokenHash,
        candidate_name: candidateName,
        candidate_email: candidateEmail || null,
        candidate_phone: candidatePhone || null,
        position,
        department,
        branch,
        employment_type: employmentType || null,
        expiry,
        status: 'pending',
      })
      .select()
      .single()
    if (error) throw error
    logAction({ action: 'ONBOARDING_LINK_CREATED', entityType: 'OnboardingLink', entityId: data.id, details: `Onboarding link created for ${candidateName}` })
    return { ...data, rawToken: token, url: buildOnboardingUrl(token) }
  },

  async listLinks() {
    const { data, error } = await supabase
      .from('employee_onboarding_links')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async revokeLink(id) {
    const { data, error } = await supabase
      .from('employee_onboarding_links')
      .update({ status: 'revoked', updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    logAction({ action: 'ONBOARDING_LINK_REVOKED', entityType: 'OnboardingLink', entityId: id, details: 'Onboarding link revoked' })
    return data
  },

  async getDetails(token) {
    const { data, error } = await supabase.rpc('get_onboarding_link_details', { p_token: token, p_mark_opened: true })
    if (error) throw error
    return data?.[0] || null
  },

  async markProgress(token) {
    const { data, error } = await supabase.rpc('mark_onboarding_progress', { p_token: token })
    if (error) throw error
    return data
  },

  async submit(token, payload) {
    const { data, error } = await supabase.rpc('submit_onboarding', { p_token: token, p_payload: payload })
    if (error) throw error
    return data
  },

  // Uploads go under "onboarding/<token-hash>/" so the anonymous submit RPC
  // can verify the candidate only touched their own namespace. The caller
  // must pass back the returned { file_path, file_name, size, mime, category }
  // entries inside the submit payload's `documents` array.
  async uploadDocument({ token, file, category = 'other' }) {
    const tokenHash = await sha256Hex(token)
    const safeName = file.name.replace(/[^\w.\- ]+/g, '_')
    const filePath = `onboarding/${tokenHash}/${Date.now()}-${safeName}`
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('documents')
      .upload(filePath, file)
    if (uploadError) throw uploadError
    return {
      file_path: uploadData?.path || filePath,
      file_name: file.name,
      size: file.size,
      mime: file.type,
      category,
    }
  },

  async listSubmissions() {
    const { data, error } = await supabase
      .from('employee_onboarding_submissions')
      .select('*')
      .order('submitted_at', { ascending: false })
    if (error) throw error
    return data || []
  },
}

export default onboardingService