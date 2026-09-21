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

import { isAmountKoboString, isDateValidYYYYMMDD } from './bankone-validation.mjs'

export { isAmountKoboString, isDateValidYYYYMMDD } from './bankone-validation.mjs'

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

// Documented endpoint (Qore Channels API — Account Enquiry: account detail /
// name enquiry, roadmap #4 in docs/bankone-integration-roadmap.md). Used to
// resolve the account holder name before an employee bank link is saved.
export const BANKONE_NAME_ENQUIRY_ENDPOINT = `${CHANNELS_API_PATH}/AccountEnquiry/GetAccountData`

export const DEFAULT_TIMEOUT_MS = 30000
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

export function baseUrlContainsApiPath(baseUrl) {
  const path = String(baseUrl || '').toLowerCase()
  return path.includes('/thirdpartyapiservice') || path.includes('/apiservice') || path.includes('/coretransactions')
}

export function resolveBankoneEnvironment(baseUrl) {
  return String(baseUrl || '').toLowerCase().includes('staging') ? BANKONE_ENV_STAGING : BANKONE_ENV_LIVE
}

export function normalizeBankoneToken(token) {
  let normalized = String(token || '').trim()
  if ((normalized.startsWith("'") && normalized.endsWith("'")) || (normalized.startsWith('"') && normalized.endsWith('"'))) {
    normalized = normalized.slice(1, -1)
  }
  return normalized
}

export function tokenFormatDiagnostics(token) {
  const raw = String(token || '')
  const normalized = normalizeBankoneToken(token)
  return {
    tokenPresent: Boolean(raw.trim()),
    tokenLength: normalized.length,
    tokenHasSurroundingQuotes: Boolean(raw.trim()) && raw.trim() !== normalized,
    tokenHasWhitespace: /\s/.test(raw),
    tokenNormalizedLength: normalized.length,
  }
}

export function checkSecretHealth({ baseUrl = '', token = '', timeoutMs = '' } = {}) {
  const baseUrlConfigured = Boolean(String(baseUrl).trim())
  const normalizedToken = normalizeBankoneToken(token)
  const tokenConfigured = Boolean(normalizedToken)
  const tokenHasWhitespace = /\s/.test(String(token))
  const baseUrlValid = baseUrlConfigured && isAllowedBankOneHost(String(baseUrl).trim()) && !baseUrlContainsApiPath(String(baseUrl).trim())
  const timeoutValid = !timeoutMs || (Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0)
  return {
    baseUrlConfigured,
    tokenConfigured,
    tokenHasWhitespace,
    baseUrlValid,
    timeoutValid,
    configurationHealthy: baseUrlConfigured && tokenConfigured && baseUrlValid && timeoutValid && !tokenHasWhitespace,
  }
}

// Roles permitted to run live BankOne queries. Mirrors the repository's
// can_manage_bankone() gate (super_admin/admin/hr_manager/hr_officer/
// head_of_operations/financial_controller) so the Edge Function does not
// invent a second authorization system.
export const BANKONE_QUERY_ROLES = ['super_admin', 'admin', 'hr_manager', 'hr_officer', 'head_of_operations', 'financial_controller']

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// Validation — malformed requests must never reach the provider.
// ---------------------------------------------------------------------------

export function cleanString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

// Transaction references are useful for correlation, but should not be copied
// into general audit text in full.
export function maskReference(value) {
  const reference = cleanString(value, 64)
  if (!reference) return null
  if (reference.length <= 4) return '*'.repeat(reference.length)
  return `${reference.slice(0, 2)}...${reference.slice(-2)}`
}

// Validation for the transaction status query. The Qore docs mark all five
// body fields as required for a successful response: RetrievalReference,
// TransactionDate, TransactionType, Amount and Token (server-injected). Type
// and amount are therefore mandatory inputs here; nothing is invented or
// converted. Amount must be a numeric kobo/CENT string as the API requires.
export function validateTransactionStatusRequest(body) {
  const errors = []
  const raw = isPlainObject(body) ? body : {}

  const RetrievalReference = cleanString(raw.RetrievalReference, 64)
  const TransactionDate = cleanString(raw.TransactionDate, 10)
  const TransactionType = cleanString(raw.TransactionType, 64)
  const amountProvided = raw.Amount !== undefined && raw.Amount !== null && String(raw.Amount).trim() !== ''
  const Amount = typeof raw.Amount === 'number' && Number.isFinite(raw.Amount)
    ? String(raw.Amount)
    : cleanString(raw.Amount, 32)

  if (!RetrievalReference) errors.push('RetrievalReference is required')
  if (!TransactionDate) errors.push('TransactionDate is required')
  else if (!isDateValidYYYYMMDD(TransactionDate)) errors.push('TransactionDate must be a valid YYYY-MM-DD date')
  if (!TransactionType) errors.push('TransactionType is required')
  if (!amountProvided || !Amount || !isAmountKoboString(Amount)) errors.push('Amount is required and must be a numeric kobo/CENT amount (digits, optionally with up to two decimals)')

  if (errors.length > 0) return { ok: false, errors }

  return { ok: true, value: { RetrievalReference, TransactionDate, TransactionType, Amount } }
}

