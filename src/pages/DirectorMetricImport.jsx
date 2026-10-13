import React, { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, Upload, Table2, Download } from 'lucide-react'
import * as XLSX from 'xlsx'
import { useAuth } from '../hooks/useAuth'
import { ErrorState, LoadingState } from '../components/PageStates'
import { proposeMapping, FIELD_SYNONYMS } from '../domains/directorIntelligence/metricImport.js'
import { directorMetricImportService } from '../services/directorMetricImportService.js'

// Identity fields are matched but are not metrics themselves.
const IDENTITY_FIELDS = ['staff_code', 'staff_name', 'branch', 'as_of_date']
const METRIC_FIELDS = Object.keys(FIELD_SYNONYMS).filter((f) => !IDENTITY_FIELDS.includes(f))

// Parse an uploaded workbook/CSV into { headers, records }. The MPR sheet has a
// single header row, so the first row with >=2 non-empty cells is the header.
async function parseSheet(file) {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false })
  if (!matrix.length) throw new Error('The file appears to be empty.')
  let headerIndex = 0
  for (let i = 0; i < Math.min(matrix.length, 25); i++) {
    if (matrix[i].filter((c) => String(c).trim() !== '').length >= 2) { headerIndex = i; break }
  }
  const headers = matrix[headerIndex].map((h) => String(h).trim()).filter((h) => h !== '')
  const records = []
  for (let i = headerIndex + 1; i < matrix.length; i++) {
    const row = matrix[i]
    if (!row || row.every((c) => String(c).trim() === '')) continue
    const rec = {}
    headers.forEach((h, j) => { rec[h] = String(row[j] ?? '').trim() })
    records.push(rec)
  }
  return { headers, records }
}

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944] dark:border-slate-700 dark:bg-slate-800 dark:text-white'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5 dark:text-slate-300'
export default function DirectorMetricImport() {
  const [employees, setEmployees] = useState([])
  const [loadingEmployees, setLoadingEmployees] = useState(true)
  const [file, setFile] = useState(null)
  const [fileSha, setFileSha] = useState('')
  const [parsed, setParsed] = useState(null)
  const [mapping, setMapping] = useState({})
  const [asOf, setAsOf] = useState('')
  const [preview, setPreview] = useState(null)
  const [commitResult, setCommitResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dupBatch, setDupBatch] = useState(null)
  const [tab, setTab] = useState('import')
  const [coverage, setCoverage] = useState(null)

  useEffect(() => {
    let live = true
    directorMetricImportService.loadEmployees()
      .then((rows) => { if (live) setEmployees(rows) })
      .catch((e) => { if (live) setError(e.message) })
      .finally(() => { if (live) setLoadingEmployees(false) })
    return () => { live = false }
  }, [])

  const detectedMetrics = useMemo(() => METRIC_FIELDS.filter((f) => mapping[f]), [mapping])

  async function onFile(e) {
    const f = e.target.files?.[0]
    if (!f) return
    setError(''); setDupBatch(null); setPreview(null); setCommitResult(null)
    setBusy(true)
    try {
      const sha = await directorMetricImportService.sha256Hex(await f.arrayBuffer())
      setFile(f); setFileSha(sha)
      const dup = await directorMetricImportService.findByHash(sha)
      if (dup) setDupBatch(dup)
      const p = await parseSheet(f)
      setParsed(p)
      setMapping(proposeMapping(p.headers))
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }

  function runPreview() {
    setError('')
    try {
      setPreview(directorMetricImportService.preview(parsed.records, mapping, employees, asOf || null))
    } catch (err) { setError(err.message) }
  }

  async function doCommit(confirmConflicts) {
    setBusy(true); setError('')
    try {
      let batchId = null
      if (fileSha && !dupBatch) {
        batchId = await directorMetricImportService.recordBatch({
          filename: file?.name, fileSha256: fileSha,
          asOfDate: asOf || new Date().toISOString().slice(0, 10),
          rowCount: preview.rows.length,
        })
      }
      const res = await directorMetricImportService.commit(preview.rows, batchId, confirmConflicts)
      setCommitResult(res)
      setPreview({ ...preview, conflicts: res.conflicts })
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }

  async function loadCoverage() {
    setBusy(true)
    try {
      const { directorCoverageService } = await import('../services/directorCoverageService.js')
      setCoverage(await directorCoverageService.load())
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  if (loadingEmployees) return <LoadingState message="Loading staff directory…" />

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <header className="mb-6">
        <p className="text-[10px] font-bold uppercase tracking-[.2em] text-[#009944]">Director Intelligence</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-900 dark:text-white">Multi-metric import</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Import any subset of metrics per staff member. A later file updates only the
          metrics it contains and never zeroes the others.
        </p>
      </header>

      <div className="mb-4 flex gap-2 border-b border-slate-200 dark:border-slate-700">
        {[['import', 'Import'], ['coverage', 'Coverage']].map(([k, lbl]) => (
          <button key={k} onClick={() => { setTab(k); if (k === 'coverage') loadCoverage() }}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === k ? 'border-[#009944] text-[#009944]' : 'border-transparent text-slate-500'}`}>
            {lbl}
          </button>
        ))}
      </div>

      {error && <ErrorState message={error} onRetry={() => setError('')} />}

      {tab === 'import' && (
        <ImportTab
          file={file} fileSha={fileSha} dupBatch={dupBatch} parsed={parsed} mapping={mapping}
          setMapping={setMapping} asOf={asOf} setAsOf={setAsOf} preview={preview}
          commitResult={commitResult} busy={busy} detectedMetrics={detectedMetrics}
          onFile={onFile} runPreview={runPreview} doCommit={doCommit}
        />
      )}
      {tab === 'coverage' && <CoverageTab coverage={coverage} />}
    </div>
  )
}


function ImportTab(props) {
  const {
    file, fileSha, dupBatch, parsed, mapping, setMapping, asOf, setAsOf, preview,
    commitResult, busy, detectedMetrics, onFile, runPreview, doCommit,
  } = props
  const conflicts = preview?.conflicts || []

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
        <label className={labelCls}>1. Upload the MPR sheet (xlsx / csv)</label>
        <div className="flex items-center gap-3">
          <label className="inline-flex items-center gap-2 rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white cursor-pointer hover:bg-[#007a35]">
            <Upload className="h-4 w-4" /> Choose file
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={onFile} />
          </label>
          {file && <span className="text-sm text-slate-600 dark:text-slate-300">{file.name}</span>}
          {busy && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
        </div>
        {fileSha && <p className="mt-2 text-xs text-slate-400">SHA-256: {fileSha.slice(0, 16)}…</p>}
        {dupBatch && (
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4 mt-0.5" />
            <span>
              This exact file was already imported on {new Date(dupBatch.uploaded_at).toLocaleString()}
              {dupBatch.uploaded_by_name ? ` by ${dupBatch.uploaded_by_name}` : ''}. Re-importing would only
              re-confirm identical values. Unmatched rows below can still be resolved.
            </span>
          </div>
        )}
      </section>

      {parsed && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
          <label className={labelCls}>2. Column mapping (auto-detected — edit any field)</label>
          <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
            {parsed.records.length} rows, {parsed.headers.length} columns. Detected metrics:{' '}
            {detectedMetrics.length ? detectedMetrics.join(', ') : 'none — map at least one metric column'}.
          </p>
          <div className="mb-3 max-w-xs">
            <label className={labelCls}>As-of date (used when the sheet has no date column)</label>
            <input type="date" className={inputCls} value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {Object.keys(FIELD_SYNONYMS).map((field) => (
              <div key={field} className="flex items-center gap-2">
                <span className="w-32 shrink-0 text-xs font-medium text-slate-600 dark:text-slate-300">{field}</span>
                <select className={inputCls} value={mapping[field] || ''}
                  onChange={(e) => setMapping({ ...mapping, [field]: e.target.value || undefined })}>
                  <option value="">— none —</option>
                  {parsed.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            ))}
          </div>
          <button onClick={runPreview} disabled={busy || !detectedMetrics.length}
            className="mt-4 inline-flex items-center gap-2 rounded-lg border border-[#009944] px-4 py-2 text-sm font-medium text-[#009944] disabled:opacity-40">
            <Table2 className="h-4 w-4" /> Preview
          </button>
        </section>
      )}


      {preview && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
          <label className={labelCls}>3. Preview & commit</label>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="New values" value={preview.summary.proposed} />
            <Stat label="Employees" value={preview.summary.employees} />
            <Stat label="As-of dates" value={preview.summary.as_of_dates.join(', ') || '—'} />
            <Stat label="Unmatched rows" value={preview.summary.unmatched_count} tone={preview.summary.unmatched_count ? 'amber' : 'green'} />
          </div>
          <div className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            Per metric: {Object.entries(preview.summary.per_metric).map(([k, v]) => `${k}=${v}`).join(', ') || '—'}
          </div>
          {preview.unmatched?.length > 0 && (
            <div className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
              {preview.unmatched.length} rows could not be matched to a staff member and were sent to the
              review queue (never created as employees). First few: {preview.unmatched.slice(0, 3).map((u) => u.reason).join('; ')}.
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <button onClick={() => doCommit(false)} disabled={busy || !!commitResult}
              className="inline-flex items-center gap-2 rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
              <CheckCircle2 className="h-4 w-4" /> Commit
            </button>
            {conflicts.length > 0 && (
              <button onClick={() => doCommit(true)} disabled={busy}
                className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
                Confirm {conflicts.length} conflict{conflicts.length === 1 ? '' : 's'} (newer wins)
              </button>
            )}
          </div>
          {commitResult && (
            <div className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-200">
              Committed: {commitResult.inserted} new, {commitResult.updated} updated, {commitResult.unchanged} unchanged
              {commitResult.conflict_count ? `, ${commitResult.conflict_count} still conflicting (confirm to apply)` : ''}.
            </div>
          )}
          {conflicts.length > 0 && (
            <table className="mt-3 w-full text-xs">
              <thead><tr className="text-left text-slate-500"><th className="p-1">Employee</th><th className="p-1">Metric</th><th className="p-1">Old</th><th className="p-1">New</th></tr></thead>
              <tbody>
                {conflicts.slice(0, 10).map((c, i) => (
                  <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="p-1 font-mono">{c.employee_id?.slice(0, 8)}</td>
                    <td className="p-1">{c.metric_key}</td>
                    <td className="p-1">{c.old_value}</td>
                    <td className="p-1">{c.new_value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  )
}

function Stat({ label, value, tone }) {
  const color = tone === 'amber' ? 'text-amber-600' : tone === 'green' ? 'text-emerald-600' : 'text-slate-900 dark:text-white'
  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${color}`}>{value}</p>
    </div>
  )
}


function CoverageTab({ coverage }) {
  if (!coverage) return <LoadingState message="Loading coverage…" />
  const metrics = [...new Set(coverage.map((r) => r.metric_key))].sort()
  const dates = [...new Set(coverage.map((r) => r.as_of_date))].sort()
  const emps = [...new Set(coverage.map((r) => r.employee_id))]
  const latest = dates[dates.length - 1]
  const has = (e, m) => coverage.some((r) => r.employee_id === e && r.as_of_date === latest && r.metric_key === m)

  function exportMissing() {
    const rows = [['employee_id', ...metrics]]
    for (const e of emps) rows.push([e, ...metrics.map((m) => (has(e, m) ? 'Imported' : 'Missing'))])
    const csv = rows.map((r) => r.join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a'); a.href = url; a.download = 'coverage_missing.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {emps.length} employees × {metrics.length} metrics. Showing coverage for {latest || '—'}.
        </p>
        <button onClick={exportMissing} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-1.5 text-xs dark:border-slate-600">
          <Download className="h-3.5 w-3.5" /> Export missing list
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead><tr className="text-left text-slate-500">
            <th className="p-2">Employee</th>
            {metrics.map((m) => <th key={m} className="p-2">{m}</th>)}
          </tr></thead>
          <tbody>
            {emps.slice(0, 50).map((e) => (
              <tr key={e} className="border-t border-slate-100 dark:border-slate-800">
                <td className="p-2 font-mono">{e.slice(0, 8)}</td>
                {metrics.map((m) => (
                  <td key={m} className="p-2">
                    {has(e, m) ? <span className="text-emerald-600">Imported</span> : <span className="text-slate-400">Missing</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

