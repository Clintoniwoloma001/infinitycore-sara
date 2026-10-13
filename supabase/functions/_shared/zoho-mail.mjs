// ============================================================================
// _shared/zoho-mail.mjs
//
// Pure, dependency-free helpers for the InfinityCore Zoho Mail OAuth
// foundation. Imported by the zoho-oauth-start / zoho-oauth-callback /
// zoho-mail-status Edge Functions AND by tests/zohoMailOauth.test.mjs (Node).
//
// NO secrets are hard-coded here. Every credential arrives as a call argument
// or from a server-side Deno.env value at the call site. Nothing in this file
// reads process/env directly, so it is safe to unit-test in plain Node.
//
// Data center: .com (US). The Head of Audit's Zoho account and the API Console
// app both live in the .com DC, so every endpoint below is the .com endpoint.
// ============================================================================

// --- Endpoints (requirement 6: .com OAuth + Mail API base) -----------------
export const ZOHO_ACCOUNTS_ORIGIN = 'https://accounts.zoho.com'
export const ZOHO_AUTHORIZE_URL = `${ZOHO_ACCOUNTS_ORIGIN}/oauth/v2/auth`
export const ZOHO_TOKEN_URL = `${ZOHO_ACCOUNTS_ORIGIN}/oauth/v2/token`
export const ZOHO_MAIL_API_BASE = 'https://mail.zoho.com/api/'
export const ZOHO_GET_ACCOUNTS_URL = `${ZOHO_MAIL_API_BASE}accounts`

// --- Least-privilege scopes (requirement 7) --------------------------------
// Verified against Zoho's current Mail API documentation:
//   * ZohoMail.messages.CREATE — "Send an Email" API
//       POST https://mail.zoho.com/api/accounts/{accountId}/messages
//     (.ALL grants full message access and is NOT needed — we only send.)
//   * ZohoMail.accounts.READ   — "Get All Accounts of a User" API
//       GET  https://mail.zoho.com/api/accounts
//     (.READ is the least-privileged account scope; enough to read the sending
//      accountId and the permitted From addresses. .ALL is broader.)
// We deliberately do NOT request full mailbox read/write.
export const ZOHO_SCOPES = ['ZohoMail.messages.CREATE', 'ZohoMail.accounts.READ']
export const ZOHO_SCOPE_STRING = ZOHO_SCOPES.join(',')

// Who may initiate / verify the connection. The Head of Audit owns the mailbox;
// super_admin / admin can administer it. No other role can touch this.
export const ZOHO_MAIL_ROLES = ['super_admin', 'admin', 'head_of_audit']

// CSRF state lifetime — short-lived by design (requirement 3).
export const STATE_TTL_SECONDS = 600 // 10 minutes

export const CALLBACK_FUNCTION_NAME = 'zoho-oauth-callback'
export const PROVIDER = 'zoho_mail'
export const ENVIRONMENT = 'live' // .com is the production US data center

// ---------------------------------------------------------------------------
// base64 helpers (Uint8Array <-> base64). Chunk-safe so a large ciphertext
// never overflows the String.fromCharCode call stack.
// ---------------------------------------------------------------------------
export function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < arr.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, arr.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function base64ToBytes(b64) {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

// ---------------------------------------------------------------------------
// redirect_uri — ONE builder, shared by the authorize step (zoho-oauth-start)
// and the token-exchange step (zoho-oauth-callback). Zoho requires the two to
// be byte-equal or it rejects the exchange with redirect_uri_mismatch, so this
// MUST be the single source of truth. `base` = OAUTH_REDIRECT_BASE || SUPABASE_URL.
// The callback URL is NEVER hard-coded — it is derived from the live project URL.
// ---------------------------------------------------------------------------
export function buildRedirectUri(base) {
  const clean = String(base || '').trim().replace(/\/+$/, '')
  return `${clean}/functions/v1/${CALLBACK_FUNCTION_NAME}`
}

// ---------------------------------------------------------------------------
// OAuth `state` — server-generated, unguessable CSRF nonce (requirement 3).
// The value is persisted server-side in zoho_oauth_states and validated
// (exists + not expired + not already consumed) on the callback.
// ---------------------------------------------------------------------------
export function generateState(randomBytes = 32) {
  const bytes = new Uint8Array(randomBytes)
  crypto.getRandomValues(bytes)
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function isValidStateShape(state) {
  return typeof state === 'string' && /^[A-Za-z0-9_-]{22,64}$/.test(state)
}

// ---------------------------------------------------------------------------
// authorize URL — built SERVER-SIDE only (requirement 1). The browser never
// constructs this; it only opens the URL the server returns.
// access_type=offline + prompt=consent => Zoho issues a refresh token.
// ---------------------------------------------------------------------------
export function buildAuthorizeUrl({ base, clientId, state }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: buildRedirectUri(base),
    scope: ZOHO_SCOPE_STRING,
    access_type: 'offline',
    prompt: 'consent',
    state,
  })
  return `${ZOHO_AUTHORIZE_URL}?${params.toString()}`
}

