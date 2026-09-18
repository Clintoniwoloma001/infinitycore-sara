import { supabase } from '../../supabaseClient'

// ---------------------------------------------------------------------------
// BankOne secure client — the browser ONLY ever talks to the Supabase Edge
// Functions, never to BankOne directly, and never carries a BankOne token.
//
//   BankOneIntegration UI → supabase.functions.invoke('bankone-...') → BankOne
//
// The functions are deployed with verify_jwt = true and additionally perform
// in-function JWT + role checks, so this client never needs to (and never
// does) send a BankOne credential. The user's Supabase session JWT is attached
// automatically by supabase-js.
// ---------------------------------------------------------------------------

const SECRET_KEY_RE = /(token|authorization|secret|api[_-]?key|client[_-]?secret)/i

function sanitizeDiagnosticValue(value, depth = 0) {
  if (depth > 4) return '[TRUNCATED]'
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeDiagnosticValue(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [
      key,
      SECRET_KEY_RE.test(key) ? '[REDACTED]' : sanitizeDiagnosticValue(item, depth + 1),
    ]))
  }
  if (typeof value !== 'string') return value
  return value
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/("?(?:token|authorization|api[_-]?key|secret)"?\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"')
    .slice(0, 1000)
}

async function readResponseBody(response) {
  if (!response || typeof response.text !== 'function') return null
  try {
    const readable = typeof response.clone === 'function' ? response.clone() : response
    const text = await readable.text()
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return sanitizeDiagnosticValue(text)
    }
  } catch {
    return null
  }
}

function responseHeader(response, name) {
  try {
    return response?.headers?.get?.(name) || null
  } catch {
    return null
  }
}

function parseDiagnosticBody(value) {
  if (!value) return null
  if (typeof value === 'object') return sanitizeDiagnosticValue(value)
  if (typeof value !== 'string') return null
  try {
    return sanitizeDiagnosticValue(JSON.parse(value))
  } catch {
    return sanitizeDiagnosticValue(value)
  }
}

function functionTarget(functionName) {
  const base = String(import.meta.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '')
  return base ? `${base}/functions/v1/${functionName}` : null
}

async function currentSessionState() {
  try {
    const { data, error } = await supabase.auth.getSession()
    if (error) return { session: null, sessionPresent: false, error, refreshed: false }

    let session = data?.session || null
    let refreshed = false
    const expiresAt = Number(session?.expires_at || 0)
    if (session?.refresh_token && expiresAt > 0 && expiresAt <= Math.floor(Date.now() / 1000) + 30) {
      const refreshedResult = await supabase.auth.refreshSession()
      if (refreshedResult.error || !refreshedResult.data?.session) {
        return { session: null, sessionPresent: Boolean(session?.access_token), error: refreshedResult.error || new Error('Session refresh returned no session.'), refreshed: false }
      }
      session = refreshedResult.data.session
      refreshed = true
    }

    return { session, sessionPresent: Boolean(session?.access_token), error: null, refreshed }
  } catch (error) {
    return { session: null, sessionPresent: false, error, refreshed: false }
  }
}

function errorStage({ body, status, error }) {
  const providerStatus = body?.providerStatus ?? null
  const providerCode = body?.errorCode || body?.error?.code
  if (providerStatus !== null && providerStatus !== undefined) return 'bankone_http'
  if (body?.provider === 'bankone' && ['network', 'timeout', 'malformed_response', 'rate_limited', 'upstream_error'].includes(providerCode)) {
    return 'edge_to_bankone'
  }
  if (body?.provider === 'bankone' && providerCode === 'missing_credentials') return 'edge_function'
  if (error?.name === 'FunctionsHttpError' && status >= 200 && status < 600) return 'edge_function'
  return 'frontend_to_edge'
}

