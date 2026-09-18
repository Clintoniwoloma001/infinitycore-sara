// ============================================================================
// BankOne integration test harness (Node, no dependencies).
//
//   npm run test:bankone
//
// Exercises the pure shared core (supabase/functions/_shared/bankone-core.mjs)
// that powers the Edge Functions, plus source-level security guarantees:
//   1. Missing RetrievalReference           7. BankOne 401/403
//   2. Missing TransactionDate              8. BankOne 500
//   3. Invalid date / invalid amount        9. Timeout
//   4. Missing BankOne credentials         10. Malformed JSON response
//   5. Successful BankOne response         11. Token never returned
//   6. BankOne 400                         12. Token never logged
//                                          13. Frontend never sends Token
//
// Live-transaction note: no fabricated BankOne transaction reference is used.
// A REAL staging RetrievalReference is only needed for a live staging test,
// which this harness intentionally does not perform.
// ============================================================================

import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as core from '../supabase/functions/_shared/bankone-core.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOKEN = 'test-token-that-must-never-leak'
const GOOD = { RetrievalReference: 'RET-REF-123', TransactionDate: '2026-09-18', TransactionType: 'ST', Amount: '150000' }

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (e) {
    failed += 1
    failures.push({ name, message: e.message })
    console.log(`  FAIL ${name}\n       ${e.message}`)
  }
}

function expect(cond, message) {
  if (!cond) throw new Error(message || 'expectation failed')
}
function expectEq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
function expectThrows(fn, needle, message) {
  let threw = null
  try { fn() } catch (e) { threw = e }
  if (!threw) throw new Error(message || 'expected function to throw')
  if (needle && !String(threw.message).includes(needle)) throw new Error(`expected error to include "${needle}", got "${threw.message}"`)
}

console.log('BankOne integration tests (pure core + source-level security checks)')
console.log(`working root: ${root}`)

// --- 1-3. Validation --------------------------------------------------------
test('1. Missing RetrievalReference is rejected', () => {
  const { ok, errors } = core.validateTransactionStatusRequest({ ...GOOD, RetrievalReference: '   ' })
  expect(!ok, 'should fail validation')
  expect(errors.some((e) => e.includes('RetrievalReference')), 'should mention RetrievalReference')
})

test('2. Missing TransactionDate is rejected', () => {
  const { ok, errors } = core.validateTransactionStatusRequest({ ...GOOD, TransactionDate: '' })
  expect(!ok, 'should fail validation')
  expect(errors.some((e) => e.includes('TransactionDate')), 'should mention TransactionDate')
})

test('3a. Invalid TransactionDate format rejected', () => {
  const { ok, errors } = core.validateTransactionStatusRequest({ ...GOOD, TransactionDate: '18/09/2026' })
  expect(!ok, 'should fail validation')
  expect(errors.some((e) => e.includes('YYYY-MM-DD')), 'should mention YYYY-MM-DD')
})

test('3b. Impossible date (Feb 30) rejected', () => {
  const { ok } = core.validateTransactionStatusRequest({ ...GOOD, TransactionDate: '2026-02-30' })
  expect(!ok, 'Feb 30 must be invalid')
})

test('3c. Invalid Amount rejected (letters / symbols)', () => {
  const a = core.validateTransactionStatusRequest({ ...GOOD, Amount: '150,000' })
  expect(!a.ok, 'comma amount invalid')
  const b = core.validateTransactionStatusRequest({ ...GOOD, Amount: 'abc' })
  expect(!b.ok, 'letters invalid')
  const c = core.validateTransactionStatusRequest({ ...GOOD, Amount: '150000' })
  expect(c.ok, 'plain digits ok')
  const d = core.validateTransactionStatusRequest({ ...GOOD, Amount: '1500.50' })
  expect(d.ok, 'two-decimal amount ok')
})

test('3d. Optional fields forwarded verbatim, never converted', () => {
  const noOpt = core.validateTransactionStatusRequest({ RetrievalReference: 'R1', TransactionDate: '2026-01-01' })
  expect(noOpt.ok, 'optional fields not required client-side')
  expect(!('Amount' in noOpt.value), 'Amount not invented when omitted')
  const withOccur = core.validateTransactionStatusRequest({ RetrievalReference: 'R1', TransactionDate: '2026-01-01', Amount: '00100', TransactionType: 'FUND' })
  expectEq(withOccur.value.Amount, '00100', 'Amount forwarded unchanged')
  expectEq(withOccur.value.TransactionType, 'FUND', 'TransactionType forwarded unchanged')
})

