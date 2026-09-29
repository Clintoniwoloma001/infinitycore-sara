// ============================================================================
// BankOne Import Review (§17-§20)
// ============================================================================
// Upload -> summary -> employee match review -> branch review -> validation.
// Two rules are visible in the UI on purpose:
//   * the financial impact of every mapping is always shown, never hidden
//   * an unresolved officer's portfolio is shown as UNATTRIBUTED, never folded
//     into a named person
import React, { useEffect, useState } from 'react'
import { Upload, Loader2, AlertTriangle } from 'lucide-react'
import { supabase } from '../supabaseClient'
import bankonePortfolioService from '../services/bankonePortfolioService'
import { readWorkbook } from '../utils/readWorkbook'
import { useAuth } from '../hooks/useAuth'
import { LoadingState, ErrorState } from '../components/PageStates'
import EmployeeReview from '../components/bankone/EmployeeReview'
import BranchReview from '../components/bankone/BranchReview'
import ValidationPanel from '../components/bankone/ValidationPanel'

const money = (n) => '₦' + Math.round(Number(n) || 0).toLocaleString('en-NG')

/** Remembers the in-flight import so a refresh resumes it. */
const BATCH_KEY = 'bankone:active-batch'

const TONE = { slate: 'text-slate-900', green: 'text-emerald-700', amber: 'text-amber-700', red: 'text-red-700' }
const Stat = ({ label, value, tone = 'slate' }) => (
  <div className="rounded-xl border border-slate-200 bg-white p-3">
    <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
    <div className={`text-xl font-bold ${TONE[tone]}`}>{value ?? 0}</div>
  </div>
)

/**
 * §22 FINAL PUBLISH RULE. Shows the exact accounting and the exact blockers,
 * and only enables Publish when the server says it will succeed. Never says
 * "Published" until the snapshot transaction has actually committed.
 */
