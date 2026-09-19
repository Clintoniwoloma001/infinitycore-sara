import { supabase } from '../../supabaseClient'
import { invokeBankoneFunction } from './bankoneClient'
import { rpcWithRetry } from '../rpcHelper'
import { isAmountKoboString, isDateValidYYYYMMDD } from '../../../supabase/functions/_shared/bankone-validation.mjs'

// ---------------------------------------------------------------------------
// BankOne transaction/health service. Frontend → Edge Functions only.
// No BankOne token ever appears in a request body produced here (secrets are
// injected server-side by the edge function).
// ---------------------------------------------------------------------------

const TRANSACTION_STATUS_FN = 'bankone-transaction-status'
const HEALTH_FN = 'bankone-health'

// Convert the user's form input into the Qore-documented body field names.
// All five documented fields are required (RetrievalReference, TransactionDate,
// TransactionType, Amount and the server-injected Token).
export function toStatusPayload(input) {
  const payload = {
    RetrievalReference: String(input?.RetrievalReference || '').trim(),
    TransactionDate: String(input?.TransactionDate || '').trim(),
    TransactionType: String(input?.TransactionType || '').trim(),
    Amount: String(input?.Amount ?? '').trim(),
  }
  return payload
}

export function validateTransactionStatusInput(input) {
  const retrievalReference = String(input?.RetrievalReference || '').trim()
  const transactionDate = String(input?.TransactionDate || '').trim()
  const transactionType = String(input?.TransactionType || '').trim()
  const amount = input?.Amount === undefined || input?.Amount === null ? '' : String(input.Amount).trim()
  const errors = []

  if (!retrievalReference) errors.push('Retrieval Reference is required.')
  if (!transactionDate) errors.push('Transaction Date is required.')
  else if (!isDateValidYYYYMMDD(transactionDate)) errors.push('Transaction Date must be a valid YYYY-MM-DD date.')
  if (!transactionType) errors.push('Transaction Type is required.')
  if (!amount) errors.push('Amount is required.')
  else if (!isAmountKoboString(amount)) errors.push('Amount must be numeric kobo/CENT, with up to two decimal places.')

  return { ok: errors.length === 0, errors }
}

export const bankoneTransactionService = {
  // Documented BankOne Channels API: Transaction Status Query.
  async queryTransactionStatus(input) {
    const validation = validateTransactionStatusInput(input)
    if (!validation.ok) {
      const error = new Error(validation.errors.join(' '))
      error.code = 'invalid_request'
      error.details = validation.errors
      throw error
    }
    const payload = toStatusPayload(input)
    const res = await invokeBankoneFunction(TRANSACTION_STATUS_FN, payload)
    return {
      success: res.success !== false,
      provider: res.provider || 'bankone',
      operation: res.operation || 'transaction_status',
      status: res.status ?? 200,
      httpStatus: res.providerStatus ?? res.status ?? 200,
      requestId: res.requestId || null,
      correlationId: res.correlationId || res.requestId || null,
      providerStatus: res.providerStatus ?? null,
      providerHttpStatus: res.providerHttpStatus ?? res.providerStatus ?? null,
      providerReached: res.providerReached ?? false,
      transportSuccess: res.transportSuccess ?? null,
      providerResultValid: res.providerResultValid ?? false,
      queryProcessed: res.queryProcessed ?? false,
      applicationSuccess: res.applicationSuccess ?? null,
      transactionSuccess: res.transactionSuccess ?? null,
      transactionStatus: res.transactionStatus ?? null,
      responseCode: res.responseCode ?? null,
      responseMessage: res.responseMessage ?? null,
      retrievalReference: res.retrievalReference ?? null,
      rrn: res.rrn ?? res.retrievalReference ?? null,
      transactionDate: res.transactionDate ?? null,
      transactionType: res.transactionType ?? null,
      amount: res.amount ?? null,
      timestamp: res.timestamp ?? null,
      providerResult: res.providerResult ?? null,
      providerResultClassification: res.providerResultClassification ?? null,
      providerContentType: res.providerContentType ?? null,
      providerBodyFormat: res.providerBodyFormat ?? null,
      providerApplicationStatus: res.providerApplicationStatus ?? null,
      providerResponsePreview: res.providerResponsePreview ?? null,
      diagnostics: res.diagnostics ?? null,
      data: res.data ?? null,
      raw: res.raw ?? null,
      request: res.request ?? null,
      environment: res.environment || 'staging',
      endpoint: res.endpoint || null,
      requestTimestamp: res.requestTimestamp || null,
      durationMs: res.durationMs ?? null,
      providerRequestSent: res.providerRequestSent ?? true,
      providerResponseReceived: res.providerResponseReceived ?? true,
      error: res.error || null,
      errorCode: res.errorCode || null,
      details: res.details ?? null,
    }
  },

  validateTransactionStatusInput,

  // Internal configuration health (never a provider call).
  async providerHealth() {
    // Configuration absence is a safe, expected diagnostic returned by the
    // health function. Preserve it for the UI instead of mislabelling it as an
    // unreachable Edge Function.
    return invokeBankoneFunction(HEALTH_FN, {}, { allowFailureEnvelope: true })
  },

  // Phase 15 integration overview for the configured environment.
  async integrationHealth(environment = 'sandbox') {
    return rpcWithRetry(() => supabase.rpc('integration_health', { p_environment: environment }))
  },

  // Masked configuration surface (secrets are never returned by the RPC).
  async integrationConfig(environment = 'sandbox') {
    const config = await rpcWithRetry(() => supabase.rpc('integration_get_config', { p_environment: environment }))
    if (Array.isArray(config)) {
      return config.find((row) => row?.provider === 'bankone' && row?.environment === environment) || null
    }
    return config?.provider && config.provider !== 'bankone' ? null : config
  },

  // Recent masked provider call logs.
  async recentLogs(environment = 'sandbox', limit = 25) {
    return rpcWithRetry(() => supabase.rpc('integration_get_logs', { p_environment: environment, p_limit: limit }))
  },
}

export default bankoneTransactionService
