import React, { useEffect, useMemo, useState } from 'react'
import { Check, Download, FileUp, Loader2, Play, RefreshCw, Trash2, X } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { EmptyState, ErrorState } from '../components/PageStates'
import { date, status } from './hrShared'
import { downloadErrorReport, HEADERS, IMPORT_TYPES, importService, parseCSV, validateRows } from '../services/importService'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

async function readFile(file) {
  const text = await file.text()
  if (file.name.toLowerCase().endsWith('.json')) {
    const parsed = JSON.parse(text)
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    if (arr.length === 0) throw new Error('The JSON file contains no records.')
    const headers = Array.from(new Set(arr.flatMap((o) => Object.keys(o))))
    return { headers, rows: arr.map((o) => {
      const clean = {}
      headers.forEach((h) => { clean[h] = o[h] === null || o[h] === undefined ? '' : String(o[h]).trim() })
      return clean
    }) }
  }
  const rows = parseCSV(text)
  if (rows.length < 2) throw new Error('CSV must contain a header row and at least one data row.')
  const headers = rows[0]
  const dataRows = rows.slice(1)
  return { headers, rows: dataRows.map((cells) => {
    const obj = {}
    headers.forEach((h, i) => { if (h) obj[String(h).trim()] = cells[i] ? String(cells[i]).trim() : '' })
    return obj
  }) }
}

