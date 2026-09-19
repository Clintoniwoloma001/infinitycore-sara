import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, ArrowRightLeft, CheckCircle2, Globe, LayoutList, Loader2,
  RefreshCw, Search, Server, ShieldCheck, Timer, XCircle,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { EmptyState, ErrorState, LoadingState } from '../components/PageStates'
import { bankoneTransactionService } from '../services/bankone/bankoneTransactionService'
import {
  BANKONE_ENVIRONMENTS,
  BANKONE_ENDPOINT_ROADMAP,
  BANKONE_OPERATIONS,
  BANKONE_LOG_STATUS_STYLE,
  bankoneErrorLabel,
} from '../services/bankone/bankoneTypes'

const cardCls = 'bg-white rounded-lg border border-slate-200 p-5 mb-6'
const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1'
const btn = 'inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium'
const btnPrimary = `${btn} bg-[#009944] text-white hover:bg-[#007a36] disabled:opacity-50`

const fmtDate = (v) => (v ? new Date(v).toLocaleString() : '—')
const fmtMs = (v) => (v === null || v === undefined ? '—' : `${v} ms`)

const CONFIG_ENV = Object.keys(BANKONE_ENVIRONMENTS)[0] // sandbox (Staging)
const TRANSACTION_STATUS_ENDPOINT = BANKONE_OPERATIONS.transaction_status.endpoint

const DIAGNOSTIC_STAGE_LABELS = {
  client_validation: 'Request validation failed',
  frontend_to_edge: 'Frontend -> Supabase Edge Function failed',
  edge_function: 'Supabase Edge Function returned an error',
  edge_to_bankone: 'Edge Function -> BankOne failed',
  bankone_http: 'BankOne returned an HTTP error',
  bankone_response_processing: 'BankOne response could not be processed',
}

function diagnosticFromError(error, fallback = 'BankOne integration call failed.') {
  const source = error?.diagnostic || error || {}
  return {
    title: DIAGNOSTIC_STAGE_LABELS[source.stage] || 'BankOne integration call failed',
    message: error?.message || bankoneErrorLabel(error?.code) || fallback,
    stage: source.stage || 'edge_function',
    code: source.code || error?.code || 'bankone_call_failed',
    functionName: source.functionName || error?.functionName || 'bankone-transaction-status',
    functionTarget: source.functionTarget || error?.functionTarget || null,
    sessionPresent: source.sessionPresent ?? error?.sessionPresent ?? null,
    sessionRefreshed: source.sessionRefreshed ?? error?.sessionRefreshed ?? false,
    functionInvoked: source.functionInvoked ?? error?.functionInvoked ?? false,
    httpResponseReceived: source.httpResponseReceived ?? error?.httpResponseReceived ?? false,
    functionResponseReceived: source.functionResponseReceived ?? error?.functionResponseReceived ?? false,
    providerRequestSent: source.providerRequestSent ?? error?.providerRequestSent ?? null,
    providerResponseReceived: source.providerResponseReceived ?? error?.providerResponseReceived ?? null,
    httpStatus: source.httpStatus ?? error?.httpStatus ?? error?.rawStatus ?? null,
    providerHttpStatus: source.providerHttpStatus ?? error?.providerHttpStatus ?? null,
    providerResultValid: source.providerResultValid ?? error?.providerResultValid ?? false,
    providerResultClassification: source.providerResultClassification ?? error?.providerResultClassification ?? null,
    transactionStatus: source.transactionStatus ?? error?.transactionStatus ?? null,
    transactionSuccess: source.transactionSuccess ?? error?.transactionSuccess ?? null,
    responseCode: source.responseCode ?? error?.responseCode ?? null,
    responseMessage: source.responseMessage ?? error?.responseMessage ?? null,
    retrievalReference: source.retrievalReference ?? error?.retrievalReference ?? null,
    transactionDate: source.transactionDate ?? error?.transactionDate ?? null,
    transactionType: source.transactionType ?? error?.transactionType ?? null,
    amount: source.amount ?? error?.amount ?? null,
    timestamp: source.timestamp ?? error?.timestamp ?? null,
    providerContentType: source.providerContentType ?? error?.providerContentType ?? null,
    providerBodyFormat: source.providerBodyFormat ?? error?.providerBodyFormat ?? null,
    providerApplicationStatus: source.providerApplicationStatus ?? error?.providerApplicationStatus ?? null,
    providerResponsePreview: source.providerResponsePreview ?? error?.providerResponsePreview ?? null,
    diagnostics: source.diagnostics ?? error?.diagnostics ?? null,
    correlationId: source.correlationId ?? error?.correlationId ?? source.requestId ?? error?.requestId ?? null,
    requestTimestamp: source.requestTimestamp || error?.requestTimestamp || null,
    durationMs: source.durationMs ?? error?.durationMs ?? null,
    requestId: source.requestId || error?.requestId || null,
    supabaseRequestId: source.supabaseRequestId || error?.supabaseRequestId || null,
    transportMessage: source.transportMessage || error?.transportMessage || null,
    responseBody: source.responseBody ?? error?.responseBody ?? null,
    details: source.details || error?.details || null,
  }
}

function validationDiagnostic(errors) {
  return {
    title: DIAGNOSTIC_STAGE_LABELS.client_validation,
    message: errors.join(' '),
    stage: 'client_validation',
    code: 'invalid_request',
    functionName: 'bankone-transaction-status',
    sessionPresent: null,
    functionInvoked: false,
    httpResponseReceived: false,
    functionResponseReceived: false,
    httpStatus: null,
    providerHttpStatus: null,
    requestId: null,
    supabaseRequestId: null,
    responseBody: null,
    details: errors,
  }
}

function boolDiagnostic(value) {
  if (value === true) return 'Yes'
  if (value === false) return 'No'
  return 'Not checked'
}

