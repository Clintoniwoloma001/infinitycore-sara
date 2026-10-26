// ============================================================================
// Supabase Edge Function: audit-reminder-sweep
// Phase 4 - Audit reminder sweep + send pipeline.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  ZOHO_TOKEN_URL,
  ZOHO_MAIL_API_BASE,
  PROVIDER,
  ENVIRONMENT,
  buildRefreshBody,
  normalizeTokenResponse,
  decryptSecret,
  decodeKey,
  extractAccountInfo,
} from '../_shared/zoho-mail.mjs';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

const SEND_ROLES = ['super_admin', 'admin', 'head_of_audit'];
const DEFAULT_DAILY_CAP = 100;
const MAX_RETRIES = 3;
const ZOHO_MAX_RECIPIENTS = 100;

// ---------------- Zoho send primitives (existing audit mailbox) -------------
async function getAuditMailbox(admin) {
  const { data: conn, error } = await admin
    .from('integration_connections')
    .select('encrypted_secret, token_expires_at, provider_account_id, enabled')
    .eq('provider', PROVIDER).eq('environment', ENVIRONMENT).eq('enabled', true)
    .maybeSingle();
  if (error || !conn || !conn.encrypted_secret) {
    return { ok: conn ? 'no_encrypted_secret' : 'no_connection' };
  }
  return { ok: true, conn };
}

async function refreshTokens(admin, conn) {
  const encryptionKey = Deno.env.get('ZOHO_TOKEN_ENCRYPTION_KEY');
  if (!encryptionKey) return { ok: false, error: 'encryption_key_missing' };
  let refreshToken;
  try { refreshToken = await decryptSecret(conn.encrypted_secret, decodeKey(encryptionKey)); }
  catch (e) { return { ok: false, error: 'decrypt_failed' }; }
  const tokenRes = await fetch(ZOHO_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: buildRefreshBody({
      refreshToken, clientId: Deno.env.get('ZOHO_CLIENT_ID'),
      clientSecret: Deno.env.get('ZOHO_CLIENT_SECRET'),
    }),
  });
  if (!tokenRes.ok) return { ok: false, error: `token_refresh_${tokenRes.status}` };
  const tokens = normalizeTokenResponse(await tokenRes.json());
  if (!tokens.accessToken) return { ok: false, error: 'no_access_token' };
  return { ok: true, accessToken: tokens.accessToken };
}

async function getSenderAddress(admin, accessToken) {
  const accountsRes = await fetch(`${ZOHO_MAIL_API_BASE}accounts`, {
    method: 'GET',
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, Accept: 'application/json' },
  });
  if (!accountsRes.ok) return { ok: false, error: `accounts_${accountsRes.status}` };
  const { extractAccountInfo } = await import('../_shared/zoho-mail.mjs');
  const info = extractAccountInfo(await accountsRes.json());
  if (!info.ok || !info.primaryAccount) return { ok: false, error: 'no_accounts' };
  return { ok: true, senderEmail: info.primaryAccount.primaryEmail };
}
