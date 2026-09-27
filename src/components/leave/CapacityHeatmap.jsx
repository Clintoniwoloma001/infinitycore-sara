// Capacity heatmap (section 18): "1 / 3" per branch per day, so HR can see
// staffing pressure at a glance.
//
// A day with NO configured capacity rule is rendered as "not configured"
// rather than as 0/0, so a missing rule is never displayed as a breach.
import React, { useMemo, useState } from 'react'
import { EmptyState } from '../PageStates'
import { Info } from 'lucide-react'

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
      {/* Says what the table IS, and what "Not configured" means, so nobody
          reads an unconfigured branch as a staffing breach. */}
      <div className="flex gap-2.5 rounded-lg border border-sky-100 bg-sky-50/70 p-3">
        <Info className="w-4 h-4 shrink-0 mt-0.5 text-sky-700" />
        <p className="text-xs leading-relaxed text-sky-900">
          Daily headcount against the capacity limit configured for this branch.
          <strong className="font-semibold"> &ldquo;Not configured&rdquo;</strong> means no
          capacity limit has been set for this branch yet &mdash; it is
          <em> not</em> a breach, and no warning is raised for it. Set a limit under the
          <strong className="font-semibold"> Capacity rules</strong> tab to start tracking
          pressure. <span className="text-sky-700">On leave</span> counts approved leave;
          <span className="text-sky-700"> Planned</span> counts booked-but-not-yet-requested
          dates, so you can see coming coverage early.
        </p>
      </div>

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
        {/* Numbers are right-aligned and tabular so the columns line up as a
            column rather than drifting with the content. */}
        <table className="min-w-full text-xs">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-semibold">Date</th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">On leave</th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">Planned</th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">Headcount</th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">Capacity</th>
              <th scope="col" className="px-3 py-2 text-left font-semibold">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {days.map((d) => {
              const r = byDay.get(d)
              const weekend = [0, 6].includes(new Date(`${d}T00:00:00`).getDay())
              if (weekend && !r) return null
              const onLeave = r?.on_leave_count ?? 0
              const booked = r?.booked_count ?? 0
              const unconfigured = r?.configured_capacity == null
              return (
                <tr key={d} className={r?.is_conflict ? 'bg-red-50' : ''}>
                  <th scope="row"
                    className="px-3 py-2 text-left font-normal text-slate-700 whitespace-nowrap">
                    {new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
                      day: 'numeric', month: 'short', weekday: 'short',
                    })}
                  </th>
                  <td className="px-3 py-2 text-right tabular-nums font-medium text-slate-900">
                    {onLeave}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                    {booked}
                    {booked > 0 && (
                      <span className="ml-1 text-[10px] text-sky-700">booked</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                    {r?.headcount ?? 0}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                    {unconfigured
                      ? <span className="text-slate-400">Not configured</span>
                      : r.configured_capacity}
                  </td>
                  <td className="px-3 py-2 text-left">
                    {r?.is_conflict
                      ? <span className="font-medium text-red-700">Conflict</span>
                      : unconfigured
                        ? <span className="text-slate-400">&mdash;</span>
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
