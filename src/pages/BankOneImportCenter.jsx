import React, { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Check, FileUp, Loader2, Play, RefreshCw, Upload, X } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { EmptyState, ErrorState } from '../components/PageStates'
import { date, status } from './hrShared'
import { bankoneImportService, parseFile, applyColumnMapping, validateRow, BANKONE_TARGET_FIELDS } from '../services/bankoneImportService'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

export default function BankOneImportCenter() {
  const { user, profile, hasPermission } = useAuth()
  const canImport = hasPermission('bankone.import')

  const [batches, setBatches] = useState([])
  const [batchesLoading, setBatchesLoading] = useState(true)
  const [mappings, setMappings] = useState([])
  const [selectedMapping, setSelectedMapping] = useState(null)
  const [file, setFile] = useState(null)
  const [parsed, setParsed] = useState(null)
  const [mapping, setMapping] = useState({})
  const [reportingPeriod, setReportingPeriod] = useState('')
  const [processing, setProcessing] = useState(false)
  const [stage, setStage] = useState('setup') // setup | preview | staged | importing | done
  const [processResult, setProcessResult] = useState(null)
  const [batchId, setBatchId] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selectedBatch, setSelectedBatch] = useState(null)
  const [batchRows, setBatchRows] = useState([])
  const [rowsLoading, setRowsLoading] = useState(false)

  const loadBatches = async () => {
    setBatchesLoading(true)
    try {
      setBatches(await bankoneImportService.listBatches())
    } catch (e) {
      setError(e?.message || 'Failed to load batches')
    } finally {
      setBatchesLoading(false)
    }
  }

  const loadMappings = async () => {
    try {
      const data = await bankoneImportService.listMappings()
      setMappings(data)
      const def = data.find((m) => m.is_default) || data[0]
      if (def) {
        setSelectedMapping(def.id)
        setMapping(def.mapping || {})
      }
    } catch (e) {
      // Table might not exist yet — use empty mapping
      console.warn('Could not load mappings:', e?.message)
    }
  }

  useEffect(() => { loadBatches(); loadMappings() }, [])

  const onFile = async (f) => {
    setError(''); setNotice(''); setStage('setup'); setProcessResult(null); setBatchId(null)
    if (!f) { setParsed(null); setFile(null); return }
    try {
      const result = await parseFile(f)
      setFile(f)
      setParsed(result)
      // Auto-map: if source header matches a target field, map it
      const autoMap = {}
      result.headers.forEach((h) => {
        const normalized = h.toLowerCase().trim().replace(/\s+/g, '_')
        if (BANKONE_TARGET_FIELDS.includes(normalized)) {
          autoMap[h] = normalized
        } else if (mapping[h]) {
          autoMap[h] = mapping[h]
        } else {
          autoMap[h] = ''
        }
      })
      setMapping(autoMap)
      setStage('preview')
    } catch (e) {
      setError(e?.message || 'Unable to read file')
    }
  }

  const preview = useMemo(() => {
    if (!parsed) return []
    return parsed.rows.slice(0, 8).map((r) => {
      const { mapped } = applyColumnMapping(r, mapping)
      return mapped
    })
  }, [parsed, mapping])

  const mappedCount = Object.values(mapping).filter(Boolean).length

  const processAndStage = async () => {
    setProcessing(true)
    setError('')
    try {
      // Create batch
      const batch = await bankoneImportService.createBatch({
        filename: file?.name || 'unknown.csv',
        sourceFormat: file?.name?.toLowerCase().endsWith('.json') ? 'json' : 'csv',
        reportingPeriod,
        mappingConfig: mapping,
        uploadedByName: profile?.full_name || user?.email,
        uploadedById: user?.id,
      })
      setBatchId(batch.id)

      // Process rows (validate, dedup, match staff)
      const { results, summary } = await bankoneImportService.processRows(batch.id, parsed, mapping)
      setProcessResult({ results, summary })

      // Stage rows to DB
      await bankoneImportService.stageRows(batch.id, results)

      setStage('staged')
      await loadBatches()
    } catch (e) {
      setError(e?.message || 'Processing failed')
      setStage('preview')
    } finally {
      setProcessing(false)
    }
  }

  const confirmImport = async () => {
    setProcessing(true)
    setError('')
    setStage('importing')
    try {
      const result = await bankoneImportService.confirmImport(batchId, user?.id, profile?.full_name || user?.email)
      setNotice(`Import complete: ${result.imported} transactions imported out of ${result.total} valid rows.`)
      setStage('done')
      await loadBatches()
    } catch (e) {
      setError(e?.message || 'Import failed')
      setStage('staged')
    } finally {
      setProcessing(false)
    }
  }

  const viewBatch = async (b) => {
    setSelectedBatch(b)
    setRowsLoading(true)
    try {
      setBatchRows(await bankoneImportService.listBatchRows(b.id))
    } catch (e) {
      setError(e?.message)
    } finally {
      setRowsLoading(false)
    }
  }

  const summary = processResult?.summary
  const results = processResult?.results

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">🏦 BankOne Import Center</h2>
          <p className="text-sm text-slate-500 mt-1">Upload BankOne transaction exports. Validate, preview, map, deduplicate, and confirm before importing.</p>
        </div>
        <button onClick={loadBatches} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {notice && <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">{notice}</div>}
      {error && <div className="mb-5"><ErrorState message={error} /></div>}

      {/* Upload + Configure */}
      <div className="bg-white rounded-lg border border-slate-200 p-6 mb-8">
        <h3 className="font-semibold text-slate-900 mb-4">New BankOne Import</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
          <div>
            <label className={labelCls}>Column Mapping</label>
            <select
              className={inputCls}
              value={selectedMapping || ''}
              onChange={(e) => {
                setSelectedMapping(e.target.value)
                const m = mappings.find((m) => m.id === e.target.value)
                if (m) setMapping(m.mapping || {})
              }}
            >
              {mappings.length === 0 && <option value="">Default (auto-detect)</option>}
              {mappings.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Reporting Period</label>
            <input className={inputCls} value={reportingPeriod} onChange={(e) => setReportingPeriod(e.target.value)} placeholder="e.g. September Week 1" />
          </div>
          <div>
            <label className={labelCls}>Source File (CSV/JSON)</label>
            <input type="file" accept=".csv,.json,.txt" onChange={(e) => onFile(e.target.files[0])} className="block w-full text-sm text-slate-500 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-[#009944] file:text-white hover:file:bg-[#007a36]" />
          </div>
        </div>

        {/* Column Mapping UI */}
        {stage === 'preview' && parsed && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
            <div>
              <p className="text-sm font-medium text-slate-700 mb-2">Column Mapping ({mappedCount} mapped)</p>
              <div className="max-h-72 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
                {parsed.headers.map((h) => (
                  <div key={h} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="w-1/2 truncate text-slate-500">{h}</span>
                    <span className="text-slate-300">→</span>
                    <select
                      className="flex-1 h-8 rounded border border-slate-300 text-sm px-1 focus:outline-none focus:ring-2 focus:ring-[#009944]"
                      value={mapping[h] || ''}
                      onChange={(e) => setMapping({ ...mapping, [h]: e.target.value })}
                    >
                      <option value="">(skip)</option>
                      {BANKONE_TARGET_FIELDS.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="text-sm font-medium text-slate-700 mb-2">Preview (first {preview.length} rows)</p>
              <div className="max-h-72 overflow-x-auto border border-slate-200 rounded-lg">
                {preview.length === 0 ? <p className="p-4 text-sm text-slate-400">Map columns to preview.</p> : (
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 text-slate-500 text-left">
                      <tr>{BANKONE_TARGET_FIELDS.slice(0, 6).map((t) => <th key={t} className="px-2 py-2 whitespace-nowrap font-medium">{t}</th>)}</tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {preview.map((row, i) => (
                        <tr key={i}>
                          {BANKONE_TARGET_FIELDS.slice(0, 6).map((t) => <td key={t} className="px-2 py-2 text-slate-600 max-w-[120px] truncate">{row[t] || '—'}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Validation Summary */}
        {stage === 'staged' && summary && (
          <div className="mt-6">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
              {[
                { label: 'Total Rows', value: summary.total, cls: 'text-slate-900' },
                { label: 'Valid', value: summary.valid, cls: 'text-[#009944]' },
                { label: 'Duplicates', value: summary.duplicates, cls: 'text-amber-600' },
                { label: 'Unmatched Staff', value: summary.unmatched, cls: 'text-orange-600' },
                { label: 'Errors', value: summary.errors, cls: 'text-rose-600' },
              ].map((s) => (
                <div key={s.label} className="rounded-lg bg-slate-50 p-3">
                  <div className={`text-xl font-bold ${s.cls}`}>{s.value}</div>
                  <div className="text-xs text-slate-400">{s.label}</div>
                </div>
              ))}
            </div>

            {results && results.filter((r) => r.status === 'error').length > 0 && (
              <div className="mb-4 max-h-40 overflow-y-auto border border-rose-200 rounded-lg bg-rose-50 p-3 text-sm text-rose-800">
                {results.filter((r) => r.status === 'error').slice(0, 15).map((r) => (
                  <p key={r.row_number}>Row {r.row_number}: {r.validation_errors.map((e) => e.message).join(' ')}</p>
                ))}
              </div>
            )}

            {results && results.filter((r) => r.status === 'unmatched_staff').length > 0 && (
              <div className="mb-4 max-h-40 overflow-y-auto border border-orange-200 rounded-lg bg-orange-50 p-3 text-sm text-orange-800">
                <p className="font-medium mb-1">Unmatched Staff Transactions ({results.filter((r) => r.status === 'unmatched_staff').length})</p>
                <p className="text-xs">These transactions will be imported but not linked to an employee. An authorized user can map them later from the Reconciliation module.</p>
              </div>
            )}

            <div className="flex gap-2">
              {canImport ? (
                <button onClick={confirmImport} disabled={processing || summary.valid === 0} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
                  {processing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />} Confirm Import ({summary.valid + summary.unmatched} rows)
                </button>
              ) : (
                <p className="text-sm text-slate-500">You need import permission to confirm.</p>
              )}
              <button onClick={() => { setStage('setup'); setParsed(null); setFile(null); setProcessResult(null) }} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Reset</button>
            </div>
          </div>
        )}

        {stage === 'preview' && parsed && (
          <div className="mt-5 flex gap-2">
            <button onClick={processAndStage} disabled={processing || mappedCount === 0} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
              {processing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Validate & Preview
            </button>
          </div>
        )}

        {stage === 'importing' && <div className="mt-6 text-sm text-[#009944] flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Importing transactions…</div>}
      </div>

      {/* Import History */}
      <h3 className="text-lg font-semibold text-slate-900 mb-3">Import History</h3>
      {batchesLoading && <div className="text-sm text-slate-500">Loading…</div>}
      {!batchesLoading && batches.length === 0 && <EmptyState title="No BankOne imports yet" description="Upload a BankOne export to get started." />}
      {!batchesLoading && batches.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                <th className="px-4 py-3 font-medium">File</th>
                <th className="px-4 py-3 font-medium">Period</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Summary</th>
                <th className="px-4 py-3 font-medium">Uploaded</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {batches.map((b) => (
                <tr key={b.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-800">{b.filename}</td>
                  <td className="px-4 py-3 text-slate-600">{b.reporting_period || '—'}</td>
                  <td className="px-4 py-3">{status(b.status, ['completed', 'completed_with_warnings', 'preview', 'importing'])}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {b.total_rows ? `${b.total_rows} rows` : ''} {b.imported_rows ? `· ${b.imported_rows} imported` : ''}
                    {b.duplicate_rows ? ` · ${b.duplicate_rows} dup` : ''} {b.unmatched_staff_rows ? ` · ${b.unmatched_staff_rows} unmatched` : ''}
                    {b.rejected_rows ? ` · ${b.rejected_rows} rejected` : ''}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{date(b.uploaded_at)} {b.uploaded_by_name ? `· ${b.uploaded_by_name}` : ''}</td>
                  <td className="px-4 py-3">
                    <button onClick={() => viewBatch(b)} className="text-xs text-[#009944] hover:underline">{selectedBatch?.id === b.id ? 'Hide' : 'Details'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Batch Details */}
      {selectedBatch && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-3">
            <h4 className="font-semibold text-slate-900">Rows for {selectedBatch.filename}</h4>
            <button onClick={() => setSelectedBatch(null)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
          </div>
          {rowsLoading && <div className="text-sm text-slate-500">Loading rows…</div>}
          {!rowsLoading && (
            <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-left">
                  <tr>
                    <th className="px-4 py-3 font-medium">Row</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Match</th>
                    <th className="px-4 py-3 font-medium">Staff Match</th>
                    <th className="px-4 py-3 font-medium">Errors/Warnings</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {batchRows.slice(0, 200).map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50">
                      <td className="px-4 py-2 text-slate-600">#{r.row_number}</td>
                      <td className="px-4 py-2">{status(r.status)}</td>
                      <td className="px-4 py-2 text-xs text-slate-500">{r.match_type || '—'}</td>
                      <td className="px-4 py-2 text-xs text-slate-500">{r.employee_match_method || (r.employee_id ? 'matched' : 'unmatched')}</td>
                      <td className="px-4 py-2 text-xs text-rose-600">{Array.isArray(r.validation_errors) ? r.validation_errors.map((e) => e.message).join('; ') : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {batchRows.length > 200 && <p className="p-3 text-xs text-slate-400">Showing first 200 of {batchRows.length} rows.</p>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
