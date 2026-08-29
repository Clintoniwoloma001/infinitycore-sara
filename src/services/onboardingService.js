import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'

// ------------------------------------------------------------------
// Digital employee onboarding — secure one-time links.
//
// If you wonder why we are using a random token + hash (rather than
// the link id): the token is a 256-bit secret that only ever exists in
// the candidate's browser (URL) and in HR's "copy link" clipboard. The
// database stores ONLY the hash, so a leaked database can never be
// replayed into the onboarding form. The candidate key is the token
// itself.
//
// The hash algorithm is md5() on purpose: it must match the RPCs
// (get_onboarding_link_details / mark_onboarding_progress /
// submit_onboarding) which use Postgres' built-in md5() so no
// extension (pgcrypto) is required. md5 is fine here because the
// unguessability comes from the token's 256-bit entropy, not the hash.
// ------------------------------------------------------------------

function bytesToBase64url(bytes) {
  let binary = ''
  bytes.forEach((b) => { binary += String.fromCharCode(b) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Compact, dependency-free MD5 (public-domain style). Output matches
// Postgres' md5(): lowercase hex, little-endian byte order per word.
function md5Hex(input) {
  const bytes = new TextEncoder().encode(input)
  const bitLen = bytes.length * 8
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, bitLen >>> 0, true)
  view.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000), true)
  const rot = (x, c) => (x << c) | (x >>> (32 - c))
  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
             5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
             4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
             6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21]
  const K = new Uint32Array(64)
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000)
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476
  for (let off = 0; off < padded.length; off += 64) {
    const M = new Uint32Array(padded.buffer, padded.byteOffset + off, 16)
    let A = a0, B = b0, C = c0, D = d0
    for (let i = 0; i < 64; i++) {
      let F, g
      if (i < 16) { F = (B & C) | (~B & D); g = i }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16 }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16 }
      else { F = C ^ (B | ~D); g = (7 * i) % 16 }
      F = (F + A + K[i] + M[g]) >>> 0
      A = D; D = C; C = B
      B = (B + rot(F, S[i])) >>> 0
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0
  }
  const word = (w) =>
    String.fromCharCode(w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, (w >>> 24) & 0xff)
  let hex = ''
  for (const ch of word(a0) + word(b0) + word(c0) + word(d0)) {
    hex += ch.charCodeAt(0).toString(16).padStart(2, '0')
  }
  return hex
}

export function generateToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return bytesToBase64url(bytes)
}

export function buildOnboardingUrl(token) {
  return `${window.location.origin}${window.location.pathname}#/onboarding/${token}`
}

export const DEFAULT_EXPIRY_DAYS = 7

const MS_PER_DAY = 24 * 60 * 60 * 1000
const MAX_EXPIRY_DAYS = 3650

// Single source of truth for link expiration. Validates the days value the
// user entered (required, numeric, positive, whole days) and returns the
// explicit ISO timestamp that is stored in both `expiry` and `expires_at`.
export function resolveExpiresAt(expiresInDays) {
  if (expiresInDays === undefined || expiresInDays === null || expiresInDays === '') {
    throw new Error(`Valid days is required (between 1 and ${MAX_EXPIRY_DAYS}).`)
  }
  const days = Number(expiresInDays)
  if (!Number.isFinite(days) || Number.isNaN(days) || days <= 0) {
    throw new Error('Valid days must be greater than 0.')
  }
  if (!Number.isInteger(days)) {
    throw new Error('Valid days must be a whole number.')
  }
  if (days > MAX_EXPIRY_DAYS) {
    throw new Error(`Valid days cannot exceed ${MAX_EXPIRY_DAYS}.`)
  }
  return new Date(Date.now() + days * MS_PER_DAY).toISOString()
}

export const onboardingService = {
  async createLink({ candidateName, candidateEmail, candidatePhone, position, department, branch, employmentType, expiresInDays = DEFAULT_EXPIRY_DAYS }) {
    if (!candidateName) throw new Error('Candidate name is required.')
    const token = generateToken()
    const tokenHash = md5Hex(token)
    const expiresAt = resolveExpiresAt(expiresInDays)
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
        expiry: expiresAt,
        expires_at: expiresAt,
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
    const tokenHash = md5Hex(token)
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