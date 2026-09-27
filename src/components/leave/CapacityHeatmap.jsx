// Capacity heatmap (section 18): "1 / 3" per branch per day, so HR can see
// staffing pressure at a glance.
//
// A day with NO configured capacity rule is rendered as "not configured"
// rather than as 0/0, so a missing rule is never displayed as a breach.
import React, { useMemo, useState } from 'react'
import { EmptyState } from '../PageStates'

export default function CapacityHeatmap({ capacity, days }) {
  const [branch, setBranch] = useState('')

  const branches = useMemo(() => {
    const seen = new Map()
    for (const c of capacity || []) {
      if (!seen.has(c.branch_id)) seen.set(c.branch_id, c.branch_name)
    }
    return [...seen.entries()]
  }, [capacity])

  const activeBranch = branch || branches[0]?.[0] || ''
  const rows = useMemo(
    () => (capacity || []).filter((c) => c.branch_id === activeBranch),
    [capacity, activeBranch],
  )
  const byDay = useMemo(() => {
    const m = new Map()
    for (const r of rows) m.set(r.day, r)
    return m
  }, [rows])

  if (!capacity?.length) {
    return (
      <EmptyState
        title="No capacity data"
        description="Capacity is reported per branch. Configure a branch capacity rule to see pressure here."
      />
    )
  }

  return (
    <div className="space-y-4">
      <label className="block text-sm max-w-xs">
        <span className="font-medium text-slate-700">Branch</span>
        <select value={activeBranch}
          onChange={(e) => setBranch(e.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
          {branches.map(([id, name]) => (
            <option key={id} value={id}>{name || 'Unnamed branch'}</option>
          ))}
        </select>
      </label>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="min-w-full text-xs">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Date</th>
              <th className="px-3 py-2 font-medium">On leave</th>
              <th className="px-3 py-2 font-medium">Headcount</th>
              <th className="px-3 py-2 font-medium">Capacity</th>
              <th className="px-3 py-2 text-left font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {days.map((d) => {
              const r = byDay.get(d)
              const weekend = [0, 6].includes(new Date(`${d}T00:00:00`).getDay())
              if (weekend && !r) return null
              return (
                <tr key={d} className={r?.is_conflict ? 'bg-red-50' : ''}>
                  <td className="px-3 py-1.5 text-slate-700">
                    {new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
                      day: 'numeric', month: 'short',
                    })}
                  </td>
                  <td className="px-3 py-1.5 font-medium text-slate-900">
                    {r?.on_leave_count ?? 0}
                  </td>
                  <td className="px-3 py-1.5 text-slate-600">{r?.headcount ?? 0}</td>
                  <td className="px-3 py-1.5 text-slate-600">
                    {r?.configured_capacity == null ? 'Not configured' : r.configured_capacity}
                  </td>
                  <td className="px-3 py-1.5">
                    {r?.is_conflict
                      ? <span className="font-medium text-red-700">Conflict</span>
                      : r?.configured_capacity == null
                        ? <span className="text-slate-400">—</span>
                        : <span className="text-emerald-700">Within capacity</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
