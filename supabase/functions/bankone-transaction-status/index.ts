// ============================================================================
// Supabase Edge Function: bankone-transaction-status
//
// Secure middleware between InfinityCore and the BankOne/Qore Channels API.
//
//   InfinityCore React → this function → BankOne (staging.mybankone.com)
//
// Authentication/authorization:
//   * The platform is configured with verify_jwt = true, so requests without a
//     valid InfinityCore session JWT are rejected before reaching this code.
//   * This function independently authenticates the caller via
//     supabase.auth.getUser() (never trusts client-supplied identity) and then
//     authorizes against the SAME role gate the database uses for BankOne
//     management (can_manage_bankone: super_admin/admin/hr_manager/hr_officer/
//     operations_manager). No second authorization system is invented.
//
// Secrets:
//   * BANKONE_API_TOKEN and BANKONE_API_BASE_URL are read from function
//     secrets only. They never reach the browser and are never logged or
//     echoed in any response payload.
//   * The token is injected into the documented Qore request body server-side.
//
// The endpoint implemented here is documented in the Qore Developer Portal:
//   POST {base}/thirdpartyapiservice/apiservice/CoreTransactions/TransactionStatusQuery
//   body: { RetrievalReference, TransactionDate, TransactionType, Amount, Token }
//
// Environment secrets required at deployment:
//   supabase secrets set BANKONE_API_BASE_URL=https://staging.mybankone.com
//   supabase secrets set BANKONE_API_TOKEN=...
// Optional:
//   supabase secrets set BANKONE_TIMEOUT_MS=30000
//   supabase secrets set BANKONE_CORS_ORIGINS="https://example.com,http://localhost:3000"
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  PROVIDER,
  DEFAULT_BANKONE_BASE_URL,
  BANKONE_ENV_STAGING,
  BANKONE_ENV_LIVE,
  BANKONE_STATUS_ENDPOINT,
  BANKONE_QUERY_ROLES,
  validateTransactionStatusRequest,
  buildTransactionStatusRequest,
  resolveTimeoutMs,
  classifyProviderStatus,
  normalizeResponse,
  buildUnparseableProviderResponse,
  providerResponseDiagnostics,
  parseProviderBody,
  sanitizeProviderValue,
  extractProviderMessage,
  maskReference,
  redactText,
  safeError,
  maskedLogSummary,
  newRequestId,
  ERROR_CATEGORIES,
} from '../_shared/bankone-core.mjs'

const OPERATION = 'transaction_status'

const DEFAULT_CORS_ORIGINS =
  'https://infinitymfbcore.vercel.app,https://clintoniwoloma001.github.io,http://localhost:3000,http://127.0.0.1:3000,http://localhost:4173,http://127.0.0.1:4173,http://localhost:5173,http://127.0.0.1:5173'

