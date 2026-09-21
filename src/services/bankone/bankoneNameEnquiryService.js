import { invokeBankoneFunction } from './bankoneClient'

// ---------------------------------------------------------------------------
// BankOne account name-enquiry service. Frontend → Edge Function only; the
// BankOne token is injected server-side and never appears in a browser payload.
//
// Used by the Payroll Bank Linking modal to confirm an employee's salary
// account holder name before the bank details are saved onto the employee.
// ---------------------------------------------------------------------------

const NAME_ENQUIRY_FN = 'bankone-name-enquiry'
const ACCOUNT_NUMBER_RE = /^\d{10}$/

export function validateNameEnquiryInput(input) {
  const errors = []
  const accountNumber = String(input?.accountNumber || '').trim()
  const bankCode = String(input?.bankCode || '').trim()
  if (!accountNumber) errors.push('Account number is required.')
  else if (!ACCOUNT_NUMBER_RE.test(accountNumber)) errors.push('Account number must be a 10-digit NUBAN.')
  if (!bankCode) errors.push('Bank is required.')
  return { ok: errors.length === 0, errors }
}

export const bankoneNameEnquiryService = {
  // Resolve the account holder name for a (accountNumber, bankCode) pair.
  async nameEnquiry({ accountNumber, bankCode, bankName } = {}) {
    const validation = validateNameEnquiryInput({ accountNumber, bankCode })
    if (!validation.ok) {
      const error = new Error(validation.errors.join(' '))
      error.code = 'invalid_request'
      error.details = validation.errors
      throw error
    }
    const res = await invokeBankoneFunction(NAME_ENQUIRY_FN, {
      AccountNumber: String(accountNumber).trim(),
      BankCode: String(bankCode).trim(),
      ...(bankName ? { BankName: String(bankName).trim() } : {}),
    })
    return {
      success: res.success !== false && Boolean(res.accountName),
      provider: res.provider || 'bankone',
      operation: res.operation || 'name_enquiry',
      requestId: res.requestId || null,
      accountName: res.accountName || null,
      accountNumber: res.accountNumber || null,
      bankName: res.bankName || null,
      bankCode: res.bankCode || null,
      accountType: res.accountType || null,
      currency: res.currency || null,
      accountStatus: res.accountStatus || null,
      responseCode: res.responseCode ?? null,
      responseMessage: res.responseMessage ?? null,
      providerStatus: res.providerStatus ?? res.status ?? null,
      providerReached: res.providerReached ?? false,
      providerResultValid: res.providerResultValid ?? false,
      environment: res.environment || 'staging',
      endpoint: res.endpoint || null,
      durationMs: res.durationMs ?? null,
      error: res.error || null,
      errorCode: res.errorCode || null,
      details: res.details ?? null,
    }
  },

  validateNameEnquiryInput,
}

export default bankoneNameEnquiryService
