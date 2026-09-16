// Supabase Edge Function: webauthn-register-verify
//
// Verifies the WebAuthn attestation response and persists the new
// credential (public key + credential ID) in employee_auth_credentials.
// This function runs with the service role — RLS is bypassed.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verifyRegistrationResponse } from 'npm:@simplewebauthn/server@10.0.0'

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function originOf(req) {
  return req.headers.get('Origin') || `https://${req.headers.get('Host') || 'localhost'}`
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !serviceRoleKey || !anonKey) return json({ error: 'env_missing' }, 500)

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const authHeader = req.headers.get('Authorization') || ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'unauthorized' }, 401)
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) return json({ error: 'unauthorized' }, 401)

  const body = await req.json()
  const { challengeId, employeeId, credential, deviceName } = body
  if (!challengeId || !employeeId || !credential) {
    return json({ error: 'missing_fields', message: 'challengeId, employeeId, credential are required' }, 400)
  }

  // Load challenge (must be register, not used, not expired)
  const { data: challenge } = await admin
    .from('webauthn_challenges')
    .select('id, challenge, employee_id, expires_at, used_at')
    .eq('id', challengeId)
    .maybeSingle()
  if (!challenge) return json({ error: 'challenge_not_found' }, 400)
  if (challenge.used_at) return json({ error: 'challenge_already_used' }, 400)
  if (new Date(challenge.expires_at).getTime() < Date.now()) return json({ error: 'challenge_expired' }, 400)
  if (challenge.employee_id !== employeeId) return json({ error: 'challenge_employee_mismatch' }, 400)

  const expectedOrigin = originOf(req)
  const rpID = new URL(expectedOrigin).hostname

  const verification = await verifyRegistrationResponse({
    response: {
      attestationObject: credential.response.attestationObject,
      clientDataJSON: credential.response.clientDataJSON,
      getAuthenticatorData() {
        return this.authenticatorData
      },
      getPublicKey() {
        return this.publicKey
      },
      getPublicKeyAlgorithm() {
        return this.publicKeyAlgorithm
      },
      getRawId() {
        return this.rawId
      },
    },
    expectedChallenge: challenge.challenge,
    expectedOrigin,
    expectedRPID: rpID,
    requireUserVerification: true,
  })

  if (!verification?.verified || !verification?.registrationInfo?.credential) {
    await admin.from('audit_logs').insert({
      action: 'CREDENTIAL_REGISTER_FAILED',
      entity_type: 'EmployeeCredential',
      entity_id: employeeId,
      user_name: user.email,
      details: 'WebAuthn registration verification failed',
      severity: 'warning',
    })
    return json({ error: 'verification_failed', message: 'Attestation could not be verified' }, 400)
  }

  const credInfo = verification.registrationInfo.credential
  const { data: existingCred } = await admin
    .from('employee_auth_credentials')
    .select('id')
    .eq('external_id', credInfo.id)
    .eq('employee_id', employeeId)
    .maybeSingle()

  if (existingCred) {
    // Already registered — update the metadata if needed
    await admin
      .from('employee_auth_credentials')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', existingCred.id)

    await admin.from('webauthn_challenges').update({ used_at: new Date() }).eq('id', challengeId)

    await admin.from('audit_logs').insert({
      action: 'CREDENTIAL_REGISTER_COMPLETED',
      entity_type: 'EmployeeCredential',
      entity_id: existingCred.id,
      user_name: user.email,
      details: `Existing credential re-registered for employee ${employeeId}`,
      severity: 'info',
    })

    return json({ ok: true, credentialId: existingCred.id, alreadyExists: true })
  }

  const { data: newCred, error: insertError } = await admin
    .from('employee_auth_credentials')
    .insert({
      employee_id: employeeId,
      external_id: credInfo.id,
      public_key: credInfo.publicKey,
      counter: Number(credInfo.counter) || 0,
      device_name: deviceName || null,
      authenticator_type: verification.registrationInfo.credentialDeviceType === 'multiDevice' ? 'platform' : 'cross-platform',
      created_by: user.id,
    })
    .select('id')
    .single()
  if (insertError) return json({ error: 'credential_store_failed', message: insertError.message }, 500)

  // Mark challenge consumed
  await admin
    .from('webauthn_challenges')
    .update({ used_at: new Date().toISOString(), consumed_external_id: credInfo.id })
    .eq('id', challengeId)

  await admin.from('audit_logs').insert({
    action: 'CREDENTIAL_REGISTERED',
    entity_type: 'EmployeeCredential',
    entity_id: newCred.id,
    user_name: user.email,
    details: `WebAuthn credential registered for employee ${employeeId}`,
    severity: 'info',
  })

  return json({ ok: true, credentialId: newCred.id })
})