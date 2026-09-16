// Supabase Edge Function: webauthn-auth-options
//
// Issues a WebAuthn authentication challenge (usernameless — resident
// credential). Any registered employee may authenticate via their
// enrolled device; the Edge Function identifies them by the credential
// ID returned by the authenticator.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { generateAuthenticationOptions } from 'npm:@simplewebauthn/server@10.0.0'

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

  const expectedOrigin = originOf(req)
  const rpID = new URL(expectedOrigin).hostname

  // Collect all active (non-revoked) credential external_ids as the
  // allow-list.  Even though we send them, the resident-key flow
  // typically ignores them (usernameless prompt).
  const { data: activeCreds } = await admin
    .from('employee_auth_credentials')
    .select('external_id')
    .is('revoked_at', null)

  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
    allowCredentials: (activeCreds || []).map((c) => ({
      id: c.external_id,
      type: 'public-key',
      transports: ['internal', 'hybrid'],
    })),
    timeout: 60000,
  })

  const { data: challengeRow, error: challengeError } = await admin
    .from('webauthn_challenges')
    .insert({
      challenge: options.challenge,
      employee_id: null,
      purpose: 'authenticate',
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })
    .select('id')
    .single()
  if (challengeError) return json({ error: 'challenge_store_failed', message: challengeError.message }, 500)

  return json({ ok: true, challengeId: challengeRow.id, options })
})