function defaultErrorMessage({ stage, body, status }) {
  const providerMessage = body?.error?.providerMessage || (typeof body?.error === 'string' ? body.error : null)
  if (providerMessage) return providerMessage
  if (body?.error?.message) return body.error.message
  if (body?.message) return body.message
  if (stage === 'frontend_to_edge') {
    if (status === 401) return 'Supabase rejected the request before the Edge Function ran. The session may be missing or expired.'
    if (status === 403) return 'Supabase or the Edge Function rejected the current session or role.'
    return 'The browser could not obtain a response from the Supabase Edge Function. Check the session, Supabase URL, network, and CORS configuration.'
  }
  if (stage === 'edge_to_bankone') return 'The Edge Function ran but could not complete the BankOne request.'
  if (stage === 'bankone_http') return `BankOne returned HTTP ${body?.statusCode || status || 'error'}.`
  return 'The Supabase Edge Function returned an integration error.'
}

function makeDiagnosticError({
  code = 'bankone_call_failed',
  message,
  stage = 'frontend_to_edge',
  functionName,
  sessionPresent = false,
  sessionRefreshed = false,
  functionInvoked = false,
  httpResponseReceived = false,
  functionResponseReceived = false,
  status = null,
  body = null,
  response = null,
  cause = null,
}) {
  const safeBody = sanitizeDiagnosticValue(body)
  const requestId = safeBody?.requestId || responseHeader(response, 'x-request-id') || null
  const supabaseRequestId = responseHeader(response, 'sb-request-id') || null
  const providerHttpStatus = safeBody?.providerStatus ?? (stage === 'bankone_http' ? status : null)
  const error = new Error(message || 'BankOne integration call failed.')
  error.name = 'BankOneIntegrationError'
  error.code = code
  error.stage = stage
  error.functionName = functionName || null
  error.functionTarget = functionTarget(functionName)
  error.sessionPresent = sessionPresent
  error.sessionRefreshed = sessionRefreshed
  error.functionInvoked = functionInvoked
  error.httpResponseReceived = httpResponseReceived
  error.functionResponseReceived = functionResponseReceived
  error.rawStatus = status
  error.httpStatus = status
  error.providerHttpStatus = providerHttpStatus
  error.requestId = requestId
  error.supabaseRequestId = supabaseRequestId
  error.details = safeBody?.error?.details || safeBody?.details || null
  error.providerRequestSent = safeBody?.providerRequestSent ?? null
  error.providerResponseReceived = safeBody?.providerResponseReceived ?? null
  error.requestTimestamp = safeBody?.requestTimestamp || null
  error.durationMs = safeBody?.durationMs ?? null
  error.responseBody = safeBody
  error.envelope = safeBody && typeof safeBody === 'object' ? safeBody : null
  error.transportMessage = cause?.message ? sanitizeDiagnosticValue(cause.message) : null
  error.cause = cause
  error.isBankoneDiagnostic = true
  error.diagnostic = {
    stage,
    code,
    functionName: functionName || null,
    functionTarget: functionTarget(functionName),
    sessionPresent,
    sessionRefreshed,
    functionInvoked,
    httpResponseReceived,
    functionResponseReceived,
    httpStatus: status,
    providerHttpStatus,
    providerRequestSent: error.providerRequestSent,
    providerResponseReceived: error.providerResponseReceived,
    requestTimestamp: error.requestTimestamp,
    durationMs: error.durationMs,
    requestId,
    supabaseRequestId,
    transportMessage: error.transportMessage,
    responseBody: safeBody,
    details: error.details,
  }
  return error
}

