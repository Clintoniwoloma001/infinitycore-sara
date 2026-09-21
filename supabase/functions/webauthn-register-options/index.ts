// Supabase Edge Function: webauthn-register-options
//
// Issues a WebAuthn registration challenge for enrolling a device
// (phone / laptop / YubiKey platform authenticator) for an employee.
// Only HR staff or the employee themselves may register.
//
// The challenge is stored server-side (webauthn_challenges) and expires
// in 10 minutes. The actual biometric never reaches this function or the
// DB — the device's authenticator builds the credential locally.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  generateRegistrationOptions,
  isoBase64URL,
} from 'npm:@simplewebauthn/server@10.0.0'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

function originOf(req) {
  return req.headers.get('Origin') || `https://${req.headers.get('Host') || 'localhost'}`
}

const HR_ROLES = ['super_admin', 'admin', 'head_of_human_resources', 'hr_officer']

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const authHeader = req.headers.get('Authorization') || ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'unauthorized' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !serviceRoleKey || !anonKey) return json({ error: 'env_missing' }, 500)

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) return json({ error: 'unauthorized' }, 401)

  // Caller role + target employee
  const { data: profile } = await userClient
    .from('profiles')
    .select('role, full_name')
    .eq('id', user.id)
    .single()
  const actorRole = profile?.role || 'customer'

  const body = await req.json()
  const { employeeId, authenticatorType = 'platform', deviceName } = body
  if (!employeeId) return json({ error: 'employee_required' }, 400)

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: employee } = await admin
    .from('employees')
    .select('id, full_name, email, user_id, employee_number, staff_id, employee_code')
    .eq('id', employeeId)
    .maybeSingle()
  if (!employee) return json({ error: 'employee_required' }, 400)

  // Permission: HR roles, or the employee themselves
  const isHR = HR_ROLES.includes(actorRole)
  const isSelf = employee.user_id === user.id
  if (!isHR && !isSelf) return json({ error: 'forbidden', message: 'Not authorized to enroll this employee' }, 403)

  // Existing registered (non-revoked) credentials for exclude list
  const { data: existing } = await admin
    .from('employee_auth_credentials')
    .select('external_id')
    .eq('employee_id', employee.id)
    .is('revoked_at', null)

  const rpID = new URL(originOf(req)).hostname
  const userHandle = isoBase64URL.fromString(employee.id)

  const options = await generateRegistrationOptions({
    rpName: 'InfinityCore',
    rpID,
    userName: employee.full_name || employee.email || employee.id,
    userDisplayName: employee.full_name || 'Employee',
    userID: isoBase64URL.toBuffer(userHandle),
    attestationType: 'none',
    authenticatorSelection: {
      authenticatorAttachment: authenticatorType,
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
    excludeCredentials: (existing || []).map((c) => ({
      id: c.external_id,
      type: 'public-key',
      transports: ['internal', 'hybrid'],
    })),
    timeout: 60000,
  })

  // Persist the challenge for later verification (10 min TTL)
  const { data: challengeRow, error: challengeError } = await admin
    .from('webauthn_challenges')
    .insert({
      challenge: options.challenge,
      employee_id: employee.id,
      purpose: 'register',
      created_by: user.id,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })
    .select('id')
    .single()
  if (challengeError) return json({ error: 'challenge_store_failed', message: challengeError.message }, 500)

  await admin.from('audit_logs').insert({
    action: 'CREDENTIAL_REGISTER_STARTED',
    entity_type: 'EmployeeCredential',
    entity_id: employee.id,
    user_name: profile?.full_name || user.email,
    details: `WebAuthn registration started for employee ${employee.full_name} by ${actorRole}`,
    severity: 'info',
  })

  return json({
    ok: true,
    challengeId: challengeRow.id,
    options,
  })
})