test('3e. Non-object request body rejected as malformed', () => {
  expectEq(core.validateTransactionStatusRequest(null).ok, false, 'null body invalid')
  expectEq(core.validateTransactionStatusRequest('text').ok, false, 'string body invalid')
  expectEq(core.validateTransactionStatusRequest([1, 2]).ok, false, 'array body invalid')
})

test('3f. Pure validation fixture payload is preserved exactly', () => {
  const result = core.validateTransactionStatusRequest(GOOD)
  expect(result.ok, 'validation fixture should validate')
  expectEq(JSON.stringify(result.value), JSON.stringify(GOOD), 'validation fixture must not be substituted or converted')
})

// --- 4. Missing credentials -------------------------------------------------
test('4. Missing BankOne credentials is a safe, explicit error', () => {
  expectThrows(() => core.buildTransactionStatusRequest({ baseUrl: '', token: '', input: GOOD }), 'missing_bankone_credentials')
  expectThrows(() => core.buildTransactionStatusRequest({ baseUrl: core.DEFAULT_BANKONE_BASE_URL, token: '', input: GOOD }), 'missing_bankone_credentials')
  const err = core.safeError({ category: core.ERROR_CATEGORIES.MISSING_CREDENTIALS })
  expectEq(err.status, 500, 'credentials error maps to 500')
  expect(!String(JSON.stringify(err)).includes('token'), 'error must not contain a token')
})

test('4b. Request builder adds the token ONLY into the outgoing provider body', () => {
  const req = core.buildTransactionStatusRequest({ baseUrl: core.DEFAULT_BANKONE_BASE_URL, token: TOKEN, input: GOOD })
  expectEq(req.url, 'https://staging.mybankone.com/thirdpartyapiservice/apiservice/CoreTransactions/TransactionStatusQuery', 'confirmed endpoint URL')
  expectEq(req.body.Token, TOKEN, 'token present in outgoing body')
  expect(!JSON.stringify(req.headers).includes(TOKEN), 'token must not be in headers')
})

// --- 5. Successful response normalization -------------------------------------
test('5. Successful BankOne response is safely projected and classified', () => {
  const mock = { TransactionStatus: 'FULFILLED', ResponseCode: '00', ResponseMessage: 'OK', Amount: 150000, extra: { nested: true } }
  const out = core.normalizeResponse({ raw: mock, operation: 'transaction_status', requestId: 'req-1', httpStatus: 200, durationMs: 120, secret: TOKEN, request: { retrievalReference: 'RE...23', transactionDate: '2026-09-18' } })
  expectEq(out.success, true, 'success true')
  expectEq(out.provider, 'bankone', 'provider label')
  expectEq(out.status, 200, 'http status preserved')
  expectEq(out.providerStatus, 200, 'provider HTTP status preserved')
  expectEq(out.transactionStatus, 'FULFILLED', 'transaction status extracted')
  expectEq(out.data.Amount, 150000, 'safe amount preserved')
  expect(!('extra' in out.raw), 'unknown provider fields are not exposed')
  expectEq(out.request.retrievalReference, 'RE...23', 'masked request reference preserved')
  expect(!JSON.stringify(out).includes(TOKEN), 'token never in normalized response')
})

test('5b. Bare 200 with empty body is not mistaken for a successful query', () => {
  const out = core.normalizeResponse({ raw: null, operation: 'transaction_status', requestId: 'r', httpStatus: 200 })
  expectEq(out.success, false, '200 null body is unconfirmed')
  expectEq(out.errorCode, 'BANKONE_PROVIDER_RESULT_UNCONFIRMED', 'unconfirmed result has a safe classification')
  expect(out.data === null, 'null body stays null')
})

test('5c. Provider business failure stays failed even when HTTP is 200', () => {
  const out = core.normalizeResponse({ raw: { ResponseCode: '99', ResponseMessage: 'Rejected' }, operation: 'transaction_status', requestId: 'r', httpStatus: 200 })
  expectEq(out.success, false, 'business failure must not become success')
  expectEq(out.providerReached, true, 'provider response confirms reachability')
  expectEq(out.providerHttpStatus, 200, 'provider HTTP status is preserved')
  expectEq(out.errorCode, 'BANKONE_PROVIDER_RESULT_FAILED', 'business failure is classified')
})