export default function DataImport() {
  const { hasPermission } = useAuth()
  const canExecute = hasPermission('data.import.execute')

  const [jobs, setJobs] = useState([])
  const [jobsLoading, setJobsLoading] = useState(true)
  const [importType, setImportType] = useState('employees')
  const [duplicateStrategy, setDuplicateStrategy] = useState('skip')
  const [file, setFile] = useState(null)
  const [parsed, setParsed] = useState(null)
  const [mapping, setMapping] = useState({})
  const [validated, setValidated] = useState(null)
  const [stage, setStage] = useState('setup') // setup | review | staged | running | done
  const [job, setJob] = useState(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [selectedJob, setSelectedJob] = useState(null)
  const [selectedRecords, setSelectedRecords] = useState([])
  const [recordsLoading, setRecordsLoading] = useState(false)

  const POSSIBLE_TARGETS = HEADERS[importType]

  const loadJobs = async () => {
    setJobsLoading(true)
    try {
      setJobs(await importService.listJobs())
    } finally {
      setJobsLoading(false)
    }
  }

  useEffect(() => { loadJobs() }, [])

  const onFile = async (f) => {
    setError('')
    setNotice('')
    setStage('setup')
    setValidated(null)
    setJob(null)
    if (!f) { setParsed(null); setFile(null); return }
    try {
      const result = await readFile(f)
      setFile(f)
      setParsed(result)
      setMapping(Object.fromEntries(result.headers.map((h) => [h, HEADERS[importType].includes(h) ? h : ''])))
      setStage('review')
    } catch (e) {
      setError(e?.message || 'Unable to read file')
    }
  }

  const preview = useMemo(() => {
    if (!parsed) return []
    return parsed.rows.slice(0, 8).map((r) => {
      const out = {}
      Object.entries(mapping).forEach(([src, tgt]) => { if (tgt) out[tgt] = r[src] })
      return out
    })
  }, [parsed, mapping])

  const runValidation = async () => {
    setError('')
    try {
      const results = validateRows(importType, parsed.rows, mapping)
      setValidated(results)
      setStage('review')
    } catch (e) {
      setError(e?.message || 'Validation failed')
    }
  }

  const stageJob = async () => {
    setBusy(true)
    setError('')
    try {
      const j = await importService.createJob({ importType, filename: file?.name, duplicateStrategy, mapping })
      const summary = await importService.stageRecords(j.id, validated)
      setJob({ ...j, ...summary })
      setStage('staged')
      await loadJobs()
    } catch (e) {
      setError(e?.message || 'Failed to stage import')
    } finally {
      setBusy(false)
    }
  }

  const runJob = async () => {
    setBusy(true)
    setError('')
    setStage('running')
    try {
      const result = await importService.run(job.id)
      setNotice(`Import finished: ${result.inserted} inserted, ${result.updated} updated, ${result.skipped} skipped, ${result.failed} failed.`)
      setStage('done')
      await loadJobs()
    } catch (e) {
      setError(e?.message || 'Import failed')
      setStage('staged')
    } finally {
      setBusy(false)
    }
  }

  const viewJob = async (j) => {
    setSelectedJob(j)
    setRecordsLoading(true)
    try {
      setSelectedRecords(await importService.listRecords(j.id))
    } finally {
      setRecordsLoading(false)
    }
  }

  const confirmPass = Object.values(mapping).filter(Boolean).length
  const counts = validated ? {
    total: validated.length,
    valid: validated.filter((r) => r.status === 'valid').length,
    warning: validated.filter((r) => r.status === 'warning').length,
    error: validated.filter((r) => r.status === 'error').length,
  } : null

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Data Import & Migration Centre</h2>
          <p className="text-sm text-slate-500 mt-1">Import employees, customers, loans, repayments, payroll, and recruitment data from CSV or JSON.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => importService.downloadTemplate(importType)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">
            <Download className="w-4 h-4" /> Template
          </button>
          <button onClick={loadJobs} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>
      </div>

      {notice && <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">{notice}</div>}
      {error && <div className="mb-5"><ErrorState message={error} /></div>}

      <div className="bg-white rounded-lg border border-slate-200 p-6 mb-8">
        <h3 className="font-semibold text-slate-900 mb-4">New import</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
          <div>
            <label className={labelCls}>Import Type</label>
            <select className={inputCls} value={importType} onChange={(e) => { setImportType(e.target.value); setParsed(null); setValidated(null); setStage('setup'); setFile(null); }}>
              {Object.entries(IMPORT_TYPES).map(([key, def]) => <option key={key} value={key}>{def.label}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Duplicate Strategy</label>
            <select className={inputCls} value={duplicateStrategy} onChange={(e) => setDuplicateStrategy(e.target.value)}>
              <option value="skip">Skip duplicates</option>
              <option value="update">Update existing</option>
              <option value="create">Create new anyway</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>Source File</label>
            <input type="file" accept=".csv,.json,.txt" onChange={(e) => onFile(e.target.files[0])} className="block w-full text-sm text-slate-500 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-[#009944] file:text-white hover:file:bg-[#007a36]" />
          </div>
        </div>

        {stage === 'review' && parsed && (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
              <div>
                <p className="text-sm font-medium text-slate-700 mb-2">Column mapping ({confirmPass} mapped)</p>
                <div className="max-h-72 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
                  {baldHeaders(parsed).map((h) => {
                    const target = mapping[h] || ''
                    return (
                      <div key={h} className="flex items-center gap-3 px-3 py-2 text-sm">
                        <span className="w-1/2 truncate text-slate-500">{h}</span>
                        <span className="text-slate-300">→</span>
                        <select className="flex-1 h-8 rounded border border-slate-300 text-sm px-1 focus:outline-none focus:ring-2 focus:ring-[#009944]" value={target} onChange={(e) => setMapping({ ...mapping, [h]: e.target.value })}>
                          <option value="">(skip)</option>
                          {POSSIBLE_TARGETS.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </div>
                    )
                  })}
                </div>
              </div>
              <div>
                <p className="text-sm font-medium text-slate-700 mb-2">Preview (first {preview.length} rows)</p>
                <div className="max-h-72 overflow-x-auto border border-slate-200 rounded-lg">
                  {preview.length === 0 ? <p className="p-4 text-sm text-slate-400">Map at least one column to preview.</p> : (
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 text-slate-500 text-left">
                        <tr>{POSSIBLE_TARGETS.map((t) => <th key={t} className="px-2 py-2 whitespace-nowrap font-medium">{t}</th>)}</tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {preview.map((row, i) => (
                          <tr key={i}>
                            {POSSIBLE_TARGETS.map((t) => <td key={t} className="px-2 py-2 text-slate-600 max-w-[140px] truncate">{row[t] || ''}</td>)}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>
            <div className="mt-5 flex gap-2">
              <button onClick={runValidation} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
                <Check className="w-4 h-4" /> Validate rows
              </button>
            </div>
          </>
        )}

        {validated && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6">
              {[
                { label: 'Total rows', value: counts.total, cls: 'text-slate-900' },
                { label: 'Valid', value: counts.valid, cls: 'text-[#009944]' },
                { label: 'Warnings', value: counts.warning, cls: 'text-amber-600' },
                { label: 'Errors', value: counts.error, cls: 'text-rose-600' },
              ].map((s) => (
                <div key={s.label} className="rounded-lg bg-slate-50 p-3">
                  <div className={`text-xl font-bold ${s.cls}`}>{s.value}</div>
                  <div className="text-xs text-slate-400">{s.label}</div>
                </div>
              ))}
            </div>
            {counts.error > 0 && (
              <div className="mt-4 max-h-48 overflow-y-auto border border-rose-200 rounded-lg bg-rose-50 p-3 text-sm text-rose-800">
                {validated.filter((r) => r.status === 'error').slice(0, 20).map((r) => (
                  <p key={r.row_number}>Row {r.row_number}: {r.validation_errors.map((e) => e.message).join(' ')}</p>
                ))}
                {counts.error > 20 && <p className="text-xs mt-1">… and {counts.error - 20} more</p>}
              </div>
            )}
            <div className="mt-5 flex gap-2">
              <button onClick={stageJob} disabled={busy} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-60">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileUp className="w-4 h-4" />} Stage for import
              </button>
              <button onClick={() => { setValidated(null); setStage('setup'); setFile(null); setParsed(null); }} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Reset</button>
            </div>
          </>
        )}

        {stage === 'staged' && job && (
          <div className="mt-6 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
            <p className="font-medium">Staged {job.total} rows ({job.valid} valid, {job.warnings} warnings, {job.errors} errors).</p>
            {canExecute ? (
              <button onClick={runJob} disabled={busy || job.valid === 0} className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />} Run import
              </button>
            ) : (
              <p className="mt-2 text-xs">An admin must execute the import.</p>
            )}
          </div>
        )}

        {stage === 'running' && <div className="mt-6 text-sm text-[#009944] flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Importing…</div>}
      </div>

      <h3 className="text-lg font-semibold text-slate-900 mb-3">Import history</h3>
      {jobsLoading && <div className="text-sm text-slate-500">Loading…</div>}
      {!jobsLoading && jobs.length === 0 && <EmptyState title="No imports yet" description="Runs will appear here with per-row results." />}
      {!jobsLoading && jobs.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                <th className="px-6 py-3 font-medium">File</th>
                <th className="px-6 py-3 font-medium">Type</th>
                <th className="px-6 py-3 font-medium">Strategy</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium">Summary</th>
                <th className="px-6 py-3 font-medium">Created</th>
                <th className="px-6 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {jobs.map((j) => (
                <tr key={j.id} className="hover:bg-slate-50">
                  <td className="px-6 py-3 font-medium text-slate-800">{j.filename || j.import_type}</td>
                  <td className="px-6 py-3 text-slate-600">{j.import_type}</td>
                  <td className="px-6 py-3 text-slate-600">{j.duplicate_strategy}</td>
                  <td className="px-6 py-3">{status(j.status, ['completed', 'completed_with_warnings', 'ready'])}</td>
                  <td className="px-6 py-3 text-xs text-slate-500">
                    {j.inserted_rows ? `+${j.inserted_rows} ` : ''}{j.updated_rows ? `~${j.updated_rows} ` : ''}{j.error_rows ? `${j.error_rows} fail` : ''}
                  </td>
                  <td className="px-6 py-3 text-slate-600">{date(j.created_at)}</td>
                  <td className="px-6 py-3">
                    <div className="flex justify-end gap-2">
                      <button onClick={() => viewJob(j)} className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-slate-300 text-slate-600 text-xs hover:bg-slate-100">{selectedJob?.id === j.id ? 'Hide' : 'Details'}</button>
                      {j.error_rows > 0 && (
                        <button onClick={() => downloadErrorReport(j, selectedJob?.id === j.id ? selectedRecords : [])} className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-slate-300 text-slate-600 text-xs hover:bg-slate-100">
                          <Download className="w-3.5 h-3.5" /> Errors
                        </button>
                      )}
                      {['pending', 'ready'].includes(j.status) && canExecute && (
                        <button onClick={() => importService.cancel(j.id).then(loadJobs)} className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-rose-300 text-rose-600 text-xs hover:bg-rose-50">
                          <Trash2 className="w-3.5 h-3.5" /> Cancel
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedJob && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-3">
            <h4 className="font-semibold text-slate-900">Rows for {selectedJob.filename || selectedJob.import_type}</h4>
            <button onClick={() => setSelectedJob(null)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
          </div>
          {recordsLoading && <div className="text-sm text-slate-500">Loading rows…</div>}
          {!recordsLoading && (
            <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-left">
                  <tr>
                    <th className="px-5 py-3 font-medium">Row</th>
                    <th className="px-5 py-3 font-medium">Status</th>
                    <th className="px-5 py-3 font-medium">Match</th>
                    <th className="px-5 py-3 font-medium">Errors</th>
                    <th className="px-5 py-3 font-medium">Source</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {selectedRecords.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50">
                      <td className="px-5 py-2 text-slate-600">#{r.row_number}</td>
                      <td className="px-5 py-2">{status(r.status)}</td>
                      <td className="px-5 py-2 text-xs text-slate-500">{r.match_type || '—'}</td>
                      <td className="px-5 py-2 text-xs text-rose-600">{Array.isArray(r.validation_errors) ? r.validation_errors.map((e) => e.message || '').join('; ') : ''}</td>
                      <td className="px-5 py-2 text-xs text-slate-400 max-w-[220px] truncate">{JSON.stringify(r.source_data)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function baldHeaders(parsed) {
  return parsed.headers
}