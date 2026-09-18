// ============================================================================
// bankone-core.mjs — pure, dependency-free BankOne/Qore integration helpers.
//
// This module is shared by the Edge Functions AND the Node test harness. It
// MUST stay free of Deno/Node runtime specifics so it can be imported by both
// runtimes without a build step.
//
// Security contract enforced here:
//   * The BankOne token is ONLY ever written into an outgoing provider request
//     (buildTransactionStatusRequest). It is never included in normalized
//     responses, log summaries, error payloads or health payloads.
//   * Logs are written through redactText() so any leaked secret is scrubbed.
//   * No BankOne endpoint path is invented here — paths come only from the
//     official Qore/BankOne Channel API documentation.
// ============================================================================

export const PROVIDER = 'bankone'
export const BANKONE_ENV_STAGING = 'sandbox' // DB environment value for the staging surface
export const BANKONE_ENV_LIVE = 'live'

// Channel API base path is fixed by the Qore docs for the thirdparty service;
// the host is configurable server-side via BANKONE_API_BASE_URL (defaults to
// the confirmed staging host).
export const DEFAULT_BANKONE_BASE_URL = 'https://staging.mybankone.com'
export const CHANNELS_API_PATH = '/thirdpartyapiservice/apiservice'

// Confirmed documented endpoint (Qore Developer Portal — Transaction Status
// Query; Channels API category). Do not add undocumented peers here.
export const BANKONE_STATUS_ENDPOINT = `${CHANNELS_API_PATH}/CoreTransactions/TransactionStatusQuery`

export const DEFAULT_TIMEOUT_MS = 15000
export const MAX_TIMEOUT_MS = 60000

