import { supabase } from '../supabaseClient'

// ============================================================
// biometricService — WebAuthn (FIDO2) credential management
//
// Security notes:
//  * InfinityCore NEVER receives or stores fingerprints / Face ID.
//    WebAuthn stores only a public key + credential ID that the
//    device authenticator created locally. The biometric never
//    leaves the device.
//  * Challenges are issued and verified by Supabase Edge Functions
//    (service role) — direct table writes are blocked by RLS.
//  * Credentials are registered per-employee (HR-managed) and can
//    be revoked by HR or by the owning employee.
// ============================================================

function base64UrlEncode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let binary = ''
  bytes.forEach((b) => { binary += String.fromCharCode(b) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4
  const padded = pad ? b64 + '='.repeat(4 - pad) : b64
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

function isWebAuthnSupported() {
  return typeof window !== 'undefined'
    && !!window.PublicKeyCredential
    && typeof window.navigator.credentials?.create === 'function'
    && typeof window.navigator.credentials?.get === 'function'
}

// ---- REGISTRATION (HR enrolls a device for an employee) ----
async function getRegisterOptions({ employeeId, authenticatorType = 'platform', deviceName }) {
  const { data, error } = await supabase.functions.invoke('webauthn-register-options', {
    body: { employeeId, authenticatorType, deviceName },
  })
  if (error) throw new Error(error.message || 'Failed to start device registration')
  if (data?.error) throw new Error(data.error || 'Failed to start device registration')
  return data
}

async function verifyRegistration({ challengeId, employeeId, credential, deviceName }) {
  const { data, error } = await supabase.functions.invoke('webauthn-register-verify', {
    body: { challengeId, employeeId, credential, deviceName },
  })
  if (error) throw new Error(error.message || 'Registration could not be verified')
  if (!data?.ok) throw new Error(data?.error || 'Registration could not be verified')
  return data
}

// The browser performs the actual create() call — the credential never
// leaves access to our servers except the public part.
async function registerDevice({ employeeId, authenticatorType = 'platform', deviceName }) {
  if (!isWebAuthnSupported()) {
    throw new Error('WebAuthn is not supported in this browser. Use a recent Chrome, Firefox, Edge or Safari.')
  }

  const pre = await getRegisterOptions({ employeeId, authenticatorType, deviceName })
  const options = pre.options

  // Decode byte fields supplied by the edge function (base64url -> ArrayBuffer)
  const publicKey = {
    ...options,
    challenge: base64UrlDecode(options.challenge),
    user: {
      ...options.user,
      id: base64UrlDecode(options.user.id),
    },
    excludeCredentials: (options.excludeCredentials || []).map((c) => ({
      ...c,
      id: base64UrlDecode(c.id),
    })),
  }

  const credential = await window.navigator.credentials.create({ publicKey })
  const result = {
    id: credential.id,
    rawId: base64UrlEncode(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {},
    response: {
      attestationObject: base64UrlEncode(credential.response.attestationObject),
      clientDataJSON: base64UrlEncode(credential.response.clientDataJSON),
    },
  }

  const verified = await verifyRegistration({ challengeId: pre.challengeId, employeeId, credential: result, deviceName })
  return verified
}

// ---- AUTHENTICATION (usernameless, resident-key credential) ----
async function getAuthOptions() {
  const { data, error } = await supabase.functions.invoke('webauthn-auth-options', { body: {} })
  if (error) throw new Error(error.message || 'Failed to start biometric authentication')
  if (data?.error) throw new Error(data.error || 'Failed to start biometric authentication')
  return data
}

async function verifyAuth({ challengeId, credential }) {
  const { data, error } = await supabase.functions.invoke('webauthn-auth-verify', {
    body: { challengeId, credential },
  })
  if (error) throw new Error(error.message || 'Biometric authentication failed')
  if (!data?.ok) throw new Error(data?.error || 'Biometric authentication failed')
  return data
}

// Returns { employee: { id, full_name, employee_number, department, branch } }
async function authenticate() {
  if (!isWebAuthnSupported()) {
    throw new Error('WebAuthn is not supported in this browser.')
  }

  const pre = await getAuthOptions()
  const options = pre.options

  const publicKey = {
    ...options,
    challenge: base64UrlDecode(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((c) => ({
      ...c,
      id: base64UrlDecode(c.id),
    })),
  }

  const credential = await window.navigator.credentials.get({ publicKey })

  const result = {
    id: credential.id,
    rawId: base64UrlEncode(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {},
    response: {
      authenticatorData: base64UrlEncode(credential.response.authenticatorData),
      clientDataJSON: base64UrlEncode(credential.response.clientDataJSON),
      signature: base64UrlEncode(credential.response.signature),
      userHandle: credential.response.userHandle ? base64UrlEncode(credential.response.userHandle) : null,
    },
  }

  const verified = await verifyAuth({ challengeId: pre.challengeId, credential: result })
  return verified
}

// ---- Credential list / revoke (self-service + HR) ----
async function listCredentials({ employeeId } = {}) {
  let query = supabase
    .from('employee_auth_credentials')
    .select('id, employee_id, external_id, device_name, authenticator_type, created_at, last_used_at, revoked_at, employees(full_name, employee_number, staff_id, employee_code)')
    .is('revoked_at', null)
  if (employeeId) query = query.eq('employee_id', employeeId)
  const { data, error } = await query.order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

async function removeCredential(credentialId) {
  const { data, error } = await supabase.rpc('revoke_employee_credential', { p_credential_id: credentialId })
  if (error) throw error
  return data
}

async function listMyCredentials() {
  const { data, error } = await supabase.rpc('list_my_auth_credentials')
  if (error) throw error
  return data || []
}

export const biometricService = {
  isWebAuthnSupported,
  registerDevice,
  authenticate,
  listCredentials,
  removeCredential,
  listMyCredentials,
}

export default biometricService