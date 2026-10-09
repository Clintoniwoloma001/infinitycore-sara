// Supabase Edge Function: oauth-callback
//
// Two routes, one deployable unit:
//
//   ?mode=start  (authenticated)  Mints a signed, expiring OAuth state and
//                                 returns the provider consent URL. Called by
//                                 the browser with the user's session JWT, so
//                                 the user identity is proven server-side.
//   (no mode)    (public)         The Google/Zoom redirect_uri target. Verifies
//                                 the signed state, exchanges the code
//                                 server-side, stores tokens in
//                                 integration_connections (service-role only),
//                                 and ALWAYS answers with a 302 to the app
//                                 landing page. It never returns JSON or plain
//                                 text to a browser redirect.
//
// The user is identified ONLY from the signed state minted by mode=start. A
// user id taken from a query parameter is never trusted.
//
// Secrets needed (names only — never commit values):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
//   ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET
//   OAUTH_STATE_SECRET      HMAC key for the signed state (long random string)
//   OAUTH_REDIRECT_BASE     e.g. https://<project-ref>.supabase.co (optional)
//
// This function must stay PUBLIC (verify_jwt = false): the provider redirects
// a plain browser navigation here and cannot send an Authorization header.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const STATE_TTL_SECONDS = 600 // 10 minutes
const PRODUCTION_ORIGIN = 'https://infinitymfbcore.vercel.app'
const LANDING_PATH = '/google-oauth-done.html'
const ALLOWED_ORIGINS = new Set([
  PRODUCTION_ORIGIN,
  'http://localhost:5173',
  'http://127.0.0.1:5173',
])

const enc = new TextEncoder()

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function safeOrigin(value: string | null | undefined): string {
  const raw = String(value || '').trim()
  return ALLOWED_ORIGINS.has(raw) ? raw : PRODUCTION_ORIGIN
}

// Every provider-callback outcome is a redirect to the app landing page.
function redirectToApp(status: 'ok' | 'error', reason: string, origin: string): Response {
  const base = new URL(LANDING_PATH, safeOrigin(origin))
  base.searchParams.set('status', status)
  if (reason) base.searchParams.set('reason', reason)
  return new Response(null, { status: 302, headers: { Location: base.toString() } })
}

// ---------------------------------------------------------------- state signing