// ---------------------------------------------------------------------------
// Request construction — this is the ONLY place the token enters the payload.
// ---------------------------------------------------------------------------

export function buildTransactionStatusRequest({ baseUrl, token, input }) {
  const cleanBase = cleanString(baseUrl, 200).replace(/\/+$/, '')
  const normalizedToken = normalizeBankoneToken(token)
  if (!cleanBase || !normalizedToken || !isAllowedBankOneHost(cleanBase) || baseUrlContainsApiPath(cleanBase)) {
    throw new Error('missing_bankone_credentials')
  }
  const body = {
    RetrievalReference: input.RetrievalReference,
    TransactionDate: input.TransactionDate,
    TransactionType: input.TransactionType,
    Amount: String(input.Amount),
    Token: normalizedToken,
  }
  return {
    url: `${cleanBase}${BANKONE_STATUS_ENDPOINT}`,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body,
    diagnostics: {
      outgoingUrl: `${cleanBase}${BANKONE_STATUS_ENDPOINT}`,
      baseUrl: cleanBase,
      endpointPath: BANKONE_STATUS_ENDPOINT,
      tokenFormat: tokenFormatDiagnostics(token),
    },
  }
}

// ---------------------------------------------------------------------------
// Name enquiry (AccountEnquiry/GetAccountData) — resolve an account holder
// name before linking an employee's salary account. The Qore docs identify the
// endpoint and its key request field (account number); BankCode/Token are
// required server-side. No undocumented field is invented: the normalizer is
// deliberately tolerant of the provider's envelope variants.
// ---------------------------------------------------------------------------

export function validateNameEnquiryRequest(body) {
  const errors = []
  const raw = isPlainObject(body) ? body : {}

  const accountNumber = cleanString(raw.AccountNumber ?? raw.accountNumber, 20)
  const bankCode = cleanString(raw.BankCode ?? raw.bankCode, 16)
  const bankName = cleanString(raw.BankName ?? raw.bankName, 120)

  if (!accountNumber) errors.push('Account number is required')
  else if (!/^\d{10}$/.test(accountNumber)) errors.push('Account number must be a 10-digit NUBAN')
  if (!bankCode) errors.push('Bank code is required')

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { AccountNumber: accountNumber, BankCode: bankCode, BankName: bankName || null } }
}

export function buildNameEnquiryRequest({ baseUrl, token, input }) {
  const cleanBase = cleanString(baseUrl, 200).replace(/\/+$/, '')
  const normalizedToken = normalizeBankoneToken(token)
  if (!cleanBase || !normalizedToken || !isAllowedBankOneHost(cleanBase) || baseUrlContainsApiPath(cleanBase)) {
    throw new Error('missing_bankone_credentials')
  }
  const body = {
    AccountNumber: input.AccountNumber,
    BankCode: input.BankCode,
    Token: normalizedToken,
  }
  return {
    url: `${cleanBase}${BANKONE_NAME_ENQUIRY_ENDPOINT}`,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body,
    diagnostics: {
      outgoingUrl: `${cleanBase}${BANKONE_NAME_ENQUIRY_ENDPOINT}`,
      baseUrl: cleanBase,
      endpointPath: BANKONE_NAME_ENQUIRY_ENDPOINT,
      tokenFormat: tokenFormatDiagnostics(token),
    },
  }
}