function PublishPanel({ state, verdict, canManage, publishing, onPublish }) {
  const s = state?.summary || {}
  const published = state?.batch?.publication_status === 'published'
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-slate-800">Publish this import</h2>
      <p className="mt-1 text-xs text-slate-500">
        Publishing writes the branch and officer snapshot the performance dashboards read. It is
        refused unless the row accounting reconciles and every loan has a branch identity.
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div className="rounded-lg border border-slate-200 p-2">
          <dt className="text-slate-400">Source rows</dt>
          <dd className="text-base font-bold text-slate-800">{s.total_rows ?? 0}</dd>
        </div>
        <div className="rounded-lg border border-slate-200 p-2">
          <dt className="text-slate-400">Parsed</dt>
          <dd className="text-base font-bold text-slate-800">{s.parsed_rows ?? 0}</dd>
        </div>
        <div className="rounded-lg border border-slate-200 p-2">
          <dt className="text-slate-400">Invalid</dt>
          <dd className="text-base font-bold text-slate-800">{s.invalid_rows ?? 0}</dd>
        </div>
        <div className="rounded-lg border border-slate-200 p-2">
          <dt className="text-slate-400">Officer decisions open</dt>
          <dd className="text-base font-bold text-amber-700">{s.officer_pending ?? 0}</dd>
        </div>
      </dl>

      {verdict && !verdict.can_publish && (
        <ul className="mt-3 space-y-1">
          {(verdict.blockers || []).map((b, i) => (
            <li key={i}
              className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{b}
            </li>
          ))}
        </ul>
      )}

      {verdict?.can_publish && (
        <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          {s.parsed_rows} loan(s) reconcile. {s.officer_pending} officer(s) may remain unresolved —
          their portfolio publishes as unattributed and stays out of officer performance.
        </p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button onClick={onPublish}
          disabled={publishing || !verdict?.can_publish || !canManage || published}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          {publishing && <Loader2 className="h-4 w-4 animate-spin" />}
          {publishing ? 'Publishing...' : published ? 'Published' : 'Publish snapshot'}
        </button>
        {state?.batch?.published_at && (
          <span className="text-xs text-slate-500">
            Published {new Date(state.batch.published_at).toLocaleString()}
          </span>
        )}
      </div>
    </section>
  )
}

export default function BankOneImportReview() {
  const { user, profile, hasPermission } = useAuth()
  const canManage = hasPermission('bankone.import.manage') ||
    ['super_admin', 'admin', 'head_of_human_resources'].includes(profile?.role)

  const [file, setFile] = useState(null)
  const [sourceType, setSourceType] = useState('par')
  const [asAt, setAsAt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [tab, setTab] = useState('employees')
  const [notice, setNotice] = useState(null)
  const [employees, setEmployees] = useState([])
  const [branches, setBranches] = useState([])
  // §20/§21 durable state. `state` is the database's view of this import and is
  // the ONLY thing the review panels render from.
  const [activeBatch, setActiveBatch] = useState(null)
  const [state, setState] = useState(null)
  const [verdict, setVerdict] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [publishing, setPublishing] = useState(false)

  const publish = async () => {
    if (!activeBatch) return
    setPublishing(true); setError(null)
    try {
      const res = await bankonePortfolioService.publish(activeBatch)
      setNotice({
        kind: 'ok',
        text: `Published ${res.parsed_rows} loan(s). ${res.officer_decisions_pending} officer(s) remain unattributed and are excluded from officer performance.`,
      })
      await refresh(activeBatch)
    } catch (e) {
      // Persist 'blocked' separately: a raised publish error rolls its own
      // status write back, so the batch would otherwise look untouched.
      const reason = e?.message || String(e)
      try { await bankonePortfolioService.markBlocked(activeBatch, reason) } catch { /* best effort */ }
      setError(reason)
      await refresh(activeBatch)
    } finally { setPublishing(false) }
  }

  useEffect(() => {
    supabase.from('employees').select('id, full_name, branch').order('full_name').then((r) => setEmployees(r.data || []))
    supabase.from('branches').select('id, branch_name, status').order('branch_name').then((r) => setBranches(r.data || []))
  }, [])

  const run = async () => {
    if (!file || !asAt) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const matrix = await readWorkbook(file)
      const res = await bankonePortfolioService.createImport({
        matrix, sourceType, asAtDate: asAt, filename: file.name,
        uploadedBy: user?.id, uploadedByName: profile?.full_name,
      })
      if (!res.persisted) { setError(res.error || 'That file could not be imported.'); return }
      if (res.seedWarning) setNotice({ kind: 'warn', text: res.seedWarning })
      // Remember the batch so a refresh RESUMES instead of restarting.
      setActiveBatch(res.batchId)
      try { localStorage.setItem(BATCH_KEY, res.batchId) } catch { /* private mode */ }
      await refresh(res.batchId)
    } catch (e) {
      // The REAL reason, never a generic "Load failed".
      setError(e?.message || String(e))
    } finally { setBusy(false) }
  }

  /**
   * Re-read the import from the DATABASE. This is what every Accept/Confirm
   * calls: it no longer re-parses the spreadsheet, so a decision can never
   * trigger a second 2,725-row upload, and the summary can never drift from
   * the resolution lists.
   */
  const refresh = async (batchId) => {
    if (!batchId) return
    setRefreshing(true)
    try {
      const state = await bankonePortfolioService.getImportState(batchId)
      setState(state)
      const verdict = await bankonePortfolioService.validatePublish(batchId)
      setVerdict(verdict)
    } catch (e) {
      setError(e?.message || String(e))
    } finally { setRefreshing(false) }
  }

  // On mount: resume the newest unfinished import instead of starting over.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const open = await bankonePortfolioService.listOpenImports(1)
        const [last] = open || []
        let batchId = null
        try { batchId = localStorage.getItem(BATCH_KEY) } catch { /* ignore */ }
        const target = batchId || last?.id
        if (target && !cancelled) {
          setActiveBatch(target)
          await refresh(target)
        }
      } catch {
        // A missing RPC must not break the page; the user can still upload.
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The summary is the DATABASE's, never a locally computed one, so it cannot
  // disagree with the resolution lists below it.
  const s = state?.summary || {}

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">BankOne Import Review</h1>
        <p className="mt-1 text-sm text-slate-500">
          Upload a Portfolio At Risk or Disbursement export. Nothing is published until the
          officer and branch identities below are resolved.
        </p>
      </header>

      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="text-xs font-medium text-slate-700">Report</span>
            <select value={sourceType} onChange={(e) => setSourceType(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
              <option value="par">Portfolio At Risk</option>
              <option value="disbursement">Disbursement</option>
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-700">Data is as at</span>
            <input type="date" value={asAt} onChange={(e) => setAsAt(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-700">File</span>
            <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
          </label>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button onClick={run} disabled={busy || !file || !asAt || !canManage}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            Parse and review
          </button>
          {!canManage && <span className="text-xs text-amber-700">You do not have permission to run BankOne imports.</span>}
        </div>
        {error && <div className="mt-3"><ErrorState title="Import stopped" message={error} /></div>}
        {notice && (
          <div className={`mt-3 rounded-lg px-3 py-2 text-sm ${
            notice.kind === 'warn' ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-800'}`}>
            {notice.text}
          </div>
        )}
      </section>

      {busy && <LoadingState label="Parsing and resolving the workbook..." />}

      {/* §20 RESUMABLE. An unfinished import is rebuilt from the database, so a
          refresh, a crash or a closed laptop never costs the work already done. */}
      {state && (
        <>
          <section className="rounded-2xl border border-[#009944]/30 bg-[#009944]/5 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-800">
                  Import in progress — nothing was lost
                </h2>
                <p className="mt-0.5 text-xs text-slate-600">
                  {state.batch?.filename} · {state.batch?.as_at_date} · batch{' '}
                  {String(state.batch?.id || '').slice(0, 8)}
                  {state.batch?.publication_status === 'blocked' && (
                    <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-red-700">
                      paused
                    </span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {refreshing && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
                <button onClick={() => refresh(activeBatch)} disabled={refreshing}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 disabled:opacity-50">
                  {refreshing ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>
            </div>
            {state.batch?.error_message && (
              <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
                {state.batch.error_message}
              </p>
            )}
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-800">
              Import summary <span className="text-xs font-normal text-slate-400">(live, from the database)</span>
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
              <Stat label="Source rows" value={s.total_rows} />
              <Stat label="Parsed" value={s.parsed_rows} tone="green" />
              <Stat label="Invalid rows" value={s.invalid_rows} tone={s.invalid_rows ? 'red' : 'slate'} />
              <Stat label="Auto-matched" value={s.auto_matched_rows} tone="green" />
              <Stat label="Needs review" value={s.officer_pending} tone="amber" />
              <Stat label="Unmatched" value={s.unresolved_officer_rows} tone="red" />
              <Stat label="Branch issues" value={s.unresolved_branch_rows} tone="amber" />
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-slate-200 p-3">
                <div className="text-xs uppercase tracking-wide text-slate-400">Officer portfolio — resolved</div>
                <div className="text-lg font-bold text-emerald-700">{money(s.resolved_outstanding)}</div>
              </div>
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                <div className="text-xs uppercase tracking-wide text-amber-700">
                  Officer portfolio — UNATTRIBUTED ({s.unattributed_loan_count} loans)
                </div>
                <div className="text-lg font-bold text-amber-800">{money(s.unattributed_outstanding)}</div>
                <p className="mt-1 text-xs text-amber-800">
                  These officers are not linked to an employee. It still counts in branch portfolio
                  and branch PAR, but is <strong>excluded from individual performance scoring</strong>.
                </p>
              </div>
            </div>
          </section>

          <div className="flex gap-2 overflow-x-auto pb-1">
            {[
              ['employees', `Officer decisions (${s.officer_pending})`],
              ['branches', `Branch review (${s.branch_pending})`],
              ['publish', 'Publish'],
            ].map(([id, label]) => (
              <button key={id} onClick={() => setTab(id)}
                className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium ${
                  tab === id ? 'border-[#009944] bg-[#009944] text-white'
                    : 'border-slate-200 bg-white text-slate-600'}`}>
                {label}
              </button>
            ))}
          </div>

          {tab === 'employees' && (
            <EmployeeReview state={state} employees={employees} batchId={activeBatch}
              onDone={async (m) => { setNotice({ kind: 'ok', text: m }); await refresh(activeBatch) }} />
          )}
          {tab === 'branches' && (
            <BranchReview state={state} branches={branches} batchId={activeBatch}
              onDone={async (m) => { setNotice({ kind: 'ok', text: m }); await refresh(activeBatch) }} />
          )}
          {tab === 'publish' && <PublishPanel state={state} verdict={verdict} canManage={canManage}
            publishing={publishing} onPublish={publish} />}
        </>
      )}
    </div>
  )
}
