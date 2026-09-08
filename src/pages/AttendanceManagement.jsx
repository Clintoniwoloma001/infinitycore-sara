import React, { useEffect, useState } from 'react'
import { Loader2, Pencil, RefreshCw, X, Check, Ban, AlertCircle, Clock3, Settings as SettingsIcon } from 'lucide-react'
import { attendanceService } from '../services/attendanceService'
import { workManagementService } from '../services/workManagementService'
import { EmptyState, ErrorState, LoadingState } from '../components/PageStates'
import { date, status } from './hrShared'
import { StatusBadge } from '../lib/utils'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

export default function AttendanceManagement() {
  const [tab, setTab] = useState('records')
  const [notice, setNotice] = useState({ kind: '', text: '' })

  const tabs = [
    { id: 'records', label: 'Attendance Records' },
    { id: 'exceptions', label: 'Late Exceptions' },
    { id: 'issues', label: 'Attendance Issues' },
    { id: 'config', label: 'Configuration' },
  ]

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold text-slate-900">Attendance Management</h2>
        <p className="text-sm text-slate-500 mt-1">Oversight of team attendance, exceptions, issues, and configuration.</p>
      </div>

      {notice.text && (
        <div className={`mb-5 rounded-lg border p-4 text-sm ${notice.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900'}`}>
          {notice.text}
        </div>
      )}

      <div className="flex gap-2 mb-5 overflow-x-auto pb-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition ${tab === t.id ? 'bg-[#009944] text-white shadow-sm' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'records' && <RecordsTab setNotice={setNotice} />}
      {tab === 'exceptions' && <ExceptionsTab setNotice={setNotice} />}
      {tab === 'issues' && <IssuesTab setNotice={setNotice} />}
      {tab === 'config' && <ConfigTab setNotice={setNotice} />}
    </div>
  )
}