function diagnosticResponseMessage(diagnostic) {
  const body = diagnostic?.responseBody
  if (body?.responseMessage) return body.responseMessage
  if (body?.error?.providerMessage) return body.error.providerMessage
  if (typeof body?.error === 'string') return body.error
  if (body?.error?.message) return body.error.message
  if (body?.message) return body.message
  return typeof body === 'string' ? body : null
}

export default function BankOneIntegration() {
  const auth = useAuth()
  const canAdmin = auth.actualRole === 'super_admin'
  const [environment, setEnvironment] = useState(CONFIG_ENV)

  // Health / overview
  const [health, setHealth] = useState(null)
  const [config, setConfig] = useState(null)
  const [providerHealth, setProviderHealth] = useState(null)
  const [connectionTest, setConnectionTest] = useState(null)
  const [testingConnection, setTestingConnection] = useState(false)
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [overviewDiagnostic, setOverviewDiagnostic] = useState(null)

  // Transaction status query
  const queryCardRef = useRef(null)
  const [form, setForm] = useState({ RetrievalReference: '', TransactionDate: '', TransactionType: '', Amount: '' })
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [queryError, setQueryError] = useState(null)
  const [connectionTestRequested, setConnectionTestRequested] = useState(false)

  const loadOverview = useCallback(async () => {
    setLoading(true)
    setError('')
    setOverviewDiagnostic(null)
    try {
      const providerHealthPromise = bankoneTransactionService.providerHealth().catch((e) => {
        setOverviewDiagnostic(diagnosticFromError(e, 'The BankOne health Edge Function could not be verified.'))
        return { functionOperational: false, configurationHealthy: null, reachabilityStatus: 'not_tested' }
      })
      const [h, c, ph] = await Promise.all([
        bankoneTransactionService.integrationHealth(environment).catch((e) => { if (e?.message?.toLowerCase().includes('super admin')) return { permissionDenied: true }; throw e }),
        bankoneTransactionService.integrationConfig(environment).catch((e) => { if (e?.message?.toLowerCase().includes('super admin')) return { permissionDenied: true }; throw e }),
        providerHealthPromise,
      ])
      setHealth(h)
      setConfig(c)
      setProviderHealth(ph)
    } catch (e) {
      setError(e?.message || 'Unable to load BankOne integration overview.')
    } finally {
      setLoading(false)
    }
  }, [environment])

  const loadLogs = useCallback(async () => {
    try {
      const entries = await bankoneTransactionService.recentLogs(environment, 20).catch(() => [])
      setLogs((entries || []).filter((entry) => entry.operation === 'transaction_status'))
    } catch {
      setLogs([])
    }
  }, [environment])

  useEffect(() => {
    loadOverview()
    loadLogs()
  }, [loadOverview, loadLogs])

  const refresh = () => {
    loadOverview()
    loadLogs()
  }

  const latency = useMemo(() => {
    const withDur = (logs || []).filter((l) => l.duration_ms != null)
    if (!withDur.length) return null
    const avg = withDur.reduce((s, l) => s + Number(l.duration_ms), 0) / withDur.length
    return { avg: Math.round(avg * 10) / 10, samples: withDur.length }
  }, [logs])

  const validation = bankoneTransactionService.validateTransactionStatusInput(form)
  const txnReady = validation.ok

  const runQuery = async ({ asConnectionTest = connectionTestRequested } = {}) => {
    if (!validation.ok) {
      if (asConnectionTest) {
        setConnectionTest({ status: 'needs_input' })
        setConnectionTestRequested(true)
        queryCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      } else {
        setQueryError(validationDiagnostic(validation.errors))
        setResult({ query: { ...form } })
      }
      return
    }
    setBusy(true)
    if (asConnectionTest) {
      setTestingConnection(true)
      setConnectionTest({ status: 'loading' })
    }
    setQueryError(null)
    setResult(null)
    const query = {
      RetrievalReference: form.RetrievalReference.trim(),
      TransactionDate: form.TransactionDate.trim(),
      TransactionType: form.TransactionType.trim(),
      Amount: String(form.Amount ?? '').trim(),
    }
    try {
      const response = await bankoneTransactionService.queryTransactionStatus(form)
      const completed = { ...response, query }
      setResult(completed)
      if (asConnectionTest) setConnectionTest({ status: 'responded', response: completed, query })
    } catch (e) {
      const diagnostic = diagnosticFromError(e, 'The transaction status query could not be completed.')
      const failed = { ...(e?.envelope || {}), success: false, status: diagnostic.providerHttpStatus || diagnostic.httpStatus || e?.envelope?.statusCode || null, query }
      setResult(failed)
      if (asConnectionTest) {
        setConnectionTest({ status: 'error', diagnostic, query })
      } else {
        setQueryError(diagnostic)
      }
    } finally {
      setBusy(false)
      if (asConnectionTest) {
        setTestingConnection(false)
        setConnectionTestRequested(false)
      }
      await Promise.all([loadLogs(), loadOverview()])
    }
  }

  const testConnection = async () => {
    setTestingConnection(true)
    setConnectionTest({ status: 'checking_health' })
    try {
      // Health is passive: it verifies the authenticated Supabase gateway and
      // server-side configuration, but never claims that BankOne was reached.
      const healthCheck = await bankoneTransactionService.providerHealth()
      setProviderHealth((current) => ({ ...(current || {}), ...healthCheck }))
      if (!healthCheck?.configured || healthCheck?.functionOperational === false) {
        setConnectionTest({ status: 'health_failed', response: healthCheck })
        return
      }
      setConnectionTestRequested(true)
      // runQuery owns the provider attempt and clears the testing state.
      setTestingConnection(false)
      await runQuery({ asConnectionTest: true })
    } catch (e) {
      setConnectionTest({
        status: 'health_error',
        diagnostic: diagnosticFromError(e, 'The authenticated BankOne health check could not be completed.'),
      })
    } finally {
      // If a transaction query started, runQuery handles this state itself.
      setTestingConnection(false)
    }
  }

  const endpoint = BANKONE_OPERATIONS.transaction_status

  return (
    <div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">BankOne Integration</h2>
          <p className="text-sm text-slate-500 mt-1">
            Secure Channel API gateway — queries are proxied through Supabase Edge Functions. The BankOne token never reaches the browser.
          </p>
        </div>
         <div className="flex items-center gap-2">
           <button onClick={testConnection} disabled={testingConnection} className={btnPrimary}>
             {testingConnection ? <Loader2 size={15} className="animate-spin" /> : <Activity size={15} />}
             {testingConnection ? 'Testing…' : 'Test Connection'}
           </button>
           <button onClick={refresh} className={`${btn} border border-slate-300 text-slate-700 hover:bg-slate-50`}>
             <RefreshCw size={15} /> Refresh
           </button>
         </div>
      </div>

      {loading ? (
        <LoadingState label="Loading BankOne integration…" />
      ) : error ? (
        <ErrorState message={error} onRetry={loadOverview} />
      ) : (
        <>
          <OverviewGrid
            health={health}
            config={config}
            providerHealth={providerHealth}
            logs={logs}
            latency={latency}
            environment={environment}
            canAdmin={canAdmin}
            onChangeEnv={setEnvironment}
          />
        </>
      )}
      {overviewDiagnostic && <DiagnosticPanel diagnostic={overviewDiagnostic} />}
      <ConnectionTestPanel test={connectionTest} />

      {/* ---- Transaction Status Query ---- */}
       <div ref={queryCardRef} className={cardCls}>
        <div className="flex items-center gap-2 mb-1">
          <Search size={16} className="text-[#009944]" />
          <h3 className="text-lg font-semibold text-slate-900">Transaction Status Query</h3>
        </div>
         <p className="text-sm text-slate-500 mb-4">
           POST {endpoint.endpoint}
           <span className="block text-xs text-slate-400 mt-0.5">BankOne/Qore staging. Retrieval Reference and Transaction Date are required; Transaction Type and Amount are optional.</span>
        </p>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className={labelCls}>Retrieval Reference *</label>
            <input
              className={inputCls}
              value={form.RetrievalReference}
              onChange={(e) => setForm((f) => ({ ...f, RetrievalReference: e.target.value }))}
              placeholder="e.g. the BankOne retrieval reference"
            />
          </div>
          <div>
            <label className={labelCls}>Transaction Date (YYYY-MM-DD) *</label>
            <input
              className={inputCls}
              type="date"
              value={form.TransactionDate}
              onChange={(e) => setForm((f) => ({ ...f, TransactionDate: e.target.value }))}
            />
          </div>
          <div>
            <label className={labelCls}>Transaction Type</label>
            <input
              className={inputCls}
              value={form.TransactionType}
              onChange={(e) => setForm((f) => ({ ...f, TransactionType: e.target.value }))}
              placeholder="optional"
            />
          </div>
          <div>
            <label className={labelCls}>Amount (kobo/CENT)</label>
            <input
              className={inputCls}
              value={form.Amount}
              onChange={(e) => setForm((f) => ({ ...f, Amount: e.target.value }))}
              placeholder="optional — numeric only"
            />
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
           <button onClick={() => runQuery()} disabled={busy || !txnReady} className={btnPrimary}>
             {busy ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
             {busy ? 'Checking…' : 'Check Transaction Status'}
          </button>
          {!txnReady && <span className="text-xs text-slate-400">{validation.errors.join(' ')}</span>}
        </div>

        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          {!form.RetrievalReference.trim()
            ? 'No real staging Retrieval Reference has been supplied yet. Do not use fabricated transaction data; this query is intended for a real BankOne reference and date.'
            : 'Use only a real BankOne Retrieval Reference and its matching transaction date. The browser sends this request only to the authenticated Supabase Edge Function.'}
        </div>

        {queryError && <DiagnosticPanel diagnostic={queryError} query={result?.query} />}

        {result && !queryError && <ResultPanel result={result} />}
      </div>

      {/* ---- Recent provider call log (masked) ---- */}
      <RecentLogs logs={logs} environment={environment} />

      {/* ---- Documented endpoints roadmap ---- */}
      <div className={cardCls}>
        <div className="flex items-center gap-2 mb-3">
          <LayoutList size={16} className="text-[#009944]" />
          <h3 className="text-lg font-semibold text-slate-900">Configured / Documented Endpoints</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-400 border-b border-slate-100">
                <th className="py-2 pr-3">Endpoint</th>
                <th className="py-2 pr-3">Category</th>
                <th className="py-2 pr-3">Purpose</th>
                <th className="py-2">Implementation</th>
              </tr>
            </thead>
            <tbody>
              {BANKONE_ENDPOINT_ROADMAP.map((ep) => (
                <tr key={ep.key} className="border-b border-slate-50">
                  <td className="py-2 pr-3 font-mono text-xs text-slate-700">{ep.path}</td>
                  <td className="py-2 pr-3 text-xs text-slate-500">{ep.category}</td>
                  <td className="py-2 pr-3 text-xs text-slate-600">{ep.purpose}</td>
                  <td className="py-2">
                    {ep.implemented ? (
                      <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">Implemented</span>
                    ) : (
                      <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-500 border border-slate-200">Not implemented</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function OverviewGrid({ health, config, providerHealth, logs, latency, environment, canAdmin, onChangeEnv }) {
  const lastOk = logs.find((l) => l.status === 'ok')
  const lastErr = logs.find((l) => l.status === 'error' || l.status === 'timeout')
  const successCount = logs.filter((l) => l.status === 'ok').length
  const errorCount = logs.filter((l) => l.status === 'error' || l.status === 'timeout').length
  const authenticationRejected = logs.some((l) => l.error_category === 'unauthorized' || l.error_category === 'forbidden')
  const providerCallState = logs.length ? 'Tested' : 'Not tested yet'
  const authenticationState = logs.length ? (authenticationRejected ? 'Rejected' : 'Tested') : 'Not tested yet'
  const configuration = providerHealth?.configuration || {}
  const configurationState = providerHealth?.configurationHealthy ?? providerHealth?.configured ?? null
  const edgeFunctionState = providerHealth?.functionOperational
  const reachability = reachabilityPresentation(providerHealth)
  const baseUrlConfigured = providerHealth?.baseUrlConfigured ?? configuration.baseUrlConfigured
  const tokenConfigured = providerHealth?.tokenConfigured ?? providerHealth?.secretPresent ?? configuration.tokenConfigured ?? configuration.secretPresent
  const serverBaseUrl = baseUrlConfigured === true || (baseUrlConfigured === undefined && configurationState === true)
    ? 'Configured'
    : baseUrlConfigured === false
      ? 'Not configured'
      : 'Unable to verify'
  const serverCredentials = tokenConfigured === true || (tokenConfigured === undefined && configurationState === true)
    ? 'Server-side secret configured'
    : tokenConfigured === false
      ? 'Not configured'
      : 'Unable to verify'

  return (
    <>
      <div className={`${cardCls} border-t-4 ${configurationState === true ? 'border-emerald-500' : configurationState === false ? 'border-amber-500' : 'border-slate-300'}`}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between lg:flex-wrap">
          <Metric label="Environment">
            <div className="flex items-center gap-2">
              <Globe size={15} className="text-slate-400" />
              <select
                value={environment}
                onChange={(e) => onChangeEnv(e.target.value)}
                className="h-8 rounded-lg border border-slate-300 px-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]"
              >
                {Object.entries(BANKONE_ENVIRONMENTS).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}
              </select>
            </div>
          </Metric>
          <Metric label="Configuration">
            <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-medium border ${
              configurationState === true
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : configurationState === false
                  ? 'bg-amber-50 text-amber-700 border-amber-200'
                  : 'bg-slate-100 text-slate-500 border-slate-200'
            }`}>
              {configurationState === true ? 'Healthy' : configurationState === false ? 'Incomplete' : 'Unable to verify'}
            </span>
          </Metric>
          <Metric label="Edge Function">
            <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-medium border ${
              edgeFunctionState === true
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : edgeFunctionState === false
                  ? 'bg-rose-50 text-rose-700 border-rose-200'
                  : 'bg-slate-100 text-slate-500 border-slate-200'
            }`}>
              {edgeFunctionState === true ? 'Reachable' : edgeFunctionState === false ? 'Error' : 'Not tested'}
            </span>
          </Metric>
           <Metric label="Provider">
             <span className="text-sm text-slate-700">BankOne/Qore Staging</span>
           </Metric>
           <Metric label="Transaction Status Endpoint">
             <span className="font-mono text-xs text-slate-700">POST {TRANSACTION_STATUS_ENDPOINT}</span>
           </Metric>
           <Metric label="Provider call">
             <span className="text-sm text-slate-700">{providerCallState}</span>
           </Metric>
           <Metric label="Authentication">
             <span className="text-sm text-slate-700">{authenticationState}</span>
           </Metric>
           <Metric label="BankOne Reachable">
             <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-medium border ${reachability.className}`}>
               {reachability.confirmed ? 'Confirmed' : reachability.label === 'Not tested' ? 'Not tested yet' : 'Not confirmed'}
             </span>
           </Metric>
          <Metric label="Last successful request">
            {lastOk ? <span className="text-sm text-slate-700">{fmtDate(lastOk.created_at)}</span> : <span className="text-sm text-slate-400">—</span>}
          </Metric>
          <Metric label="Last failed request">
            {lastErr ? <span className="text-sm text-slate-700">{fmtDate(lastErr.created_at)} <span className="text-xs text-slate-400">({lastErr.status})</span></span> : <span className="text-sm text-slate-400">—</span>}
          </Metric>
          <Metric label="API latency (recent)">
            {latency ? <span className="text-sm text-slate-700">{latency.avg} ms <span className="text-xs text-slate-400">(avg, {latency.samples} calls)</span></span> : <span className="text-sm text-slate-400">—</span>}
          </Metric>
          <Metric label="Last synchronization">
            <span className="text-sm text-slate-700">{fmtDate(health?.last_successful_sync_at || health?.last_success_at)}</span>
          </Metric>
        </div>

        {canAdmin && !config?.permissionDenied && (
          <div className="mt-5 border-t border-slate-100 pt-4">
            <div className="flex flex-wrap gap-x-8 gap-y-3 text-xs text-slate-600">
              <div><span className="text-slate-400 font-medium">Base URL</span><div className="font-mono mt-0.5">{serverBaseUrl}</div></div>
              <div><span className="text-slate-400 font-medium">Credentials</span><div className="mt-0.5">{serverCredentials}</div></div>
              <div><span className="text-slate-400 font-medium">Authentication test</span><div className="mt-0.5">{providerHealth?.authenticationStatus === 'rejected' ? 'Rejected' : providerHealth?.authenticationTested ? 'Tested' : 'Not tested'}</div></div>
              <div><span className="text-slate-400 font-medium">Endpoint test</span><div className="mt-0.5">{providerHealth?.endpointTested ? 'Tested' : 'Not tested'}</div></div>
              <div><span className="text-slate-400 font-medium">Auth type</span><div className="mt-0.5">{config?.authentication_type || 'server-side secret'}</div></div>
              <div><span className="text-slate-400 font-medium">Read/Write/Webhook</span><div className="mt-0.5">{config ? `${String(config.read_enabled)}/${String(config.write_enabled)}/${String(config.webhook_enabled)}` : '—/—/—'}</div></div>
              <div><span className="text-slate-400 font-medium">Queue depth</span><div className="mt-0.5">{health?.queue_depth ?? '—'}</div></div>
              <div><span className="text-slate-400 font-medium">Pending approvals</span><div className="mt-0.5">{health?.pending_approvals ?? '—'}</div></div>
              <div><span className="text-slate-400 font-medium">Open conflicts</span><div className="mt-0.5">{health?.open_conflicts ?? '—'}</div></div>
            </div>
          </div>
        )}

        {canAdmin && config?.permissionDenied && (
          <p className="mt-4 text-xs text-slate-400">Configuration is only visible to Super Admin.</p>
        )}
      </div>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <MiniStat icon={<Server size={16} />} label="Configured endpoints" value={`${BANKONE_ENDPOINT_ROADMAP.filter((e) => e.implemented).length}/${BANKONE_ENDPOINT_ROADMAP.length}`} hint="implemented/documented" />
        <MiniStat icon={<ArrowRightLeft size={16} />} label="Recent calls" value={`${successCount} ok`} hint={`${errorCount} failed/timeout`} />
        <MiniStat icon={<Timer size={16} />} label="Avg latency" value={latency ? `${latency.avg} ms` : '—'} hint={latency ? `over ${latency.samples} calls` : 'no calls yet'} />
        <MiniStat icon={<ShieldCheck size={16} />} label="Security" value="secret server-side" hint="token never in browser" />
      </div>
    </>
  )
}

function reachabilityPresentation(providerHealth) {
  const status = providerHealth?.providerReachability || providerHealth?.reachabilityStatus
  if (status === 'reachable' || (status === undefined && providerHealth?.bankoneReachable === true)) {
    return { label: 'Reachable', confirmed: true, className: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
  }
  if (status === 'provider_result_failed' || status === 'provider_rejected' || status === 'provider_response_invalid' || status === 'provider_authentication_rejected') {
    return { label: 'Provider responded', confirmed: true, className: 'bg-amber-50 text-amber-700 border-amber-200' }
  }
  if (status === 'unreachable' || status === 'network_failure' || status === 'timeout') {
    return { label: 'Unreachable', confirmed: false, className: 'bg-rose-50 text-rose-700 border-rose-200' }
  }
  return { label: 'Not tested', confirmed: false, className: 'bg-slate-100 text-slate-500 border-slate-200' }
}

function ConnectionTestPanel({ test }) {
  if (!test) return null

  if (test.status === 'needs_input') {
    return (
      <div className={`${cardCls} border-amber-200 bg-amber-50/50`} aria-live="polite">
        <div className="flex items-center gap-2 text-sm font-semibold text-amber-800">
          <Activity size={16} />
          Connection Test
        </div>
        <p className="mt-2 text-sm text-amber-800">Connection testing requires a valid BankOne staging transaction reference.</p>
        <p className="mt-1 text-xs text-amber-700">Enter the reference and transaction date in the Transaction Status Query form below, then select Check Transaction Status or Test Connection again.</p>
      </div>
    )
  }

  if (test.status === 'loading' || test.status === 'checking_health') {
    return (
      <div className={`${cardCls} border-blue-200 bg-blue-50/50`} aria-live="polite">
        <div className="flex items-center gap-2 mb-3 text-sm text-blue-700">
          <Loader2 size={16} className="animate-spin" />
          <h3 className="text-lg font-semibold text-slate-900">Connection Test</h3>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <ConnectionStep label="InfinityCore authentication" state={test.status === 'checking_health' ? 'pending' : 'ok'} />
          <ConnectionStep label="Supabase Edge Function reached" state="pending" />
          <ConnectionStep label="BankOne network reachability" state="pending" />
          <ConnectionStep label="BankOne authentication" state="pending" />
          <ConnectionStep label="BankOne endpoint response" state="pending" />
          <ConnectionStep label="Provider response parsing" state="pending" />
          <ConnectionStep label="Transaction confirmation" state="pending" />
        </div>
      </div>
    )
  }

  const diagnostic = test.diagnostic || {}
  const response = test.response || diagnostic.responseBody || {}
  const responseProcessed = test.status === 'responded' && (response.providerResultValid === true || response.queryProcessed === true)
  const success = responseProcessed && response.success === true
  const providerRequestSent = response.providerRequestSent ?? diagnostic.providerRequestSent ?? ['edge_to_bankone', 'bankone_http'].includes(diagnostic.stage)
  const providerResponseReceived = response.providerResponseReceived ?? diagnostic.providerResponseReceived ?? diagnostic.stage === 'bankone_http'
  const providerConnectionOk = providerRequestSent && providerResponseReceived
  const bankoneAuthRejected = isBankoneAuthRejected(response, diagnostic)
  const bankoneAuthOk = providerConnectionOk && !bankoneAuthRejected
  const endpointResponded = providerResponseReceived
  const parsingOk = response.providerBodyFormat === 'json' && response.providerResultValid === true
  const parsingWarn = providerResponseReceived && !parsingOk
  const transactionQueryOk = responseProcessed && response.applicationSuccess === true
  const edgeReached = diagnostic.functionResponseReceived || providerRequestSent || providerResponseReceived || test.status === 'responded'
  const authOk = test.status === 'responded' || diagnostic.sessionPresent === true
  const httpStatus = response.providerHttpStatus ?? response.providerStatus ?? diagnostic.providerHttpStatus ?? diagnostic.httpStatus ?? '—'
  const timestamp = response.timestamp || response.requestTimestamp || diagnostic.timestamp || diagnostic.requestTimestamp
  const latency = response.durationMs ?? diagnostic.durationMs
  const safeError = response.responseMessage || response.error || diagnosticResponseMessage(diagnostic) || 'The BankOne provider request failed.'
  const classification = response.providerResultClassification || diagnostic.providerResultClassification
  const resultLabel = providerResultLabel(classification, success, responseProcessed)
  const panelTone = success ? 'border-emerald-200 bg-emerald-50/30' : responseProcessed || parsingWarn ? 'border-amber-200 bg-amber-50/30' : 'border-rose-200 bg-rose-50/30'
  const tokenDiagnostic = bankoneAuthRejected ? bankoneTokenDiagnostic(response, diagnostic) : null
  const diagnostics = response.diagnostics || null

  return (
    <div className={`${cardCls} ${panelTone}`} aria-live="polite">
      <div className="flex items-center gap-2 mb-3">
        {success ? <CheckCircle2 size={17} className="text-emerald-600" /> : responseProcessed || parsingWarn ? <Activity size={17} className="text-amber-600" /> : <XCircle size={17} className="text-rose-600" />}
        <h3 className="text-lg font-semibold text-slate-900">Connection Test</h3>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <ConnectionStep label="InfinityCore authentication" state={authOk ? 'ok' : 'fail'} />
        <ConnectionStep label="Supabase Edge Function reached" state={edgeReached ? 'ok' : 'fail'} />
        <ConnectionStep label="BankOne network reachability" state={providerConnectionOk ? 'ok' : providerResponseReceived ? 'warn' : 'fail'} />
        <ConnectionStep label="BankOne authentication" state={bankoneAuthOk ? 'ok' : bankoneAuthRejected ? 'fail' : 'warn'} />
        <ConnectionStep label="BankOne endpoint response" state={endpointResponded ? 'ok' : 'fail'} />
        <ConnectionStep label="Provider response parsing" state={parsingOk ? 'ok' : parsingWarn ? 'warn' : 'fail'} />
        <ConnectionStep label="Transaction confirmation" state={transactionQueryOk ? 'ok' : responseProcessed ? 'warn' : 'fail'} />
      </div>
      <p className={`mt-3 text-sm ${success ? 'text-emerald-700' : responseProcessed || parsingWarn ? 'text-amber-800' : 'text-rose-700'}`}>
        {responseProcessed ? resultLabel : safeError}
      </p>
      {tokenDiagnostic && <p className="mt-2 text-sm text-amber-800">{tokenDiagnostic}</p>}
      <div className="mt-3 grid gap-x-6 gap-y-1 text-xs text-slate-500 sm:grid-cols-2">
        <span>Provider HTTP status: {httpStatus}</span>
        <span>Provider result: {resultLabel}</span>
        <span>Transaction status: {response.transactionStatus || diagnostic.transactionStatus || '—'}</span>
        <span>Transaction confirmation: {transactionConfirmationLabel(response.transactionSuccess ?? diagnostic.transactionSuccess)}</span>
        <span>Response code: {response.responseCode || diagnostic.responseCode || '—'}</span>
        <span>Response message: {response.responseMessage || diagnostic.responseMessage || safeError || '—'}</span>
        <span>RRN: {response.rrn || response.retrievalReference || diagnostic.retrievalReference || '—'}</span>
        <span>Latency: {fmtMs(latency)}</span>
        <span>Timestamp: {timestamp ? fmtDate(timestamp) : '—'}</span>
        <span>Content type: {response.providerContentType || diagnostic.providerContentType || '—'}</span>
        <span className="sm:col-span-2">Endpoint: POST {TRANSACTION_STATUS_ENDPOINT}</span>
        <span className="sm:col-span-2">Correlation ID: {response.correlationId || response.requestId || diagnostic.correlationId || diagnostic.requestId || '—'}</span>
      </div>
      {diagnostics && (
        <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600">
          <div className="font-semibold mb-1">Safe provider diagnostics</div>
          <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
            {diagnostics.finalUrl && <span>Final URL: {diagnostics.finalUrl}</span>}
            {diagnostics.redirectDetected != null && <span>Redirect detected: {diagnostics.redirectDetected ? 'yes' : 'no'}</span>}
            {diagnostics.contentLength != null && <span>Content-Length: {diagnostics.contentLength}</span>}
            {diagnostics.bodyLength != null && <span>Body length: {diagnostics.bodyLength}</span>}
            {diagnostics.server && <span>Server: {diagnostics.server}</span>}
            {diagnostics.location && <span>Location: {diagnostics.location}</span>}
            {diagnostics.preview && <span className="sm:col-span-2">Preview: <span className="font-mono">{diagnostics.preview}</span></span>}
          </div>
        </div>
      )}
      {!success && !responseProcessed && <p className="mt-3 text-xs text-slate-600"><span className="font-medium">Suggested next action:</span> {suggestedNextAction(response.errorCode || diagnostic.code)}</p>}
      {response.providerResponsePreview && !diagnostics?.preview && <div className="mt-3 text-xs text-slate-500"><span className="font-medium">Response preview:</span> <span className="font-mono">{response.providerResponsePreview}</span></div>}
      {response.details && <StructuredData label="Safe provider details" value={response.details} />}
    </div>
  )
}

function ConnectionStep({ label, state }) {
  const icon = state === 'ok'
    ? <CheckCircle2 size={16} className="text-emerald-600" />
    : state === 'fail'
      ? <XCircle size={16} className="text-rose-600" />
      : state === 'warn'
        ? <Activity size={16} className="text-amber-600" />
        : <Loader2 size={16} className="animate-spin text-blue-600" />
  const toneClass = state === 'ok'
    ? 'border-emerald-200 bg-emerald-50/50'
    : state === 'fail'
      ? 'border-rose-200 bg-rose-50/50'
      : state === 'warn'
        ? 'border-amber-200 bg-amber-50/50'
        : 'border-slate-200 bg-white'
  return (
    <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm text-slate-700 ${toneClass}`}>
      {icon}
      <span>{state === 'ok' ? `✓ ${label}` : state === 'fail' ? `✗ ${label}` : state === 'warn' ? `! ${label}` : label}</span>
    </div>
  )
}

function suggestedNextAction(code) {
  if (code === 'invalid_request') return 'Confirm the retrieval reference, date, optional transaction type, and kobo/CENT amount.'
  if (code === 'unauthorized' || code === 'forbidden') return 'Verify the BankOne staging secret configuration with the integration administrator.'
  if (code === 'provider_application_response_unparseable' || code === 'provider_application_response_html' || code === 'provider_malformed_json') return 'BankOne returned a non-JSON response. Confirm the endpoint URL, request body, and that the staging environment is not returning an HTML error/redirect page.'
  if (code === 'provider_empty_response') return 'BankOne returned an empty body. Confirm the staging RRN exists and the endpoint is the documented TransactionStatusQuery path.'
  if (code === 'timeout' || code === 'network') return 'Retry after confirming staging availability and the Edge Function network path.'
  if (code === 'rate_limited') return 'Wait briefly and retry the staging request.'
  if (code === 'missing_credentials') return 'Configure the server-side BankOne staging secrets before retrying.'
  return 'Review the safe provider details and the audit record, then retry with the supplied staging reference.'
}

function isBankoneAuthRejected(response, diagnostic) {
  const responseCode = response.responseCode ?? diagnostic.responseCode
  const responseMessage = ((response.responseMessage ?? diagnostic.responseMessage) || '').toLowerCase()
  const providerHttpStatus = response.providerHttpStatus ?? response.providerStatus ?? diagnostic.providerHttpStatus
  if (providerHttpStatus === 401 || providerHttpStatus === 403) return true
  if (responseCode === '12' && responseMessage.includes('invalid token')) return true
  if (responseMessage.includes('invalid token') || responseMessage.includes('unauthorized')) return true
  return false
}

function bankoneTokenDiagnostic(response, diagnostic) {
  const responseCode = response.responseCode ?? diagnostic.responseCode
  const responseMessage = response.responseMessage ?? diagnostic.responseMessage
  if (responseCode === '12' || (responseMessage || '').toLowerCase().includes('invalid token')) {
    return 'BankOne reached successfully, but BankOne rejected the authentication token. Verify the server-side BankOne API token in Supabase Secrets and confirm that the token belongs to this staging environment/institution.'
  }
  return 'BankOne authentication was rejected. Verify the server-side BankOne credentials.'
}

function providerResultLabel(classification, success, processed) {
  if (success || classification === 'success') return 'Successful provider response'
  if (classification === 'business_failure') return 'Application-level provider failure'
  if (classification === 'unconfirmed') return 'Provider response processed but transaction result is unconfirmed'
  if (classification === 'html') return 'Provider returned HTML instead of JSON'
  if (classification === 'empty') return 'Provider returned an empty body'
  if (classification === 'malformed_json') return 'Provider returned malformed JSON'
  if (classification === 'unparseable') return 'Provider response format was not JSON'
  if (!processed) return 'Provider response could not be processed'
  return 'Provider response processed'
}

function transactionConfirmationLabel(value) {
  if (value === true) return 'Confirmed'
  if (value === false) return 'Provider reported failure'
  return 'Not returned'
}

function DiagnosticPanel({ diagnostic, query, title }) {
  const message = diagnosticResponseMessage(diagnostic)
  const correlationId = diagnostic?.requestId || diagnostic?.supabaseRequestId
  return (
    <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-4" role="alert">
      <div className="flex items-start gap-2 text-sm text-rose-700">
        <XCircle size={16} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{title || diagnostic?.title || 'BankOne integration call failed'}</div>
          <div className="mt-1">{diagnostic?.message || 'The integration call failed.'}</div>
          {diagnostic?.transportMessage && diagnostic.transportMessage !== diagnostic.message && (
            <div className="mt-1 text-xs">SDK diagnostic: {diagnostic.transportMessage}</div>
          )}
          <div className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            <div><span className="text-rose-500">Session present:</span> {boolDiagnostic(diagnostic?.sessionPresent)}</div>
            <div><span className="text-rose-500">Invocation attempted:</span> {boolDiagnostic(diagnostic?.functionInvoked)}</div>
            <div><span className="text-rose-500">Supabase HTTP response:</span> {boolDiagnostic(diagnostic?.httpResponseReceived)}</div>
            <div><span className="text-rose-500">Edge response received:</span> {boolDiagnostic(diagnostic?.functionResponseReceived)}</div>
            <div><span className="text-rose-500">Edge Function:</span> {diagnostic?.functionName || '—'}</div>
            <div><span className="text-rose-500">HTTP status:</span> {diagnostic?.httpStatus ?? '—'}</div>
            <div><span className="text-rose-500">BankOne HTTP status:</span> {diagnostic?.providerHttpStatus ?? '—'}</div>
            <div><span className="text-rose-500">Provider result:</span> {providerResultLabel(diagnostic?.providerResultClassification, false, diagnostic?.providerResultValid)}</div>
            <div><span className="text-rose-500">Transaction status:</span> {diagnostic?.transactionStatus || '—'}</div>
            <div><span className="text-rose-500">Transaction confirmation:</span> {transactionConfirmationLabel(diagnostic?.transactionSuccess)}</div>
            <div><span className="text-rose-500">Response code:</span> {diagnostic?.responseCode || '—'}</div>
            <div><span className="text-rose-500">Response message:</span> {diagnostic?.responseMessage || message || '—'}</div>
            <div><span className="text-rose-500">Content type:</span> {diagnostic?.providerContentType || '—'}</div>
            <div className="sm:col-span-2"><span className="text-rose-500">Correlation ID:</span> {diagnostic?.correlationId || correlationId || '—'}</div>
            <div className="sm:col-span-2 break-all"><span className="text-rose-500">Supabase target:</span> {diagnostic?.functionTarget || '—'}</div>
          </div>
          {query && (
            <div className="mt-3 rounded border border-rose-200 bg-white/60 p-2 text-xs">
              <div className="font-medium">Request sent to the Edge Function</div>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap">{JSON.stringify(query, null, 2)}</pre>
            </div>
          )}
          {message && message !== diagnostic?.message && <div className="mt-2 text-xs">Response message: {message}</div>}
          {diagnostic?.details?.length > 0 && (
            <ul className="mt-2 list-disc pl-4 text-xs">{diagnostic.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>
          )}
          {diagnostic?.stage === 'frontend_to_edge' && !diagnostic.functionResponseReceived && (
            <div className="mt-2 text-xs text-rose-600">The Edge Function did not return an application response, so BankOne was not confirmed as reached.</div>
          )}
        </div>
      </div>
    </div>
  )
}

function Diagnostic({ label, value, tone }) {
  const styles = {
    good: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    bad: 'bg-rose-50 text-rose-700 border-rose-200',
    warn: 'bg-amber-50 text-amber-700 border-amber-200',
    neutral: 'bg-slate-100 text-slate-600 border-slate-200',
  }
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="text-xs font-medium text-slate-400">{label}</div>
      <div className={`mt-1 inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${styles[tone] || styles.neutral}`}>{value}</div>
    </div>
  )
}

function StructuredData({ label, value }) {
  return (
    <div className="mt-4">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <pre className="mt-1 rounded-lg bg-slate-900 p-4 text-xs text-slate-100 overflow-x-auto whitespace-pre-wrap break-words">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  )
}

function Metric({ label, children }) {
  return (
    <div className="min-w-[180px]">
      <div className="text-xs font-medium text-slate-400 mb-1">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  )
}

function MiniStat({ icon, label, value, hint }) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4">
      <div className="flex items-center gap-1.5 text-xs font-medium text-slate-400 mb-2">{icon}{label}</div>
      <div className="text-xl font-semibold text-slate-900">{value}</div>
      <div className="text-xs text-slate-400 mt-0.5">{hint}</div>
    </div>
  )
}

function ResultPanel({ result }) {
  const success = result.success === true
  const processed = result.providerResultValid === true || result.queryProcessed === true
  const providerData = result.providerResult ?? result.data ?? result.raw
  const providerStatus = result.providerHttpStatus ?? result.providerStatus ?? result.status
  const resultLabel = providerResultLabel(result.providerResultClassification, success, processed)
  const rows = [
    ['Provider', 'BankOne/Qore'],
    ['Environment', result.environment === 'staging' ? 'Staging' : (result.environment || 'Staging')],
    ['Endpoint', 'TransactionStatusQuery'],
    ['Retrieval reference', result.request?.retrievalReference || 'masked'],
    ['RRN', result.rrn || result.retrievalReference || '—'],
    ['Transaction date', result.transactionDate || result.query?.TransactionDate || '—'],
    ['Transaction type', result.transactionType || '—'],
    ['Amount', result.amount ?? '—'],
    ['Provider HTTP status', providerStatus ?? '—'],
    ['Provider result', resultLabel],
    ['Transaction status', result.transactionStatus || '—'],
    ['Transaction confirmation', transactionConfirmationLabel(result.transactionSuccess)],
    ['Response code', result.responseCode || '—'],
    ['Response message', result.responseMessage || result.error || '—'],
    ['Timestamp', result.timestamp ? fmtDate(result.timestamp) : (result.requestTimestamp ? fmtDate(result.requestTimestamp) : '—')],
    ['Correlation ID', result.correlationId || result.requestId || '—'],
    ['Latency', fmtMs(result.durationMs)],
    ['Response content type', result.providerContentType || '—'],
  ]
  return (
    <div className={`mt-4 rounded-lg border p-4 ${success ? 'border-emerald-200 bg-emerald-50/50' : processed ? 'border-amber-200 bg-amber-50/50' : 'border-rose-200 bg-rose-50/50'}`}>
      <div className="flex items-center gap-2 mb-3">
        {success ? <CheckCircle2 size={18} className="text-emerald-600" /> : processed ? <Activity size={18} className="text-amber-600" /> : <XCircle size={18} className="text-rose-600" />}
        <h4 className="font-semibold text-slate-900">{resultLabel}</h4>
      </div>
      <div className="grid gap-x-8 gap-y-1.5 sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-2 text-sm">
            <span className="w-36 shrink-0 text-slate-400">{k}</span>
            <span className="text-slate-700 break-all">{v}</span>
          </div>
        ))}
      </div>
      {!success && !processed && <p className="mt-3 text-xs text-slate-600"><span className="font-medium">Suggested next action:</span> {suggestedNextAction(result.errorCode)}</p>}
      {providerData && <StructuredData label="Provider response fields" value={providerData} />}
      {!success && result.details && <StructuredData label="Safe provider details" value={result.details} />}
    </div>
  )
}

