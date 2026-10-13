// Supabase Edge Function: zoho-oauth-start
//
// STEP 1 of the Zoho Mail server-side OAuth (authorization-code) flow.
//
// This function BUILDS THE AUTHORIZE URL SERVER-SIDE and returns it to the
// caller (requirement 1: no OAuth logic in browser JS / mobile). It also
// generates a cryptographically-random `state`, persists it (short-lived,
// single-use) in zoho_oauth_states, and hands it back. The browser only OPENS
// the returned URL — it never assembles the authorize request.
//
// The code exchange and token storage happen in zoho-oauth-callback. This
// function does NOT exchange anything and does NOT send any mail.
//
// Secrets needed (server-side only — `supabase secrets set`):
//   ZOHO_CLIENT_ID
//   (Client Secret is only needed by the callback, not here.)
// Optional:
//   OAUTH_REDIRECT_BASE  — override the callback host; defaults to SUPABASE_URL
//
// Deployed callback URL (register EXACTLY this in the Zoho API Console):
//   https://<project-ref>.supabase.co/functions/v1/zoho-oauth-callback

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  ZOHO_MAIL_ROLES,
  ZOHO_SCOPE_STRING,
  STATE_TTL_SECONDS,
  CALLBACK_FUNCTION_NAME,
  buildRedirectUri,
  buildAuthorizeUrl,
  generateState,
} from '../_shared/zoho-mail.mjs'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  // Authenticate the caller. Only Head of Audit / admin / super_admin may start.
  const authHeader = req.headers.get('Authorization') || ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'unauthorized' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const zohoClientId = Deno.env.get('ZOHO_CLIENT_ID')
  const redirectBase = Deno.env.get('OAUTH_REDIRECT_BASE') || supabaseUrl

  if (!supabaseUrl || !anonKey || !serviceRoleKey) return json({ error: 'env_missing' }, 500)
  if (!zohoClientId) {
    return json({ status: 'not_configured', error: 'ZOHO_CLIENT_ID is not set on the server.' }, 200)
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) return json({ error: 'unauthorized' }, 401)

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
  const { data: profile } = await admin
    .from('profiles')
    .select('role, status, full_name')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile || !ZOHO_MAIL_ROLES.includes(profile.role)) {
    return json({ error: 'forbidden', message: 'Only the Head of Audit or an administrator may connect Zoho Mail.' }, 403)
  }
  if (profile.status && !['active', 'approved'].includes(profile.status)) {
    return json({ error: 'forbidden', message: 'Your account is not active.' }, 403)
  }

  // Generate + persist the CSRF state (short-lived, single-use).
  const state = generateState()
  const expiresAt = new Date(Date.now() + STATE_TTL_SECONDS * 1000).toISOString()
  const { error: stateErr } = await admin.from('zoho_oauth_states').insert({
    state,
    created_by: user.id,
    expires_at: expiresAt,
  })
  if (stateErr) return json({ error: 'state_store_failed' }, 500)

  const authorizeUrl = buildAuthorizeUrl({ base: redirectBase, clientId: zohoClientId, state })
  const callbackUrl = buildRedirectUri(redirectBase)

  await admin.from('audit_logs').insert({
    action: 'ZOHO_OAUTH_STARTED',
    entity_type: 'IntegrationConnection',
    entity_id: user.id,
    user_name: profile.full_name || user.email || user.id,
    details: `Zoho Mail OAuth authorize URL issued (state ttl=${STATE_TTL_SECONDS}s, scopes=${ZOHO_SCOPE_STRING})`,
    severity: 'info',
  })

  // Return ONLY the URL to open + metadata. No client secret, no tokens.
  return json({
    status: 'ok',
    authorizeUrl,
    callbackUrl,
    scopes: ZOHO_SCOPE_STRING,
    stateTtlSeconds: STATE_TTL_SECONDS,
    callbackFunction: CALLBACK_FUNCTION_NAME,
  }, 200)
})
