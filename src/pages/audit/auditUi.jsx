// ============================================================================
// Audit workspaces - shared UI primitives
// ============================================================================
// The Audit Command Centre, the Head of Department tab and the shared Audit
// Workspace all render the same shapes derived from the same server payloads,
// so the KPI card, the SLA chip and the table frame live here once.
//
// These are PRESENTATIONAL only. No SLA state, countdown, overdue flag or
// permission decision is made in this file - the server computed all of it and
// the components render what they were given.
import React from 'react'
import { Loader2 } from 'lucide-react'
import { SLA_STATE } from '../../services/auditService'

/** A restrained KPI card: value in reading order, tone only for alarms. */
export function KpiCard({ label, value, hint, tone = 'slate', icon: Icon }) {
  const tones = {
    slate: 'text-slate-900',
    red: 'text-red-600',
    amber: 'text-amber-600',
    green: 'text-emerald-600',
  }
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs text-slate-500">{label}</div>
        {Icon && <Icon className="h-4 w-4 shrink-0 text-slate-300" aria-hidden="true" />}
      </div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tones[tone] || tones.slate}`}>
        {value ?? 0}
      </div>
      {hint && <div className="mt-0.5 text-xs text-slate-400">{hint}</div>}
    </div>
  )
}

/** SLA chip. `slaState` arrives pre-computed from the server. */
export function SlaChip({ slaState, daysUntilDue }) {
  const s = SLA_STATE[slaState] || { label: slaState || '—', chip: 'bg-slate-100 text-slate-600' }
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${s.chip}`}>
      {s.label}
      {daysUntilDue != null && (slaState === 'due_soon' || slaState === 'upcoming') && (
        <span className="ml-1 tabular-nums opacity-70">{daysUntilDue}d</span>
      )}
    </span>
  )
}

/** A plain chip for any { label, chip } status map entry. */
export function StatusChip({ map, value }) {
  const s = map?.[value] || { label: value || '—', chip: 'bg-slate-100 text-slate-600' }
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${s.chip}`}>{s.label}</span>
  )
}

/** A titled panel with an optional action slot. */
export function SectionCard({ title, description, action, children }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
        </div>
        {action}
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}

/** Horizontal completion meter. `pct` is the server's number, never re-derived. */
export function Meter({ pct, tone = 'green' }) {
  const tones = { green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500' }
  const value = pct == null ? null : Math.max(0, Math.min(100, Number(pct)))
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100" title={value == null ? 'Not measured' : `${value}%`}>
      <div
        className={`h-full rounded-full ${tones[tone] || tones.green}`}
        style={{ width: value == null ? '0%' : `${value}%` }}
      />
    </div>
  )
}

/** Table frame: header cells, empty state and loading state in one place.
 *  Rows are supplied as children (`<tr>` elements) so a caller can render any
 *  cell layout without this component knowing about the data. */
export function DataTable({ columns, rowCount = 0, loading, empty = 'Nothing to show', children }) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" />Loading...
      </div>
    )
  }
  if (rowCount === 0) {
    return <p className="py-6 text-sm text-slate-500">{empty}</p>
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={`px-3 py-2 font-medium ${c.className || ''}`}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  )
}
