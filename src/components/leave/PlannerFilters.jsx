// Every filter here narrows the SERVER query. None of them is decorative, and
// none is left un-wired.
import React from 'react'

const field = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm'
const label = 'block text-sm'

export default function PlannerFilters({
  ranges, rangeId, from, to, filters,
  onRange, onFrom, onTo, onFilters, onClear,
}) {
  const set = (key) => (e) => onFilters((f) => ({ ...f, [key]: e.target.value }))

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 rounded-lg border border-slate-200 bg-white p-4 print:hidden">
      <label className={label}>
        <span className="font-medium text-slate-700">Range</span>
        <select className={field} value={rangeId}
          onChange={(e) => onRange(ranges.find((r) => r.id === e.target.value))}>
          {ranges.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
      </label>

      <label className={label}>
        <span className="font-medium text-slate-700">From</span>
        <input type="date" className={field} value={from} onChange={(e) => onFrom(e.target.value)} />
      </label>

      <label className={label}>
        <span className="font-medium text-slate-700">To</span>
        <input type="date" className={field} value={to} onChange={(e) => onTo(e.target.value)} />
      </label>

      <label className={label}>
        <span className="font-medium text-slate-700">Leave type</span>
        <input type="text" className={field} value={filters.leaveType}
          placeholder="e.g. annual" onChange={set('leaveType')} />
      </label>

      <label className={label}>
        <span className="font-medium text-slate-700">Department</span>
        <input type="text" className={field} value={filters.department}
          placeholder="Any" onChange={set('department')} />
      </label>

      <label className={label}>
        <span className="font-medium text-slate-700">Role</span>
        <input type="text" className={field} value={filters.role}
          placeholder="Any" onChange={set('role')} />
      </label>

      <label className={label}>
        <span className="font-medium text-slate-700">Status</span>
        <select className={field} value={filters.status} onChange={set('status')}>
          <option value="">All</option>
          <option value="approved">Approved</option>
          <option value="pending">Pending</option>
        </select>
      </label>

      <div className="flex items-end">
        <button onClick={onClear}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">
          Clear filters
        </button>
      </div>
    </div>
  )
}