export function isAllowedBankOneHost(baseUrl) {
  let url
  try {
    url = new URL(String(baseUrl || '').trim())
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  return host === 'staging.mybankone.com' || host === 'api.mybankone.com' || host === 'mybankone.com'
}

export function resolveBankoneEnvironment(baseUrl) {
  return String(baseUrl || '').toLowerCase().includes('staging') ? BANKONE_ENV_STAGING : BANKONE_ENV_LIVE
}

// Roles permitted to run live BankOne queries. Mirrors the repository's
// can_manage_bankone() gate (super_admin/admin/hr_manager/hr_officer/
// operations_manager) so the Edge Function does not invent a second
// authorization system.
export const BANKONE_QUERY_ROLES = ['super_admin', 'admin', 'hr_manager', 'hr_officer', 'operations_manager']

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// Validation — malformed requests must never reach the provider.
// ---------------------------------------------------------------------------

// Validates a true calendar date, not just the YYYY-MM-DD shape.
export function isDateValidYYYYMMDD(value) {
  if (typeof value !== 'string') return false
  if (!DATE_RE.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

// Numeric string that BankOne interprets as an amount in kobo/CENT units.
// Kept as a string and forwarded unchanged — we never convert currency.
export function isAmountKoboString(value) {
  if (typeof value !== 'string') return false
  return AMOUNT_RE.test(value)
}

export function cleanString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

// Validation for the transaction status query. The Qore docs mark all five
// body fields as required for a successful response; InfinityCore treats
// RetrievalReference + TransactionDate as mandatory and forwards
// TransactionType/Amount when supplied. Never converts any value.
export function validateTransactionStatusRequest(body) {
  const errors = []
  const raw = isPlainObject(body) ? body : {}

  const RetrievalReference = cleanString(raw.RetrievalReference, 64)
  const TransactionDate = cleanString(raw.TransactionDate, 10)
  const TransactionType = cleanString(raw.TransactionType, 64)
  const Amount = cleanString(raw.Amount, 32)

  if (!RetrievalReference) errors.push('RetrievalReference is required')
  if (!TransactionDate) errors.push('TransactionDate is required')
  else if (!isDateValidYYYYMMDD(TransactionDate)) errors.push('TransactionDate must be a valid YYYY-MM-DD date')
  if (Amount && !isAmountKoboString(Amount)) errors.push('Amount must be a numeric kobo/CENT amount (digits, optionally with up to two decimals)')

  if (errors.length > 0) return { ok: false, errors }

  const value = { RetrievalReference, TransactionDate }
  if (TransactionType) value.TransactionType = TransactionType
  if (Amount) value.Amount = Amount
  return { ok: true, value }
}

// ---------------------------------------------------------------------------
// Request construction — this is the ONLY place the token enters the payload.
// ---------------------------------------------------------------------------

export function buildTransactionStatusRequest({ baseUrl, token, input }) {
  const cleanBase = cleanString(baseUrl, 200).replace(/\/+$/, '')
  if (!cleanBase || !token) throw new Error('missing_bankone_credentials')
  const body = {
    RetrievalReference: input.RetrievalReference,
    TransactionDate: input.TransactionDate,
    Token: token,
  }
  if (input.TransactionType) body.TransactionType = input.TransactionType
  if (input.Amount) body.Amount = input.Amount
  return {
    url: `${cleanBase}${BANKONE_STATUS_ENDPOINT}`,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body,
  }
}

// ---------------------------------------------------------------------------
// Response body parsing — non-JSON upstream bodies are treated as malformed.
// ---------------------------------------------------------------------------

export function parseProviderBody(text) {
  if (text === undefined || text === null || text === '') return { ok: true, value: null }
  try {
    return { ok: true, value: JSON.parse(String(text)) }
  } catch {
    return { ok: false, value: null, error: 'malformed_json' }
  }
}

// ---------------------------------------------------------------------------
// Timeout handling
// ---------------------------------------------------------------------------

export function resolveTimeoutMs(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.floor(n), MAX_TIMEOUT_MS)
}

// ---------------------------------------------------------------------------
// Safe error classification (never exposes stack traces or secrets)
// ---------------------------------------------------------------------------

export const ERROR_CATEGORIES = {
  MISSING_CREDENTIALS: 'missing_credentials',
  INVALID_REQUEST: 'invalid_request',
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  PROVIDER_HTTP: 'provider_http',
  MALFORMED_RESPONSE: 'malformed_response',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  RATE_LIMITED: 'rate_limited',
  UPSTREAM_ERROR: 'upstream_error',
  ENDPOINT_UNAVAILABLE: 'endpoint_unavailable',
  INTERNAL: 'internal',
}

const SAFE_MESSAGES = {
  missing_credentials: 'BankOne integration is not configured server-side.',
  invalid_request: 'The request failed validation before reaching BankOne.',
  timeout: 'BankOne did not respond in time. The request timed out.',
  network: 'BankOne could not be reached. Please try again later.',
  malformed_response: 'BankOne returned an unreadable response.',
  unauthorized: 'BankOne rejected the API credentials (HTTP 401).',
  forbidden: 'BankOne denied this request (HTTP 403).',
  rate_limited: 'BankOne rate limit reached (HTTP 429). Try again shortly.',
  upstream_error: 'BankOne returned a server error (HTTP 5xx).',
  endpoint_unavailable: 'No harmless documented BankOne connectivity endpoint is configured.',
}

export function safeError({
  category = ERROR_CATEGORIES.INTERNAL,
  status = null,
  providerMessage = null,
  internal = null,
}) {
  const message = SAFE_MESSAGES[category] || 'The BankOne request could not be completed.'
  return {
    code: category,
    message,
    status: status ?? failureStatusForCategory(category),
    providerMessage: typeof providerMessage === 'string' ? providerMessage.slice(0, 500) : null,
    internal: typeof internal === 'string' ? internal.slice(0, 200) : null,
  }
}

export function failureStatusForCategory(category) {
  switch (category) {
    case ERROR_CATEGORIES.INVALID_REQUEST: return 400
    case ERROR_CATEGORIES.UNAUTHORIZED: return 401
    case ERROR_CATEGORIES.FORBIDDEN: return 403
    case ERROR_CATEGORIES.RATE_LIMITED: return 429
    case ERROR_CATEGORIES.TIMEOUT: return 504
    case ERROR_CATEGORIES.NETWORK: return 502
    case ERROR_CATEGORIES.MISSING_CREDENTIALS: return 500
    case ERROR_CATEGORIES.MALFORMED_RESPONSE: return 502
    case ERROR_CATEGORIES.ENDPOINT_UNAVAILABLE: return 501
    case ERROR_CATEGORIES.PROVIDER_HTTP: return null
    default: return 500
  }
}

// Maps an upstream HTTP status to a safe, non-leaky error classification so
// the frontend sees a status + safe message instead of the provider's body.
export function classifyProviderStatus(status) {
  if (status === 400) return safeError({ category: ERROR_CATEGORIES.INVALID_REQUEST, status, providerMessage: 'BankOne rejected the request body (HTTP 400).' })
  if (status === 401) return safeError({ category: ERROR_CATEGORIES.UNAUTHORIZED, status })
  if (status === 403) return safeError({ category: ERROR_CATEGORIES.FORBIDDEN, status })
  if (status === 404) return safeError({ category: ERROR_CATEGORIES.UPSTREAM_ERROR, status, providerMessage: 'BankOne could not find the resource (HTTP 404).' })
  if (status === 429) return safeError({ category: ERROR_CATEGORIES.RATE_LIMITED, status })
  if (status >= 500) return safeError({ category: ERROR_CATEGORIES.UPSTREAM_ERROR, status })
  return null
}

// ---------------------------------------------------------------------------
// Normalized response envelope
// ---------------------------------------------------------------------------

// Returns a normalized InfinityCore envelope. Provider responses are retained
// for operator visibility, but credential-shaped fields and any configured
// secret are scrubbed before they can reach the browser.
export function normalizeResponse({ raw, operation, requestId, httpStatus = 200, durationMs, secret = '' }) {
  const safeRaw = sanitizeProviderValue(raw, secret)
  const isObject = isPlainObject(safeRaw)
  const meta = isObject ? safeRaw : null
  const providerStatus = isObject ? extractProviderStatus(meta) : null
  return {
    success: httpStatus >= 200 && httpStatus < 300,
    provider: PROVIDER,
    operation,
    status: httpStatus,
    requestId,
    providerStatus,
    responseCode: isObject ? String(meta?.ResponseCode ?? meta?.responseCode ?? '') : null,
    responseMessage: isObject ? String(meta?.ResponseMessage ?? meta?.responseMessage ?? '') : null,
    data: isObject ? safeRaw : null,
    raw: isObject ? safeRaw : null,
    durationMs,
  }
}

function sanitizeProviderValue(value, secret = '') {
  if (Array.isArray(value)) return value.map((item) => sanitizeProviderValue(item, secret))
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (/(token|authorization|secret|api[_-]?key|client[_-]?secret)/i.test(key)) {
        return [key, '[REDACTED]']
      }
      return [key, sanitizeProviderValue(item, secret)]
    }))
  }
  return typeof value === 'string' && secret ? redactText(value, secret) : value
}

