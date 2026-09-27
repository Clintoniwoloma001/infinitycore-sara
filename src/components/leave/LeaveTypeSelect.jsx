// One dropdown, one source of truth. The option list is the SAME leave-type
// catalogue the Leave Rules and balances screens already use, so a type can
// never be spelled one way in the planner and another way in the balance sheet.
import React from 'react'
import { LEAVE_TYPE_LABELS } from '../../services/leaveRulesService'

export const LEAVE_TYPES = Object.keys(LEAVE_TYPE_LABELS)

/**
 * @param value        currently selected leave type ('' for "Any")
 * @param onChange     receives the leave type, or '' for "Any"
 * @param allowAny     show an "Any" option (filter contexts only)
 */
export default function LeaveTypeSelect({
  value, onChange, allowAny = false, className = '', id,
}) {
  return (
    <select
      id={id}
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      className={className || 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm'}
    >
      {allowAny && <option value="">Any</option>}
      {LEAVE_TYPES.map((t) => (
        <option key={t} value={t}>{LEAVE_TYPE_LABELS[t]}</option>
      ))}
    </select>
  )
}