// ============================================================
// RECORDS TAB (existing functionality, enhanced)
// ============================================================
function RecordsTab({ setNotice }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [dayFilter, setDayFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [deptFilter, setDeptFilter] = useState('')
  const [correcting, setCorrecting] = useState(null)
  const [form, setForm] = useState({})
  const [busy, setBusy] = useState(false)

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
    const deptOk = !deptFilter || r.employees?.department === deptFilter
    return dayOk && statusOk && deptOk
  })

  const openCorrection = (row) => {
    setCorrecting(row)
    setForm({
      clock_in: row.clock_in ? row.clock_in.slice(0, 16) : '',
      clock_out: row.clock_out ? row.clock_out.slice(0, 16) : '',
      reason: '',
    })
  }

  const submitCorrection = async () => {
    setBusy(true)
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

  const today = new Date().toISOString().slice(0, 10)
  const todayRecords = rows.filter((r) => String(r.attendance_date) === today)
  const departments = [...new Set(rows.map((r) => r.employees?.department).filter(Boolean))]
  const summary = {
    present: todayRecords.filter((r) => r.status === 'present' || (r.clock_in && !r.clock_out)).length,
    late: todayRecords.filter((r) => r.status === 'late').length,
    absent: todayRecords.filter((r) => r.status === 'absent').length,
    onLeave: todayRecords.filter((r) => r.status === 'on_leave').length,
    notClockedIn: 0, // Would need total employee count
    total: todayRecords.length,
  }

  return (
    <div>
      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 mb-5">
        {[
          { label: 'Present', value: summary.present, color: 'text-emerald-600' },
          { label: 'Late', value: summary.late, color: 'text-amber-600' },
          { label: 'Absent', value: summary.absent, color: 'text-rose-600' },
          { label: 'On Leave', value: summary.onLeave, color: 'text-blue-600' },
          { label: 'Not Clocked In', value: summary.notClockedIn, color: 'text-slate-500' },
          { label: 'Total Today', value: summary.total, color: 'text-slate-900' },
        ].map((s) => (
          <div key={s.label} className="bg-white rounded-lg border border-slate-200 p-3">
            <div className={`text-xl font-bold ${s.color}`}>{s.value}</div>
            <div className="text-xs text-slate-500">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <input type="date" value={dayFilter} onChange={(e) => setDayFilter(e.target.value)} className="h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]">
          <option value="">All statuses</option>
          {['present', 'absent', 'late', 'early_exit', 'on_leave', 'incomplete', 'corrected'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} className="h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]">
          <option value="">All departments</option>
          {departments.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <button onClick={load} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {error && <ErrorState message={error} />}
      {loading && <LoadingState label="Loading attendance records..." />}
      {!loading && !error && filtered.length === 0 && <EmptyState title="No matching attendance records" description="Adjust the filters or check back later." />}
      {!loading && !error && filtered.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                <th className="px-6 py-3 font-medium whitespace-nowrap">Employee</th>
                <th className="px-6 py-3 font-medium whitespace-nowrap">Department</th>
                <th className="px-6 py-3 font-medium whitespace-nowrap">Date</th>
                <th className="px-6 py-3 font-medium whitespace-nowrap">Clock In</th>
                <th className="px-6 py-3 font-medium whitespace-nowrap">Clock Out</th>
                <th className="px-6 py-3 font-medium whitespace-nowrap">Duration</th>
                <th className="px-6 py-3 font-medium whitespace-nowrap">Status</th>
                <th className="px-6 py-3 font-medium whitespace-nowrap text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-6 py-3 font-medium text-slate-900">{r.employees?.full_name || r.employee_id}</td>
                  <td className="px-6 py-3 text-slate-500 text-xs">{r.employees?.department || '—'}</td>
                  <td className="px-6 py-3 text-slate-600">{date(r.attendance_date)}</td>
                  <td className="px-6 py-3 text-slate-600 tabular-nums">{r.clock_in ? new Date(r.clock_in).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                  <td className="px-6 py-3 text-slate-600 tabular-nums">{r.clock_out ? new Date(r.clock_out).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                  <td className="px-6 py-3 text-slate-600">{r.work_hours ? `${r.work_hours}h` : '—'}</td>
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
          <div className="bg-white rounded-xl w-full max-w-md p-6 shadow-xl">
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
                <label className={labelCls}>Reason (required for audit)</label>
                <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="e.g. Missed clock-in due to staff meeting" />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => setCorrecting(null)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                <button onClick={submitCorrection} disabled={busy || !form.clock_in || !form.reason} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
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

// ============================================================
// EXCEPTIONS TAB — Late arrival reasons
// ============================================================
function ExceptionsTab({ setNotice }) {
  const [exceptions, setExceptions] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const data = await attendanceService.listAllExceptions()
      setExceptions(data)
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Failed to load exceptions' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const review = async (id, status, comment) => {
    setBusy(true)
    try {
      await attendanceService.reviewException(id, { status, comment })
      setNotice({ kind: 'ok', text: `Exception ${status}.` })
      await load()
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Review failed' })
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <LoadingState label="Loading exceptions..." />

  return (
    <div>
      <p className="text-sm text-slate-500 mb-4">Late arrival reasons submitted by employees. Review and accept or reject each exception.</p>
      {exceptions.length === 0 ? (
        <EmptyState title="No attendance exceptions" description="Late arrival reasons will appear here when submitted." />
      ) : (
        <div className="space-y-3">
          {exceptions.map((e) => (
            <div key={e.id} className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <Clock3 className="w-4 h-4 text-amber-500" />
                    <h4 className="font-medium text-slate-900">{e.employees?.full_name || 'Unknown'}</h4>
                    <StatusBadge label={e.status} color={e.status === 'accepted' ? 'emerald' : e.status === 'rejected' ? 'rose' : 'amber'} />
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-2 text-xs text-slate-500">
                    <div>Expected: <span className="font-medium text-slate-700">{e.expected_time || '—'}</span></div>
                    <div>Actual: <span className="font-medium text-amber-700">{e.actual_time || '—'}</span></div>
                    <div>Reason: <span className="font-medium text-slate-700 capitalize">{e.reason?.replace(/_/g, ' ') || '—'}</span></div>
                    <div>Date: <span className="font-medium text-slate-700">{new Date(e.created_at).toLocaleDateString()}</span></div>
                  </div>
                  {e.custom_explanation && <p className="text-sm text-slate-600 mt-2 italic">"{e.custom_explanation}"</p>}
                  {e.review_comment && <p className="text-xs text-slate-400 mt-1">Review: {e.review_comment}</p>}
                </div>
                {e.status === 'pending' && (
                  <div className="flex gap-1.5">
                    <button onClick={() => review(e.id, 'accepted', '')} disabled={busy} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-emerald-50 text-emerald-700 text-xs font-medium hover:bg-emerald-100 disabled:opacity-50"><Check className="w-3.5 h-3.5" /> Accept</button>
                    <button onClick={() => review(e.id, 'rejected', 'Not accepted')} disabled={busy} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-rose-50 text-rose-700 text-xs font-medium hover:bg-rose-100 disabled:opacity-50"><Ban className="w-3.5 h-3.5" /> Reject</button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ============================================================
// ISSUES TAB — Employee-reported attendance issues
// ============================================================
function IssuesTab({ setNotice }) {
  const [issues, setIssues] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const data = await attendanceService.listAllIssues()
      setIssues(data)
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Failed to load issues' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const review = async (id, status, comment) => {
    setBusy(true)
    try {
      await attendanceService.reviewIssue(id, { status, comment })
      setNotice({ kind: 'ok', text: `Issue ${status}.` })
      await load()
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Review failed' })
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <LoadingState label="Loading issues..." />

  return (
    <div>
      <p className="text-sm text-slate-500 mb-4">Attendance issues reported by employees (forgot clock-in, incorrect time, etc.). Review and approve or reject each issue.</p>
      {issues.length === 0 ? (
        <EmptyState title="No attendance issues" description="Employee-reported issues will appear here." />
      ) : (
        <div className="space-y-3">
          {issues.map((i) => (
            <div key={i.id} className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-rose-500" />
                    <h4 className="font-medium text-slate-900">{i.employees?.full_name || 'Unknown'}</h4>
                    <StatusBadge label={i.status} color={i.status === 'approved' ? 'emerald' : i.status === 'rejected' ? 'rose' : 'amber'} />
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-2 text-xs text-slate-500">
                    <div>Issue: <span className="font-medium text-slate-700 capitalize">{i.issue_type?.replace(/_/g, ' ') || '—'}</span></div>
                    <div>Date: <span className="font-medium text-slate-700">{i.issue_date ? new Date(i.issue_date).toLocaleDateString() : '—'}</span></div>
                  </div>
                  {i.explanation && <p className="text-sm text-slate-600 mt-2 italic">"{i.explanation}"</p>}
                  {i.review_comment && <p className="text-xs text-slate-400 mt-1">Review: {i.review_comment}</p>}
                </div>
                {i.status === 'pending' && (
                  <div className="flex gap-1.5">
                    <button onClick={() => review(i.id, 'approved', '')} disabled={busy} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-emerald-50 text-emerald-700 text-xs font-medium hover:bg-emerald-100 disabled:opacity-50"><Check className="w-3.5 h-3.5" /> Approve</button>
                    <button onClick={() => review(i.id, 'rejected', 'Rejected')} disabled={busy} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-rose-50 text-rose-700 text-xs font-medium hover:bg-rose-100 disabled:opacity-50"><Ban className="w-3.5 h-3.5" /> Reject</button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ============================================================
// CONFIG TAB — Attendance configuration
// ============================================================
function ConfigTab({ setNotice }) {
  const [config, setConfig] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({})

  const load = async () => {
    setLoading(true)
    try {
      const cfg = await attendanceService.getConfig()
      setConfig(cfg)
      if (cfg) {
        setForm({
          expected_start_time: cfg.expected_start_time || '08:00',
          expected_end_time: cfg.expected_end_time || '17:00',
          grace_period_minutes: cfg.grace_period_minutes || 15,
          late_threshold_time: cfg.late_threshold_time || '08:16',
          working_days: cfg.working_days || ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
        })
      }
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Failed to load config' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const save = async () => {
    setBusy(true)
    try {
      await workManagementService.updateAttendanceConfig(form)
      setNotice({ kind: 'ok', text: 'Attendance configuration updated.' })
      await load()
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Update failed' })
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <LoadingState label="Loading configuration..." />

  const ALL_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

  return (
    <div>
      <p className="text-sm text-slate-500 mb-4">Configure expected work schedule. These values determine late detection and attendance status. Not hard-coded — change them here.</p>
      <div className="bg-white rounded-xl border border-slate-200 p-6 max-w-lg">
        <div className="flex items-center gap-2 mb-4">
          <SettingsIcon className="w-5 h-5 text-slate-400" />
          <h3 className="font-semibold text-slate-900">Attendance Configuration</h3>
        </div>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Expected Start Time</label>
              <input type="time" className={inputCls} value={form.expected_start_time || ''} onChange={(e) => setForm({ ...form, expected_start_time: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Expected End Time</label>
              <input type="time" className={inputCls} value={form.expected_end_time || ''} onChange={(e) => setForm({ ...form, expected_end_time: e.target.value })} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Grace Period (minutes)</label>
              <input type="number" className={inputCls} value={form.grace_period_minutes || ''} onChange={(e) => setForm({ ...form, grace_period_minutes: Number(e.target.value) })} />
            </div>
            <div>
              <label className={labelCls}>Late Threshold Time</label>
              <input type="time" className={inputCls} value={form.late_threshold_time || ''} onChange={(e) => setForm({ ...form, late_threshold_time: e.target.value })} />
            </div>
          </div>
          <div>
            <label className={labelCls}>Working Days</label>
            <div className="flex flex-wrap gap-2 mt-1">
              {ALL_DAYS.map((d) => {
                const active = (form.working_days || []).includes(d)
                return (
                  <button
                    key={d}
                    onClick={() => {
                      const days = active ? (form.working_days || []).filter((w) => w !== d) : [...(form.working_days || []), d]
                      setForm({ ...form, working_days: days })
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition ${active ? 'bg-[#009944] text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                  >
                    {d}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="flex justify-end pt-2">
            <button onClick={save} disabled={busy} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Save Configuration
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