// BankOne field names vary by endpoint; sample a small known set without
// fabricating a schema. Null when none are present.
export function extractProviderStatus(meta) {
  for (const key of ['TransactionStatus', 'Status', 'status', 'TransactionStatusCode']) {
    const v = meta?.[key]
    if (v !== undefined && v !== null && v !== '') return String(v)
  }
  return null
}

// ---------------------------------------------------------------------------
// Redaction — used before anything is written to logs / audit / errors.
// ---------------------------------------------------------------------------

export function redactText(text, secret) {
  if (typeof text !== 'string' || !text) return typeof text === 'string' ? text : ''
  if (!secret) return text
  let out = text
  if (secret.length >= 4) out = out.split(secret).join('REDACTED')
  else out = out.split(secret).join('*')
  // Also scrub any plausible bearer-auth headers.
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~%!@#+=-]+/gi, '$1REDACTED')
  return out
}

export function containsSecret(text, secret) {
  if (typeof text !== 'string' || !secret) return false
  return secret.length >= 4 ? text.includes(secret) : text.split(secret).length > 1
}

// Builds a safe, token-free log summary for audit/`integration_logs`.
export function maskedLogSummary({ operation, status, httpStatus, requestId, errorCode, durationMs }) {
  const parts = [`bankone:${operation}`]
  if (status) parts.push(`status=${status}`)
  if (httpStatus) parts.push(`http=${httpStatus}`)
  if (errorCode) parts.push(`error=${errorCode}`)
  // Only use the fixed, safe message for a known error category. Provider
  // response text is never copied into an audit row.
  if (errorCode && SAFE_MESSAGES[errorCode]) parts.push(`message=${SAFE_MESSAGES[errorCode]}`)
  if (requestId) parts.push(`request=${requestId}`)
  if (durationMs != null) parts.push(`ms=${durationMs}`)
  return parts.join(' ')
}

// ---------------------------------------------------------------------------
// Random correlation/request id — crypto.randomUUID where available, with a
// safe fallback for runtimes without one.
// ---------------------------------------------------------------------------

export function newRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = []
  for (let i = 0; i < 16; i += 1) b.push(Math.floor(Math.random() * 256).toString(16).padStart(2, '0'))
  return `${b.slice(0, 4).join('')}-${b.slice(4, 6).join('')}-${b.slice(6, 8).join('')}-${b.slice(8, 10).join('')}-${b.slice(10, 16).join('')}`
}
