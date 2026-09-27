// One cell per day, coloured by the state of the leave covering that day.
// Weekends are visibly different so a leave bar never appears to cover a day
// the platform does not count as a working day.
import React from 'react'
import { PLANNER_STATE } from '../../services/leavePlannerService'

export function TimelineRow({ days, leaves, onFocus }) {
  return (
    <div className="flex gap-0.5" style={{ minWidth: `${days.length * 34}px` }}>
      {days.map((d) => {
        const weekend = [0, 6].includes(new Date(`${d}T00:00:00`).getDay())
        const leave = leaves.find((l) =>
          l.start_date <= d && (l.end_date || l.start_date) >= d)

        if (!leave) {
          return (
            <div key={d} title={d}
              className={`h-7 flex-1 rounded-sm ${weekend ? 'bg-slate-100' : 'bg-slate-50'}`} />
          )
        }
        const meta = PLANNER_STATE[leave.planner_state] || PLANNER_STATE.completed
        return (
          <button key={d}
            onClick={() => onFocus({ ...leave, full_name: leave.full_name })}
            title={`${d} — ${meta.label}`}
            className={`h-7 flex-1 rounded-sm ${meta.chip} text-[9px] leading-none flex items-center justify-center`}>
            <span aria-hidden="true">{meta.icon}</span>
          </button>
        )
      })}
    </div>
  )
}

export default TimelineRow
