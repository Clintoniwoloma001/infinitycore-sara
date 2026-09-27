// The planner's primary view: employees down the side, dates across the top.
// State is conveyed by colour AND an icon AND a text label, never colour alone,
// so it stays readable for colour-blind users and in print.
import React, { useMemo, useState } from 'react'
import { PLANNER_STATE, formatLeaveRange } from '../../services/leavePlannerService'
import { TimelineRow } from './TimelineRow'

export default function PlannerTimeline({ entries, days }) {
  const [focus, setFocus] = useState(null)

  // Group entries by employee, preserving the server's ordering.
  const rows = useMemo(() => {
    const byEmployee = new Map()
    for (const e of entries) {
      if (!byEmployee.has(e.employee_id)) {
        byEmployee.set(e.employee_id, {
          employee_id: e.employee_id,
          full_name: e.full_name,
          employee_number: e.employee_number,
          position: e.position,
          branch_name: e.branch_name,
          leaves: [],
        })
      }
      byEmployee.get(e.employee_id).leaves.push(e)
    }
    return [...byEmployee.values()]
  }, [entries])

  if (!rows.length) return null

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3 print:hidden">
        {Object.entries(PLANNER_STATE).map(([key, meta]) => (
          <span key={key}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${meta.chip}`}>
            <span aria-hidden="true">{meta.icon}</span>{meta.label}
          </span>
        ))}
      </div>

      {/* Desktop: a scrollable grid. */}
      <div className="hidden lg:block overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="text-sm min-w-full">
          <thead>
            <tr className="bg-slate-50">
              <th className="sticky left-0 z-10 bg-slate-50 px-4 py-2 text-left font-medium text-slate-600 min-w-[200px]">
                Employee
              </th>
              {days.map((d) => (
                <th key={d} className="px-1 py-2 text-center font-normal text-[10px] text-slate-500 w-8">
                  {new Date(`${d}T00:00:00`).getDate()}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr key={row.employee_id} className="hover:bg-slate-50">
                <td className="sticky left-0 z-10 bg-white px-4 py-2">
                  <p className="font-medium text-slate-900">{row.full_name}</p>
                  <p className="text-xs text-slate-500">
                    {row.employee_number || '—'} · {row.branch_name || 'No branch'}
                  </p>
                </td>
                <td className="px-1 py-2">
                  <TimelineRow days={days} leaves={row.leaves} onFocus={setFocus} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Small screens: per-employee agenda cards, not a squeezed calendar. */}
      <AgendaCards rows={rows} />

      {focus && <LeaveDetail leave={focus} onClose={() => setFocus(null)} />}
    </div>
  )
}

function AgendaCards({ rows }) {
  return (
    <div className="lg:hidden space-y-3">
      {rows.map((row) => (
        <div key={row.employee_id} className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="font-medium text-slate-900">{row.full_name}</p>
          <p className="text-xs text-slate-500">
            {row.employee_number || '—'} · {row.position || '—'} · {row.branch_name || 'No branch'}
          </p>
          <ul className="mt-2 space-y-1.5">
            {row.leaves.map((l) => {
              const meta = PLANNER_STATE[l.planner_state] || PLANNER_STATE.completed
              return (
                <li key={l.request_id || `${l.start_date}-${l.end_date}`}
                  className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-slate-700">
                    {formatLeaveRange(l.start_date, l.end_date)}
                    <span className="text-slate-400"> · {l.leave_type}</span>
                  </span>
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${meta.chip}`}>
                    <span aria-hidden="true">{meta.icon}</span>{meta.label}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}

function LeaveDetail({ leave, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
        <p className="font-semibold text-slate-900">{leave.full_name}</p>
        <p className="text-sm text-slate-600 mt-1">
          {formatLeaveRange(leave.start_date, leave.end_date)}
        </p>
        <dl className="mt-3 space-y-1 text-sm">
          <Row k="Leave type" v={leave.leave_type} />
          <Row k="Status" v={leave.status} />
          <Row k="Working days" v={leave.working_days ?? '—'} />
          <Row k="Department" v={leave.department || '—'} />
        </dl>
        <button onClick={onClose}
          className="mt-4 w-full rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white hover:bg-[#007a36]">
          Close
        </button>
      </div>
    </div>
  )
}

function Row({ k, v }) {
  return (
    <div className="flex justify-between">
      <dt className="text-slate-500">{k}</dt>
      <dd className="text-slate-900 capitalize">{v}</dd>
    </div>
  )
}
