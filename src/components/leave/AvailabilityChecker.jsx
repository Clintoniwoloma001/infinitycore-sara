// Smart scheduling (sections 9, 10).
//
// This NEVER changes an employee's dates. It reports the server's verdict, the
// server's conflicts with their explanations, and the server's deterministic
// alternatives with the reason each one was suggested.
import React, { useEffect, useState } from 'react'
import { CheckCircle2, AlertTriangle, XCircle, CalendarClock } from 'lucide-react'
import { leavePlannerService, formatLeaveRange, isoToday } from '../../services/leavePlannerService'
import { supabase } from '../../supabaseClient'
import ResultPanel from './AvailabilityResult'
import LeaveTypeSelect from './LeaveTypeSelect'

const field = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm'

export default function AvailabilityChecker({ onChecked }) {
  const [employees, setEmployees] = useState([])
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState([])
  const [leaveType, setLeaveType] = useState('annual')
  const [start, setStart] = useState(isoToday())
  const [end, setEnd] = useState(isoToday())
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    ;(async () => {
      const { data, error: e } = await supabase
        .from('employees')
        .select('id, full_name, employee_number, department')
        .order('full_name')
        .limit(300)
      if (!e) setEmployees(data || [])
    })()
  }, [])

  const matches = employees
    .filter((e) => {
      const t = search.trim().toLowerCase()
      if (!t) return false
      return [e.full_name, e.employee_number, e.department]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(t))
    })
    .slice(0, 8)

  const check = async () => {
    setBusy(true); setError(null); setResult(null)
    try {
      setResult(await leavePlannerService.checkAvailability({
        employeeIds: selected, leaveType, start, end,
      }))
      onChecked?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  // Adopting an alternative only fills the date fields. It still submits
  // nothing: approving leave stays with the existing request workflow, and an
  // approved record is never silently modified from this screen.
  const adopt = (alt) => { setStart(alt.start); setEnd(alt.end) }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
        <div>
          <p className="text-sm font-medium text-slate-700">Employee(s)</p>
          {selected.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {selected.map((id) => {
                const e = employees.find((x) => x.id === id)
                return (
                  <span key={id}
                    className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700">
                    {e?.full_name || 'Employee'}
                    <button onClick={() => setSelected((s) => s.filter((x) => x !== id))}
                      aria-label={`Remove ${e?.full_name}`}
                      className="text-slate-400 hover:text-slate-700">×</button>
                  </span>
                )
              })}
            </div>
          )}
          <input type="search" value={search} placeholder="Search employees"
            onChange={(e) => setSearch(e.target.value)}
            className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          {matches.length > 0 && (
            <ul className="mt-1 rounded-lg border border-slate-200 divide-y divide-slate-100 max-h-48 overflow-y-auto">
              {matches.map((e) => (
                <li key={e.id}>
                  <button onClick={() => {
                    setSelected((s) => [...new Set([...s, e.id])])
                    setSearch('')
                  }} className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50">
                    <span className="font-medium text-slate-900">{e.full_name}</span>
                    <span className="text-xs text-slate-500"> · {e.employee_number || '—'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Leave type</span>
            {/* The same catalogue the rest of the app uses, so the check runs
                against a real leave type rather than whatever was typed. */}
            <LeaveTypeSelect value={leaveType} onChange={setLeaveType} className={field} />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">From</span>
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className={field} />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">To</span>
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className={field} />
          </label>
        </div>

        <button onClick={check} disabled={busy || !selected.length}
          className="rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white hover:bg-[#007a36] disabled:opacity-50">
          {busy ? 'Checking...' : 'Check availability'}
        </button>
        {selected.length === 0 && (
          <p className="text-xs text-slate-500">Select at least one employee to check.</p>
        )}
        {error && <p className="text-sm text-amber-700">{error}</p>}
      </div>

      {result && <ResultPanel result={result} onAdopt={adopt} />}
    </div>
  )
}
