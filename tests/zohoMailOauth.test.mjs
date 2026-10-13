import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ZOHO_AUTHORIZE_URL,
  ZOHO_TOKEN_URL,
  ZOHO_MAIL_API_BASE,
  ZOHO_GET_ACCOUNTS_URL,
  ZOHO_SCOPES,
  ZOHO_SCOPE_STRING,
  ZOHO_MAIL_ROLES,
  STATE_TTL_SECONDS,
  CALLBACK_FUNCTION_NAME,
  buildRedirectUri,
  buildAuthorizeUrl,
  generateState,
  isValidStateShape,
  buildTokenExchangeBody,
  buildRefreshBody,
  normalizeTokenResponse,
  extractAccountInfo,
  decodeKey,
  encryptSecret,
  decryptSecret,
} from '../supabase/functions/_shared/zoho-mail.mjs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const shared = read('supabase/functions/_shared/zoho-mail.mjs')
const start = read('supabase/functions/zoho-oauth-start/index.ts')
const callback = read('supabase/functions/zoho-oauth-callback/index.ts')
const status = read('supabase/functions/zoho-mail-status/index.ts')
const config = read('supabase/config.toml')
const migration = read('supabase/migrations/20261114000000_zoho_mail_oauth_foundation.sql')
const service = read('src/services/zohoMailService.js')

const check = (name, fn) => { fn(); console.log('  ok - ' + name) }

console.log('Zoho Mail OAuth foundation — content + logic tests')

// 1. .com endpoints (requirement 6)
check('uses the .com OAuth authorize + token endpoints and Mail API base', () => {
  assert.equal(ZOHO_AUTHORIZE_URL, 'https://accounts.zoho.com/oauth/v2/auth')
  assert.equal(ZOHO_TOKEN_URL, 'https://accounts.zoho.com/oauth/v2/token')
  assert.equal(ZOHO_MAIL_API_BASE, 'https://mail.zoho.com/api/')
  assert.equal(ZOHO_GET_ACCOUNTS_URL, 'https://mail.zoho.com/api/accounts')
  assert.doesNotMatch(shared, /accounts\.zoho\.(eu|in|com\.au|jp|ca|sa)\b/)
})

// 2. Least-privilege scopes (requirement 7)
check('requests only ZohoMail.messages.CREATE + ZohoMail.accounts.READ', () => {
  assert.deepEqual(ZOHO_SCOPES, ['ZohoMail.messages.CREATE', 'ZohoMail.accounts.READ'])
  assert.equal(ZOHO_SCOPE_STRING, 'ZohoMail.messages.CREATE,ZohoMail.accounts.READ')
  assert.doesNotMatch(ZOHO_SCOPE_STRING, /\.ALL/)
})

// 3. Server-side authorize URL (requirement 1)
check('authorize URL is built server-side with offline + consent + state', () => {
  const url = new URL(buildAuthorizeUrl({ base: 'https://proj.supabase.co', clientId: 'CID', state: 'STATE123' }))
  assert.equal(url.origin + url.pathname, ZOHO_AUTHORIZE_URL)
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('client_id'), 'CID')
  assert.equal(url.searchParams.get('access_type'), 'offline')
  assert.equal(url.searchParams.get('prompt'), 'consent')
  assert.equal(url.searchParams.get('state'), 'STATE123')
  assert.equal(url.searchParams.get('scope'), ZOHO_SCOPE_STRING)
})

check('the frontend service never builds an authorize URL or holds a secret', () => {
  assert.doesNotMatch(service, /accounts\.zoho\.com/)
  assert.doesNotMatch(service, /ZOHO_CLIENT_SECRET/)
  assert.doesNotMatch(service, /refresh_token/i)
  assert.doesNotMatch(service, /access_token/i)
  assert.doesNotMatch(service, /VITE_ZOHO_CLIENT_SECRET/)
})

// 4. Callback URL is derived, never hard-coded (requirement 2)
check('callback URL is derived from the project URL, not hard-coded', () => {
  assert.equal(
    buildRedirectUri('https://atzomqicwjufuxhfexxd.supabase.co'),
    'https://atzomqicwjufuxhfexxd.supabase.co/functions/v1/zoho-oauth-callback',
  )
  assert.equal(CALLBACK_FUNCTION_NAME, 'zoho-oauth-callback')
  assert.equal(buildRedirectUri('https://x.supabase.co///'), 'https://x.supabase.co/functions/v1/zoho-oauth-callback')
  assert.match(callback, /buildRedirectUri\(redirectBase\)/)
})

// 5. CSRF state (requirement 3)
check('state is random, short-lived, and shape-validated', () => {
  assert.notEqual(generateState(), generateState())
  assert.ok(isValidStateShape(generateState()))
  assert.ok(!isValidStateShape('short'))
  assert.equal(STATE_TTL_SECONDS, 600)
})

