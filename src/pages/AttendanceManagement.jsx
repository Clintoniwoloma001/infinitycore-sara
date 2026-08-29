import React, { useEffect, useState } from 'react'
import { Loader2, Pencil, RefreshCw, X } from 'lucide-react'
import { attendanceService } from '../services/attendanceService'
import { EmptyState, ErrorState, LoadingState } from '../components/PageStates'
import { date, status } from './hrShared'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

export default function AttendanceManagement() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [dayFilter, setDayFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [correcting, setCorrecting] = useState(null)
  const [form, setForm] = useState({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState({ kind: '', text: '' })

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await attendanceService.listAll()
      setRows(data)
    } catch (e) {
      setError(e?.message || 'Unable to load attendance records')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const filtered = rows.filter((r) => {
    const dayOk = !dayFilter || String(r.attendance_date) === dayFilter
    const statusOk = !statusFilter || r.status === statusFilter
    return dayOk && statusOk
  })

  const openCorrection = (row) => {
    setCorrecting(row)
    setNotice({ kind: '', text: '' })
    setForm({
      clock_in: row.clock_in ? row.clock_in.slice(0, 16) : '',
      clock_out: row.clock_out ? row.clock_out.slice(0, 16) : '',
      reason: '',
    })
  }

  const submitCorrection = async () => {
    setBusy(true)
    setNotice({ kind: '', text: '' })
    try {
      await attendanceService.correct({
        id: correcting.id,
        clockIn: new Date(form.clock_in).toISOString(),
        clockOut: form.clock_out ? new Date(form.clock_out).toISOString() : null,
        reason: form.reason,
      })
      setNotice({ kind: 'ok', text: `Attendance for ${correcting.employees?.full_name || correcting.employee_id} corrected.` })
      setCorrecting(null)
      await load()
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Correction failed' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Attendance Management</h2>
          <p className="text-sm text-slate-500 mt-1">Oversight of team attendance and corrections.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <input type="date" value={dayFilter} onChange={(e) => setDayFilter(e.target.value)} className={inputCls} />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputCls}>
            <option value="">All statuses</option>
            {['present', 'absent', 'late', 'early_exit', 'on_leave', 'incomplete', 'corrected'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button onClick={load} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>
      </div>

      {notice.text && <div className={`mb-5 rounded-lg border p-4 text-sm ${notice.kind === 'error' ? 'border-rose-200 bg-rose-50 text-rose-900' : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`}>{notice.text}</div>}
      {error && <ErrorState message={error} />}
      {loading && <LoadingState label="Loading attendance records..." />}
      {!loading && !error && filtered.length === 0 && <EmptyState title="No matching attendance records" description="Adjust the filters or check back later." />}
      {!loading && !error && filtered.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                <th className="px-6 py-3 font-medium whitespace-nowrap">Employee</th>
                <th className="px-6 py-3 font-medium whitespace-nowrap">Date</th>
                <th className="px-6 py-3 font-medium whitespace-nowrap">Clock In</th>
                <th className="px-6 py-3 font-medium whitespace-nowrap">Clock Out</th>
                <th className="px-6 py-3 font-medium whitespace-nowrap">Hours</th>
                <th className="px-6 py-3 font-medium whitespace-nowrap">Status</th>
                <th className="px-6 py-3 font-medium whitespace-nowrap text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-6 py-3">
                    <div className="font-medium text-slate-900">{r.employees?.full_name || r.employee_id}</div>
                    {r.employees?.department && <div className="text-xs text-slate-400">{r.employees.department} · {r.employees.position || ''}</div>}
                  </td>
                  <td className="px-6 py-3 text-slate-600">{date(r.attendance_date)}</td>
                  <td className="px-6 py-3 text-slate-600">{r.clock_in ? new Date(r.clock_in).toLocaleTimeString() : '—'}</td>
                  <td className="px-6 py-3 text-slate-600">{r.clock_out ? new Date(r.clock_out).toLocaleTimeString() : '—'}</td>
                  <td className="px-6 py-3 text-slate-600">{r.work_hours || '—'}</td>
                  <td className="px-6 py-3">{status(r.status)}</td>
                  <td className="px-6 py-3 text-right">
                    <button onClick={() => openCorrection(r)} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-300 text-slate-600 text-xs hover:bg-slate-100">
                      <Pencil className="w-3.5 h-3.5" /> Correct
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {correcting && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Correct attendance</h3>
                <p className="text-sm text-slate-500">{correcting.employees?.full_name} — {date(correcting.attendance_date)}</p>
              </div>
              <button onClick={() => setCorrecting(null)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className={labelCls}>Clock In (local)</label>
                <input type="datetime-local" className={inputCls} value={form.clock_in} onChange={(e) => setForm({ ...form, clock_in: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>Clock Out (optional)</label>
                <input type="datetime-local" className={inputCls} value={form.clock_out} onChange={(e) => setForm({ ...form, clock_out: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>Reason</label>
                <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="e.g. Missed clock-in due to staff meeting" />
              </div>
              {notice.text && <p className="text-sm text-rose-600">{notice.text}</p>}
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => setCorrecting(null)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                <button onClick={submitCorrection} disabled={busy || !form.clock_in} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Save correction
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}