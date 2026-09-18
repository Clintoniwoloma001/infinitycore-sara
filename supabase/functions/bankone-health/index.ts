// ============================================================================
// Supabase Edge Function: bankone-health
//
// Internal configuration/status health check for the BankOne integration.
//
// The Qore Channel API documentation does NOT provide a "health/ping"
// endpoint, so this function deliberately does NOT call BankOne. It reports
// server-side configuration presence and, when available, the result of the
// latest real transaction-status attempt. It never returns secret values.
//
// Same auth model as the sibling integration function: platform
// verify_jwt=true + in-function JWT verification + the can_manage_bankone
// role gate. No tokens and no provider requests are ever produced.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  DEFAULT_BANKONE_BASE_URL,
  BANKONE_ENV_STAGING,
  BANKONE_ENV_LIVE,
  BANKONE_QUERY_ROLES,
  newRequestId,
} from '../_shared/bankone-core.mjs'

const OPERATION = 'health'

const DEFAULT_CORS_ORIGINS =
  'https://clintoniwoloma001.github.io,http://localhost:3000,http://127.0.0.1:3000,http://localhost:4173,http://127.0.0.1:4173,http://localhost:5173,http://127.0.0.1:5173'

function corsHeaders(origin) {
  const allowed = (Deno.env.get('BANKONE_CORS_ORIGINS') || DEFAULT_CORS_ORIGINS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const allowOrigin = origin && allowed.includes(origin) ? origin : 'null'
  return {
    'Access-Control-Allow-Origin': allowOrigin || 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Expose-Headers': 'x-request-id, sb-request-id',
    'Access-Control-Max-Age': '3600',
    Vary: 'Origin',
  }
}

function json(body, status = 200, origin) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...corsHeaders(origin) }
  if (body?.requestId) headers['X-Request-Id'] = body.requestId
  return new Response(JSON.stringify(body), {
    status,
    headers,
  })
}

function isAllowedBankOneHost(baseUrl) {
  let u
  try {
    u = new URL(String(baseUrl || '').trim())
  } catch {
    return false
  }
  if (!/^https:$/.test(u.protocol)) return false
  const host = u.hostname.toLowerCase()
  return host === 'staging.mybankone.com' || host === 'api.mybankone.com' || host === 'mybankone.com'
}

function resolveEnvironment(baseUrl) {
  return String(baseUrl || '').toLowerCase().includes('staging') ? BANKONE_ENV_STAGING : BANKONE_ENV_LIVE
}

function classifyReachability(call) {
  if (!call) return 'not_tested'
  if (call.status === 'ok') return 'reachable'
  if (call.error_category === 'network' || call.error_category === 'timeout' || call.http_status) return 'unreachable'
  return 'not_tested'
}

function safeProviderCall(call) {
  if (!call) return null
  const safeErrorCategories = new Set([
    'missing_credentials',
    'internal',
    'network',
    'timeout',
    'unauthorized',
    'forbidden',
    'invalid_request',
    'rate_limited',
    'upstream_error',
    'malformed_response',
  ])
  return {
    status: call.status,
    errorCategory: safeErrorCategories.has(call.error_category) ? call.error_category : null,
    httpStatus: call.http_status ?? null,
    durationMs: call.duration_ms ?? null,
    createdAt: call.created_at || null,
  }
}

