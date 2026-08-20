import React, { useEffect, useState } from 'react'
import { Pencil, Check, X } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { logAction } from '../services/supabaseService'
import {
  LEAVE_TYPE_LABELS,
  currentYear,
  listAllBalances,
  adjustBalance,
} from '../services/leaveBalanceService'

export default function LeaveBalances() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState(null) // row id
  const [draft, setDraft] = useState({ entitled_days: '', used_days: '' })
  const { name: userName } = useAuth()

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setRows(await listAllBalances(currentYear()))
    } catch (e) {
      setError(e?.message || 'Failed to load balances')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const startEdit = (r) => {
    setEditing(r.id)
    setDraft({ entitled_days: r.entitled_days, used_days: r.used_days })
  }

  const save = async (r) => {
    try {
      await adjustBalance(r.id, { entitled_days: Number(draft.entitled_days), used_days: Number(draft.used_days) })
      await logAction({ action: 'leave_balance_adjusted', entityType: 'LeaveBalance', entityId: r.id, details: `${r.employee_name} ${r.leave_type} → entitled ${draft.entitled_days}, used ${draft.used_days}`, userName })
      setEditing(null)
      load()
    } catch (e) {
      alert(e?.message || 'Failed to save adjustment.')
    }
  }

  // Group by employee for a readable table.
  const byEmployee = rows.reduce((acc, r) => {
    acc[r.employee_id] = acc[r.employee_id] || { name: r.employee_name || r.employee_id, balances: {} }
    acc[r.employee_id].balances[r.leave_type] = r
    return acc
  }, {})

  const types = Object.keys(LEAVE_TYPE_LABELS).filter((t) => t !== 'unpaid')

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold text-slate-900">Leave Balances</h2>
        <p className="text-sm text-slate-500 mt-1">Company-wide entitlements for {currentYear()} — corrections logged to audit trail</p>
      </div>

      {error && <div className="mb-6 rounded-xl border border-rose-200 bg-rose-50 text-rose-700 text-sm p-4">{error}</div>}

      {loading ? (
        <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-slate-200 border-t-[#009944] rounded-full animate-spin" /></div>
      ) : Object.keys(byEmployee).length === 0 ? (
        <div className="text-center py-16 text-slate-400">No leave balances found for {currentYear()}. Run the yearly reset function in Supabase to seed them.</div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                <th className="px-6 py-3 font-medium">Employee</th>
                {types.map((t) => <th key={t} className="px-4 py-3 font-medium text-center">{LEAVE_TYPE_LABELS[t]}</th>)}
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {Object.entries(byEmployee).map(([empId, emp]) => (
                <tr key={empId} className="hover:bg-slate-50">
                  <td className="px-6 py-3 font-medium text-slate-800">{emp.name}</td>
                  {types.map((t) => {
                    const r = emp.balances[t]
                    if (!r) return <td key={t} className="px-4 py-3 text-center text-slate-300">—</td>
                    const isEditing = editing === r.id
                    const remaining = Number(r.entitled_days) - Number(r.used_days)
                    return (
                      <td key={t} className="px-4 py-3 text-center">
                        {isEditing ? (
                          <div className="flex items-center justify-center gap-1">
                            <input type="number" value={draft.entitled_days} onChange={(e) => setDraft({ ...draft, entitled_days: e.target.value })} className="w-14 h-8 text-center rounded border border-slate-300" />
                            <span className="text-slate-300">/</span>
                            <input type="number" value={draft.used_days} onChange={(e) => setDraft({ ...draft, used_days: e.target.value })} className="w-14 h-8 text-center rounded border border-slate-300" />
                            <button onClick={() => save(r)} className="text-emerald-600 p-1"><Check className="w-4 h-4" /></button>
                            <button onClick={() => setEditing(null)} className="text-slate-400 p-1"><X className="w-4 h-4" /></button>
                          </div>
                        ) : (
                          <button onClick={() => startEdit(r)} className="group inline-flex items-center gap-1.5 text-slate-700 hover:text-[#009944]">
                            <span>{remaining}<span className="text-slate-400">/{r.entitled_days}</span></span>
                            <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-100" />
                          </button>
                        )}
                      </td>
                    )
                  })}
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
