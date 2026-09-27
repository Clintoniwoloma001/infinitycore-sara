// Quick overview cards. Each one is a real filter: clicking it narrows the
// planner query, it is not a decorative statistic. Values come from the same
// aggregated read that renders the timeline, so a card can never disagree with
// the rows beneath it.
import React from 'react'

export default function OverviewCards({ summary, conflictCount, statusFilter, onStatus }) {
  const cards = [
    { label: 'Currently on leave', value: summary.currently_on_leave, status: '' },
    { label: 'Upcoming this week', value: summary.upcoming_this_week, status: 'approved' },
    { label: 'Upcoming this month', value: summary.upcoming_this_month, status: 'approved' },
    { label: 'Pending requests', value: summary.pending_requests, status: 'pending' },
  ]

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 print:hidden">
      {cards.map((c) => {
        const active = statusFilter === c.status && c.status !== ''
        return (
          <button
            key={c.label}
            onClick={() => onStatus(c.status)}
            className={`rounded-lg border p-3 text-left transition-colors ${active
              ? 'border-[#009944] bg-emerald-50'
              : 'border-slate-200 bg-white hover:bg-slate-50'}`}
          >
            <p className="text-xs text-slate-500">{c.label}</p>
            <p className="text-2xl font-semibold text-slate-900 mt-0.5">
              {c.value ?? 0}
            </p>
          </button>
        )
      })}

      <div className={`rounded-lg border p-3 ${conflictCount > 0
        ? 'border-red-200 bg-red-50'
        : 'border-slate-200 bg-white'}`}>
        <p className="text-xs text-slate-500">Capacity conflicts</p>
        <p className={`text-2xl font-semibold mt-0.5 ${conflictCount > 0
          ? 'text-red-700' : 'text-slate-900'}`}>
          {conflictCount}
        </p>
      </div>
    </div>
  )
}