async function handleHealthRequest(req, origin, requestId) {
  if (req.method === 'OPTIONS') return json({ ok: true, requestId }, 200, origin)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json({ ok: false, success: false, provider: 'BankOne', operation: OPERATION, requestId, error: { code: 'method_not_allowed', message: 'Use GET or POST.' } }, 405, origin)
  }

  const authHeader = req.headers.get('Authorization') || ''
  if (!authHeader.startsWith('Bearer ')) return json({ ok: false, success: false, provider: 'BankOne', operation: OPERATION, requestId, error: { code: 'unauthorized', message: 'Authentication required.' } }, 401, origin)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json({
      ok: false,
      success: false,
      provider: 'BankOne',
      operation: OPERATION,
      requestId,
      functionOperational: false,
      configured: false,
      configurationHealthy: false,
      checks: [{ name: 'supabase_runtime', ok: false, detail: 'Supabase function runtime is incomplete' }],
    }, 500, origin)
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return json({ ok: false, success: false, provider: 'BankOne', operation: OPERATION, requestId, error: { code: 'forbidden', message: 'Invalid or expired session.' } }, 403, origin)

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  let role = null
  try {
    const { data } = await admin.from('profiles').select('role').eq('id', user.id).maybeSingle()
    role = data?.role || null
  } catch {
    role = null
  }
  if (!BANKONE_QUERY_ROLES.includes(role)) return json({ ok: false, success: false, provider: 'BankOne', operation: OPERATION, requestId, error: { code: 'forbidden', message: 'Your role is not permitted to run the BankOne health check.' } }, 403, origin)

  // ---- Configuration health (secret presence only — values never exposed) ----
  const baseUrlRaw = (Deno.env.get('BANKONE_API_BASE_URL') || '').trim()
  const tokenRaw = (Deno.env.get('BANKONE_API_TOKEN') || '').trim()
  const accountRaw = (Deno.env.get('BANKONE_ACCOUNT_NUMBER') || '').trim()
  const creditGlRaw = (Deno.env.get('BANKONE_CREDIT_GL_CODE') || '').trim()
  const debitGlRaw = (Deno.env.get('BANKONE_DEBIT_GL_CODE') || '').trim()
  const timeoutRaw = Deno.env.get('BANKONE_TIMEOUT_MS') || ''
  const baseUrlConfigured = Boolean(baseUrlRaw)
  const tokenConfigured = Boolean(tokenRaw)
  const accountConfigured = Boolean(accountRaw)
  const creditGlConfigured = Boolean(creditGlRaw)
  const debitGlConfigured = Boolean(debitGlRaw)

  const checks = [
    {
      name: 'bankone_api_base_url',
      ok: baseUrlConfigured,
      detail: baseUrlRaw ? 'BANKONE_API_BASE_URL set' : 'BANKONE_API_BASE_URL missing',
    },
    {
      name: 'bankone_base_url_valid_host',
      ok: !baseUrlRaw || isAllowedBankOneHost(baseUrlRaw),
      detail: 'Base URL must be an https BankOne/Qore host',
    },
    {
      name: 'bankone_api_token',
      ok: tokenConfigured,
      detail: tokenRaw ? 'BANKONE_API_TOKEN set' : 'BANKONE_API_TOKEN missing',
    },
    {
      name: 'bankone_account_number',
      ok: accountConfigured,
      detail: accountConfigured ? 'BANKONE_ACCOUNT_NUMBER set' : 'BANKONE_ACCOUNT_NUMBER missing',
    },
    {
      name: 'bankone_credit_gl_code',
      ok: creditGlConfigured,
      detail: creditGlConfigured ? 'BANKONE_CREDIT_GL_CODE set' : 'BANKONE_CREDIT_GL_CODE missing',
    },
    {
      name: 'bankone_debit_gl_code',
      ok: debitGlConfigured,
      detail: debitGlConfigured ? 'BANKONE_DEBIT_GL_CODE set' : 'BANKONE_DEBIT_GL_CODE missing',
    },
    {
      name: 'bankone_timeout',
      ok: !timeoutRaw || !Number.isNaN(Number(timeoutRaw)),
      detail: timeoutRaw ? 'timeout configured' : 'using default timeout',
    },
  ]

  const configurationHealthy = checks.every((c) => c.ok)

  // ---- Provider reachability (historical evidence only) ----
  let bankoneReachable = null
  let providerEvidence = null
  let lastProviderCall = null
  const environment = resolveEnvironment(baseUrlRaw || DEFAULT_BANKONE_BASE_URL)
  try {
    const { data: conn } = await admin
      .from('integration_connections')
      .select('status, last_success_at, last_fail_at, last_connected_at')
      .eq('provider', 'bankone')
      .eq('environment', environment)
      .maybeSingle()
    providerEvidence = conn || null
  } catch {
    providerEvidence = null
  }
  try {
    const { data: call } = await admin
      .from('integration_logs')
      .select('status, error_category, http_status, duration_ms, created_at')
      .eq('environment', environment)
      .eq('operation', 'transaction_status')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    lastProviderCall = call || null
  } catch {
    lastProviderCall = null
  }
  const reachabilityStatus = classifyReachability(lastProviderCall)
  if (reachabilityStatus === 'reachable') bankoneReachable = true
  else if (reachabilityStatus === 'unreachable') bankoneReachable = false

  const missing = [
    !baseUrlConfigured && 'BANKONE_API_BASE_URL',
    !tokenConfigured && 'BANKONE_API_TOKEN',
    !accountConfigured && 'BANKONE_ACCOUNT_NUMBER',
    !creditGlConfigured && 'BANKONE_CREDIT_GL_CODE',
    !debitGlConfigured && 'BANKONE_DEBIT_GL_CODE',
  ].filter(Boolean)
  const message = configurationHealthy
    ? reachabilityStatus === 'not_tested'
      ? 'Configuration is healthy. No documented non-transaction BankOne health endpoint is available; provider connectivity has not been tested.'
      : `Configuration is healthy. Provider reachability reflects the latest real transaction-status attempt; this check did not call BankOne.`
    : `Configuration is incomplete. Missing ${missing.join(', ')}. Provider connectivity was not tested by this check.`

  const body = {
    ok: configurationHealthy,
    success: true,
    functionOperational: true,
    provider: 'BankOne',
    operation: OPERATION,
    requestId,
    configured: configurationHealthy,
    environment: environment === BANKONE_ENV_STAGING ? 'staging' : 'production',
    databaseEnvironment: environment,
    configuration: {
      baseUrlConfigured,
      tokenConfigured,
      accountConfigured,
      creditGlConfigured,
      debitGlConfigured,
    },
    providerReachability: reachabilityStatus,
    message,
    baseUrlConfigured,
    tokenConfigured,
    accountConfigured,
    creditGlConfigured,
    debitGlConfigured,
    configurationHealthy,
    bankoneReachable,
    reachabilityStatus,
    lastProviderCall: safeProviderCall(lastProviderCall),
    providerEvidence: providerEvidence
      ? {
          status: providerEvidence.status,
          last_success_at: providerEvidence.last_success_at,
          last_fail_at: providerEvidence.last_fail_at,
        }
      : null,
    checks,
  }
  return json(body, 200, origin)
}

Deno.serve(async (req) => {
  const origin = (req.headers.get('origin') || '').slice(0, 300)
  const requestId = newRequestId()
  try {
    return await handleHealthRequest(req, origin, requestId)
  } catch {
    return json({
      ok: false,
      success: false,
      provider: 'BankOne',
      operation: OPERATION,
      requestId,
      functionOperational: false,
      error: { code: 'internal', message: 'The BankOne health check could not be completed.' },
    }, 500, origin)
  }
})
