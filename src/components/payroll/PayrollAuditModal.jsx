import React, { useEffect, useState } from 'react'
import { FileSpreadsheet, History, Loader2, PenLine, ShieldCheck, X } from 'lucide-react'
import { payrollProfileService } from '../../services/payrollProfileService'
import { money, date } from '../../pages/hrShared'

const btnGhost = 'inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-300 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50'

const FIELD_LABELS = {
  basic_monthly: 'BASIC',
  allowances: 'ALLOWANCES',
  component_deductions: 'DEDUCTIONS',
  net_monthly: 'NET',
  gross_monthly: 'GROSS',
  gross_override: 'GROSS',
  net_override: 'NET',
  mid_override: 'MID-MONTH',
  end_override: 'MONTH-END',
}

const ACTION_META = {
  EMPLOYEE_COMPENSATION_EDITED: { label: 'Payroll edit', icon: PenLine, cls: 'text-slate-600' },
  PAYROLL_STRUCTURE_OVERRIDE: { label: 'Excel structure override', icon: FileSpreadsheet, cls: 'text-[#009944]' },
}

function DiffChips({ row }) {
  const diff = row.field_diff || {}
  const entries = Object.entries(diff)
  if (!entries.length) return <span className="text-xs text-slate-400">No field changes</span>
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(([key, change]) => (
        <span key={key} className="inline-flex items-center gap-1 rounded-md bg-slate-100 border border-slate-200 px-1.5 py-0.5 text-[11px]">
          <span className="font-medium text-slate-500">{FIELD_LABELS[key] || key}</span>
          <span className="text-slate-400 line-through">{money(change.from)}</span>
          <span className="text-slate-400">→</span>
          <span className="font-semibold text-[#009944]">{money(change.to)}</span>
        </span>
      ))}
    </div>
  )
}

// Read-only payment audit trail — every HR Manager / HR Officer payroll
// edit and every Excel structure override with before/after values, the
// captured signature (where required) and the caller IP.
export default function PayrollAuditModal({ onClose }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setLoading(true)
    payrollProfileService
      .listAudit({ limit: 100 })
      .then((data) => { if (active) setRows(data || []) })
      .catch((e) => { if (active) setError(e?.message || 'Unable to load the audit trail') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-3xl max-h-[92vh] overflow-hidden shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 bg-[#009944]/5 rounded-t-xl">
          <div className="flex items-center gap-2">
            <History className="w-5 h-5 text-[#009944]" />
            <h3 className="text-lg font-semibold text-slate-900">Payroll Audit Trail</h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1 space-y-3">
          {error && <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}

          {loading ? (
            <div className="flex items-center justify-center py-16 text-slate-400"><Loader2 className="w-5 h-5 animate-spin" /></div>
          ) : rows.length === 0 ? (
            <div className="text-center py-16 text-sm text-slate-400">No payroll changes recorded yet.</div>
          ) : (
            rows.map((r) => {
              const meta = ACTION_META[r.action] || { label: r.action || 'Event', icon: ShieldCheck, cls: 'text-slate-500' }
              const Icon = meta.icon
              return (
                <div key={r.id} className="rounded-lg border border-slate-200 p-3.5">
                  <div className="flex items-center justify-between flex-wrap gap-2 mb-1.5">
                    <div className="flex items-center gap-2">
                      <Icon className={`w-4 h-4 ${meta.cls}`} />
                      <span className="text-sm font-medium text-slate-800">{meta.label}</span>
                      {r.action === 'PAYROLL_STRUCTURE_OVERRIDE' && r.details?.columns && (
                        <span className="text-[11px] text-slate-400">{r.details.columns} columns · {r.details.rows} rows</span>
                      )}
                      {r.employee_name && (
                        <span className="text-xs text-slate-500">{r.employee_name}{r.employee_code ? ` · ${r.employee_code}` : ''}</span>
                      )}
                    </div>
                    <div className="text-xs text-slate-400">{date(r.created_at)}</div>
                  </div>

                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <span className="text-xs text-slate-500">
                      by <span className="font-medium">{r.edited_by_name || '—'}</span>
                      {r.edited_by_role ? ` (${r.edited_by_role.replace(/_/g, ' ')})` : ''}
                    </span>
                    {r.ip_address && r.ip_address !== 'unknown' && (
                      <span className="text-[11px] text-slate-400">IP {r.ip_address}</span>
                    )}
                    {r.signature_data_url && <span className="text-[11px] text-amber-600">signed</span>}
                  </div>

                  <DiffChips row={r} />

                  {r.field_diff?.added_columns && r.field_diff.added_columns.length > 0 && (
                    <div className="text-[11px] text-slate-500 mt-1.5">Added: {r.field_diff.added_columns.join(', ')}</div>
                  )}
                  {r.field_diff?.removed_columns && r.field_diff.removed_columns.length > 0 && (
                    <div className="text-[11px] text-slate-500 mt-0.5">Removed: {r.field_diff.removed_columns.join(', ')}</div>
                  )}

                  {r.reason && <div className="text-xs text-slate-500 mt-1.5"><span className="font-medium">Reason:</span> {r.reason}</div>}

                  {r.signature_data_url && (
                    <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
                      <img src={r.signature_data_url} alt="signature" className="h-16" />
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        <div className="flex justify-end px-5 py-3 border-t border-slate-100">
          <button className={btnGhost} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}