// ---------------------------------------------------------------------------
// Token exchange (authorization_code) and refresh (refresh_token) bodies.
// ---------------------------------------------------------------------------
export function buildTokenExchangeBody({ code, clientId, clientSecret, redirectUri }) {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  })
}

export function buildRefreshBody({ refreshToken, clientId, clientSecret }) {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  })
}

// Normalize a Zoho token response into a stable shape. Callers must never log
// the returned token values.
export function normalizeTokenResponse(json) {
  return {
    accessToken: json?.access_token || null,
    refreshToken: json?.refresh_token || null,
    expiresIn: Number(json?.expires_in || 3600),
    apiDomain: json?.api_domain || null,
    tokenType: json?.token_type || null,
  }
}

// ---------------------------------------------------------------------------
// Parse "Get All Accounts of a User" -> the sending accountId and the
// permitted From addresses. Used by the status/test function to VERIFY the
// account and From address (requirement 9) WITHOUT sending anything.
// ---------------------------------------------------------------------------
export function extractAccountInfo(apiResponse) {
  const data = Array.isArray(apiResponse?.data) ? apiResponse.data : []
  const accounts = data
    .map((acc) => {
      const primary = Array.isArray(acc.emailAddress)
        ? acc.emailAddress.find((e) => e.isPrimary) || acc.emailAddress[0]
        : null
      const fromAddresses = Array.isArray(acc.sendMailDetails)
        ? acc.sendMailDetails.map((d) => d.fromAddress).filter(Boolean)
        : []
      return {
        accountId: acc.accountId || null,
        primaryEmail: acc.primaryEmailAddress || primary?.mailId || null,
        fromAddresses,
        enabled: acc.enabled !== false,
      }
    })
    .filter((a) => a.accountId)
  const primaryAccount = accounts.find((a) => a.enabled) || accounts[0] || null
  return {
    ok: accounts.length > 0,
    apiStatus: apiResponse?.status?.code ?? null,
    accounts,
    primaryAccount,
  }
}

// ---------------------------------------------------------------------------
// Encryption at rest — AES-256-GCM via Web Crypto (Deno + Node 18+).
// The refresh token is stored as `base64(iv):base64(ciphertext)` in
// integration_connections.encrypted_secret, matching the column's documented
// convention. The 256-bit key comes ONLY from the ZOHO_TOKEN_ENCRYPTION_KEY
// server secret and never leaves the server.
// ---------------------------------------------------------------------------
export function decodeKey(secret) {
  const raw = String(secret || '')
  let bytes
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    bytes = new Uint8Array(raw.match(/../g).map((h) => parseInt(h, 16)))
  } else {
    bytes = base64ToBytes(raw)
  }
  if (bytes.length !== 32) {
    throw new Error('ZOHO_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (256-bit).')
  }
  return bytes
}

async function importAesKey(keyBytes) {
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function encryptSecret(plaintext, keyBytes) {
  const key = await importAesKey(keyBytes)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  )
  return `${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ct))}`
}

export async function decryptSecret(payload, keyBytes) {
  const parts = String(payload || '').split(':')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('Malformed encrypted secret payload.')
  }
  const key = await importAesKey(keyBytes)
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(parts[0]) },
    key,
    base64ToBytes(parts[1]),
  )
  return new TextDecoder().decode(pt)
}

// Masked hint for masked display (last 4 chars) — never the whole token.
export function secretHint(secret) {
  const s = String(secret || '')
  return s.length >= 4 ? s.slice(-4) : '****'
}

