// BankOne/Qore integration shared constants, labels and colour maps.
// These describe provider/operation semantics for InfinityCore UIs. No
// secret values ever live here, and no endpoint path is invented — the
// endpoint list mirrors only what the official Qore/Channel docs expose.
import { PERMISSIONS } from '../../constants/permissions'

export const BANKONE_PROVIDER = 'bankone'

// DB environment values (Phase 15 integration_connections environment check).
export const BANKONE_ENVIRONMENTS = {
  sandbox: { label: 'Staging', color: 'amber' },
  live: { label: 'Production', color: 'emerald' },
}

// Frontend-visible permission gate for the BankOne integration surface.
// Server-side, every integration RPC additionally enforces current_role() =
// super_admin and the edge functions enforce the can_manage_bankone set.
export const BANKONE_READ_PERMISSION = PERMISSIONS.BANKONE_READ

export const BANKONE_OPERATIONS = {
  transaction_status: {
    label: 'Transaction Status Query',
    operation: 'transaction_status',
    endpoint: '/thirdpartyapiservice/apiservice/CoreTransactions/TransactionStatusQuery',
    method: 'POST',
  },
  health: {
    label: 'Integration Health',
    operation: 'health',
    endpoint: 'internal (configuration check, no provider call)',
    method: 'GET/POST',
  },
}

// Documented Qore/BankOne endpoints identified for the integration roadmap.
// Only transaction_status has a confirmed, implemented contract in this repo
// (see docs/bankone-integration-roadmap.md). Everything else is listed with a
// "documentation ref / not implemented" status so it is never invented.
export const BANKONE_ENDPOINT_ROADMAP = [
  {
    key: 'transaction_status',
    path: '/thirdpartyapiservice/apiservice/CoreTransactions/TransactionStatusQuery',
    category: 'Channels API',
    purpose: 'Confirm the status of a transaction',
    docs: 'https://docs.qore.inc/docs/transaction-statusquery',
    implemented: true,
  },
  {
    key: 'search_transactions',
    path: 'https://docs.mybankone.com/account/account-api/get-transactions',
    category: 'Corebanking API',
    purpose: 'Search / retrieve a customer transaction list',
    docs: 'https://docs.qore.inc/docs/welcome',
    implemented: false,
  },
  {
    key: 'get_transactions',
    path: 'http://staging.mybankone.com/BankOneWebAPI/api/Account/GetTransactions',
    category: 'Corebanking API',
    purpose: 'Get complete transactions for an account (master-account style)',
    docs: 'https://docs.mybankone.com/account/account-api/get-transactions',
    implemented: false,
  },
  {
    key: 'get_account_by_tracking_ref',
    path: 'documented only in the Qore portal (password-gated)',
    category: 'Channels/Corebanking API',
    purpose: 'Resolve an account from a transaction tracking reference',
    docs: 'https://docs.qore.inc/docs/welcome',
    implemented: false,
  },
  {
    key: 'check_post_no_debit_status',
    path: 'documented only in the Qore portal (password-gated)',
    category: 'Corebanking API',
    purpose: 'Check post-no-debit (PND) status',
    docs: 'https://docs.qore.inc/docs/welcome',
    implemented: false,
  },
  {
    key: 'retrieve_bvn_details',
    path: 'documented only in the Qore portal (password-gated)',
    category: 'Corebanking API',
    purpose: 'Retrieve BVN details for KYC',
    docs: 'https://docs.qore.inc/docs/welcome',
    implemented: false,
  },
  {
    key: 'generate_account_statement',
    path: 'documented only in the Qore portal (password-gated)',
    category: 'Corebanking API',
    purpose: 'Generate an account statement',
    docs: 'https://docs.qore.inc/docs/welcome',
    implemented: false,
  },
  {
    key: 'get_accounts_by_customer_id',
    path: 'documented only in the Qore portal (password-gated)',
    category: 'Corebanking API',
    purpose: 'List accounts for a customer',
    docs: 'https://docs.qore.inc/docs/welcome',
    implemented: false,
  },
]

export function bankoneErrorLabel(code) {
  const labels = {
    missing_credentials: 'BankOne credentials are not configured',
    session_missing: 'No active Supabase session is available',
    session_lookup_failed: 'The current Supabase session could not be verified',
    edge_function_unreachable: 'The Supabase Edge Function could not be reached',
    bankone_response_processing: 'BankOne response could not be processed',
    invalid_request: 'The request failed validation',
    timeout: 'BankOne request timed out',
    network: 'BankOne could not be reached',
    provider_http: 'BankOne returned an HTTP error',
    malformed_response: 'BankOne returned an unreadable response',
    provider_application_response_unparseable: 'BankOne responded, but the response format was not JSON',
    provider_application_response_html: 'BankOne responded with an HTML page instead of JSON',
    provider_empty_response: 'BankOne responded with an empty body',
    provider_malformed_json: 'BankOne responded with malformed JSON',
    BANKONE_PROVIDER_RESULT_FAILED: 'BankOne returned an application-level failure',
    BANKONE_PROVIDER_RESULT_UNCONFIRMED: 'BankOne returned an unconfirmed transaction result',
    unauthorized: 'BankOne rejected the API credentials (401)',
    forbidden: 'BankOne denied this request (403)',
    rate_limited: 'BankOne rate limit reached (429)',
    upstream_error: 'BankOne server error (5xx)',
    endpoint_unavailable: 'No harmless documented BankOne health endpoint is available',
    internal: 'Server-side error',
  }
  return labels[code] || 'BankOne request failed'
}

export const BANKONE_STATUS_STYLE = {
  connected: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  not_connected: 'bg-slate-100 text-slate-600 border-slate-200',
  auth_failed: 'bg-rose-50 text-rose-700 border-rose-200',
  configuration_error: 'bg-amber-50 text-amber-700 border-amber-200',
  degraded: 'bg-amber-50 text-amber-700 border-amber-200',
  disabled: 'bg-slate-100 text-slate-500 border-slate-200',
}

export const BANKONE_LOG_STATUS_STYLE = {
  ok: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  error: 'bg-rose-50 text-rose-700 border-rose-200',
  timeout: 'bg-amber-50 text-amber-700 border-amber-200',
  skipped: 'bg-slate-100 text-slate-500 border-slate-200',
}
