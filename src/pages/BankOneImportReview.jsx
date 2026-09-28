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

const TONE = { slate: 'text-slate-900', green: 'text-emerald-700', amber: 'text-amber-700', red: 'text-red-700' }
const Stat = ({ label, value, tone = 'slate' }) => (
  <div className="rounded-xl border border-slate-200 bg-white p-3">
    <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
    <div className={`text-xl font-bold ${TONE[tone]}`}>{value}</div>
  </div>
)

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
      setResult(res)
      if (!res.persisted && res.error) setError(res.error)
    } catch (e) {
      setError(e.message)
    } finally { setBusy(false) }
  }

  const s = result?.summary
  const p = result?.portfolio

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
        {notice && <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</div>}
      </section>

      {busy && <LoadingState label="Parsing and resolving the workbook..." />}

      {result?.persisted && (
        <>
          <section className="rounded-2xl border border-slate-200 bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-800">Import summary</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
              <Stat label="Records" value={s.sourceRowCount} />
              <Stat label="Parsed" value={s.parsedRowCount} tone="green" />
              <Stat label="Auto-matched" value={s.matchedAutomatically} tone="green" />
              <Stat label="Needs review" value={s.needsReview} tone="amber" />
              <Stat label="Unmatched" value={s.unmatchedEmployees} tone="red" />
              <Stat label="Branch issues" value={s.branchIssues + s.mergedStructures} tone="amber" />
              <Stat label="Invalid rows" value={s.invalidRows} tone={s.invalidRows ? 'red' : 'slate'} />
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-slate-200 p-3">
                <div className="text-xs uppercase tracking-wide text-slate-400">Officer portfolio — resolved</div>
                <div className="text-lg font-bold text-emerald-700">{money(p.officerResolvedOutstanding)}</div>
              </div>
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                <div className="text-xs uppercase tracking-wide text-amber-700">
                  Officer portfolio — UNATTRIBUTED ({p.officerUnresolvedCount} loans)
                </div>
                <div className="text-lg font-bold text-amber-800">{money(p.officerUnresolvedOutstanding)}</div>
                <p className="mt-1 text-xs text-amber-800">
                  This belongs to officers not linked to an employee. It is not counted against
                  any person.
                </p>
              </div>
            </div>

            {!p.parPublishable && (
              <p className="mt-3 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                PAR is calculated from the real data ({p.parRatio.toFixed(2)}%) but must not be
                published for officer performance until every officer is resolved. Branch-level
                figures are unaffected.
              </p>
            )}
          </section>

          <div className="flex gap-2 overflow-x-auto pb-1">
            {[
              ['employees', `Employee review (${result.unresolvedOfficers.length})`],
              ['branches', `Branch review (${s.branchIssues + s.mergedStructures})`],
              ['validation', `Data validation (${s.invalidRows})`],
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
            <EmployeeReview result={result} employees={employees} batchId={result.batchId}
              onDone={(m) => { setNotice(m); run() }} />
          )}
          {tab === 'branches' && (
            <BranchReview result={result} branches={branches} batchId={result.batchId}
              onDone={(m) => { setNotice(m); run() }} />
          )}
          {tab === 'validation' && <ValidationPanel result={result} />}
        </>
      )}
    </div>
  )
}
