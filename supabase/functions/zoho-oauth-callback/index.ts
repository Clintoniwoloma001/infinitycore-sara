// Supabase Edge Function: zoho-oauth-callback
//
// STEP 2 of the Zoho Mail server-side OAuth (authorization-code) flow.
// Zoho redirects the browser here with ?code=...&state=... . This function:
//   1. Validates `state` against zoho_oauth_states — rejects unknown, expired,
//      or already-consumed (replayed) state (requirement 3 / CSRF).
//   2. Atomically consumes the state so it can never be reused.
//   3. Exchanges the code for tokens SERVER-SIDE ONLY via ZOHO_CLIENT_ID /
//      ZOHO_CLIENT_SECRET (requirement 4/5).
//   4. Encrypts the refresh token (AES-256-GCM) into integration_connections
//      .encrypted_secret — never exposed to any client, log, or API response.
//   5. Does NOT send any mail (requirements 8/9).
//
// verify_jwt = false (browser redirect target). Security = single-use state.
//
// Secrets (server-side only — `supabase secrets set`):
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET,
//   ZOHO_TOKEN_ENCRYPTION_KEY (32 bytes, base64 or 64-char hex)
// Optional: OAUTH_REDIRECT_BASE (must match zoho-oauth-start).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  ZOHO_TOKEN_URL,
  PROVIDER,
  ENVIRONMENT,
  CALLBACK_FUNCTION_NAME,
  buildRedirectUri,
  buildTokenExchangeBody,
  normalizeTokenResponse,
  encryptSecret,
  decodeKey,
  secretHint,
} from '../_shared/zoho-mail.mjs'

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// Branded HTML page shown in the popup. NEVER contains a token or secret.
function resultPage(ok, title, message) {
  const color = ok ? '#009944' : '#dc2626'
  return new Response(
    `<html><body style="font-family: sans-serif; text-align: center; padding: 40px;">
       <h2 style="color: ${color};">${ok ? '✓' : '✗'} ${title}</h2>
       <p>${message}</p>
       <script>
         if (window.opener) {
           window.opener.postMessage({ type: 'zoho_oauth_complete', success: ${ok} }, '*');
         }
         setTimeout(() => window.close(), 2000);
       </script>
     </body></html>`,
    { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html' } },
  )
}

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  if (error) return resultPage(false, 'Authorization Failed', `Zoho returned: ${error}`)
  if (!code || !state) return json({ error: 'missing_params' }, 400)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const zohoClientId = Deno.env.get('ZOHO_CLIENT_ID')
  const zohoClientSecret = Deno.env.get('ZOHO_CLIENT_SECRET')
  const encryptionKey = Deno.env.get('ZOHO_TOKEN_ENCRYPTION_KEY')
  // redirect_uri MUST be byte-identical to the one zoho-oauth-start sent.
  const redirectBase = Deno.env.get('OAUTH_REDIRECT_BASE') || supabaseUrl

  if (!supabaseUrl || !serviceRoleKey) return json({ error: 'env_missing' }, 500)
  if (!zohoClientId || !zohoClientSecret) return json({ error: 'zoho_not_configured' }, 500)
  if (!encryptionKey) return json({ error: 'encryption_key_missing' }, 500)

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })

  // ---- 1 & 2. Validate + atomically consume the state (CSRF, single-use) ----
  // UPDATE ... WHERE consumed_at IS NULL AND expires_at > now() guarantees an
  // unknown, expired, or already-used state updates ZERO rows -> rejected.
  const { data: consumed, error: consumeErr } = await admin
    .from('zoho_oauth_states')
    .update({ consumed_at: new Date().toISOString() })
    .eq('state', state)
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('created_by')
    .maybeSingle()

  if (consumeErr) return json({ error: 'state_check_failed' }, 500)
  if (!consumed) {
    await admin.from('audit_logs').insert({
      action: 'ZOHO_OAUTH_STATE_REJECTED',
      entity_type: 'IntegrationConnection',
      entity_id: state.slice(0, 8),
      user_name: CALLBACK_FUNCTION_NAME,
      details: 'Invalid, expired, or replayed OAuth state rejected.',
      severity: 'warning',
    })
    return resultPage(false, 'Invalid or Expired Link',
      'This authorization link is invalid, expired, or was already used. Please start again from InfinityCore.')
  }

  const userId = consumed.created_by

  // ---- 3. Exchange the code for tokens (server-side only) ----
  const redirectUri = buildRedirectUri(redirectBase)
  let tokenRes
  try {
    tokenRes = await fetch(ZOHO_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: buildTokenExchangeBody({
        code,
        clientId: zohoClientId,
        clientSecret: zohoClientSecret,
        redirectUri,
      }),
    })
  } catch (e) {
    return json({ error: `token_request_failed: ${String(e.message || e)}` }, 502)
  }

  if (!tokenRes.ok) {
    await admin.from('audit_logs').insert({
      action: 'ZOHO_OAUTH_EXCHANGE_FAILED',
      entity_type: 'IntegrationConnection',
      entity_id: userId,
      user_name: CALLBACK_FUNCTION_NAME,
      details: `Zoho token exchange failed with HTTP ${tokenRes.status}.`, // no body: may echo secrets
      severity: 'warning',
    })
    return resultPage(false, 'Connection Failed', 'Zoho could not complete the token exchange. Please try again.')
  }

  const tokens = normalizeTokenResponse(await tokenRes.json())
  if (!tokens.accessToken) return json({ error: 'no_access_token' }, 400)

  // ---- 4. Encrypt the refresh token and store it (never in plaintext) ----
  const expiresAt = new Date(Date.now() + (tokens.expiresIn || 3600) * 1000).toISOString()
  let encryptedRefresh = null
  let hint = null
  if (tokens.refreshToken) {
    try {
      encryptedRefresh = await encryptSecret(tokens.refreshToken, decodeKey(encryptionKey))
      hint = secretHint(tokens.refreshToken)
    } catch (e) {
      return json({ error: `encryption_failed: ${String(e.message || e)}` }, 500)
    }
  } else {
    await admin.from('audit_logs').insert({
      action: 'ZOHO_OAUTH_NO_REFRESH_TOKEN',
      entity_type: 'IntegrationConnection',
      entity_id: userId,
      user_name: CALLBACK_FUNCTION_NAME,
      details: 'Zoho did not return a refresh token (offline access missing?).',
      severity: 'warning',
    })
  }

  // Upsert the connection row PER USER (multi-mailbox): each account stores its
  // OWN mailbox. The ENCRYPTED refresh token only is kept; the access token is
  // intentionally NOT persisted (the status/test function refreshes on demand).
  const { data: existing } = await admin
    .from('integration_connections')
    .select('id')
    .eq('provider', PROVIDER)
    .eq('environment', ENVIRONMENT)
    .eq('user_id', userId)
    .maybeSingle()

  const baseRow = {
    provider: PROVIDER,
    environment: ENVIRONMENT,
    user_id: userId,
    client_id: zohoClientId,
    authentication_type: 'oauth2_authorization_code_offline',
    token_endpoint: ZOHO_TOKEN_URL,
    base_url: 'https://mail.zoho.com/api/',
    encrypted_secret: encryptedRefresh,
    secret_hint: hint,
    connected: true,
    enabled: true,
    token_expires_at: expiresAt,
    last_connected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  if (existing) {
    await admin.from('integration_connections').update(baseRow).eq('id', existing.id)
  } else {
    await admin.from('integration_connections').insert(baseRow)
  }

  await admin.from('audit_logs').insert({
    action: 'ZOHO_MAIL_CONNECTED',
    entity_type: 'IntegrationConnection',
    entity_id: userId,
    user_name: CALLBACK_FUNCTION_NAME,
    details: 'Zoho Mail OAuth connected. Refresh token stored encrypted. No email sent.',
    severity: 'info',
  })

  return resultPage(true, 'Zoho Mail Connected',
    'You can close this window and return to InfinityCore. Use "Test connection" to verify the sending mailbox before enabling reminders.')
})