// --- 6-8. Provider HTTP classification (preserve status, never leak body) -------
test('6. BankOne 400 → invalid_request, status preserved, no provider body', () => {
  const err = core.classifyProviderStatus(400)
  expectEq(err.status, 400, '400 preserved')
  expectEq(err.code, 'invalid_request', 'classified as invalid_request')
  expect(!JSON.stringify(err).includes('token'), 'no token')
})

test('7. BankOne 401 and 403 → safe auth errors', () => {
  const e401 = core.classifyProviderStatus(401)
  expectEq(e401.status, 401, '401 preserved')
  expectEq(e401.code, 'unauthorized', '401 → unauthorized')
  const e403 = core.classifyProviderStatus(403)
  expectEq(e403.status, 403, '403 preserved')
  expectEq(e403.code, 'forbidden', '403 → forbidden')
})

test('7b. 404 handled safely (required by spec)', () => {
  const e404 = core.classifyProviderStatus(404)
  expectEq(e404.status, 404, '404 preserved')
  expectEq(e404.code, 'upstream_error', '404 classified as upstream error')
})

test('7c. 408 is preserved as a provider timeout', () => {
  const e408 = core.classifyProviderStatus(408)
  expectEq(e408.status, 408, '408 preserved')
  expectEq(e408.code, 'timeout', '408 classified as timeout')
})

test('8. BankOne 500 → upstream_error, status preserved', () => {
  const err = core.classifyProviderStatus(500)
  expectEq(err.status, 500, '500 preserved')
  expectEq(err.code, 'upstream_error', 'classified as upstream_error')
})

test('8b. 429 → rate_limited', () => {
  const err = core.classifyProviderStatus(429)
  expectEq(err.status, 429, '429 preserved')
  expectEq(err.code, 'rate_limited', '429 classified as rate_limited')
})

// --- 9. Timeout ---------------------------------------------------------------
test('9. Timeout is a safe, distinct error (504, never hangs)', () => {
  const err = core.safeError({ category: core.ERROR_CATEGORIES.TIMEOUT })
  expectEq(err.status, 504, 'timeout → 504')
  expectEq(err.code, 'timeout', 'timeout code')
  expect(!JSON.stringify(err).includes('stack'), 'no stack trace leaked')
  expectEq(core.resolveTimeoutMs('5'), 5, 'timeout honours config')
  expectEq(core.resolveTimeoutMs('999999'), core.MAX_TIMEOUT_MS, 'timeout is capped')
  expectEq(core.resolveTimeoutMs('garbage'), core.DEFAULT_TIMEOUT_MS, 'bad timeout falls back')
})

// --- 10. Malformed JSON --------------------------------------------------------
test('10. Malformed JSON provider body is detected', () => {
  const r = core.parseProviderBody('<html>error</html>')
  expectEq(r.ok, false, 'non-JSON recognised')
  const good = core.parseProviderBody('{"a":1}')
  expectEq(good.ok, true, 'valid JSON ok')
  expectEq(core.parseProviderBody('').ok, true, 'empty body ok')
})

// --- 11. Token never returned --------------------------------------------------
test('11. Token never appears in any output envelope', () => {
  const mock = { TransactionStatus: 'OK', Token: 'INJECTED', token: TOKEN, ResponseCode: '00', inner: { Token: TOKEN } }
  const out = core.normalizeResponse({ raw: mock, operation: 'transaction_status', requestId: 'req-2', httpStatus: 200, secret: TOKEN })
  const err = core.safeError({ category: core.ERROR_CATEGORIES.UPSTREAM_ERROR, status: 502 })
  const log = core.maskedLogSummary({ operation: 'transaction_status', status: 'error', httpStatus: 502, requestId: 'req-2', errorCode: 'upstream_error', durationMs: 10 })
  expect(!JSON.stringify(out).includes(TOKEN), 'normalized provider data must redact the token')
  expect(!JSON.stringify(err).includes(TOKEN), 'error payload has no token')
  expect(!log.includes(TOKEN), 'log summary has no token')
  const red = core.redactText(`request failed token=${TOKEN}`, TOKEN)
  expect(!red.includes(TOKEN), 'redactText strips token')
})