function RecentLogs({ logs, environment }) {
  return (
    <div className={cardCls}>
      <div className="flex items-center gap-2 mb-3">
        <Activity size={16} className="text-[#009944]" />
        <h3 className="text-lg font-semibold text-slate-900">Recent provider calls</h3>
        <span className="text-xs text-slate-400">masked · never contains secrets · {BANKONE_ENVIRONMENTS[environment]?.label} environment</span>
      </div>
      {logs.length === 0 ? (
        <EmptyState message="No provider calls recorded yet. Run a transaction status query to see activity here." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-400 border-b border-slate-100">
                <th className="py-2 pr-3">Time</th>
                <th className="py-2 pr-3">Operation</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">HTTP</th>
                <th className="py-2 pr-3">Duration</th>
                <th className="py-2">Correlation ID</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id} className="border-b border-slate-50">
                  <td className="py-2 pr-3 text-xs text-slate-500 whitespace-nowrap">{fmtDate(l.created_at)}</td>
                  <td className="py-2 pr-3 text-xs">{l.operation || '—'}</td>
                  <td className="py-2 pr-3">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium border ${BANKONE_LOG_STATUS_STYLE[l.status] || 'bg-slate-100 text-slate-500 border-slate-200'}`}>{l.status}</span>
                  </td>
                  <td className="py-2 pr-3 text-xs text-slate-600">{l.http_status ?? '—'}</td>
                  <td className="py-2 pr-3 text-xs text-slate-600">{fmtMs(l.duration_ms)}</td>
                  <td className="py-2 pr-3 text-xs font-mono text-slate-500">{l.correlation_id || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
