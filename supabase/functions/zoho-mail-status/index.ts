// Supabase Edge Function: zoho-mail-status
//
// Backend-only connection-status / TEST function (requirements 8 & 9).
// It checks server config + the stored zoho_mail connection, and in "test"
// mode decrypts the stored refresh token, refreshes an access token
// server-side, and calls GET /api/accounts to read the sending accountId and
// permitted From addresses so the Head of Audit can VERIFY them before any
// sending is enabled. It NEVER sends an email and NEVER returns a token, the
// client secret, or the encryption key (requirement 5). Only Head of Audit /
// admin / super_admin may call it.
//
// Body: { _check: true } -> config + stored-connection status only
//       { test: true }   -> also a live account lookup (still no send)
//
// Secrets (server-side only): ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET,
//   ZOHO_TOKEN_ENCRYPTION_KEY.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  ZOHO_TOKEN_URL,
  ZOHO_GET_ACCOUNTS_URL,
  ZOHO_SCOPE_STRING,
  PROVIDER,
  ENVIRONMENT,
  ZOHO_MAIL_ROLES,
  buildRefreshBody,
  normalizeTokenResponse,
  extractAccountInfo,
  decryptSecret,
  decodeKey,
} from '../_shared/zoho-mail.mjs'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const authHeader = req.headers.get('Authorization') || ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'unauthorized' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const zohoClientId = Deno.env.get('ZOHO_CLIENT_ID')
  const zohoClientSecret = Deno.env.get('ZOHO_CLIENT_SECRET')
  const encryptionKey = Deno.env.get('ZOHO_TOKEN_ENCRYPTION_KEY')

  if (!supabaseUrl || !anonKey || !serviceRoleKey) return json({ error: 'env_missing' }, 500)

  const configured = Boolean(zohoClientId && zohoClientSecret && encryptionKey)

  // Authenticate + authorize the caller.
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) return json({ error: 'unauthorized' }, 401)

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
  const { data: profile } = await admin.from('profiles').select('role, status').eq('id', user.id).maybeSingle()
  if (!profile || !ZOHO_MAIL_ROLES.includes(profile.role)) {
    return json({ error: 'forbidden', message: 'Not permitted to view Zoho Mail status.' }, 403)
  }

  // Stored connection state (service-role read; RLS denies all client access).
  const { data: conn } = await admin
    .from('integration_connections')
    .select('connected, enabled, secret_hint, provider_account_id, last_connected_at, token_expires_at')
    .eq('provider', PROVIDER)
    .eq('environment', ENVIRONMENT)
    .maybeSingle()

  const body = await req.json().catch(() => ({}))
  const baseStatus = {
    provider: PROVIDER,
    configured,
    connected: Boolean(conn?.connected),
    enabled: Boolean(conn?.enabled),
    scopes: ZOHO_SCOPE_STRING,
    accountId: conn?.provider_account_id || null,
    lastConnectedAt: conn?.last_connected_at || null,
    // Masked only — never the raw token.
    refreshTokenHint: conn?.secret_hint ? `****${conn.secret_hint}` : null,
  }

  // _check (default): config + stored status only, no network call.
  if (body?.test !== true) {
    return json({ ...baseStatus, tested: false }, 200)
  }

  // test mode: do a live account lookup. STILL NO SEND.
  if (!configured) {
    return json({ ...baseStatus, tested: true, ok: false, error: 'not_configured',
      message: 'ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_TOKEN_ENCRYPTION_KEY are not all set on the server.' }, 200)
  }
  if (!conn?.connected) {
    return json({ ...baseStatus, tested: true, ok: false, error: 'not_connected',
      message: 'Zoho Mail is not connected yet. Complete the OAuth flow first.' }, 200)
  }


  // Read the FULL row (service role) to get the encrypted refresh token.
  const { data: full } = await admin
    .from('integration_connections')
    .select('encrypted_secret, token_expires_at')
    .eq('provider', PROVIDER)
    .eq('environment', ENVIRONMENT)
    .maybeSingle()

  if (!full?.encrypted_secret) {
    return json({ ...baseStatus, tested: true, ok: false, error: 'no_refresh_token',
      message: 'No stored refresh token. Re-run the OAuth connection.' }, 200)
  }

  // Decrypt the refresh token (server-side only) and refresh an access token.
  let refreshToken
  try {
    refreshToken = await decryptSecret(full.encrypted_secret, decodeKey(encryptionKey))
  } catch (e) {
    return json({ ...baseStatus, tested: true, ok: false, error: 'decrypt_failed',
      message: 'Could not decrypt the stored refresh token. Check ZOHO_TOKEN_ENCRYPTION_KEY.' }, 200)
  }

  const tokenRes = await fetch(ZOHO_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: buildRefreshBody({ refreshToken, clientId: zohoClientId, clientSecret: zohoClientSecret }),
  })

  if (!tokenRes.ok) {
    await admin.from('integration_connections').update({ connected: false }).eq('provider', PROVIDER).eq('environment', ENVIRONMENT)
    await admin.from('audit_logs').insert({
      action: 'ZOHO_MAIL_TEST_FAILED',
      entity_type: 'IntegrationConnection',
      entity_id: user.id,
      user_name: user.email || user.id,
      details: `Zoho token refresh failed with HTTP ${tokenRes.status}.`,
      severity: 'warning',
    })
    return json({ ...baseStatus, connected: false, tested: true, ok: false, error: 'refresh_failed',
      message: 'The stored refresh token was rejected. Please reconnect Zoho Mail.' }, 200)
  }

  const tokens = normalizeTokenResponse(await tokenRes.json())
  if (!tokens.accessToken) {
    return json({ ...baseStatus, tested: true, ok: false, error: 'no_access_token', message: 'Zoho returned no access token.' }, 200)
  }

  // Get All Accounts -> sending accountId + permitted From addresses.
  const accRes = await fetch(ZOHO_GET_ACCOUNTS_URL, {
    method: 'GET',
    headers: { 'Authorization': `Zoho-oauthtoken ${tokens.accessToken}`, 'Accept': 'application/json' },
  })

  if (!accRes.ok) {
    await admin.from('audit_logs').insert({
      action: 'ZOHO_MAIL_TEST_FAILED',
      entity_type: 'IntegrationConnection',
      entity_id: user.id,
      user_name: user.email || user.id,
      details: `Get All Accounts failed with HTTP ${accRes.status}.`,
      severity: 'warning',
    })
    return json({ ...baseStatus, tested: true, ok: false, error: 'accounts_api_failed',
      message: `Zoho Mail /api/accounts returned HTTP ${accRes.status}. Confirm the ZohoMail.accounts.READ scope is granted.` }, 200)
  }

  const info = extractAccountInfo(await accRes.json())

  // Persist the verified accountId so the Head of Audit can confirm WHICH
  // mailbox would send (requirement 9). This still sends NOTHING.
  if (info.ok && info.primaryAccount?.accountId) {
    await admin.from('integration_connections')
      .update({ provider_account_id: info.primaryAccount.accountId, last_success_at: new Date().toISOString() })
      .eq('provider', PROVIDER)
      .eq('environment', ENVIRONMENT)
  }

  await admin.from('audit_logs').insert({
    action: 'ZOHO_MAIL_TEST_OK',
    entity_type: 'IntegrationConnection',
    entity_id: user.id,
    user_name: user.email || user.id,
    details: `Zoho Mail connection verified. accountId=${info.primaryAccount?.accountId || 'none'} from=${info.primaryAccount?.primaryEmail || 'none'}. No email sent.`,
    severity: 'info',
  })

  return json({
    ...baseStatus,
    tested: true,
    ok: info.ok,
    accountId: info.primaryAccount?.accountId || null,
    primaryEmail: info.primaryAccount?.primaryEmail || null,
    fromAddresses: info.primaryAccount?.fromAddresses || [],
    accounts: info.accounts.length,
    readyToSend: false, // sending is intentionally NOT enabled yet (requirement 9)
    message: info.ok
      ? 'Connection verified. Review the sending mailbox above, then an administrator may enable sending later. No email was sent by this test.'
      : 'Connected, but Zoho returned no accounts to send from.',
  }, 200)
})