function b64urlEncodeBytes(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecodeToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

async function signPayload(payload: string, secret: string): Promise<string> {
  const key = await hmacKey(secret)
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
  return b64urlEncodeBytes(new Uint8Array(signature))
}

async function mintState(
  claims: { userId: string; provider: string; origin: string },
  secret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const body = {
    uid: claims.userId,
    pv: claims.provider,
    origin: claims.origin,
    nonce: crypto.randomUUID(),
    iat: now,
    exp: now + STATE_TTL_SECONDS,
  }
  const payload = b64urlEncodeBytes(enc.encode(JSON.stringify(body)))
  return `${payload}.${await signPayload(payload, secret)}`
}

interface StateClaims {
  uid: string
  pv: string
  origin: string
  nonce: string
  iat: number
  exp: number
}

// Returns null for missing, malformed, tampered or expired state.
async function readState(state: string | null, secret: string): Promise<StateClaims | null> {
  const parts = String(state || '').split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  const [payload, signature] = parts

  const key = await hmacKey(secret)
  let valid = false
  try {
    valid = await crypto.subtle.verify('HMAC', key, b64urlDecodeToBytes(signature), enc.encode(payload))
  } catch {
    return null
  }
  if (!valid) return null

  let body: Partial<StateClaims> | null = null
  try {
    body = JSON.parse(new TextDecoder().decode(b64urlDecodeToBytes(payload)))
  } catch {
    return null
  }
  if (!body || typeof body.uid !== 'string' || !body.uid) return null
  if (typeof body.exp !== 'number' || body.exp * 1000 <= Date.now()) return null
  if (typeof body.pv !== 'string' || !body.pv) return null
  return body as StateClaims
}

// ------------------------------------------------------------ provider registry

interface ProviderConfig {
  label: string
  clientIdEnv: string
  clientSecretEnv: string
  scopes: string
  buildAuthUrl: (clientId: string, redirectUri: string, state: string) => string
  tokenUrl: string
  usesBasicAuth: boolean
}

const PROVIDERS: Record<string, ProviderConfig> = {
  google_calendar: {
    label: 'Google Calendar',
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
    scopes: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email',
    buildAuthUrl: (clientId, redirectUri, state) =>
      'https://accounts.google.com/o/oauth2/v2/auth' +
      `?client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      '&response_type=code' +
      `&scope=${encodeURIComponent(PROVIDERS.google_calendar.scopes)}` +
      '&access_type=offline&prompt=consent' +
      `&state=${encodeURIComponent(state)}`,
    tokenUrl: 'https://oauth2.googleapis.com/token',
    usesBasicAuth: false,
  },
  zoom: {
    label: 'Zoom',
    clientIdEnv: 'ZOOM_CLIENT_ID',
    clientSecretEnv: 'ZOOM_CLIENT_SECRET',
    scopes: 'meeting:write meeting:read user:read',
    buildAuthUrl: (clientId, redirectUri, state) =>
      'https://zoom.us/oauth/authorize' +
      `?client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code&state=${encodeURIComponent(state)}`,
    tokenUrl: 'https://zoom.us/oauth/token',
    usesBasicAuth: true,
  },
}

// Single source of truth for the redirect_uri, used by BOTH the start route and
// the callback route, so the value exchanged for a code is exactly the value
// that was sent to the provider.
function callbackRedirectUri(provider: string): string {
  const base = (
    Deno.env.get('OAUTH_REDIRECT_BASE') || Deno.env.get('SUPABASE_URL') || ''
  ).replace(/\/+$/, '')
  return `${base}/functions/v1/oauth-callback?provider=${provider}`
}

async function exchangeCode(
  provider: ProviderConfig,
  code: string,
  redirectUri: string,
): Promise<{ ok: boolean; tokens?: Record<string, unknown>; detail: string }> {
  const clientId = Deno.env.get(provider.clientIdEnv)
  const clientSecret = Deno.env.get(provider.clientSecretEnv)
  if (!clientId || !clientSecret) return { ok: false, detail: `${provider.clientIdEnv}/${provider.clientSecretEnv} not set` }

  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  const form = new URLSearchParams({
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  })

  if (provider.usesBasicAuth) {
    headers.Authorization = `Basic ${btoa(`${clientId}:${clientSecret}`)}`
  } else {
    form.set('client_id', clientId)
    form.set('client_secret', clientSecret)
  }

  const res = await fetch(provider.tokenUrl, { method: 'POST', headers, body: form })
  const text = await res.text()
  if (!res.ok) return { ok: false, detail: `${provider.label} token exchange returned ${res.status}` }
  try {
    return { ok: true, tokens: JSON.parse(text), detail: 'ok' }
  } catch {
    return { ok: false, detail: `${provider.label} token response was not JSON` }
  }
}

async function storeTokens(
  admin: ReturnType<typeof createClient>,
  userId: string,
  provider: string,
  tokens: Record<string, unknown>,
) {
  const expiresAt = new Date(Date.now() + (Number(tokens.expires_in) || 3600) * 1000).toISOString()
  const { data: existing } = await admin
    .from('integration_connections')
    .select('id')
    .eq('user_id', userId)
    .eq('provider', provider)
    .maybeSingle()

  const payload = {
    connected: true,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? null,
    token_expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  }

  if (existing) {
    await admin.from('integration_connections').update(payload).eq('id', existing.id)
  } else {
    await admin.from('integration_connections').insert({ user_id: userId, provider, ...payload })
  }

  // Audit only; never log token material.
  await admin.from('audit_logs').insert({
    action: `${provider}_connected`,
    entity_type: 'IntegrationConnection',
    entity_id: userId,
    details: `${provider} integration connected via signed OAuth state`,
    severity: 'info',
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    })
  }
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405)

  const url = new URL(req.url)
  const providerKey = url.searchParams.get('provider') || 'google_calendar'
  const origin = safeOrigin(url.searchParams.get('origin'))

  // ------------------------------------------------------ mode=start (authed)
  if (url.searchParams.get('mode') === 'start') {
    const provider = PROVIDERS[providerKey]
    if (!provider) return json({ error: 'unknown_provider' }, 400)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    if (!supabaseUrl || !anonKey) return json({ error: 'env_missing' }, 500)

    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'unauthorized' }, 401)

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) return json({ error: 'unauthorized' }, 401)

    const clientId = Deno.env.get(provider.clientIdEnv)
    if (!clientId) {
      return json({ status: 'not_configured', error: `${provider.clientIdEnv} not set` }, 200)
    }

    const secret = Deno.env.get('OAUTH_STATE_SECRET')
    if (!secret) {
      return json({ status: 'not_configured', error: 'OAUTH_STATE_SECRET not set' }, 200)
    }

    const state = await mintState({ userId: user.id, provider: providerKey, origin }, secret)
    return json({
      url: provider.buildAuthUrl(clientId, callbackRedirectUri(providerKey), state),
      provider: providerKey,
    })
  }

  // ------------------------------------------- provider callback (public, 302)
  const provider = PROVIDERS[providerKey]
  if (!provider) return redirectToApp('error', 'unknown_provider', origin)
  if (url.searchParams.get('error')) return redirectToApp('error', 'oauth_denied', origin)

  const code = url.searchParams.get('code')
  if (!code) return redirectToApp('error', 'missing_code', origin)

  const secret = Deno.env.get('OAUTH_STATE_SECRET')
  if (!secret) return redirectToApp('error', 'state_secret_missing', origin)

  const stateParam = url.searchParams.get('state')
  if (!stateParam) return redirectToApp('error', 'missing_state', origin)

  const claims = await readState(stateParam, secret)
  if (!claims) return redirectToApp('error', 'invalid_state', origin)
  if (claims.pv !== providerKey) return redirectToApp('error', 'provider_mismatch', origin)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) return redirectToApp('error', 'env_missing', origin)

  const admin = createClient(supabaseUrl, serviceRoleKey)
  const exchange = await exchangeCode(provider, code, callbackRedirectUri(providerKey))
  if (!exchange.ok || !exchange.tokens) {
    return redirectToApp('error', 'token_exchange_failed', claims.origin)
  }

  try {
    await storeTokens(admin, claims.uid, providerKey, exchange.tokens)
  } catch {
    return redirectToApp('error', 'store_failed', claims.origin)
  }

  return redirectToApp('ok', '', claims.origin)
})
