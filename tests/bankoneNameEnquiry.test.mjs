import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  BANKONE_NAME_ENQUIRY_ENDPOINT,
  CHANNELS_API_PATH,
  validateNameEnquiryRequest,
  buildNameEnquiryRequest,
  extractAccountName,
  extractAccountDetails,
  normalizeNameEnquiryResponse,
  BANKONE_QUERY_ROLES,
} from '../supabase/functions/_shared/bankone-core.mjs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const edge = read('supabase/functions/bankone-name-enquiry/index.ts')
const config = read('supabase/config.toml')
const service = read('src/services/bankone/bankoneNameEnquiryService.js')
const modal = read('src/components/payroll/BankOneLinkModal.jsx')
const page = read('src/pages/PayrollBankOne.jsx')
const banks = read('src/constants/nigerianBanks.js')

const SECRET = 'super-secret-bankone-token'

// ------------------------------------------------------------------
// 1. Documented endpoint (roadmap #4) — never invented.
// ------------------------------------------------------------------
assert.equal(BANKONE_NAME_ENQUIRY_ENDPOINT, `${CHANNELS_API_PATH}/AccountEnquiry/GetAccountData`)

// ------------------------------------------------------------------
// 2. Validation — required NUBAN + bank code.
// ------------------------------------------------------------------
assert.deepEqual(
  validateNameEnquiryRequest({ AccountNumber: '0123456789', BankCode: '058' }),
  { ok: true, value: { AccountNumber: '0123456789', BankCode: '058', BankName: null } },
)
assert.equal(validateNameEnquiryRequest({ AccountNumber: '123', BankCode: '058' }).ok, false)
assert.equal(validateNameEnquiryRequest({ AccountNumber: '0123456789', BankCode: '' }).ok, false)
assert.equal(validateNameEnquiryRequest({}).ok, false)

// ------------------------------------------------------------------
// 3. Request build — the ONLY place the token enters the payload, and the
//    host guard rejects non-BankOne URLs.
// ------------------------------------------------------------------
const built = buildNameEnquiryRequest({
  baseUrl: 'https://staging.mybankone.com',
  token: SECRET,
  input: { AccountNumber: '0123456789', BankCode: '058' },
})
assert.equal(built.url, `https://staging.mybankone.com${BANKONE_NAME_ENQUIRY_ENDPOINT}`)
assert.equal(built.body.Token, SECRET)
assert.equal(built.body.AccountNumber, '0123456789')
assert.throws(
  () => buildNameEnquiryRequest({ baseUrl: 'https://evil.example.com', token: SECRET, input: { AccountNumber: '0123456789', BankCode: '058' } }),
  /missing_bankone_credentials/,
)

// ------------------------------------------------------------------
// 4. Tolerant name extraction across provider envelope variants.
// ------------------------------------------------------------------
assert.equal(extractAccountName({ ResponseCode: '00', data: { AccountNameEnquiry: 'JOHN DOE' } }), 'JOHN DOE')
assert.equal(extractAccountName({ result: { account_name: 'JANE DOE' } }), 'JANE DOE')
assert.equal(extractAccountName({ data: { AccountTitle: 'ACME LTD' } }), 'ACME LTD')
assert.equal(extractAccountName({ ResponseCode: '00' }), null)

const details = extractAccountDetails({
  data: { AccountName: 'JOHN DOE', AccountNumber: '0123456789', BankName: 'GTBank', BankCode: '058', AccountType: 'SAVINGS' },
})
assert.equal(details.accountName, 'JOHN DOE')
assert.equal(details.accountNumber, '0123456789')
assert.equal(details.bankName, 'GTBank')
assert.equal(details.bankCode, '058')
assert.equal(details.accountType, 'SAVINGS')

// ------------------------------------------------------------------
// 5. Normalization — success requires a resolved account name; the token is
//    never present in the normalized envelope.
// ------------------------------------------------------------------
const ok = normalizeNameEnquiryResponse({
  raw: { ResponseCode: '00', data: { AccountName: 'JOHN DOE', AccountNumber: '0123456789' } },
  requestId: 'r1', httpStatus: 200, durationMs: 10, secret: SECRET,
})
assert.equal(ok.success, true)
assert.equal(ok.accountName, 'JOHN DOE')
assert.equal(ok.operation, 'name_enquiry')
assert.equal(ok.provider, 'bankone')
assert.equal(JSON.stringify(ok).includes(SECRET), false, 'token never returned')

const noName = normalizeNameEnquiryResponse({
  raw: { ResponseCode: '00', Message: 'No record' },
  requestId: 'r2', httpStatus: 200, durationMs: 10, secret: SECRET,
})
assert.equal(noName.success, false)
assert.ok(noName.error)
assert.equal(JSON.stringify(noName).includes(SECRET), false, 'token never returned on failure')

// ------------------------------------------------------------------
// 6. Edge function — JWT + role gate mirrors the DB, verify_jwt configured.
// ------------------------------------------------------------------
assert.match(edge, /BANKONE_QUERY_ROLES/)
assert.match(edge, /createClient\(supabaseUrl, anonKey/)
assert.match(edge, /supabase\.auth\.getUser\(\)/)
assert.match(edge, /BANKONE_NAME_ENQUIRY_ENDPOINT/)
assert.match(edge, /Deno\.env\.get\('BANKONE_API_TOKEN'\)/)
assert.match(edge, /redactText\(/)
assert.doesNotMatch(edge, /body\.Token\s*[:=]\s*[^,}]*response/i, 'token is never echoed into a response')
assert.ok(BANKONE_QUERY_ROLES.includes('head_of_operations') && BANKONE_QUERY_ROLES.includes('financial_controller'))

assert.match(config, /\[functions\.bankone-name-enquiry\]/)
assert.match(config, /verify_jwt = true/)
assert.match(config, /entrypoint = "\.\/functions\/bankone-name-enquiry\/index\.ts"/)

// ------------------------------------------------------------------
// 7. Frontend — service, modal and Payroll wiring.
// ------------------------------------------------------------------
assert.match(service, /nameEnquiry/)
assert.match(service, /\/\^\\d\{10\}\$\//)
assert.match(service, /invokeBankoneFunction\('bankone-name-enquiry'|NAME_ENQUIRY_FN/)
assert.doesNotMatch(service, /BANKONE_API_TOKEN/, 'no token in the browser service')

assert.match(modal, /bankoneNameEnquiryService\.nameEnquiry/)
assert.match(modal, /employeeService\.updateHrFields/)
assert.match(modal, /bank_sort_code/)
assert.match(modal, /bank_name/)
assert.match(modal, /account_name/)
assert.match(modal, /Confirm &amp; Link|Confirm & Link/)

assert.match(page, /BankOneLinkModal/)
assert.match(page, /PAYROLL_BANK_LINK_ROLES/)
assert.match(page, /Link Bank Account/)

// Bank catalogue must be code/name pairs.
assert.match(banks, /code: '058', name: 'Guaranty Trust Bank/)
assert.match(banks, /findBankByCode/)

console.log('bankoneNameEnquiry.test.mjs passed')
