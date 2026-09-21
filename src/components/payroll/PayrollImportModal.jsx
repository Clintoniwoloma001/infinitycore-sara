import React, { useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, RefreshCw, Upload, X } from 'lucide-react'
import { payrollImportService } from '../../services/payrollImportService'
import { displayImportedValue } from '../../lib/payrollExcel'

const btnPrimary = 'inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50'
const btnGhost = 'inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-300 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50'
const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

// Import Payroll (Excel) — dynamic schema adaptation.
//
// Upload .xlsx/.xls/.csv and the platform adopts the workbook column
// structure as the active payroll schema. Each row is matched to the
// employee profile by staff identifier and snapshotted onto it. A second
// upload supersedes the active import ONLY after explicit confirmation.
export default function PayrollImportModal({ activeImport, onClose, onSaved }) {
  const fileRef = useRef(null)
  const [filename, setFilename] = useState('')
  const [parsed, setParsed] = useState(null)
  const [parseError, setParseError] = useState('')
  const [matchKey, setMatchKey] = useState('')
  const [periodLabel, setPeriodLabel] = useState('')
  const [currency, setCurrency] = useState('NGN')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmOverride, setConfirmOverride] = useState(false)

  const selectedFile = fileRef.current?.files?.[0]

  const handleFile = (file) => {
    if (!file) return
    setFilename(file.name)
    setParsed(null)
    setParseError('')
    setError('')
    setNotice('')
    setConfirmOverride(false)
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const res = payrollImportService.parse(reader.result, file.name)
        if (!res.columns?.length) throw new Error('No recognizable column headers in the first row.')
        setParsed(res)
        setMatchKey(res.matchKey || (res.columns[0]?.key || ''))
      } catch (e) {
        setParseError(e?.message || 'Unable to parse this file')
      }
    }
    reader.onerror = () => setParseError('Could not read the selected file')
    reader.readAsArrayBuffer(file)
  }

  const previewColumns = useMemo(() => parsed?.columns?.slice(0, 6) || [], [parsed])
  const previewRows = useMemo(() => parsed?.rows?.slice(0, 5) || [], [parsed])

  const doImport = async () => {
    if (!parsed) { setError('Parse a workbook first.'); return }
    if (!matchKey) { setError('Choose the staff identifier column to match rows to employees.'); return }
    setBusy(true); setError(''); setNotice('')
    try {
      const res = await payrollImportService.save({
        filename,
        sourceFormat: parsed.sourceFormat,
        periodLabel,
        currency,
        matchKey,
        columns: parsed.columns,
        rows: parsed.rows,
        confirmOverride,
      })
      if (res && res.ok === false && res.code === 'override_required') {
        setConfirmOverride(true)
        setNotice('An active payroll structure already exists — confirm to replace it with this workbook.')
        return
      }
      setNotice(
        `Adopted ${res.columns} columns across ${res.rows} rows — ${res.matched_profiles} employee profile(s) matched${res.override_applied ? ' (previous structure superseded)' : ''}.`
      )
      onSaved?.()
    } catch (e) {
      setError(e?.message || 'Import failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-3xl max-h-[92vh] overflow-y-auto shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 bg-[#009944]/5 rounded-t-xl">
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5 text-[#009944]" />
            <h3 className="text-lg font-semibold text-slate-900">Import Payroll (Excel)</h3>
          </div>
          <button onClick={onClose} disabled={busy} className="text-slate-400 hover:text-slate-600 disabled:opacity-40"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {activeImport && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              <span className="font-medium">Active structure:</span> {activeImport.filename} · {activeImport.columns?.length} columns · {activeImport.row_count} rows · {activeImport.matched_profiles} matched
            </div>
          )}

          {(error || parseError) && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              <AlertTriangle className="w-4 h-4 mt-0.5" /> <span>{error || parseError}</span>
            </div>
          )}
          {notice && (
            <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
              <CheckCircle2 className="w-4 h-4 mt-0.5" /> <span>{notice}</span>
            </div>
          )}

          {/* File selection */}
          <div>
            <label className={labelCls}>Workbook</label>
            <div className="flex items-center gap-3">
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-[#009944]/10 file:px-3 file:py-2 file:text-sm file:font-medium file:text-[#007a36] hover:file:bg-[#009944]/20"
                onChange={(e) => handleFile(e.target.files?.[0])}
              />
              {selectedFile?.name && <span className="text-xs text-slate-400 truncate">{selectedFile.name}</span>}
            </div>
            <p className="text-xs text-slate-400 mt-1.5">
              The header row becomes the new payroll schema. Rows are matched to employees by the staff identifier column.
            </p>
          </div>

          {parsed && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className={labelCls}>Staff identifier column</label>
                  <select className={inputCls} value={matchKey} onChange={(e) => setMatchKey(e.target.value)}>
                    {parsed.columns.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Period label</label>
                  <input className={inputCls} value={periodLabel} onChange={(e) => setPeriodLabel(e.target.value)} placeholder="e.g. Oct 2026" />
                </div>
                <div>
                  <label className={labelCls}>Currency</label>
                  <input className={inputCls} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} placeholder="NGN" />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-sm font-semibold text-slate-700">Preview — {parsed.rows.length} row(s), {parsed.columns.length} column(s)</h4>
                  <span className="text-[11px] text-slate-400">{filename}</span>
                </div>
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left bg-slate-50 border-b border-slate-200 text-slate-500 uppercase tracking-wide">
                        {previewColumns.map((c) => <th key={c.key} className="px-2.5 py-1.5 whitespace-nowrap">{c.label}</th>)}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {previewRows.map((r, i) => (
                        <tr key={i}>
                          {previewColumns.map((c) => (
                            <td key={c.key} className="px-2.5 py-1.5 whitespace-nowrap text-slate-600">{displayImportedValue(r[c.key])}</td>
                          ))}
                        </tr>
                      ))}
                      {previewRows.length === 0 && <tr><td className="px-2.5 py-3 text-slate-400">No data rows</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>

              {confirmOverride && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                  <span className="font-medium">Replace the active payroll structure?</span> Importing this workbook will supersede the current structure and update every matched employee profile.
                </div>
              )}
            </>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button className={btnGhost} onClick={onClose} disabled={busy}>Cancel</button>
            <button className={btnPrimary} onClick={doImport} disabled={!parsed || busy} title={parsed ? 'Adopt this workbook as the payroll schema' : 'Parse a workbook first'}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : confirmOverride ? <RefreshCw className="w-4 h-4" /> : <Upload className="w-4 h-4" />}
              {busy ? 'Importing…' : confirmOverride ? 'Replace structure' : 'Import payroll'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}