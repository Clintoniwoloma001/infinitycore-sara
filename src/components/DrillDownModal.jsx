import React, { useEffect, useMemo, useState } from 'react'
import { X, Search, Loader2, RefreshCw, Inbox, AlertTriangle } from 'lucide-react'

/**
 * DrillDownModal — generic record drill-down used by every clickable HR metric.
 *
 * The rows prop MUST be the SAME in-memory array the metric count was derived
 * from (single source of truth: count === rows.length, by construction). The
 * modal never re-queries; it re-renders the already-fetched records with
 * search/filter/actions, so a metric and its drill-down can never disagree.
 *
 * Every state is explicit: loading, error (with retry), empty, and done.
 */
export default function DrillDownModal({ open, onClose, title, subtitle, accent = '#009944', rows = [], columns = [], searchText = '', actions, emptyTitle = 'No records found', emptyMessage = 'No records match this metric.', error = null, loading = false, onRetry = null, activeFilterLabel = '' }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setFilter(null)
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [open])

  const filtered = useMemo(() => {
    let out = rows
    if (filter) out = out.filter(filter.predicate)
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      const keys = columns.map((c) => c.key).filter((k) => k !== 'actions')
      out = out.filter((row) => keys.some((k) => String(row[k] ?? '').toLowerCase().includes(q)))
    }
    return out
  }, [rows, query, filter, columns])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 sm:p-6"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-full max-w-4xl bg-white rounded-2xl shadow-2xl overflow-hidden my-4">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: accent }} />
              <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
            </div>
            <p className="text-sm text-slate-500 mt-0.5">
              {subtitle}
              {activeFilterLabel && <span className="text-slate-400"> · {activeFilterLabel}</span>}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><X className="w-5 h-5" /></button>
        </div>

        {/* Toolbar: search + filter chips */}
        <div className="px-6 py-3 border-b border-slate-100 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchText || `Search ${title.toLowerCase()}...`}
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]/20 focus:border-[#009944]"
            />
          </div>
          {error && onRetry && (
            <button onClick={onRetry} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-50">
              <RefreshCw className="w-3.5 h-3.5" /> Retry
            </button>
          )}
        </div>

        {/* Body */}
        <div className="max-h-[56vh] overflow-y-auto">
          {loading ? (
            <div className="py-16 flex flex-col items-center justify-center text-slate-400">
              <Loader2 className="w-6 h-6 animate-spin mb-2" />
              <p className="text-sm">Loading records...</p>
            </div>
          ) : error ? (
            <div className="py-16 flex flex-col items-center justify-center text-center px-6">
              <div className="w-12 h-12 rounded-full bg-rose-50 flex items-center justify-center mb-3">
                <AlertTriangle className="w-6 h-6 text-rose-500" />
              </div>
              <p className="text-sm font-medium text-slate-900">Could not load these records</p>
              <p className="text-xs text-slate-500 mt-1 max-w-sm">{error}</p>
              {onRetry && (
                <button onClick={onRetry} className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-xs font-medium hover:bg-[#007a36]">
                  <RefreshCw className="w-3.5 h-3.5" /> Try again
                </button>
              )}
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-16 flex flex-col items-center justify-center text-center px-6">
              <div className="w-12 h-12 rounded-full bg-slate-50 flex items-center justify-center mb-3">
                <Inbox className="w-6 h-6 text-slate-300" />
              </div>
              <p className="text-sm font-medium text-slate-900">{emptyTitle}</p>
              <p className="text-xs text-slate-500 mt-1 max-w-sm">{emptyMessage}</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-100">
                  {columns.map((col) => (
                    <th key={col.key} className="px-4 py-2.5 font-medium">{col.label}</th>
                  ))}
                  {actions && <th className="px-4 py-2.5 text-right font-medium">Action</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {filtered.map((row) => (
                  <tr key={row.id ?? `${row.employee_id}-${row.scheduled_date ?? row.created_at ?? Math.random()}`} className="hover:bg-slate-50/60">
                    {columns.map((col) => (
                      <td key={col.key} className="px-4 py-3 text-slate-700 whitespace-nowrap">
                        {col.render ? col.render(row) : String(row[col.key] ?? '—')}
                      </td>
                    ))}
                    {actions && (
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1.5">{actions(row)}</div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-100 flex items-center justify-between">
          <span className="text-xs text-slate-500">
            {loading ? 'Loading…' : error ? 'Load failed' : `${filtered.length} of ${rows.length} record${rows.length === 1 ? '' : 's'}`}
          </span>
          <span className="text-xs text-slate-400">Drilled from the same dataset as the dashboard count</span>
        </div>
      </div>
    </div>
  )
}