// Recursively locate the first scalar value for any of the given aliases. This
// tolerates the provider's nesting variants without assuming a fixed schema.
function findProviderValue(value, aliases, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return undefined
  const wanted = new Set(aliases.map((a) => String(a).toLowerCase().replace(/[^a-z0-9]/g, '')))
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findProviderValue(item, aliases, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  for (const [key, item] of Object.entries(value)) {
    if (wanted.has(String(key).toLowerCase().replace(/[^a-z0-9]/g, '')) && item !== undefined && item !== null && item !== '') {
      if (typeof item !== 'object') return item
    }
  }
  for (const [, nested] of Object.entries(value)) {
    const found = findProviderValue(nested, aliases, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

export function extractAccountName(value) {
  return providerScalar(findProviderValue(value, [
    'AccountName', 'AccountNameEnquiry', 'NameEnquiry', 'AccountTitle',
    'AccountHolderName', 'AccountHolder', 'CustomerName',
  ]))
}

export function extractAccountDetails(value) {
  return {
    accountName: extractAccountName(value),
    accountNumber: providerScalar(findProviderValue(value, ['AccountNumber', 'Nuban', 'AccountNo'])),
    bankName: providerScalar(findProviderValue(value, ['BankName', 'Bank'])),
    bankCode: providerScalar(findProviderValue(value, ['BankCode', 'SortCode', 'BankSortCode'])),
    accountType: providerScalar(findProviderValue(value, ['AccountType', 'ProductName', 'Product'])),
    currency: providerScalar(findProviderValue(value, ['Currency', 'CurrencyCode'])),
    accountStatus: providerScalar(findProviderValue(value, ['AccountStatus'])),
  }
}

export function normalizeNameEnquiryResponse({
  raw,
  operation = 'name_enquiry',
  requestId,
  httpStatus = 200,
  durationMs,
  secret = '',
  request = null,
  timestamp = null,
  environment = null,
  providerRequestSent = true,
  providerResponseReceived = true,
  contentType = null,
  bodyFormat = null,
  diagnostics = null,
}) {
  const safeRaw = sanitizeProviderValue(raw, secret)
  const providerResult = projectProviderResult(safeRaw)
  const details = extractAccountDetails(safeRaw)
  const result = classifyProviderResult(safeRaw)
  const responseCode = providerScalar(findProviderValue(safeRaw, ['ResponseCode', 'ResultCode', 'Code']))
  const responseMessage = extractProviderMessage(safeRaw)
  const providerResultValid = Boolean(details.accountName) || hasProviderResultFields(safeRaw)
  const success = providerResultValid && Boolean(details.accountName)
  return {
    success,
    provider: PROVIDER,
    operation,
    status: httpStatus,
    providerStatus: httpStatus,
    providerHttpStatus: httpStatus,
    providerReached: true,
    transportSuccess: httpStatus >= 200 && httpStatus < 300,
    providerResultValid,
    queryProcessed: providerResultValid,
    applicationSuccess: providerResultValid ? success : null,
    requestId,
    correlationId: requestId,
    responseCode,
    responseMessage,
    accountName: details.accountName,
    accountNumber: details.accountNumber,
    bankName: details.bankName,
    bankCode: details.bankCode,
    accountType: details.accountType,
    currency: details.currency,
    accountStatus: details.accountStatus,
    providerResult,
    providerResultClassification: result.classification,
    errorCode: success ? null : (result.errorCode || 'BANKONE_NAME_ENQUIRY_UNCONFIRMED'),
    error: success ? null : (responseMessage || result.message || 'BankOne was reached, but no account name was returned.'),
    data: providerResult,
    raw: providerResult,
    request,
    environment,
    requestTimestamp: timestamp,
    durationMs,
    providerRequestSent,
    providerResponseReceived,
    providerContentType: contentType || null,
    providerBodyFormat: bodyFormat || null,
    providerApplicationStatus: providerResultValid ? (success ? 'success' : 'error') : null,
    diagnostics,
  }
}

// ---------------------------------------------------------------------------
// Response body parsing — read the body as text first so content type and the
// exact provider format are available to the caller before JSON parsing.
// ---------------------------------------------------------------------------

export function parseProviderBody(text, contentType = '') {
  if (text === undefined || text === null || String(text).trim() === '') return { ok: false, value: null, format: 'empty', error: 'empty_body' }
  const source = String(text).replace(/^\uFEFF/, '').trim()
  const declaredType = String(contentType || '').toLowerCase()
  const looksJson = source.startsWith('{') || source.startsWith('[')
  try {
    return { ok: true, value: JSON.parse(source), format: 'json' }
  } catch {
    const format = declaredType.includes('html') || /^<!doctype\s+html|^<html[\s>]/i.test(source)
      ? 'html'
      : declaredType.includes('xml') || /^<\?xml|^<[^>]+>/i.test(source)
        ? 'xml'
        : looksJson || declaredType.includes('json')
          ? 'malformed_json'
          : 'text'
    return { ok: false, value: null, error: format === 'malformed_json' ? 'malformed_json' : 'non_json_body', format }
  }
}

export function classifyNonJsonCategory(format) {
  switch (format) {
    case 'html': return ERROR_CATEGORIES.PROVIDER_APPLICATION_RESPONSE_HTML
    case 'empty': return ERROR_CATEGORIES.PROVIDER_EMPTY_RESPONSE
    case 'malformed_json': return ERROR_CATEGORIES.PROVIDER_MALFORMED_JSON
    default: return ERROR_CATEGORIES.PROVIDER_APPLICATION_RESPONSE_UNPARSEABLE
  }
}

export function nonJsonMessage(format) {
  switch (format) {
    case 'html': return SAFE_MESSAGES.provider_application_response_html
    case 'empty': return SAFE_MESSAGES.provider_empty_response
    case 'malformed_json': return SAFE_MESSAGES.provider_malformed_json
    default: return SAFE_MESSAGES.provider_application_response_unparseable
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
  PROVIDER_APPLICATION_RESPONSE_UNPARSEABLE: 'provider_application_response_unparseable',
  PROVIDER_APPLICATION_RESPONSE_HTML: 'provider_application_response_html',
  PROVIDER_EMPTY_RESPONSE: 'provider_empty_response',
  PROVIDER_MALFORMED_JSON: 'provider_malformed_json',
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
  provider_application_response_unparseable: 'BankOne responded, but the response format was not JSON.',
  provider_application_response_html: 'BankOne responded with an HTML page instead of JSON.',
  provider_empty_response: 'BankOne responded with an empty body.',
  provider_malformed_json: 'BankOne responded with malformed JSON.',
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
    case ERROR_CATEGORIES.PROVIDER_APPLICATION_RESPONSE_UNPARSEABLE: return 200
    case ERROR_CATEGORIES.PROVIDER_APPLICATION_RESPONSE_HTML: return 200
    case ERROR_CATEGORIES.PROVIDER_EMPTY_RESPONSE: return 200
    case ERROR_CATEGORIES.PROVIDER_MALFORMED_JSON: return 200
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
  if (status === 408) return safeError({ category: ERROR_CATEGORIES.TIMEOUT, status })
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
export function normalizeResponse({
  raw,
  operation,
  requestId,
  httpStatus = 200,
  durationMs,
  secret = '',
  request = null,
  timestamp = null,
  environment = null,
  providerRequestSent = true,
  providerResponseReceived = true,
  contentType = null,
  bodyFormat = null,
  diagnostics = null,
}) {
  const safeRaw = sanitizeProviderValue(raw, secret)
  const providerResult = projectProviderResult(safeRaw)
  const providerResultValid = hasProviderResultFields(safeRaw)
  const result = classifyProviderResult(safeRaw)
  const providerPayload = findProviderPayload(safeRaw)
  const responseCode = providerField(providerPayload, ['ResponseCode', 'ResultCode', 'Code'])
  const responseMessage = providerField(providerPayload, ['ResponseMessage', 'ResultMessage', 'Message', 'Description'])
  const transactionStatus = extractProviderStatus(providerPayload)
  const transactionSuccess = classifyTransactionStatus(transactionStatus)
  const retrievalReference = providerField(providerPayload, ['RetrievalReference', 'Reference', 'RRN', 'RetrievalReferenceNumber'])
  const transactionDate = providerField(providerPayload, ['TransactionDate', 'Date'])
  const transactionType = providerField(providerPayload, ['TransactionType', 'Type'])
  const amount = providerField(providerPayload, ['Amount', 'TransactionAmount'])
  const timestampValue = providerField(providerPayload, ['Timestamp', 'TransactionTimestamp', 'ResponseTimestamp'])
  return {
    // `success` describes the provider/application result. It is deliberately
    // separate from transportSuccess and transactionSuccess below.
    success: providerResultValid && result.success,
    provider: PROVIDER,
    operation,
    status: httpStatus,
    providerStatus: httpStatus,
    providerHttpStatus: httpStatus,
    providerReached: true,
    transportSuccess: httpStatus >= 200 && httpStatus < 300,
    providerResultValid,
    queryProcessed: providerResultValid,
    applicationSuccess: providerResultValid ? result.success : null,
    transactionSuccess,
    requestId,
    correlationId: requestId,
    responseCode: providerScalar(responseCode),
    responseMessage: providerScalar(responseMessage),
    retrievalReference: maskReference(retrievalReference),
    rrn: maskReference(retrievalReference),
    transactionDate: providerScalar(transactionDate),
    transactionType: providerScalar(transactionType),
    amount: amount === undefined || amount === null || amount === '' ? null : amount,
    timestamp: providerScalar(timestampValue),
    transactionStatus,
    providerResult,
    providerResultClassification: result.classification,
    errorCode: result.success ? null : result.errorCode,
    error: result.success ? null : result.message,
    data: providerResult,
    raw: providerResult,
    request,
    environment,
    requestTimestamp: timestamp,
    durationMs,
    providerRequestSent,
    providerResponseReceived,
    providerContentType: contentType || null,
    providerBodyFormat: bodyFormat || null,
    providerApplicationStatus: providerResultValid ? (result.success ? 'success' : 'error') : null,
    diagnostics,
  }
}

export function buildUnparseableProviderResponse({
  rawText = '',
  httpStatus = 200,
  contentType = null,
  bodyFormat = null,
  operation,
  requestId,
  durationMs,
  secret = '',
  request = null,
  timestamp = null,
  environment = null,
  providerRequestSent = true,
  providerResponseReceived = true,
  diagnostics = null,
}) {
  const safePreview = providerResponsePreview(rawText, secret)
  const category = classifyNonJsonCategory(bodyFormat)
  return {
    success: false,
    provider: PROVIDER,
    operation,
    status: httpStatus,
    providerStatus: httpStatus,
    providerHttpStatus: httpStatus,
    providerReached: true,
    transportSuccess: httpStatus >= 200 && httpStatus < 300,
    providerResultValid: false,
    queryProcessed: false,
    applicationSuccess: false,
    transactionSuccess: null,
    providerApplicationStatus: 'unparseable',
    requestId,
    correlationId: requestId,
    responseCode: null,
    responseMessage: null,
    retrievalReference: null,
    rrn: null,
    transactionDate: null,
    transactionType: null,
    amount: null,
    timestamp: null,
    transactionStatus: null,
    providerResult: null,
    providerResultClassification: bodyFormat || 'unparseable',
    errorCode: category,
    error: nonJsonMessage(bodyFormat),
    data: null,
    raw: null,
    request,
    environment,
    requestTimestamp: timestamp,
    durationMs,
    providerRequestSent,
    providerResponseReceived,
    providerContentType: contentType || null,
    providerBodyFormat: bodyFormat || null,
    providerResponsePreview: safePreview,
    diagnostics,
  }
}

export function providerResponsePreview(text, secret = '', maxLength = 500) {
  if (text === undefined || text === null) return null
  let raw = String(text).replace(/^\uFEFF/, '').trim()
  if (!raw) return null
  // Collapse whitespace and strip simple HTML tags before truncation/redaction
  // so the preview is a safe, readable text fragment.
  raw = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, maxLength)
  if (secret) raw = redactText(raw, secret)
  // Final defensive strip of any plausible bearer/token patterns that might
  // appear in an error page.
  raw = raw.replace(/(Bearer\s+)[A-Za-z0-9._~%!@#+=-]+/gi, '$1REDACTED')
  return raw
}

export function sanitizeResponseHeaders(headers, secret = '') {
  const safe = {}
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase()
    if (['authorization', 'cookie', 'set-cookie', 'x-api-key'].includes(lower)) continue
    let v = String(value || '')
    if (secret) v = redactText(v, secret)
    v = v.replace(/(Bearer\s+)[A-Za-z0-9._~%!@#+=-]+/gi, '$1REDACTED')
    safe[key] = v.slice(0, 500)
  }
  return safe
}

export function providerResponseDiagnostics({
  rawText = '',
  response,
  outgoingUrl = null,
  secret = '',
  maxPreviewLength = 500,
}) {
  if (!response) return null
  const finalUrl = response.url || null
  const redirectDetected = Boolean(outgoingUrl && finalUrl && outgoingUrl !== finalUrl)
  const contentType = response.headers.get('content-type') || null
  const contentLength = response.headers.get('content-length') || null
  const location = response.headers.get('location') || null
  const server = response.headers.get('server') || null
  const safeHeaders = sanitizeResponseHeaders(response.headers, secret)
  const bodyLength = typeof rawText === 'string' ? rawText.length : 0
  const preview = providerResponsePreview(rawText, secret, maxPreviewLength)
  return {
    finalUrl,
    redirectDetected,
    outgoingUrl,
    contentType,
    contentLength,
    location,
    server,
    safeHeaders,
    bodyLength,
    preview,
  }
}

export function sanitizeProviderValue(value, secret = '') {
  if (Array.isArray(value)) return value.map((item) => sanitizeProviderValue(item, secret))
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (/(token|authorization|secret|api[_-]?key|client[_-]?secret)/i.test(key)) {
        return [key, '[REDACTED]']
      }
      if (/(retrieval[_-]?reference|reference|rrn)/i.test(key) && item !== null && item !== undefined) {
        return [key, maskReference(item)]
      }
      return [key, sanitizeProviderValue(item, secret)]
    }))
  }
  return typeof value === 'string' && secret ? redactText(value, secret) : value
}

function providerKey(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase()
}

const PROVIDER_ENVELOPE_KEYS = new Set(['data', 'result', 'response', 'transaction', 'payload'])
const PROVIDER_FIELDS = new Set([
  'amount',
  'code',
  'description',
  'date',
  'error',
  'errormessage',
  'issuccessful',
  'message',
  'reference',
  'responsecode',
  'responsemessage',
  'responsetimestamp',
  'result',
  'resultcode',
  'resultmessage',
  'retrievalreference',
  'retrievalreferencenumber',
  'rrn',
  'status',
  'success',
  'timestamp',
  'transactionamount',
  'transactiondate',
  'transactionstatus',
  'transactionstatuscode',
  'transactiontimestamp',
  'transactiontype',
  'type',
])

function hasKnownProviderField(value) {
  if (!isPlainObject(value)) return false
  return Object.entries(value).some(([key, item]) => {
    const normalizedKey = providerKey(key)
    if (!PROVIDER_FIELDS.has(normalizedKey)) return false
    // `result`, `data`, and similar keys can be envelopes rather than result
    // fields. Only count a scalar Result as a direct provider field; nested
    // objects are inspected recursively below.
    if (PROVIDER_ENVELOPE_KEYS.has(normalizedKey)) return item === null || typeof item !== 'object'
    return true
  })
}

function findProviderPayload(value, depth = 0) {
  if (!isPlainObject(value) || depth > 4) return value
  if (hasKnownProviderField(value)) return value
  for (const [key, nested] of Object.entries(value)) {
    if (PROVIDER_ENVELOPE_KEYS.has(providerKey(key)) && isPlainObject(nested)) {
      const found = findProviderPayload(nested, depth + 1)
      if (hasKnownProviderField(found)) return found
    }
  }
  return value
}

function providerField(value, aliases) {
  const payload = findProviderPayload(value)
  if (!isPlainObject(payload)) return undefined
  const wanted = new Set(aliases.map(providerKey))
  const entry = Object.entries(payload).find(([key, item]) => wanted.has(providerKey(key)) && item !== undefined)
  return entry ? entry[1] : undefined
}

function providerScalar(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'object' || typeof value === 'function') return null
  return String(value).slice(0, 500)
}

function hasProviderResultFields(value) {
  if (!value || typeof value !== 'object') return false
  if (hasKnownProviderField(value)) return true
  if (Array.isArray(value)) return value.some((item) => hasProviderResultFields(item))
  return Object.entries(value).some(([key, nested]) => PROVIDER_ENVELOPE_KEYS.has(providerKey(key)) && hasProviderResultFields(nested))
}

// BankOne field names vary by endpoint; sample a small known set without
// fabricating a schema. Null when none are present.
export function extractProviderStatus(meta) {
  return providerScalar(providerField(meta, ['TransactionStatus', 'Status', 'TransactionStatusCode']))
}

function classifyTransactionStatus(status) {
  const marker = providerMarker(status)
  if (!marker) return null
  if (SUCCESS_MARKERS.has(marker)) return true
  if (FAILURE_MARKERS.has(marker)) return false
  return null
}

// Provider error schemas vary. Only known, short message fields are surfaced
// after recursive secret redaction; the complete provider error is not copied
// into an audit row.
export function extractProviderMessage(value) {
  if (!isPlainObject(value)) return null
  const direct = providerField(value, ['ResponseMessage', 'ErrorMessage', 'Message', 'Description'])
  if (typeof direct === 'string' && direct.trim()) return direct.trim().slice(0, 500)
  for (const [key, nested] of Object.entries(value)) {
    if (PROVIDER_ENVELOPE_KEYS.has(providerKey(key)) || providerKey(key) === 'error') {
      const message = extractProviderMessage(nested)
      if (message) return message
    }
  }
  return null
}

const PROVIDER_RESULT_KEYS = new Set([
  'accountname',
  'accountno',
  'accountnumber',
  'accountholder',
  'accountholdername',
  'accountstatus',
  'accounttitle',
  'accounttype',
  'amount',
  'bank',
  'bankcode',
  'bankname',
  'code',
  'currency',
  'currencycode',
  'customername',
  'data',
  'description',
  'date',
  'errormessage',
  'issuccessful',
  'message',
  'nuban',
  'payload',
  'product',
  'productname',
  'reference',
  'responsecode',
  'responsemessage',
  'responsetimestamp',
  'response',
  'result',
  'resultcode',
  'resultmessage',
  'retrievalreference',
  'retrievalreferencenumber',
  'rrn',
  'sortcode',
  'status',
  'success',
  'timestamp',
  'transactionamount',
  'transactiondate',
  'transaction',
  'transactionstatus',
  'transactionstatuscode',
  'transactiontimestamp',
  'transactiontype',
  'type',
])

const SUCCESS_MARKERS = new Set(['0', '00', '000', '200', 'OK', 'SUCCESS', 'SUCCESSFUL', 'COMPLETED', 'FULFILLED'])
const FAILURE_MARKERS = new Set(['1', '01', '99', 'ERROR', 'FAILED', 'FAILURE', 'REJECTED', 'DECLINED', 'DENIED'])

// Only return fields needed to classify/display a transaction-status result.
// Unknown provider fields are intentionally not copied to the browser.
export function projectProviderResult(value, depth = 0) {
  if (depth > 3) return '[TRUNCATED]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value.slice(0, 500)
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => projectProviderResult(item, depth + 1))
  if (!isPlainObject(value)) return null

  const projected = {}
  for (const [key, item] of Object.entries(value)) {
    if (!PROVIDER_RESULT_KEYS.has(providerKey(key))) continue
    projected[key] = projectProviderResult(item, depth + 1)
  }
  return projected
}

function providerMarker(value) {
  if (value === undefined || value === null || value === '') return null
  return String(value).trim().toUpperCase()
}

function providerResultOutcome(value) {
  const payload = findProviderPayload(value)
  if (!isPlainObject(payload)) return null
  const booleanSuccess = providerField(payload, ['IsSuccessful', 'Success'])
  if (typeof booleanSuccess === 'boolean') return booleanSuccess

  const code = providerMarker(providerField(payload, ['ResponseCode', 'ResultCode', 'Code']))
  if (code) return SUCCESS_MARKERS.has(code) ? true : FAILURE_MARKERS.has(code) || code.length > 0 ? false : null

  const marker = providerMarker(extractProviderStatus(payload))
  if (marker && SUCCESS_MARKERS.has(marker)) return true
  if (marker && FAILURE_MARKERS.has(marker)) return false

  const message = providerMarker(providerField(payload, ['ResponseMessage', 'ResultMessage', 'Message']))
  if (message === 'OK' || message === 'SUCCESS' || message === 'SUCCESSFUL' || message === 'COMPLETED') return true
  if (message === 'ERROR' || message === 'FAILED' || message === 'FAILURE' || message === 'REJECTED' || message === 'DECLINED') return false
  return null
}

export function classifyProviderResult(value) {
  const outcome = providerResultOutcome(value)
  if (outcome === true) return { success: true, classification: 'success', errorCode: null, message: null }
  if (outcome === false) {
    return {
      success: false,
      classification: 'business_failure',
      errorCode: 'BANKONE_PROVIDER_RESULT_FAILED',
      message: 'BankOne was reached, but the provider rejected/failed the transaction query.',
    }
  }
  return {
    success: false,
    classification: 'unconfirmed',
    errorCode: 'BANKONE_PROVIDER_RESULT_UNCONFIRMED',
    message: 'BankOne was reached, but no explicit successful transaction result was returned.',
  }
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
