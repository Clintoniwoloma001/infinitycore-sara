// Employee picker for the history tab. Search by name, employee number, email
// or position, straight from the existing employees table.
import React, { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { supabase } from '../../supabaseClient'
import HistoryDrawer from './HistoryDrawer'
import { LoadingState, EmptyState, ErrorState } from '../PageStates'

export default function MovementHistory() {
  const [employees, setEmployees] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const { data, error: e } = await supabase
          .from('employees')
          .select('id, full_name, employee_number, position, department, branch_id, branches(branch_name)')
          .order('full_name')
          .limit(500)
        if (e) throw e
        if (alive) setEmployees(data || [])
      } catch (err) {
        if (alive) setError(err.message)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [])

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return employees.slice(0, 25)
    return employees.filter((e) =>
      [e.full_name, e.employee_number, e.position, e.department, e.branch_id]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(term))
    ).slice(0, 25)
  }, [employees, q])

  if (loading) return <LoadingState label="Loading employees..." />
  if (error) return <ErrorState title="Unable to load employees" message={error} />

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, employee number, designation or department"
          className="w-full rounded-lg border border-slate-300 pl-9 pr-3 py-2.5 text-sm"
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="No employees match" description="Try a different search term." />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((e) => (
            <button
              key={e.id}
              onClick={() => setSelected({
                employee_id: e.id,
                full_name: e.full_name,
                employee_number: e.employee_number,
                position: e.position,
                branch_name: e.branches?.branch_name,
              })}
              className="rounded-lg border border-slate-200 bg-white p-3 text-left hover:border-[#009944] transition-colors"
            >
              <p className="font-medium text-slate-900">{e.full_name}</p>
              <p className="text-xs text-slate-500">
                {e.employee_number || '—'} · {e.position || '—'}
              </p>
              <p className="text-xs text-slate-400">
                {e.branches?.branch_name || 'No branch'}
              </p>
            </button>
          ))}
        </div>
      )}

      {selected && <HistoryDrawer row={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