function corsHeaders(origin) {
  const configured = (Deno.env.get('BANKONE_CORS_ORIGINS') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const allowed = [...new Set([...DEFAULT_CORS_ORIGINS.split(','), ...configured])]

  const allowOrigin = origin && allowed.includes(origin) ? origin : 'null'

  return {
    'Access-Control-Allow-Origin': allowOrigin || 'null',
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

function cleanOrigin(req) {
  const raw = req.headers.get('origin') || ''
  return raw.slice(0, 300)
}

// The environment recorded in integration_logs is derived from the base URL so
// the audit trail reflects where the call actually went.
function resolveEnvironment(baseUrl) {
  return String(baseUrl || '').includes('staging') ? BANKONE_ENV_STAGING : BANKONE_ENV_LIVE
}

Deno.serve(async (req) => {
  const origin = cleanOrigin(req)
  if (req.method === 'OPTIONS') {
    return json({ ok: true }, 200, origin)
  }
  if (req.method !== 'POST') return json({ success: false, error: { code: 'method_not_allowed', message: 'Use POST.' } }, 405, origin)

  const requestId = newRequestId()
  const startedAt = Date.now()

  // ---- 1. Authenticate (JWT) + authorize (role) ----
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json({ success: false, provider: PROVIDER, operation: OPERATION, requestId, error: safeError({ category: ERROR_CATEGORIES.INTERNAL }) }, 500, origin)
  }

  const authHeader = req.headers.get('Authorization') || ''
  if (!authHeader.startsWith('Bearer ')) {
    return json({ success: false, provider: PROVIDER, operation: OPERATION, requestId, error: { code: 'unauthorized', message: 'Authentication required.' } }, 401, origin)
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })

  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return json({ success: false, provider: PROVIDER, operation: OPERATION, requestId, error: { code: 'forbidden', message: 'Invalid or expired session.' } }, 403, origin)
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  let profile = null
  try {
    const { data } = await admin
      .from('profiles')
      .select('role, full_name, status')
      .eq('id', user.id)
      .maybeSingle()
    profile = data || null
  } catch {
    profile = null
  }

  const role = profile?.role || null
  if (!BANKONE_QUERY_ROLES.includes(role)) {
    return json({ success: false, provider: PROVIDER, operation: OPERATION, requestId, error: { code: 'forbidden', message: 'Your role is not permitted to query BankOne.' } }, 403, origin)
  }

  const actorName = profile?.full_name || user.email || user.id
  const userRef = user.id

  // ---- 2. Validate the request ----
  let body
  try {
    body = await req.json()
  } catch {
    return json({ success: false, provider: PROVIDER, operation: OPERATION, requestId, error: { code: ERROR_CATEGORIES.INVALID_REQUEST, message: 'Request body must be valid JSON.' } }, 400, origin)
  }

  const validation = validateTransactionStatusRequest(body)
  if (!validation.ok) {
    return json({
      success: false,
      provider: PROVIDER,
      operation: OPERATION,
      requestId,
      error: { code: ERROR_CATEGORIES.INVALID_REQUEST, message: 'Invalid request.', details: validation.errors },
    }, 400, origin)
  }

  // ---- 3. Read server-side credentials ----
  const baseUrl = Deno.env.get('BANKONE_API_BASE_URL') || ''
  const token = Deno.env.get('BANKONE_API_TOKEN') || ''
  const timeoutMs = resolveTimeoutMs(Deno.env.get('BANKONE_TIMEOUT_MS'))
  const environment = resolveEnvironment(baseUrl || DEFAULT_BANKONE_BASE_URL)

  if (!baseUrl || !token) {
    const error = safeError({ category: ERROR_CATEGORIES.MISSING_CREDENTIALS })
    return json(failureEnvelope({
      requestId,
      environment,
      error,
      startedAt,
      input: validation.value,
      providerRequestSent: false,
      providerResponseReceived: false,
    }), 500, origin)
  }

  // ---- 4. Build + call BankOne ----
  let outgoing
  try {
    outgoing = buildTransactionStatusRequest({ baseUrl, token, input: validation.value })
  } catch (e) {
    const error = safeError({ category: ERROR_CATEGORIES.MISSING_CREDENTIALS })
    return json(failureEnvelope({
      requestId,
      environment,
      error,
      startedAt,
      input: validation.value,
      providerRequestSent: false,
      providerResponseReceived: false,
    }), 500, origin)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let response
  try {
    response = await fetch(outgoing.url, {
      method: 'POST',
      headers: outgoing.headers,
      body: JSON.stringify(outgoing.body),
      signal: controller.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    const timedOut = e && (e.name === 'AbortError' || e.name === 'TimeoutError')
    const error = timedOut
      ? safeError({ category: ERROR_CATEGORIES.TIMEOUT })
      : safeError({ category: ERROR_CATEGORIES.NETWORK })
    await recordFailure(admin, {
      requestId,
      environment,
      error,
      startedAt,
      actorName,
      userRef,
      reference: validation.value.RetrievalReference,
      secret: token,
    })
    return json(failureEnvelope({
      requestId,
      environment,
      error,
      startedAt,
      input: validation.value,
      providerRequestSent: true,
      providerResponseReceived: false,
    }), error.status, origin)
  }
  clearTimeout(timer)

  const httpStatus = response.status
  const providerContentType = response.headers.get('content-type') || null
  let rawText = ''
  try {
    rawText = await response.text()
  } catch {
    const error = safeError({ category: ERROR_CATEGORIES.MALFORMED_RESPONSE, status: 502 })
    await recordFailure(admin, {
      requestId,
      environment,
      error,
      httpStatus,
      startedAt,
      actorName,
      userRef,
      reference: validation.value.RetrievalReference,
      secret: token,
    })
    return json(failureEnvelope({
      requestId,
      environment,
      error,
      startedAt,
      input: validation.value,
      providerStatus: httpStatus,
      providerContentType,
      providerRequestSent: true,
      providerResponseReceived: false,
    }), 502, origin)
  }

  const diagnostics = providerResponseDiagnostics({
    rawText,
    response,
    outgoingUrl: outgoing.url,
    secret: token,
    maxPreviewLength: 500,
  })

  const parsedRes = parseProviderBody(rawText, providerContentType)
  if (!parsedRes.ok) {
    if (!response.ok) {
      const error = classifyProviderStatus(httpStatus) || safeError({ category: ERROR_CATEGORIES.UPSTREAM_ERROR, status: httpStatus })
      await recordFailure(admin, {
        requestId,
        environment,
        error,
        httpStatus,
        startedAt,
        actorName,
        userRef,
        reference: validation.value.RetrievalReference,
        secret: token,
      })
      return json(failureEnvelope({
        requestId,
        environment,
        error,
        startedAt,
        input: validation.value,
        providerStatus: httpStatus,
        providerContentType,
        providerBodyFormat: parsedRes.format,
        providerRequestSent: true,
        providerResponseReceived: true,
      }), httpStatus, origin)
    }

    // BankOne answered HTTP 200 but the body is not JSON. Treat this as a
    // transport success with an unparseable application response, not as a
    // generic Edge 502 / "provider unreachable" failure.
    const unparseable = buildUnparseableProviderResponse({
      rawText,
      httpStatus,
      contentType: providerContentType,
      bodyFormat: parsedRes.format,
      operation: OPERATION,
      requestId,
      durationMs: Date.now() - startedAt,
      secret: token,
      request: safeRequest(validation.value),
      timestamp: new Date(startedAt).toISOString(),
      environment: environmentLabel(environment),
      diagnostics,
    })
    await recordFailure(admin, {
      requestId,
      environment,
      error: {
        code: unparseable.errorCode,
        message: unparseable.error,
        status: httpStatus,
      },
      httpStatus,
      startedAt,
      actorName,
      userRef,
      reference: validation.value.RetrievalReference,
      secret: token,
    }).catch(() => {})
    return json(unparseable, httpStatus, origin)
  }

  const providerData = sanitizeProviderValue(parsedRes.value, token)

  // ---- 5. Preserve provider HTTP status and expose only safe details ----
  if (!response.ok) {
    const classified = classifyProviderStatus(httpStatus) || safeError({ category: ERROR_CATEGORIES.UPSTREAM_ERROR, status: httpStatus })
    const providerMessage = extractProviderMessage(providerData)
    const error = {
      ...classified,
      providerMessage: providerMessage || classified.providerMessage,
    }
    await recordFailure(admin, {
      requestId,
      environment,
      error,
      httpStatus,
      startedAt,
      actorName,
      userRef,
      reference: validation.value.RetrievalReference,
      secret: token,
    })
    return json(failureEnvelope({
      requestId,
      environment,
      error,
      startedAt,
      input: validation.value,
      providerStatus: httpStatus,
      details: providerData,
      providerContentType,
      providerBodyFormat: parsedRes.format,
      providerRequestSent: true,
      providerResponseReceived: true,
      diagnostics,
    }), httpStatus, origin)
  }

  // ---- 6. Normalize + persist audit traces ----
  const durationMs = Date.now() - startedAt
  const normalized = normalizeResponse({
    raw: providerData,
    operation: OPERATION,
    requestId,
    httpStatus,
    durationMs,
    secret: token,
    request: safeRequest(validation.value),
    timestamp: new Date(startedAt).toISOString(),
    environment: environmentLabel(environment),
    providerRequestSent: true,
    providerResponseReceived: true,
    contentType: providerContentType,
    bodyFormat: parsedRes.format,
    diagnostics,
  })

  // A syntactically valid JSON body is not enough to claim that the query was
  // processed. Return 502 only when the provider body has no recognizable
  // transaction-status envelope; a recognized application-level error stays a
  // provider HTTP 200 and is returned below for the UI to display.
  if (!normalized.providerResultValid) {
    const error = safeError({ category: ERROR_CATEGORIES.MALFORMED_RESPONSE, status: 502 })
    await recordFailure(admin, {
      requestId,
      environment,
      error,
      httpStatus,
      startedAt,
      actorName,
      userRef,
      reference: validation.value.RetrievalReference,
      secret: token,
    }).catch(() => {})
    return json(failureEnvelope({
      requestId,
      environment,
      error,
      startedAt,
      input: validation.value,
      providerStatus: httpStatus,
      details: providerData,
      providerContentType,
      providerBodyFormat: parsedRes.format,
      providerRequestSent: true,
      providerResponseReceived: true,
    }), 502, origin)
  }

  // A transport-level 200 only means BankOne answered the HTTP request. Keep
  // the audit state aligned with the provider's business-level result so a
  // rejected query never appears as a successful provider call in the UI.
  if (normalized.success) {
    await recordSuccess(admin, {
      requestId,
      environment,
      httpStatus,
      durationMs,
      startedAt,
      actorName,
      userRef,
      reference: validation.value.RetrievalReference,
      secret: token,
    }).catch(() => {})
  } else {
    await recordFailure(admin, {
      requestId,
      environment,
      error: {
        code: normalized.errorCode || 'BANKONE_PROVIDER_RESULT_FAILED',
        message: normalized.error || 'BankOne returned an unsuccessful transaction result.',
        status: httpStatus,
      },
      httpStatus,
      startedAt,
      actorName,
      userRef,
      reference: validation.value.RetrievalReference,
      secret: token,
    }).catch(() => {})
  }

  return json(normalized, httpStatus, origin)
})

function environmentLabel(environment) {
  return environment === BANKONE_ENV_STAGING ? 'staging' : 'production'
}

function safeRequest(input) {
  return {
    retrievalReference: maskReference(input?.RetrievalReference),
    transactionDate: input?.TransactionDate || null,
  }
}

function failureEnvelope({
  requestId,
  environment,
  error,
  startedAt,
  input,
  providerStatus = null,
  details = null,
  providerContentType = null,
  providerBodyFormat = null,
  providerRequestSent = false,
  providerResponseReceived = false,
  diagnostics = null,
}) {
  const errorMessage = error.providerMessage
    || (providerStatus === 400 ? 'BankOne rejected the transaction-status request.' : error.message)
    || 'The BankOne transaction-status request could not be completed.'
  return {
    success: false,
    provider: PROVIDER,
    operation: OPERATION,
    status: providerStatus ?? error.status ?? 500,
    providerStatus,
    providerHttpStatus: providerStatus,
    providerContentType,
    providerBodyFormat,
    providerReached: providerResponseReceived,
    statusCode: providerStatus ?? error.status ?? 500,
    requestId,
    error: errorMessage,
    errorCode: error.code,
    details,
    request: input ? safeRequest(input) : null,
    environment: environmentLabel(environment),
    endpoint: BANKONE_STATUS_ENDPOINT,
    requestTimestamp: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    providerRequestSent,
    providerResponseReceived,
    diagnostics,
  }
}

// ---------------------------------------------------------------------------
// Audit writes — masked, token-free, best-effort. Uses the SERVICE ROLE client
// so RLS (integration_* locked to super_admin) is bypassed safely, exactly like
// the other integration RPCs the edge functions call. Never logs secrets.
// ---------------------------------------------------------------------------

async function recordSuccess(admin, { requestId, environment, httpStatus, durationMs, startedAt, actorName, userRef, reference, secret }) {
  await recordProviderCall(admin, {
    environment,
    operation: OPERATION,
    status: 'ok',
    httpStatus,
    durationMs,
    startedAt,
    actorName,
    userRef,
    reference,
    requestId,
    secret,
  })
  await audit(admin, { action: 'BANKONE_TRANSACTION_STATUS_OK', actorName, userRef, environment, reference, requestId, httpStatus, durationMs, secret })
}

async function recordFailure(admin, { requestId, environment, error, httpStatus = null, startedAt, actorName, userRef, reference = null, secret = '' }) {
  const durationMs = Date.now() - startedAt
  await recordProviderCall(admin, {
    environment,
    operation: OPERATION,
    status: error.code === 'timeout' ? 'timeout' : 'error',
    httpStatus,
    durationMs,
    startedAt,
    actorName,
    userRef,
    requestId,
    errorCode: error.code,
    reference,
    secret,
  })
  await audit(admin, {
    action: 'BANKONE_TRANSACTION_STATUS_ERROR',
    actorName,
    userRef,
    environment,
    requestId,
    httpStatus,
    durationMs,
    errorCode: error.code,
    severity: 'high',
    reference,
    secret,
  })
}

// Prefers the Phase 43 RPC (single audited server-side entry point) and falls
// back to direct writes so the function works even before migrations run.
async function recordProviderCall(admin, { environment, operation, status, httpStatus, durationMs, startedAt, actorName, userRef, requestId, reference, errorCode, secret = '' }) {
  const endpointRef = BANKONE_STATUS_ENDPOINT
  const summary = maskedLogSummary({ operation, status, httpStatus, requestId, errorCode, durationMs })
  const safeReference = redactText(maskReference(reference) || '', secret) || null

  try {
    const { error } = await admin.rpc('integration_record_provider_call', {
      p_environment: environment,
      p_operation: operation,
      p_endpoint: endpointRef,
      p_direction: 'out',
      p_status: status,
      p_http_status: httpStatus,
      p_duration_ms: durationMs,
      p_correlation_id: requestId,
      p_error_category: errorCode || null,
      p_masked_summary: summary,
      p_record_reference: safeReference,
      p_created_by: userRef,
    })
    if (!error) return
  } catch {
    // RPC unavailable — fall through to direct writes below.
  }

  try {
    await admin.from('integration_logs').insert({
      environment,
      operation,
      endpoint: endpointRef,
      direction: 'out',
      status,
      http_status: httpStatus,
      duration_ms: durationMs,
      record_reference: safeReference,
      correlation_id: requestId,
      error_category: errorCode || null,
      masked_summary: summary,
      created_by: userRef,
    })
    if (status === 'ok') {
      await admin
        .from('integration_connections')
        .update({ status: 'connected', last_connected_at: new Date().toISOString(), last_success_at: new Date().toISOString(), last_error: null })
        .eq('provider', 'bankone')
        .eq('environment', environment)
    } else {
      await admin
        .from('integration_connections')
        .update({
          last_fail_at: new Date().toISOString(),
          last_error: (httpStatus === 401 || httpStatus === 403 ? 'auth_failed' : errorCode || 'request_failed'),
        })
        .eq('provider', 'bankone')
        .eq('environment', environment)
    }
  } catch {
    // Table or column may be missing if Phase 15 wasn't applied — never fail a live lookup.
  }
}

async function audit(admin, { action, actorName, userRef, environment, reference, requestId, httpStatus, durationMs, errorCode, severity = 'info', secret = '' }) {
  const details = [`env=${environment}`, requestId ? `request=${requestId}` : '', httpStatus ? `http=${httpStatus}` : '', durationMs != null ? `ms=${durationMs}` : '', errorCode ? `error=${errorCode}` : '', reference ? `ref=${maskReference(reference)}` : '']
    .filter(Boolean)
    .join(' ')
  try {
    await admin.from('audit_logs').insert({
      action,
      entity_type: 'BankOneIntegration',
      entity_id: requestId,
      user_name: redactText(actorName || userRef || 'system', secret),
      details: redactText(details, secret),
      severity,
    })
  } catch {
    /* non-fatal */
  }
}
