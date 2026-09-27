// The result of an availability check. Everything shown here is the server's
// own verdict and its own wording - this component adds no leave arithmetic and
// no opinion of its own.
import React from 'react'
import { CheckCircle2, AlertTriangle, XCircle, CalendarClock } from 'lucide-react'
import { formatLeaveRange } from '../../services/leavePlannerService'

const VERDICT = {
  AVAILABLE: {
    icon: CheckCircle2, tone: 'text-emerald-700', bg: 'bg-emerald-50', label: 'Available',
  },
  WARNING: {
    icon: AlertTriangle, tone: 'text-amber-700', bg: 'bg-amber-50', label: 'Available with warnings',
  },
  CONFLICT: {
    icon: XCircle, tone: 'text-red-700', bg: 'bg-red-50', label: 'Conflict',
  },
}

export default function AvailabilityResult({ result, onAdopt }) {
  const meta = VERDICT[result.verdict] || {
    icon: AlertTriangle, tone: 'text-slate-700', bg: 'bg-slate-50', label: result.verdict,
  }
  const Icon = meta.icon

  return (
    <div className={`rounded-lg border border-slate-200 p-5 ${meta.bg} space-y-4`}>
      <div className="flex flex-wrap items-center gap-2">
        <Icon className={`w-5 h-5 ${meta.tone}`} />
        <p className={`font-semibold ${meta.tone}`}>{meta.label}</p>
        <span className="text-sm text-slate-600">
          {formatLeaveRange(result.start, result.end)} · {result.working_days} working day(s)
        </span>
      </div>

      {result.conflicts?.length > 0 && (
        <ul className="space-y-1.5">
          {result.conflicts.map((c, i) => (
            <li key={i} className="text-sm text-slate-800">
              <span className="font-medium">{c.rule || c.code}</span>: {c.message}
            </li>
          ))}
        </ul>
      )}

      {result.warnings?.length > 0 && (
        <ul className="space-y-1.5">
          {result.warnings.map((w, i) => (
            <li key={i} className="text-sm text-amber-800">{w.message}</li>
          ))}
        </ul>
      )}

      {result.alternatives?.length > 0 && (
        <section>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
            <CalendarClock className="w-4 h-4" />Suggested alternatives
          </h3>
          <ul className="mt-2 space-y-2">
            {result.alternatives.map((a) => (
              <li key={a.start} className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-slate-900">
                    {formatLeaveRange(a.start, a.end)}
                    <span className="ml-2 text-xs text-slate-500">
                      {a.working_days} working days
                    </span>
                  </span>
                  <button onClick={() => onAdopt(a)}
                    className="text-xs font-medium text-[#009944] hover:underline">
                    Use these dates
                  </button>
                </div>
                <p className="mt-1 text-xs text-slate-500">{a.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
