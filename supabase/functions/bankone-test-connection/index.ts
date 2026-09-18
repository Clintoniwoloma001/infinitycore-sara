// ============================================================================
// Supabase Edge Function: bankone-test-connection
//
// This is deliberately separate from bankone-health and the transaction-status
// endpoint. The current repository contains no harmless, documented BankOne
// health/ping endpoint. Until BankOne supplies one, this function performs a
// server-side configuration/capability diagnostic and records a SKIPPED test;
// it never fabricates a transaction reference and never calls an unapproved
// banking endpoint.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  PROVIDER,
  DEFAULT_BANKONE_BASE_URL,
  BANKONE_QUERY_ROLES,
  ERROR_CATEGORIES,
  isAllowedBankOneHost,
  resolveBankoneEnvironment,
  newRequestId,
} from '../_shared/bankone-core.mjs'

const DEFAULT_CORS_ORIGINS =
  'https://clintoniwoloma001.github.io,http://localhost:3000,http://127.0.0.1:3000,http://localhost:4173,http://127.0.0.1:4173,http://localhost:5173,http://127.0.0.1:5173'

function corsHeaders(origin) {
  const allowed = (Deno.env.get('BANKONE_CORS_ORIGINS') || DEFAULT_CORS_ORIGINS)
    .split(',').map((value) => value.trim()).filter(Boolean)
  const allowOrigin = origin && allowed.includes(origin) ? origin : 'null'
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

async function recordDiagnostic(admin, { environment, status, durationMs, requestId, errorCode, userId, actorName }) {
  const summary = `bankone:test_connection status=${status} error=${errorCode || 'none'} request=${requestId} ms=${durationMs}`
  const args = {
    p_environment: environment,
    p_operation: 'test_connection',
    p_endpoint: 'internal/configuration',
    p_direction: 'out',
    p_status: status,
    p_http_status: null,
    p_duration_ms: durationMs,
    p_correlation_id: requestId,
    p_error_category: errorCode,
    p_masked_summary: summary,
    p_record_reference: null,
    p_created_by: userId,
  }
  const first = await admin.rpc('integration_record_provider_call', args)
  if (first.error) {
    const { p_created_by: _ignored, ...legacyArgs } = args
    await admin.rpc('integration_record_provider_call', legacyArgs)
  }
  await admin.from('audit_logs').insert({
    action: 'BANKONE_CONNECTION_TEST',
    entity_type: 'BankOneIntegration',
    entity_id: requestId,
    user_name: actorName || userId,
    details: `environment=${environment} status=${status} error=${errorCode || 'none'} duration_ms=${durationMs}`,
    severity: status === 'skipped' ? 'info' : 'warning',
  })
}

async function handleTestConnectionRequest(req, origin, requestId) {
  if (req.method === 'OPTIONS') return json({ ok: true, requestId }, 200, origin)
  if (req.method !== 'POST') return json({ success: false, provider: PROVIDER, operation: 'test_connection', requestId, error: { code: 'method_not_allowed', message: 'Use POST.' } }, 405, origin)

  const startedAt = Date.now()
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json({
      success: false, provider: PROVIDER, operation: 'test_connection', requestId,
      status: 'configuration_error', functionOperational: false,
      error: { code: 'internal', message: 'The BankOne diagnostic runtime is not configured.' },
    }, 500, origin)
  }

  const authHeader = req.headers.get('Authorization') || ''
  if (!authHeader.startsWith('Bearer ')) return json({ success: false, provider: PROVIDER, operation: 'test_connection', requestId, error: { code: 'unauthorized', message: 'Authentication required.' } }, 401, origin)

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) return json({ success: false, provider: PROVIDER, operation: 'test_connection', requestId, error: { code: 'forbidden', message: 'Invalid or expired session.' } }, 403, origin)

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  const { data: profile } = await admin.from('profiles').select('role, status, full_name').eq('id', user.id).maybeSingle()
  if (!BANKONE_QUERY_ROLES.includes(profile?.role)) {
    return json({ success: false, provider: PROVIDER, operation: 'test_connection', requestId, error: { code: 'forbidden', message: 'Your role is not permitted to run the BankOne connection test.' } }, 403, origin)
  }
  if (profile?.status && !['active', 'approved'].includes(profile.status)) {
    return json({ success: false, provider: PROVIDER, operation: 'test_connection', requestId, error: { code: 'forbidden', message: 'Your account is not active.' } }, 403, origin)
  }

  const baseUrl = (Deno.env.get('BANKONE_API_BASE_URL') || '').trim()
  const tokenConfigured = Boolean((Deno.env.get('BANKONE_API_TOKEN') || '').trim())
  const accountConfigured = Boolean((Deno.env.get('BANKONE_ACCOUNT_NUMBER') || '').trim())
  const creditGlConfigured = Boolean((Deno.env.get('BANKONE_CREDIT_GL_CODE') || '').trim())
  const debitGlConfigured = Boolean((Deno.env.get('BANKONE_DEBIT_GL_CODE') || '').trim())
  const timeoutRaw = Deno.env.get('BANKONE_TIMEOUT_MS') || ''
  const timeoutValid = !timeoutRaw || Number.isFinite(Number(timeoutRaw))
  const baseUrlConfigured = Boolean(baseUrl)
  const baseUrlValid = baseUrlConfigured && isAllowedBankOneHost(baseUrl)
  const configurationHealthy = baseUrlConfigured && baseUrlValid && tokenConfigured && accountConfigured && creditGlConfigured && debitGlConfigured && timeoutValid
  const environment = resolveBankoneEnvironment(baseUrl || DEFAULT_BANKONE_BASE_URL)
  const durationMs = Date.now() - startedAt
  const errorCode = configurationHealthy ? ERROR_CATEGORIES.ENDPOINT_UNAVAILABLE : 'missing_credentials'
  const status = configurationHealthy ? 'skipped' : 'configuration_error'

  await recordDiagnostic(admin, {
    environment,
    status,
    durationMs,
    requestId,
    errorCode,
    userId: user.id,
    actorName: profile?.full_name || user.email || user.id,
  }).catch(() => {})

  const body = {
    success: configurationHealthy,
    provider: PROVIDER,
    operation: 'test_connection',
    requestId,
    status: configurationHealthy ? 'endpoint_unavailable' : 'configuration_error',
    functionOperational: true,
    environment: environment === 'sandbox' ? 'staging' : 'production',
    configuration: {
      baseUrlConfigured,
      tokenConfigured,
      accountConfigured,
      creditGlConfigured,
      debitGlConfigured,
    },
    configurationHealthy,
    baseUrlConfigured,
    tokenConfigured,
    accountConfigured,
    creditGlConfigured,
    debitGlConfigured,
    endpointAvailability: configurationHealthy ? 'unavailable' : 'misconfigured',
    providerCallMade: false,
    providerReachability: 'not_tested',
    authentication: 'not_tested',
    functionalTest: 'not_run',
    verified: false,
    http_status: null,
    latency_ms: durationMs,
    error_code: errorCode,
    error_message: configurationHealthy
      ? 'No harmless, documented BankOne health endpoint is available. No provider call was made.'
      : 'BankOne server-side configuration is incomplete or invalid.',
    tested_at: new Date().toISOString(),
    endpoint_name: null,
  }
  return json(body, 200, origin)
}

Deno.serve(async (req) => {
  const origin = (req.headers.get('origin') || '').slice(0, 300)
  const requestId = newRequestId()
  try {
    return await handleTestConnectionRequest(req, origin, requestId)
  } catch {
    return json({
      success: false,
      provider: PROVIDER,
      operation: 'test_connection',
      requestId,
      functionOperational: false,
      error: { code: 'internal', message: 'The BankOne connection test could not be completed.' },
    }, 500, origin)
  }
})