check('callback validates + atomically consumes state; rejects reuse/expiry', () => {
  assert.match(callback, /\.update\(\{ consumed_at: /)
  assert.match(callback, /\.is\('consumed_at', null\)/)
  assert.match(callback, /\.gt\('expires_at',/)
  assert.match(callback, /if \(!consumed\)/)
  assert.match(callback, /ZOHO_OAUTH_STATE_REJECTED/)
})


// 6. Token exchange server-side + offline refresh token (requirement 4/5)
check('token exchange + refresh bodies carry the grant correctly', () => {
  const ex = buildTokenExchangeBody({ code: 'C', clientId: 'ID', clientSecret: 'S', redirectUri: 'R' })
  assert.equal(ex.get('grant_type'), 'authorization_code')
  assert.equal(ex.get('code'), 'C')
  assert.equal(ex.get('client_secret'), 'S')
  assert.equal(ex.get('redirect_uri'), 'R')
  const rf = buildRefreshBody({ refreshToken: 'RT', clientId: 'ID', clientSecret: 'S' })
  assert.equal(rf.get('grant_type'), 'refresh_token')
  assert.equal(rf.get('refresh_token'), 'RT')
})

check('callback exchanges server-side and stores the refresh token ENCRYPTED', () => {
  assert.match(callback, /fetch\(ZOHO_TOKEN_URL/)
  assert.match(callback, /clientSecret: zohoClientSecret/)
  assert.match(callback, /encryptSecret\(tokens\.refreshToken, decodeKey\(encryptionKey\)\)/)
  assert.match(callback, /encrypted_secret: encryptedRefresh/)
  assert.doesNotMatch(callback, /refresh_token: tokens\.refreshToken/)
})

// 7. Secrets live only server-side (requirement 5)
check('client secret + encryption key are read only from server env', () => {
  assert.match(callback, /Deno\.env\.get\('ZOHO_CLIENT_SECRET'\)/)
  assert.match(callback, /Deno\.env\.get\('ZOHO_TOKEN_ENCRYPTION_KEY'\)/)
  assert.match(start, /Deno\.env\.get\('ZOHO_CLIENT_ID'\)/)
  assert.doesNotMatch(start, /ZOHO_CLIENT_SECRET/)
})

// 8. Backend-only status/test; NO send anywhere (requirement 8 & 9)
check('status function is role-gated and never sends mail', () => {
  assert.match(status, /ZOHO_MAIL_ROLES\.includes\(profile\.role\)/)
  assert.match(status, /ZOHO_GET_ACCOUNTS_URL/)
  assert.doesNotMatch(status, /\/messages/)
  assert.match(status, /readyToSend: false/)
})

check('no function in the whole Zoho flow sends an email', () => {
  for (const [name, src] of [['start', start], ['callback', callback], ['status', status]]) {
    assert.doesNotMatch(src, /\/messages/, `${name} must not POST to /messages`)
    assert.doesNotMatch(src, /ZohoMail\.messages\.ALL/, `${name} must not request .ALL`)
  }
})

check('Get All Accounts parser extracts accountId + From addresses', () => {
  const api = {
    status: { code: 200 },
    data: [{
      accountId: '2560636000000008002',
      primaryEmailAddress: 'audit@infinitymfb.com',
      enabled: true,
      sendMailDetails: [{ fromAddress: 'audit@infinitymfb.com' }, { fromAddress: 'alias@infinitymfb.com' }],
    }],
  }
  const info = extractAccountInfo(api)
  assert.equal(info.ok, true)
  assert.equal(info.primaryAccount.accountId, '2560636000000008002')
  assert.deepEqual(info.primaryAccount.fromAddresses, ['audit@infinitymfb.com', 'alias@infinitymfb.com'])
})

// 9. At-rest encryption round-trips and the key must be 256-bit
check('AES-256-GCM encrypt/decrypt round-trips; bad key length rejected', async () => {
  const keyBytes = decodeKey(Buffer.alloc(32, 7).toString('base64'))
  const ct = await encryptSecret('1000.refresh-token-value', keyBytes)
  assert.ok(ct.includes(':'))
  assert.doesNotMatch(ct, /1000\.refresh-token-value/)
  assert.equal(await decryptSecret(ct, keyBytes), '1000.refresh-token-value')
  assert.throws(() => decodeKey(Buffer.alloc(16).toString('base64')), /32 bytes/)
})

// 10. Migration + config wiring
check('migration widens provider CHECK and adds the state table', () => {
  assert.match(migration, /'zoho_mail'/)
  assert.match(migration, /provider_account_id text/)
  assert.match(migration, /create table if not exists public\.zoho_oauth_states/)
  assert.match(migration, /enable row level security/)
  assert.match(migration, /revoke all on public\.zoho_oauth_states from anon, authenticated/)
})

check('config.toml registers all three functions with correct verify_jwt', () => {
  assert.match(config, /\[functions\.zoho-oauth-start\][\s\S]*?verify_jwt = true/)
  assert.match(config, /\[functions\.zoho-oauth-callback\][\s\S]*?verify_jwt = false/)
  assert.match(config, /\[functions\.zoho-mail-status\][\s\S]*?verify_jwt = true/)
})

check('roles gate is Head of Audit + admins only', () => {
  assert.deepEqual(ZOHO_MAIL_ROLES, ['super_admin', 'admin', 'head_of_audit'])
})

console.log('\nAll Zoho Mail OAuth foundation checks passed.')
