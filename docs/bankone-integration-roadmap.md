# BankOne / Qore Channel API — Integration Roadmap

Secure integration layer between InfinityCore and BankOne (Qore Channels API).
The BankOne token never leaves the server side: all calls pass through a
Supabase Edge Function that authenticates the logged-in user, authorizes them
with the existing HR-ops role gate, injects the token server-side, and records
every attempt into the Phase 15 audit surfaces.

## Architecture

```
Browser (React)
   │  supabase.functions.invoke("bankone-transaction-status")   ← JWT only, NO token
   ▼
Supabase Edge Function
   │  verify JWT → can_manage_bankone() role gate → inject BANKONE_API_TOKEN
   ▼
BankOne / Qore Channel API  (documented endpoints only)
   ▲
   └ every call logged via integration_record_provider_call → integration_logs
```

- Token, base URL and BankOne operating configuration live only in Edge Function
  secrets (`BANKONE_API_TOKEN`, `BANKONE_API_BASE_URL`,
  `BANKONE_ACCOUNT_NUMBER`, `BANKONE_CREDIT_GL_CODE`,
  `BANKONE_DEBIT_GL_CODE`) — never in `VITE_*`, never in the bundle, never in
  browser payloads, logs or error messages. The transaction-status token is
  injected only into the server-side provider request.
- DB audit RPC is gated to the service-role runtime (or a dashboard super
  admin); arbitrary authenticated users cannot forge connection/log state.
- There is no "Token" field anywhere in the frontend. Source-level checks in
  `scripts/test-bankone-integration.mjs` enforce this.

## Roadmap (documented Qore endpoints)

`Qore API docs: https://docs.qore.inc` (access is password-gated; endpoint list
below follows the public Channels API reference).

| # | Endpoint / Operation | Purpose | Authentication | Key fields (request) | Implementation |
|---|----------------------|---------|----------------|---------------------|----------------|
| 1 | `POST /thirdpartyapiservice/apiservice/CoreTransactions/TransactionStatusQuery` | Query transaction status by reference | Qore token in JSON body `Token` | `RetrievalReference` (required), `TransactionDate` (YYYY-MM-DD) (required), `TransactionType`, `Amount` | ✅ Edge function `bankone-transaction-status` (this PR) |
| 2 | `POST /thirdpartyapiservice/apiservice/CoreTransactions/InternalTransactions` | Open / initiate an internal transaction | Qore token | account, amount, debit/credit legs | ⬜ Identified; not implemented (needs business flow + sample body) |
| 3 | `POST /thirdpartyapiservice/apiservice/AccountEnquiry/GetAccountBalance` | Account balance enquiry | Qore token | account number | ⬜ Identified (phase8 schema); not implemented |
| 4 | `POST /thirdpartyapiservice/apiservice/AccountEnquiry/GetAccountData` | Account detail / name enquiry | Qore token | account number | ⬜ Identified (phase8 schema); not implemented |
| 5 | `POST /thirdpartyapiservice/apiservice/CoreTransactions/Transactions` | Transactions export by date range | Qore token | account, start/end date | ⬜ Identified; not implemented |

### Implemented — transaction status (Endpoints 1)

Edge function: `supabase/functions/bankone-transaction-status/index.ts`

- Request (from InfinityCore): `{ RetrievalReference, TransactionDate, TransactionType?, Amount? }`
- The function merges `Token` server-side and POSTs to the documented URL above.
- `TransactionDate` must be `YYYY-MM-DD`; `Amount` is a numeric string and is
  forwarded verbatim (never converted) — no currency conversion is performed.
- Response is normalized to
  `{ success, provider, operation, status, requestId, providerStatus, responseCode, responseMessage, data, raw, durationMs }`.
  Provider HTTP status codes are preserved (200/400/401/403/404/429/5xx);
  timeouts map to 504. Provider response bodies are forwarded untouched for
  field compatibility, but the token is never emitted by InfinityCore.

### Implemented — integration health (no provider call)

Edge function: `supabase/functions/bankone-health/index.ts`

Returns safe presence diagnostics for the required server-side configuration
and `providerReachability` derived only from the latest real transaction-status
attempt, if one exists. It is a **passive** check: it does not invent a
BankOne endpoint or a health call that Qore has not published. With no real
provider attempt, the provider state is `not_tested`.

## Configuration

| Secret | Purpose |
|--------|---------|
| `BANKONE_API_BASE_URL` | Base URL, e.g. `https://staging.mybankone.com` |
| `BANKONE_API_TOKEN` | Qore channel API token (staging) |
| `BANKONE_ACCOUNT_NUMBER` | Server-side BankOne account configuration |
| `BANKONE_CREDIT_GL_CODE` | Server-side credit GL configuration |
| `BANKONE_DEBIT_GL_CODE` | Server-side debit GL configuration |

> The real staging token value lives only in the gitignored
> `supabase/functions/.env.local` (local dev) and the Supabase project's
> secret store — never in the repository or the client bundle.

Local serving: `supabase functions serve bankone-transaction-status bankone-health`.

## Database

Migration (idempotent, additive): `schema_phase43_bankone_live_api.sql`

- `public.integration_record_provider_call(...)` — SECURITY DEFINER RPC used by
  the edge function to write `integration_logs` rows and update
  `integration_connections`. It records the authenticated caller in
  `integration_logs.created_by` and is gated to `service_role` / `super_admin`.
- Hardens `public.integration_apply_test_result(...)` (Phase 15) with the same
  server-side-only gate (previously any authenticated user could forge a
  `TEST_CONNECTION` log and flip connection status).

## Frontend

- `src/services/bankone/bankoneClient.js` — `supabase.functions.invoke` wrapper.
- `src/services/bankone/bankoneTransactionService.js` — status query + health +
  Phase 15 config/log RPC reads (`rpcWithRetry`).
- `src/services/bankone/bankoneTypes.js` — env labels (`sandbox`→Staging,
  `live`→Production), documented endpoint roadmap, status styles.
- `src/pages/BankOneIntegration.jsx` — admin/HR-ops page (route
  `/bankone-integration`, permission `BANKONE_READ`): explicit Test Connection
  diagnostics, separate configuration/Edge Function/provider states, status
  query form, result panel, masked recent logs, endpoint roadmap table.

## Verification

- `npm run test:bankone` — 23 tests: validation, creds safety, status
  classification, timeout, malformed JSON, token-never-returned /
  never-logged / never-sent-from-frontend (source-level).
- `npm run build` — Vite production build succeeds.
- Local edge-function smoke: serving via `supabase functions serve` returns
  the authored 401/403 JSON for unauthenticated/anon callers (proves compile +
  JWT gate), no Deno errors at boot.

## Boundary / blocked items

- A **real staging transaction reference** (`RetrievalReference`) from BankOne
  is required to exercise a live 200 response end-to-end. That credential must
  be obtained from BankOne; the first live smoke test should be run with it
  and its result recorded in `integration_logs`.
- Qore docs are password-gated; endpoint #2-5 bodies need the documented
  samples confirmed before implementation.
