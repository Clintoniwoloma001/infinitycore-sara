// ============================================================================
// §17 DATA VALIDATION + UNMATCHED RECORDS
// ============================================================================
// Rows that were refused, and WHY. A refused row is never silently dropped and
// never written with a guessed value - the reason is shown verbatim.
import React from 'react'
import { FileWarning } from 'lucide-react'

export default function ValidationPanel({ result }) {
  const invalid = result.invalidRows || []
  const header = result.header

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-slate-800">How this file was read</h3>
        <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div className="flex gap-2">
            <dt className="text-slate-500">Header detected on row</dt>
            <dd className="font-medium text-slate-800">{(header?.headerIndex ?? 0) + 1}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-slate-500">Header confidence</dt>
            <dd className="font-medium text-slate-800">{Math.round((header?.confidence ?? 0) * 100)}%</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-slate-500">Source rows</dt>
            <dd className="font-medium text-slate-800">{result.summary?.sourceRowCount ?? 0}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-slate-500">Rows written</dt>
            <dd className="font-medium text-slate-800">{result.summary?.parsedRowCount ?? 0}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-slate-500">
          The header row is detected from the column labels, never assumed. Disbursement Date
          format detected as <strong>{result.dateFormats?.disbursementDate?.format ?? 'text (DD-MMM-YYYY)'}</strong>.
        </p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
          <FileWarning className="h-4 w-4 text-amber-600" />
          Rows that were not imported ({invalid.length})
        </h3>
        {invalid.length === 0 ? (
          <p className="mt-2 text-sm text-emerald-700">
            Every source row passed validation. Nothing was discarded.
          </p>
        ) : (
          <>
            <p className="mt-1 text-xs text-slate-500">
              These rows were refused rather than imported with a guessed value. Only the first 200
              are shown.
            </p>
            <div className="mt-3 max-h-96 overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-white text-slate-500">
                  <tr>
                    <th className="py-1 pr-3">Row</th>
                    <th className="py-1 pr-3">Account</th>
                    <th className="py-1">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {invalid.slice(0, 200).map((r, i) => (
                    <tr key={`${r.rowNumber}-${i}`} className="border-t border-slate-100">
                      <td className="py-1 pr-3 tabular-nums text-slate-400">{r.rowNumber}</td>
                      <td className="py-1 pr-3 font-mono text-slate-700">{r.accountNo || '—'}</td>
                      <td className="py-1 text-rose-700">{r.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