export async function unwrapError(error, data, response, context = {}) {
  const errorContext = error?.context || {}
  const contextResponse = typeof errorContext.text === 'function' ? errorContext : null
  const responseForError = response || contextResponse
  const body = data && typeof data === 'object'
    ? sanitizeDiagnosticValue(data)
    : await readResponseBody(responseForError) || parseDiagnosticBody(errorContext.body)
  const status = responseForError?.status || errorContext.status || body?.statusCode || body?.providerStatus || null
  const stage = errorStage({ body, status, error })
  const code = body?.errorCode || body?.error?.code
    || (error?.name === 'FunctionsFetchError' ? 'edge_function_unreachable' : 'bankone_call_failed')
  const applicationResponseReceived = Boolean(body?.provider || body?.requestId || body?.operation || body?.functionOperational)
  return makeDiagnosticError({
    code,
    message: defaultErrorMessage({ stage, body, status }),
    stage,
    functionName: context.functionName,
    sessionPresent: context.sessionPresent,
    sessionRefreshed: context.sessionRefreshed,
    functionInvoked: context.functionInvoked,
    httpResponseReceived: Boolean(responseForError || errorContext.status || errorContext.body || body),
    functionResponseReceived: applicationResponseReceived,
    status,
    body,
    response: responseForError,
    cause: error,
  })
}

export async function invokeBankoneFunction(functionName, body = {}, options = {}) {
  const sessionState = await currentSessionState()
  if (!sessionState.sessionPresent) {
    throw makeDiagnosticError({
      code: sessionState.error ? 'session_lookup_failed' : 'session_missing',
      message: sessionState.error
        ? 'InfinityCore could not verify the current Supabase session. The Edge Function was not invoked.'
        : 'No active Supabase session is available. Sign in again before invoking the Edge Function.',
      stage: 'frontend_to_edge',
      functionName,
      sessionPresent: false,
      functionInvoked: false,
      functionResponseReceived: false,
      cause: sessionState.error,
    })
  }

  // A configuration-health result can be a successful Edge Function response
  // whose application payload is { success: false, configured: false }.  That
  // is not a browser-to-function failure, so callers that need to display the
  // safe configuration diagnostic can opt into receiving that envelope.
  const { allowFailureEnvelope = false, ...functionOptions } = options
  const invokeOptions = { ...functionOptions, body }
  if (functionOptions.headers) {
    // Never allow a caller to override the current-user JWT. supabase-js adds
    // Bearer <current session access token> through its authenticated fetch.
    invokeOptions.headers = Object.fromEntries(
      Object.entries(functionOptions.headers).filter(([name]) => name.toLowerCase() !== 'authorization'),
    )
  }

  try {
    const { data, error, response } = await supabase.functions.invoke(functionName, invokeOptions)
    if (error) {
      throw await unwrapError(error, data, response, {
        functionName,
        sessionPresent: sessionState.sessionPresent,
        sessionRefreshed: sessionState.refreshed,
        functionInvoked: true,
      })
    }
    // If the function still returned a success:false envelope (rare), surface it.
    if (!allowFailureEnvelope && data && typeof data === 'object' && data.success === false) {
      const status = data.statusCode || data.providerStatus || data.status || null
      throw makeDiagnosticError({
        code: data.errorCode || data.error?.code || 'bankone_call_failed',
        message: defaultErrorMessage({ stage: errorStage({ body: data, status, error: null }), body: data, status }),
        stage: errorStage({ body: data, status, error: null }),
        functionName,
        sessionPresent: sessionState.sessionPresent,
        sessionRefreshed: sessionState.refreshed,
        functionInvoked: true,
        httpResponseReceived: true,
        functionResponseReceived: true,
        status,
        body: data,
      })
    }
    return data || {}
  } catch (e) {
    if (e?.isBankoneDiagnostic) throw e
    throw makeDiagnosticError({
      code: 'edge_function_unreachable',
      message: 'The browser could not obtain a response from the Supabase Edge Function. This is usually a CORS, network, or Supabase URL problem; BankOne was not contacted by the browser.',
      stage: 'frontend_to_edge',
      functionName,
      sessionPresent: sessionState.sessionPresent,
      sessionRefreshed: sessionState.refreshed,
      functionInvoked: true,
      httpResponseReceived: false,
      functionResponseReceived: false,
      cause: e,
    })
  }
}

export const bankoneClient = { invokeBankoneFunction, unwrapError }
export default bankoneClient