// --- 12. Token never logged ----------------------------------------------------
test('12. maskedLogSummary + redaction never include the token', () => {
  const secret = 'QoreSuperSecret'
  const original = `error from provider ${secret}`
  expect(core.containsSecret(original, secret), 'sanity: secret detectable in raw text')
  const scrubbed = core.redactText(original, secret)
  expect(!core.containsSecret(scrubbed, secret), 'redactText must scrub the token')
  expect(!scrubbed.includes(secret), 'scrubbed text must not contain the token')
  expect(!core.containsSecret(core.maskedLogSummary({ operation: 'transaction_status', status: 'error', httpStatus: 500, requestId: 'r', errorCode: 'upstream_error', durationMs: 5 }), secret), 'summary never holds a token')
})

// --- 13. Frontend never sends Token (source-level) ------------------------------
test('13. Frontend source never references BankOne credentials or a Token field', () => {
  const dir = join(root, 'src', 'services', 'bankone')
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'))
  expect(files.length >= 3, 'bankone services exist')
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8')
    expect(!src.includes('BANKONE_API_TOKEN'), `${f} must not reference BANKONE_API_TOKEN`)
    expect(!src.includes('BANKONE_API_BASE_URL'), `${f} must not reference BANKONE_API_BASE_URL`)
    // Network-call detection: no raw fetch/http client in the service layer.
    expect(!/\bfetch\s*\(|XMLHttpRequest|\baxios\b/.test(src), `${f} must not open its own network calls`)
    expect(!/\bToken\s*[:=]/.test(src), `${f} must never compose a Token field`)
    expect(!src.includes('import.meta.env.VITE_BANKONE'), `${f} must not read VITE_BANKONE_*`)
  }
  // The page/form must not define a Token field either.
  const pageSrc = readFileSync(join(root, 'src', 'pages', 'BankOneIntegration.jsx'), 'utf8')
  expect(!/\bToken\s*[:=]/.test(pageSrc), 'page must not compose a Token field')
  expect(!pageSrc.includes('BANKONE_API_TOKEN'), 'page must not reference the token')
})

test('13b. No VITE_BANKONE_* variables anywhere in the app env files', () => {
  const pattern = /VITE_BANKONE/i
  let hits = 0
  for (const name of ['package.json', '.env.example', '.env.base44-defaults', 'supabase/config.toml']) {
    const p = join(root, name)
    try {
      const src = readFileSync(p, 'utf8')
      if (pattern.test(src)) { hits += 1; console.log(`       env-var leak candidate: ${name}`) }
    } catch {
      /* optional file */
    }
  }
  expectEq(hits, 0, 'no VITE_BANKONE_* variables configured')
})

test('13c. Frontend invokes the Supabase Edge Function, never BankOne directly', () => {
  const src = readFileSync(join(root, 'src', 'services', 'bankone', 'bankoneClient.js'), 'utf8')
  expect(src.includes('supabase.functions.invoke'), 'client must use supabase.functions.invoke')
  expect(!src.includes('fetch('), 'client must not fetch any URL directly')
})

test('14. Test Connection reuses the authenticated transaction-status flow', () => {
  const service = readFileSync(join(root, 'src', 'services', 'bankone', 'bankoneTransactionService.js'), 'utf8')
  const page = readFileSync(join(root, 'src', 'pages', 'BankOneIntegration.jsx'), 'utf8')
  expect(!service.includes('bankone-test-connection'), 'service must not invoke the configuration-only test function')
  expect(page.includes('onClick={testConnection}'), 'page must expose the Test Connection action')
  expect(page.includes('bankoneTransactionService.queryTransactionStatus'), 'Test Connection must reuse transaction status')
  expect(page.includes('Connection testing requires a valid BankOne staging transaction reference.'), 'page must explain the real-reference requirement')
  expect(!page.includes('Not available'), 'page must not report the documented endpoint as unavailable')
})

test('13d. Frontend verifies the current Supabase session before invoking', () => {
  const src = readFileSync(join(root, 'src', 'services', 'bankone', 'bankoneClient.js'), 'utf8')
  expect(src.includes('supabase.auth.getSession'), 'client must check the current session')
  expect(src.includes('supabase.auth.refreshSession'), 'client must be able to refresh an expiring session')
  expect(src.includes('invokeOptions'), 'client must pass the validated body to the standard invoke call')
  expect(!src.includes('BANKONE_API_TOKEN'), 'client must not reference the provider token')
})

// --- Finishing ----------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`)
if (failures.length) {
  console.log('\nfailures:')
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`)
  process.exit(1)
}
process.exit(0)
