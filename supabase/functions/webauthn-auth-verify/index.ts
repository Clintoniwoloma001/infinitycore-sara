// Supabase Edge Function: webauthn-auth-verify
//
// Verifies a WebAuthn authentication assertion. The credential is
// looked up by external_id from the response, the signed challenge
// is verified, and the employee is identified (the attendance terminal
// reads the employee record from the verified credential).
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verifyAuthenticationResponse } from 'npm:@simplewebauthn/server@10.0.0'

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
  if (!supabaseUrl || !serviceRoleKey) return json({ error: 'env_missing' }, 500)

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const body = await req.json()
  const { challengeId, credential } = body
  if (!challengeId || !credential) {
    return json({ error: 'missing_fields', message: 'challengeId and credential are required' }, 400)
  }

  // Load challenge
  const { data: challenge } = await admin
    .from('webauthn_challenges')
    .select('id, challenge, expires_at, used_at')
    .eq('id', challengeId)
    .maybeSingle()
  if (!challenge) return json({ error: 'challenge_not_found' }, 400)
  if (challenge.used_at) return json({ error: 'challenge_already_used' }, 400)
  if (new Date(challenge.expires_at).getTime() < Date.now()) return json({ error: 'challenge_expired' }, 400)

  // Find the credential row by external_id (must not be revoked)
  const { data: credRow } = await admin
    .from('employee_auth_credentials')
    .select('id, external_id, public_key, counter, employee_id')
    .eq('external_id', credential.id)
    .is('revoked_at', null)
    .maybeSingle()
  if (!credRow) {
    await admin.from('audit_logs').insert({
      action: 'CREDENTIAL_AUTH_FAILED',
      entity_type: 'EmployeeCredential',
      entity_id: null,
      user_name: null,
      details: `Unknown or revoked credential ${credential.id} used in authentication`,
      severity: 'warning',
    })
    return json({ error: 'credential_not_found', message: 'Credential is not registered or has been revoked' }, 400)
  }

  // Load the employee record (for RLS-safe response and audit)
  const { data: employee } = await admin
    .from('employees')
    .select('id, full_name, employee_number, staff_id, employee_code, department, branch, position, employment_status')
    .eq('id', credRow.employee_id)
    .maybeSingle()
  if (!employee) return json({ error: 'employee_not_found' }, 400)
  if (employee.employment_status !== 'active') {
    return json({ error: 'employee_inactive', message: `Employee is ${employee.employment_status} and cannot clock in or out.` }, 400)
  }

  const expectedOrigin = originOf(req)
  const rpID = new URL(expectedOrigin).hostname

  const verification = await verifyAuthenticationResponse({
    response: {
      authenticatorData: credential.response.authenticatorData,
      clientDataJSON: credential.response.clientDataJSON,
      signature: credential.response.signature,
      userHandle: credential.response.userHandle,
      getAuthenticatorData() {
        return this.authenticatorData
      },
      getRawId() {
        return this.rawId
      },
    },
    expectedChallenge: challenge.challenge,
    expectedOrigin,
    expectedRPID: rpID,
    credential: {
      id: credRow.external_id,
      publicKey: credRow.public_key,
      counter: Number(credRow.counter) || 0,
    },
    requireUserVerification: true,
  })

  if (!verification?.verified) {
    await admin.from('audit_logs').insert({
      action: 'CREDENTIAL_AUTH_FAILED',
      entity_type: 'EmployeeCredential',
      entity_id: credRow.id,
      user_name: null,
      details: `Authentication verification failed for credential ${credRow.external_id} (employee ${credRow.employee_id})`,
      severity: 'warning',
    })
    return json({ error: 'verification_failed', message: 'Signature verification failed' }, 400)
  }

  // Update counter and last_used_at
  await admin
    .from('employee_auth_credentials')
    .update({
      counter: Number(verification.authenticationInfo?.newCounter) || Number(credRow.counter) + 1,
      last_used_at: new Date().toISOString(),
    })
    .eq('id', credRow.id)

  // Consume the challenge
  await admin
    .from('webauthn_challenges')
    .update({ used_at: new Date().toISOString(), consumed_external_id: credential.id })
    .eq('id', challengeId)

  await admin.from('audit_logs').insert({
    action: 'CREDENTIAL_AUTHENTICATED',
    entity_type: 'EmployeeCredential',
    entity_id: credRow.id,
    user_name: employee.full_name,
    details: `WebAuthn authentication succeeded for employee ${employee.full_name}`,
    severity: 'info',
  })

  return json({
    ok: true,
    employee: {
      id: employee.id,
      full_name: employee.full_name,
      employee_number: employee.employee_number || employee.staff_id || employee.employee_code,
      department: employee.department,
      branch: employee.branch,
      position: employee.position,
      employment_status: employee.employment_status,
    },
  })
})