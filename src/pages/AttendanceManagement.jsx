import React, { useEffect, useState, useMemo } from 'react'
import { Users, CheckCircle2, XCircle, AlertTriangle, Clock, TrendingUp, RefreshCw, MapPin, Pencil, X, Loader2, Check, Ban, AlertCircle, Clock3, Settings as SettingsIcon } from 'lucide-react'
import { attendanceService, platformDateKey } from '../services/attendanceService'
import { attendanceEngineService } from '../services/attendanceEngineService'
import { LoadingState, EmptyState, ErrorState } from '../components/PageStates'
import SaraBriefing from '../components/attendance/SaraBriefing'
import TrendChart from '../components/attendance/TrendChart'
import LocationAuditModal from '../components/attendance/LocationAuditModal'

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
  const [employees, setEmployees] = useState([])
  const [branches, setBranches] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filters, setFilters] = useState({ date: '', branchId: '', department: '', employeeId: '', status: '' })
  const [auditRecord, setAuditRecord] = useState(null)
  const [correcting, setCorrecting] = useState(null)
  const [form, setForm] = useState({})
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [data, emps, brs] = await Promise.all([
        attendanceService.listAll(filters),
        attendanceService.listEmployees(),
        attendanceService.listBranches(),
      ])
      setRows(data)
      setEmployees(emps)
      setBranches(brs)
    } catch (e) {
      setError(e?.message || 'Unable to load attendance records')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  // Apply filters
  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (filters.date && String(r.attendance_date) !== filters.date) return false
      if (filters.branchId && r.branch_id !== filters.branchId) return false
      if (filters.department && r.employees?.department !== filters.department) return false
      if (filters.employeeId && r.employee_id !== filters.employeeId) return false
      if (filters.status && r.status !== filters.status) return false
      return true
    })
  }, [rows, filters])

  // KPIs
  const kpis = useMemo(() => {
    const today = platformDateKey()
    const todayRows = rows.filter((r) => String(r.attendance_date) === today)
    const totalEmps = employees.length
    const present = todayRows.filter((r) => r.clock_in).length
    const late = todayRows.filter((r) => r.status === 'late' || (r.late_minutes || 0) > 0).length
    const absent = totalEmps - present
    const withHours = todayRows.filter((r) => r.work_hours != null)
    const avgHours = withHours.length > 0 ? (withHours.reduce((s, r) => s + parseFloat(r.work_hours), 0) / withHours.length).toFixed(1) : 0
    const pct = totalEmps > 0 ? Math.round((present / totalEmps) * 100) : 0
    return { totalEmps, present, late, absent, avgHours, pct }
  }, [rows, employees])

  // Trend data
  const trendData = useMemo(() => {
    const last7 = []
    for (let i = 6; i >= 0; i--) {
      const ds = platformDateKey(new Date(Date.now() - i * 86400000))
      const [y, m, dd] = ds.split('-').map(Number)
      const dayRows = rows.filter((r) => String(r.attendance_date) === ds)
      const present = dayRows.filter((r) => r.clock_in).length
      last7.push({
        label: new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }).charAt(0),
        value: present,
        color: '#009944',
      })
    }
    return last7
  }, [rows])

  const departments = useMemo(() => {
    return [...new Set(employees.map((e) => e.department).filter(Boolean))].sort()
  }, [employees])

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

  return (
    <div className="max-w-7xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Attendance Management</h2>
          <p className="text-sm text-slate-500 mt-1">Organization-wide attendance oversight and corrections.</p>
        </div>
        <button onClick={load} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {error && <ErrorState message={error} />}
      {loading && <LoadingState label="Loading attendance records..." />}

      {!loading && (
        <>
          {/* SARA Briefing */}
          <div className="mb-6">
            <SaraBriefing records={rows} employees={employees} isManager={true} />
          </div>

          {/* KPI cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
            <KpiCard icon={Users} label="Total Employees" value={kpis.totalEmps} color="text-slate-700" />
            <KpiCard icon={CheckCircle2} label="Present Today" value={kpis.present} color="text-emerald-600" />
            <KpiCard icon={XCircle} label="Absent Today" value={kpis.absent} color="text-rose-600" />
            <KpiCard icon={AlertTriangle} label="Late Today" value={kpis.late} color="text-amber-600" />
            <KpiCard icon={TrendingUp} label="Attendance %" value={`${kpis.pct}%`} color="text-blue-600" />
            <KpiCard icon={Clock} label="Avg Hours" value={kpis.avgHours} color="text-violet-600" />
          </div>

          {/* Trend chart */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5 mb-6">
            <h3 className="text-sm font-semibold text-slate-700 mb-4">7-Day Attendance Trend</h3>
            <TrendChart data={trendData} color="#009944" />
          </div>

          {/* Filters */}
          <div className="bg-white rounded-2xl border border-slate-200 p-4 mb-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              <div>
                <label className={labelCls}>Date</label>
                <input type="date" className={inputCls} value={filters.date} onChange={(e) => setFilters({ ...filters, date: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>Branch</label>
                <select className={inputCls} value={filters.branchId} onChange={(e) => setFilters({ ...filters, branchId: e.target.value })}>
                  <option value="">All branches</option>
                  {branches.map((b) => <option key={b.id} value={b.id}>{b.branch_name}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Department</label>
                <select className={inputCls} value={filters.department} onChange={(e) => setFilters({ ...filters, department: e.target.value })}>
                  <option value="">All departments</option>
                  {departments.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Employee</label>
                <select className={inputCls} value={filters.employeeId} onChange={(e) => setFilters({ ...filters, employeeId: e.target.value })}>
                  <option value="">All employees</option>
                  {employees.map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Status</label>
                <select className={inputCls} value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
                  <option value="">All statuses</option>
                  {['present', 'late', 'absent', 'early_exit', 'on_leave', 'corrected', 'incomplete'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* Table */}
          {filtered.length === 0 ? (
            <EmptyState title="No matching attendance records" description="Adjust the filters or check back later." />
          ) : (
            <div className="bg-white rounded-2xl border border-slate-200 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-left">
                  <tr>
                    <th className="px-5 py-3 font-medium whitespace-nowrap">Employee</th>
                    <th className="px-5 py-3 font-medium whitespace-nowrap">Date</th>
                    <th className="px-5 py-3 font-medium whitespace-nowrap">Clock In</th>
                    <th className="px-5 py-3 font-medium whitespace-nowrap">Clock Out</th>
                    <th className="px-5 py-3 font-medium whitespace-nowrap">Hours</th>
                    <th className="px-5 py-3 font-medium whitespace-nowrap">Status</th>
                    <th className="px-5 py-3 font-medium whitespace-nowrap">Late</th>
                    <th className="px-5 py-3 font-medium whitespace-nowrap text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-5 py-3">
                        <div className="font-medium text-slate-900">{r.employees?.full_name || r.employee_id}</div>
                        {r.employees?.department && <div className="text-xs text-slate-400">{r.employees.department} · {r.employees.position || ''}</div>}
                      </td>
                      <td className="px-5 py-3 text-slate-600">{new Date(r.attendance_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
                      <td className="px-5 py-3 text-slate-600 tabular-nums">{r.clock_in ? new Date(r.clock_in).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                      <td className="px-5 py-3 text-slate-600 tabular-nums">{r.clock_out ? new Date(r.clock_out).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                      <td className="px-5 py-3 text-slate-600 tabular-nums">{r.work_hours || '—'}</td>
                      <td className="px-5 py-3"><StatusPill status={r.status} /></td>
                      <td className="px-5 py-3 text-slate-600">{r.late_minutes > 0 ? `${r.late_minutes}m` : '—'}</td>
                      <td className="px-5 py-3 text-right">
                        <div className="inline-flex gap-1.5">
                          {(r.clock_in_lat || r.clock_out_lat || r.geofence_status !== 'no_geofence') && (
                            <button onClick={() => setAuditRecord(r)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-300 text-slate-600 text-xs hover:bg-slate-100" title="Location audit">
                              <MapPin className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button onClick={() => openCorrection(r)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-300 text-slate-600 text-xs hover:bg-slate-100" title="Correct">
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Location Audit Modal */}
      {auditRecord && (
        <LocationAuditModal record={auditRecord} onClose={() => setAuditRecord(null)} />
      )}

      {/* Correction Modal */}
      {correcting && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md p-6 shadow-xl">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Correct attendance</h3>
                <p className="text-sm text-slate-500">{correcting.employees?.full_name} — {new Date(correcting.attendance_date).toLocaleDateString()}</p>
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

function KpiCard({ icon: Icon, label, value, color }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-3.5">
      <Icon className={`w-4 h-4 ${color}`} />
      <div className={`text-xl font-bold ${color} mt-1.5`}>{value}</div>
      <div className="text-xs text-slate-400 mt-0.5">{label}</div>
    </div>
  )
}

function StatusPill({ status }) {
  const styles = {
    present: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    late: 'bg-amber-50 text-amber-700 border-amber-200',
    absent: 'bg-rose-50 text-rose-700 border-rose-200',
    early_exit: 'bg-orange-50 text-orange-700 border-orange-200',
    on_leave: 'bg-blue-50 text-blue-700 border-blue-200',
    corrected: 'bg-violet-50 text-violet-700 border-violet-200',
    incomplete: 'bg-slate-100 text-slate-600 border-slate-200',
  }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border capitalize ${styles[status] || styles.incomplete}`}>
      {status.replace(/_/g, ' ')}
    </span>
  )
}

function ReviewPill({ status, positive }) {
  const tone = positive.includes(status)
    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : status === 'rejected'
      ? 'bg-rose-50 text-rose-700 border-rose-200'
      : 'bg-amber-50 text-amber-700 border-amber-200'
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border capitalize ${tone}`}>{(status || 'pending').replace(/_/g, ' ')}</span>
}

// ============================================================
// EXCEPTIONS TAB — late-arrival reasons awaiting review
// ============================================================
function ExceptionsTab({ setNotice }) {
  const [exceptions, setExceptions] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      setExceptions(await attendanceService.listAllExceptions())
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
    <div className="max-w-4xl">
      <p className="text-sm text-slate-500 mb-4">Late arrival reasons submitted by employees. Review and accept or reject each exception.</p>
      {exceptions.length === 0 ? (
        <EmptyState title="No attendance exceptions" description="Late arrival reasons will appear here when submitted." />
      ) : (
        <div className="space-y-3">
          {exceptions.map((e) => (
            <div key={e.id} className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <Clock3 className="w-4 h-4 text-amber-500" />
                    <h4 className="font-medium text-slate-900">{e.employees?.full_name || 'Unknown'}</h4>
                    <ReviewPill status={e.status} positive={['accepted']} />
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-2 text-xs text-slate-500">
                    <div>Expected: <span className="font-medium text-slate-700">{e.expected_time || '—'}</span></div>
                    <div>Actual: <span className="font-medium text-amber-700">{e.actual_time || '—'}</span></div>
                    <div>Reason: <span className="font-medium text-slate-700 capitalize">{e.reason?.replace(/_/g, ' ') || '—'}</span></div>
                    <div>Date: <span className="font-medium text-slate-700">{e.created_at ? new Date(e.created_at).toLocaleDateString() : '—'}</span></div>
                  </div>
                  {e.custom_explanation && <p className="text-sm text-slate-600 mt-2 italic">"{e.custom_explanation}"</p>}
                  {e.review_comment && <p className="text-xs text-slate-400 mt-1">Review: {e.review_comment}</p>}
                </div>
                {e.status === 'pending' && (
                  <div className="flex gap-1.5 shrink-0">
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
// ISSUES TAB — employee-reported attendance issues
// ============================================================
function IssuesTab({ setNotice }) {
  const [issues, setIssues] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      setIssues(await attendanceService.listAllIssues())
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
    <div className="max-w-4xl">
      <p className="text-sm text-slate-500 mb-4">Attendance issues reported by employees (forgot clock-in, incorrect time, etc.). Review and approve or reject each issue.</p>
      {issues.length === 0 ? (
        <EmptyState title="No attendance issues" description="Employee-reported issues will appear here." />
      ) : (
        <div className="space-y-3">
          {issues.map((i) => (
            <div key={i.id} className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-rose-500" />
                    <h4 className="font-medium text-slate-900">{i.employees?.full_name || 'Unknown'}</h4>
                    <ReviewPill status={i.status} positive={['approved', 'resolved']} />
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-2 text-xs text-slate-500">
                    <div>Issue: <span className="font-medium text-slate-700 capitalize">{i.issue_type?.replace(/_/g, ' ') || '—'}</span></div>
                    <div>Date: <span className="font-medium text-slate-700">{i.issue_date ? new Date(i.issue_date).toLocaleDateString() : '—'}</span></div>
                  </div>
                  {i.explanation && <p className="text-sm text-slate-600 mt-2 italic">"{i.explanation}"</p>}
                  {i.review_comment && <p className="text-xs text-slate-400 mt-1">Review: {i.review_comment}</p>}
                </div>
                {i.status === 'pending' && (
                  <div className="flex gap-1.5 shrink-0">
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
// CONFIG TAB — attendance schedule & policy configuration
// ============================================================
function ConfigTab({ setNotice }) {
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({})

  const load = async () => {
    setLoading(true)
    try {
      const cfg = await attendanceEngineService.getConfig()
      if (cfg) {
        setForm({
          expected_start_time: cfg.expected_start_time || '08:00',
          expected_end_time: cfg.expected_end_time || '17:00',
          grace_period_minutes: cfg.grace_period_minutes ?? 15,
          late_threshold_time: cfg.late_threshold_time || '08:16',
          early_departure_threshold_minutes: cfg.early_departure_threshold_minutes ?? 0,
          overtime_threshold_hours: cfg.overtime_threshold_hours ?? 0,
          break_allowed: cfg.break_allowed ?? false,
          break_duration_minutes: cfg.break_duration_minutes ?? 0,
          geofence_enabled: cfg.geofence_enabled ?? false,
          manual_correction_requires_reason: cfg.manual_correction_requires_reason ?? true,
          working_days: cfg.working_days || ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
        })
      }
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Failed to load configuration' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const save = async () => {
    setBusy(true)
    try {
      await attendanceEngineService.updateConfig(form)
      setNotice({ kind: 'ok', text: 'Attendance configuration updated and synchronized with Platform Settings.' })
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
    <div className="max-w-2xl">
      <p className="text-sm text-slate-500 mb-4">Configure the expected work schedule. These values determine late detection and attendance status. Working hours and grace period mirror <strong>Platform Settings → Working Hours</strong> and stay synchronized when saved here.</p>
      <div className="bg-white rounded-xl border border-slate-200 p-6">
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
              <input type="number" min="0" className={inputCls} value={form.grace_period_minutes ?? ''} onChange={(e) => setForm({ ...form, grace_period_minutes: Number(e.target.value) })} />
            </div>
            <div>
              <label className={labelCls}>Late Threshold Time</label>
              <input type="time" className={inputCls} value={form.late_threshold_time || ''} onChange={(e) => setForm({ ...form, late_threshold_time: e.target.value })} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Early Departure Threshold (minutes)</label>
              <input type="number" min="0" className={inputCls} value={form.early_departure_threshold_minutes ?? ''} onChange={(e) => setForm({ ...form, early_departure_threshold_minutes: Number(e.target.value) })} />
            </div>
            <div>
              <label className={labelCls}>Overtime Threshold (hours)</label>
              <input type="number" min="0" step="0.5" className={inputCls} value={form.overtime_threshold_hours ?? ''} onChange={(e) => setForm({ ...form, overtime_threshold_hours: Number(e.target.value) })} />
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
                    type="button"
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
          <div className="space-y-2 pt-1">
            {[
              { key: 'geofence_enabled', label: 'Require geofence for clock in/out' },
              { key: 'break_allowed', label: 'Allow breaks during shift' },
              { key: 'manual_correction_requires_reason', label: 'Require reason for manual corrections' },
            ].map(({ key, label }) => (
              <label key={key} className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={!!form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.checked })} className="rounded border-slate-300 text-[#009944] focus:ring-[#009944]" />
                {label}
              </label>
            ))}
            {form.break_allowed && (
              <div>
                <label className={labelCls}>Break Duration (minutes)</label>
                <input type="number" min="0" className={inputCls} value={form.break_duration_minutes ?? ''} onChange={(e) => setForm({ ...form, break_duration_minutes: Number(e.target.value) })} />
              </div>
            )}
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
