import React, { useEffect, useState, useMemo } from 'react'
import { QRCodeCanvas } from 'qrcode.react'
import { Users, CheckCircle2, XCircle, AlertTriangle, Clock, TrendingUp, RefreshCw, MapPin, Pencil, X, Loader2, Check, Ban, AlertCircle, Clock3, Settings as SettingsIcon, QrCode, Copy, Download, Printer, RotateCcw, Eye, Trash2, Pause, Play, Fingerprint, ShieldAlert, History, MessageSquare, ShieldCheck } from 'lucide-react'
import { attendanceService, platformDateKey, formatWorkedHours } from '../services/attendanceService'
import { attendanceEngineService } from '../services/attendanceEngineService'
import { platformSettingsService } from '../services/platformSettingsService'
import { supabase } from '../supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { LoadingState, EmptyState, ErrorState } from '../components/PageStates'
import SaraBriefing from '../components/attendance/SaraBriefing'
import TrendChart from '../components/attendance/TrendChart'
import LocationAuditModal from '../components/attendance/LocationAuditModal'
import {
  locationLabel,
  assignedBranchGeofenceText,
  assignedBranchDistanceLabel,
  assignedBranchStatusMeta,
  clockingLocationText,
} from '../utils/attendanceLocation'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

export default function AttendanceManagement() {
  const { role: actorRole } = useAuth()
  const [tab, setTab] = useState('records')
  const [notice, setNotice] = useState({ kind: '', text: '' })

  const canManageDeviceBindings = ['super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'branch_manager'].includes(actorRole)

  const tabs = [
    { id: 'records', label: 'Attendance Records' },
    { id: 'exceptions', label: 'Late Exceptions' },
    { id: 'issues', label: 'Attendance Issues' },
    { id: 'config', label: 'Configuration' },
    { id: 'qr', label: 'QR Attendance' },
    ...(canManageDeviceBindings ? [{ id: 'bindings', label: 'Device Binding' }] : []),
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
      {tab === 'qr' && <QrTerminalTab setNotice={setNotice} />}
      {tab === 'bindings' && canManageDeviceBindings && <DeviceBindingsTab setNotice={setNotice} />}
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
  const [summary, setSummary] = useState(null)
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
      // Fetch a window that supports both the table view and the 7-day trend.
      // When a specific date is selected, fetch the 7 days ending on that date
      // so the trend still renders; the table will narrow to the exact date.
      const activeDate = filters.date || platformDateKey()
      const active = new Date(`${activeDate}T12:00:00`)
      const start = new Date(active)
      start.setDate(start.getDate() - 6)
      const startDate = platformDateKey(start)
      const endDate = activeDate

      const [data, emps, brs, todaySummary] = await Promise.all([
        attendanceService.listAll({
          startDate,
          endDate,
          branchId: filters.branchId || undefined,
          department: filters.department || undefined,
          employeeId: filters.employeeId || undefined,
          status: filters.status || undefined,
        }),
        attendanceService.listEmployees(),
        attendanceService.listBranches(),
        attendanceService.getManagementSummary().catch(() => null),
      ])
      setRows(data)
      setEmployees(emps)
      setBranches(brs)
      setSummary(todaySummary)
    } catch (e) {
      setError(e?.message || 'Unable to load attendance records')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [filters.date, filters.branchId, filters.department, filters.employeeId, filters.status])

  // Trigger lazy auto-clock-out reconciliation once per management session.
  useEffect(() => {
    attendanceService.reconcileAutoClockouts().catch(() => { /* best-effort background reconciliation */ })
  }, [])

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

  // Population scope used by metrics and trend (date/status are applied separately).
  const populationMatch = (r) => {
    if (filters.employeeId && r.employee_id !== filters.employeeId) return false
    if (filters.department && r.employees?.department !== filters.department) return false
    if (filters.branchId && r.branch_id !== filters.branchId) return false
    return true
  }

  const filteredEmployees = useMemo(() => {
    return employees.filter((e) => {
      if (filters.employeeId && e.id !== filters.employeeId) return false
      if (filters.department && e.department !== filters.department) return false
      if (filters.branchId && e.branch_id !== filters.branchId) return false
      return true
    })
  }, [employees, filters.employeeId, filters.department, filters.branchId])

  // KPIs — scoped to active filters. Total headcount comes from the filtered
  // employee list; present/absent/late come from records for the active date.
  const activeDate = filters.date || platformDateKey()
  const kpis = useMemo(() => {
    const activeDateRows = rows.filter((r) => populationMatch(r) && String(r.attendance_date) === activeDate)
    const totalEmps = filteredEmployees.length || summary?.total_employees || 0
    const present = activeDateRows.filter((r) => r.clock_in).length
    const late = activeDateRows.filter((r) => r.status === 'late' || (r.late_minutes || 0) > 0).length
    const absent = Math.max(0, totalEmps - present)
    const withHours = activeDateRows.filter((r) => r.clock_in && r.clock_out)
    const avgHours = withHours.length > 0
      ? (withHours.reduce((s, r) => s + (r.computed_work_hours ?? (Number(r.work_hours) || 0)), 0) / withHours.length).toFixed(1)
      : 0
    const pct = totalEmps > 0 ? Math.round((present / totalEmps) * 100) : 0
    return { totalEmps, present, late, absent, avgHours, pct }
  }, [rows, filteredEmployees, summary, activeDate])

  // 7-day trend — scoped to the same population filters, ending on the active date.
  const trendData = useMemo(() => {
    const active = new Date(`${activeDate}T12:00:00`)
    const last7 = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date(active)
      d.setDate(d.getDate() - i)
      const ds = platformDateKey(d)
      const [y, m, dd] = ds.split('-').map(Number)
      const dayRows = rows.filter((r) => populationMatch(r) && String(r.attendance_date) === ds)
      const present = dayRows.filter((r) => r.clock_in).length
      last7.push({
        label: new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }).charAt(0),
        value: present,
        color: '#009944',
      })
    }
    return last7
  }, [rows, filters.employeeId, filters.department, filters.branchId, activeDate])

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
            <SaraBriefing records={rows} employees={employees} isManager={true} summary={summary} />
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
                    <th className="px-5 py-3 font-medium whitespace-nowrap">Employee Number</th>
                    <th className="px-5 py-3 font-medium whitespace-nowrap">Assigned Branch</th>
                    <th className="px-5 py-3 font-medium whitespace-nowrap">Date</th>
                    <th className="px-5 py-3 font-medium whitespace-nowrap">Clock In</th>
                    <th className="px-5 py-3 font-medium whitespace-nowrap">Clock Out</th>
                    <th className="px-5 py-3 font-medium whitespace-nowrap">Hours</th>
                    <th className="px-5 py-3 font-medium whitespace-nowrap">Status</th>
                    <th className="px-5 py-3 font-medium whitespace-nowrap">Late</th>
                    <th className="px-5 py-3 font-medium whitespace-nowrap">Clocking Location</th>
                    <th className="px-5 py-3 font-medium whitespace-nowrap">Geofence</th>
                    <th className="px-5 py-3 font-medium whitespace-nowrap">Location Difference</th>
                    <th className="px-5 py-3 font-medium whitespace-nowrap">Location Status</th>
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
                      <td className="px-5 py-3 text-slate-600 font-mono text-xs">{r.employees?.employee_number || r.employees?.staff_id || r.employees?.employee_code || '—'}</td>
                      <td className="px-5 py-3 text-slate-600">{r.employees?.branches?.branch_name || r.branches?.branch_name || r.employees?.branch || '—'}</td>
                      <td className="px-5 py-3 text-slate-600">{new Date(r.attendance_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
                      <td className="px-5 py-3 text-slate-600 tabular-nums">{r.clock_in ? new Date(r.clock_in).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                      <td className="px-5 py-3 text-slate-600 tabular-nums">
                        {r.clock_out ? new Date(r.clock_out).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—'}
                        {r.auto_clock_out && (
                          <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-700 border border-amber-200" title="Closed automatically at the scheduled work-end time (no manual clock-out was recorded)">
                            Auto
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-slate-600 tabular-nums">{formatWorkedHours(r)}</td>
                      <td className="px-5 py-3"><StatusPill status={r.status} /></td>
                      <td className="px-5 py-3 text-slate-600">{r.late_minutes > 0 ? `${r.late_minutes}m` : '—'}</td>
                      <td className="px-5 py-3 text-slate-600">{clockingLocationDisplay(r) || <span className="text-slate-400">No location data</span>}</td>
                      <td className="px-5 py-3 text-slate-600">{geofenceName(r) || '—'}</td>
                      <td className="px-5 py-3">{locationDifference(r)}</td>
                      <td className="px-5 py-3"><LocationStatusPill record={r} /></td>
                      <td className="px-5 py-3 text-right">
                        <div className="inline-flex gap-1.5">
                          {(r.clock_in_lat || r.clock_out_lat || assignedBranchGeofenceText(r)) && (
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

function eventMetadata(record) {
  return record?.clock_in_event?.metadata || record?.clock_out_event?.metadata || {}
}

function locationName(record) {
  return locationLabel(record)
}

function clockingLocationDisplay(record) {
  const inCoords = clockingLocationText(record, 'clock_in')
  const outCoords = clockingLocationText(record, 'clock_out')
  if (inCoords && outCoords && inCoords !== outCoords) return `In: ${inCoords} / Out: ${outCoords}`
  return inCoords || outCoords || null
}

function geofenceName(record) {
  return assignedBranchGeofenceText(record)
}

function locationDifference(record) {
  const distance = assignedBranchDistanceLabel(record, 'clock_in')
  if (distance) return <span className="text-slate-600">{distance}</span>
  return <span className="text-slate-400">No location data</span>
}

function LocationStatusPill({ record }) {
  const meta = assignedBranchStatusMeta(record, 'clock_in')
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full border text-xs ${meta.tone}`}>
      {meta.label}
    </span>
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
      const [cfg, settings] = await Promise.all([
        attendanceEngineService.getConfig(),
        platformSettingsService.get(),
      ])
      if (cfg) {
        setForm({
          expected_start_time: settings?.default_work_start_time?.slice(0, 5) || cfg.expected_start_time || '',
          expected_end_time: settings?.default_work_end_time?.slice(0, 5) || cfg.expected_end_time || '',
          grace_period_minutes: settings?.default_grace_period_minutes ?? cfg.grace_period_minutes,
          late_threshold_time: cfg.late_threshold_time || '',
          early_departure_threshold_minutes: settings?.early_departure_threshold_minutes ?? cfg.early_departure_threshold_minutes,
          overtime_threshold_hours: settings?.overtime_threshold_minutes != null
            ? Number((Number(settings.overtime_threshold_minutes) / 60).toFixed(2))
            : cfg.overtime_threshold_hours,
          break_allowed: cfg.break_allowed ?? false,
          break_duration_minutes: settings?.default_break_duration_minutes ?? cfg.break_duration_minutes,
          geofence_enabled: settings?.geofence_enabled ?? cfg.geofence_enabled ?? false,
          manual_correction_requires_reason: cfg.manual_correction_requires_reason ?? true,
          working_days: (settings?.default_working_days || cfg.working_days || []).map((day) => String(day).toLowerCase().slice(0, 3)),
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
      const { expected_start_time, expected_end_time, grace_period_minutes, late_threshold_time, working_days, ...policy } = form
      await attendanceEngineService.updateConfig(policy)
      setNotice({ kind: 'ok', text: 'Attendance policy updated. Work hours remain controlled by Platform Settings → Working Hours.' })
      await load()
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Update failed' })
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <LoadingState label="Loading configuration..." />

  const ALL_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

  return (
    <div className="max-w-2xl">
      <p className="text-sm text-slate-500 mb-4">Review attendance policy and location behavior. Platform Settings → Working Hours is the single source of truth for start time, end time, working days, grace period, and lateness calculations.</p>
      <div className="bg-white rounded-xl border border-slate-200 p-6">
        <div className="flex items-center gap-2 mb-4">
          <SettingsIcon className="w-5 h-5 text-slate-400" />
          <h3 className="font-semibold text-slate-900">Attendance Configuration</h3>
        </div>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Expected Start Time</label>
               <input type="time" className={`${inputCls} bg-slate-50`} value={form.expected_start_time || ''} readOnly />
            </div>
            <div>
              <label className={labelCls}>Expected End Time</label>
               <input type="time" className={`${inputCls} bg-slate-50`} value={form.expected_end_time || ''} readOnly />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Grace Period (minutes)</label>
               <input type="number" min="0" className={`${inputCls} bg-slate-50`} value={form.grace_period_minutes ?? ''} readOnly />
            </div>
            <div>
              <label className={labelCls}>Late Threshold Time</label>
               <input type="time" className={`${inputCls} bg-slate-50`} value={form.late_threshold_time || ''} readOnly />
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
                    disabled
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium uppercase transition ${active ? 'bg-[#009944] text-white' : 'bg-slate-100 text-slate-500'}`}
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

function buildTerminalUrl(token) {
  return `${window.location.origin}${window.location.pathname}#/attendance-terminal?token=${encodeURIComponent(token)}`
}

function QrTerminalTab({ setNotice }) {
  const [devices, setDevices] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [terminalLink, setTerminalLink] = useState('')
  const [showQr, setShowQr] = useState('')
  const [qrLink, setQrLink] = useState('')
  const [qrLoading, setQrLoading] = useState(false)
  const [qrError, setQrError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [busyId, setBusyId] = useState('')
  const [historyDevice, setHistoryDevice] = useState('')
  const [historyRows, setHistoryRows] = useState([])
  const [historyFilter, setHistoryFilter] = useState('all')
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [branchNames, setBranchNames] = useState({})
  const [reviews, setReviews] = useState([])
  const [reviewStatus, setReviewStatus] = useState('PENDING_REVIEW')
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewBusyId, setReviewBusyId] = useState('')
  const [reviewModal, setReviewModal] = useState(null)

  const branchLabel = (id) => {
    if (!id) return '—'
    if (branchNames[id]) return branchNames[id]
    return /^[0-9a-fA-F-]{36}$/.test(String(id)) ? '—' : id
  }

  const loadReviews = async (status = reviewStatus) => {
    setReviewLoading(true)
    try {
      const rows = await attendanceService.listHrReviewRecords(status || 'PENDING_REVIEW')
      setReviews(rows || [])
    } catch (e) {
      setReviews([])
      setNotice({ kind: 'error', text: e?.message || 'Failed to load HR review records' })
    } finally {
      setReviewLoading(false)
    }
  }

  const load = async () => {
    setLoading(true)
    try {
      const [rows, branchRows] = await Promise.all([
        attendanceService.listTerminalDevices(),
        supabase.from('branches').select('id, branch_name').then(({ data }) => data || []),
      ])
      setDevices(rows)
      setBranchNames(Object.fromEntries(branchRows.map((b) => [b.id, b.branch_name])))
      setSelectedId((current) => current || rows[0]?.id || '')
      await loadReviews('PENDING_REVIEW')
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Failed to load attendance terminals' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const approveReview = async (record) => {
    setReviewBusyId(record.record_id)
    try {
      await attendanceService.approveHrReview(record.record_id)
      setNotice({ kind: 'ok', text: `Attendance approved for ${record.employee_name || 'the employee'}.` })
      await loadReviews(reviewStatus)
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Could not approve attendance' })
    } finally {
      setReviewBusyId('')
    }
  }

  const flagReview = async () => {
    if (!reviewModal?.record_id || !reviewModal?.note?.trim() || reviewModal.note.trim().length < 5) {
      setNotice({ kind: 'error', text: 'Enter a query note of at least 5 characters.' })
      return
    }
    setReviewBusyId(reviewModal.record_id)
    try {
      await attendanceService.flagHrReview(reviewModal.record_id, reviewModal.note.trim())
      setReviewModal(null)
      setNotice({ kind: 'ok', text: 'Attendance flagged. A query and notification were raised for the employee.' })
      await loadReviews(reviewStatus)
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Could not flag attendance' })
    } finally {
      setReviewBusyId('')
    }
  }

  const generate = async () => {
    setBusy(true)
    try {
      const result = await attendanceService.generateTerminalToken(selectedId || null)
      setSelectedId(result.device_id)
      const link = buildTerminalUrl(result.token)
      setTerminalLink(link)
      setNotice({ kind: 'ok', text: 'QR attendance terminal generated. The link above can be re-viewed anytime from the terminal list.' })
      await load()
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Could not generate terminal QR' })
    } finally {
      setBusy(false)
    }
  }

  const revoke = async () => {
    if (!selectedId) return
    setBusy(true)
    try {
      await attendanceService.revokeTerminal(selectedId)
      setTerminalLink('')
      if (showQr === selectedId) { setShowQr(''); setQrLink('') }
      setNotice({ kind: 'ok', text: 'Terminal link revoked. Existing QR codes will no longer work.' })
      await load()
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Could not revoke terminal' })
    } finally {
      setBusy(false)
    }
  }

  const copyLink = async (link) => {
    if (!link) return
    await navigator.clipboard?.writeText(link)
    setNotice({ kind: 'ok', text: 'Terminal link copied.' })
  }

  const downloadQr = (id = 'attendance-terminal-qr') => {
    const canvas = document.getElementById(id)
    if (!canvas) return
    const anchor = document.createElement('a')
    anchor.href = canvas.toDataURL('image/png')
    anchor.download = 'infinitycore-attendance-terminal.png'
    anchor.click()
  }

  const statusMeta = (device) => {
    const s = device?.status
    if (s === 'active') return { label: 'Active', cls: 'bg-emerald-100 text-emerald-700' }
    if (s === 'suspended') return { label: 'Suspended', cls: 'bg-amber-100 text-amber-700' }
    if (s === 'revoked') return { label: 'Revoked', cls: 'bg-rose-100 text-rose-700' }
    if (s === 'deleted') return { label: 'Deleted (history kept)', cls: 'bg-slate-200 text-slate-600' }
    return { label: s || 'Unknown', cls: 'bg-slate-100 text-slate-600' }
  }

  const historyBadge = (status) => {
    if (status === 'active') return { label: 'Active', cls: 'bg-emerald-100 text-emerald-700' }
    if (status === 'expired') return { label: 'Expired', cls: 'bg-slate-200 text-slate-600' }
    if (status === 'deleted') return { label: 'Deleted', cls: 'bg-slate-200 text-slate-600' }
    return { label: 'Revoked', cls: 'bg-amber-100 text-amber-700' }
  }

  const runFor = async (id, fn, okText, errorText) => {
    setBusyId(id)
    try {
      await fn(id)
      setNotice({ kind: 'ok', text: okText })
      await load()
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || errorText })
    } finally {
      setBusyId('')
    }
  }

  const suspendDevice = (device) => {
    if (!window.confirm(`Suspend "${device.device_name}"? Scans are blocked until you resume it. The QR token is kept so it can resume without reprinting.`)) return
    runFor(device.id, attendanceService.suspendTerminal, 'Terminal suspended. Scans are now blocked.', 'Could not suspend terminal')
  }

  const resumeDevice = (device) => {
    if (!window.confirm(`Resume "${device.device_name}"? Scans work again with the existing QR token.`)) return
    runFor(device.id, attendanceService.resumeTerminal, 'Terminal resumed. Scans re-enabled.', 'Could not resume terminal')
  }

  const revokeDevice = (device) => {
    if (!window.confirm(`Revoke "${device.device_name}"? This invalidates its QR token. Existing printed QRs stop working and cannot be re-enabled — a brand-new QR must be generated to bring the terminal back. The revoked token stays in the QR history log (it is never destroyed).`)) return
    setBusyId(device.id)
    attendanceService.revokeTerminal(device.id)
      .then(async () => {
        setTerminalLink((cur) => (device.id === selectedId ? '' : cur))
        if (showQr === device.id) { setShowQr(''); setQrLink('') }
        setNotice({ kind: 'ok', text: 'Terminal revoked. The QR token is invalidated and archived in history.' })
        await load()
      })
      .catch((e) => setNotice({ kind: 'error', text: e?.message || 'Could not revoke terminal' }))
      .finally(() => setBusyId(''))
  }

  const deleteDevice = (device) => {
    if (!window.confirm(`Delete "${device.device_name}"? Only revoked terminals can be deleted. This disables the terminal permanently — its row AND its full token history are kept (soft delete) so the audit trail is never destroyed.`)) return
    setBusyId(device.id)
    attendanceService.deleteTerminal(device.id)
      .then(async () => {
        if (showQr === device.id) { setShowQr(''); setQrLink('') }
        setNotice({ kind: 'ok', text: 'Terminal deleted (soft). History preserved.' })
        await load()
      })
      .catch((e) => setNotice({ kind: 'error', text: e?.message || 'Could not delete terminal' }))
      .finally(() => setBusyId(''))
  }

  const openQrView = async (device) => {
    setShowQr(device.id)
    setQrLoading(true)
    setQrError('')
    setQrLink('')
    const liveSessionLink = device.id === selectedId && terminalLink ? terminalLink : ''
    try {
      const info = await attendanceService.getTerminalQrLink(device.id)
      const storedLink = info?.has_qr && info.token ? buildTerminalUrl(info.token) : ''
      setQrLink(storedLink || liveSessionLink)
    } catch (e) {
      if (liveSessionLink) setQrLink(liveSessionLink)
      else setQrError(e?.message || 'Could not load this terminal link')
    } finally {
      setQrLoading(false)
    }
  }

  const modalGenerate = async () => {
    setQrLoading(true)
    setQrError('')
    try {
      const result = await attendanceService.generateTerminalToken(showQr || null)
      setQrLink(buildTerminalUrl(result.token))
      if (result.device_id === selectedId) setTerminalLink(buildTerminalUrl(result.token))
      setNotice({ kind: 'ok', text: 'New terminal QR generated. The previous QR link is invalid.' })
      await load()
    } catch (e) {
      setQrError(e?.message || 'Could not generate terminal QR')
    } finally {
      setQrLoading(false)
    }
  }

  const actionBtn = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium hover:bg-slate-50'
  const dangerBtn = 'border-rose-200 text-rose-700 hover:bg-rose-50'
  const plainBtn = 'border-slate-300 text-slate-600'

  const openQrHistory = async (device) => {
    setHistoryDevice(device.id)
    setHistoryFilter('all')
    setHistoryLoading(true)
    setHistoryError('')
    try {
      const rows = await attendanceService.listTerminalQrHistory(device.id)
      setHistoryRows(rows)
    } catch (e) {
      setHistoryError(e?.message || 'Could not load this terminal QR history')
      setHistoryRows([])
    } finally {
      setHistoryLoading(false)
    }
  }

  const changeHistoryFilter = async (status) => {
    setHistoryFilter(status)
    setHistoryLoading(true)
    setHistoryError('')
    try {
      const rows = await attendanceService.listTerminalQrHistory(historyDevice, status === 'all' ? null : status)
      setHistoryRows(rows)
    } catch (e) {
      setHistoryError(e?.message || 'Could not load this terminal QR history')
      setHistoryRows([])
    } finally {
      setHistoryLoading(false)
    }
  }

  const renderActions = (device) => (
    <div className="flex flex-wrap gap-1.5">
      <button onClick={() => openQrView(device)} className={`${actionBtn} ${plainBtn}`}><Eye className="w-3.5 h-3.5" /> View QR</button>
      {device.status === 'active' && (
        <button onClick={() => suspendDevice(device)} className={`${actionBtn} bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100`}><Pause className="w-3.5 h-3.5" /> Suspend</button>
      )}
      {device.status === 'suspended' && (
        <button onClick={() => resumeDevice(device)} className={`${actionBtn} border-emerald-200 text-emerald-700 hover:bg-emerald-50`}><Play className="w-3.5 h-3.5" /> Resume</button>
      )}
      {device.status !== 'revoked' && device.status !== 'deleted' && (
        <button onClick={() => revokeDevice(device)} className={`${actionBtn} ${dangerBtn}`}><Ban className="w-3.5 h-3.5" /> Revoke</button>
      )}
      {device.status === 'revoked' && (
        <button onClick={() => deleteDevice(device)} className={`${actionBtn} ${dangerBtn}`}><Trash2 className="w-3.5 h-3.5" /> Delete</button>
      )}
      <button onClick={() => openQrHistory(device)} className={`${actionBtn} ${plainBtn}`}><History className="w-3.5 h-3.5" /> QR History</button>
    </div>
  )

  const qrDevice = devices.find((d) => d.id === showQr)
  const closeQrModal = () => { setShowQr(''); setQrLink(''); setQrError('') }
  const qrModal = qrDevice ? (() => {
    const link = qrLink
    const meta = statusMeta(qrDevice)
    return (
      <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" onClick={closeQrModal}>
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="font-semibold text-slate-900">{qrDevice.device_name}</h3>
              <p className="text-xs text-slate-500 mt-1">
                <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${meta.cls}`}>{meta.label}</span>
                {qrDevice.last_seen_at && <span className="ml-2">Last seen {new Date(qrDevice.last_seen_at).toLocaleString()}</span>}
              </p>
            </div>
            <button onClick={closeQrModal} className="p-1 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"><X className="w-5 h-5" /></button>
          </div>

          {qrLoading ? (
            <div className="py-8 text-center">
              <Loader2 className="w-5 h-5 mx-auto animate-spin text-[#009944]" />
              <p className="text-sm text-slate-500 mt-2">Loading the current terminal QR…</p>
            </div>
          ) : qrError ? (
            <div className="space-y-3">
              <p className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{qrError}</p>
              <button onClick={modalGenerate} disabled={busy} className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <QrCode className="w-4 h-4" />} Generate new QR
              </button>
            </div>
          ) : link ? (
            <div className="space-y-3">
              <div className="bg-white border border-slate-200 rounded-xl p-4 w-fit mx-auto">
                <QRCodeCanvas id="attendance-terminal-qr-modal" value={link} size={220} level="H" includeMargin />
              </div>
              <p className="text-xs text-slate-500 break-all">{link}</p>
              <div className="flex flex-wrap gap-2 justify-center">
                <button onClick={() => copyLink(link)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-slate-600 text-xs hover:bg-slate-50"><Copy className="w-3.5 h-3.5" /> Copy link</button>
                <button onClick={() => downloadQr('attendance-terminal-qr-modal')} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-slate-600 text-xs hover:bg-slate-50"><Download className="w-3.5 h-3.5" /> Download</button>
                <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-slate-600 text-xs hover:bg-slate-50"><Printer className="w-3.5 h-3.5" /> Print</button>
              </div>
              <button onClick={modalGenerate} disabled={busy} className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-[#009944] text-[#009944] text-sm font-medium hover:bg-[#009944]/5 disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Regenerate QR
              </button>
              {qrDevice.status === 'suspended' && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">Suspended — this terminal does not accept scans right now. The QR below is preserved and will work again after Resume without reprinting.</p>}
              {qrDevice.status !== 'active' && qrDevice.status !== 'suspended' && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">Regenerating will reactivate this terminal with a brand-new QR.</p>}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-slate-500">This terminal has no current QR link{qrDevice.status === 'revoked' ? ' — it was revoked' : ''}. Generate one to display, download, and print it.</p>
              <button onClick={modalGenerate} disabled={busy} className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <QrCode className="w-4 h-4" />} Generate QR
              </button>
              {qrDevice.status === 'revoked' && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">This terminal is revoked. Generating a QR will revive it with a brand-new token.</p>}
            </div>
          )}
        </div>
      </div>
    )
  })() : null

  const historyDeviceObj = devices.find((d) => d.id === historyDevice)
  const closeHistoryModal = () => { setHistoryDevice(''); setHistoryRows([]); setHistoryError('') }
  const historyModal = historyDeviceObj ? (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" onClick={closeHistoryModal}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold text-slate-900">{historyDeviceObj.device_name}</h3>
            <p className="text-xs text-slate-500 mt-1">QR token history — every token ever issued to this terminal. Tokens are never destroyed: regenerated/revoked tokens stay here as <span className="font-medium">Revoked</span>, and the terminal row itself is a soft delete (<span className="font-medium">Deleted</span>). Only the first 8 characters of each token are shown; full tokens never leave the locked-down server store.</p>
          </div>
          <button onClick={closeHistoryModal} className="p-1 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {[['all', 'All'], ['active', 'Active'], ['revoked', 'Revoked'], ['deleted', 'Deleted']].map(([value, label]) => (
            <button key={value} onClick={() => changeHistoryFilter(value)}
              className={`px-3 py-1 rounded-full text-xs font-medium border ${historyFilter === value ? 'bg-[#009944] text-white border-[#009944]' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>
              {label}
            </button>
          ))}
        </div>

        {historyLoading ? (
          <div className="py-8 text-center">
            <Loader2 className="w-5 h-5 mx-auto animate-spin text-[#009944]" />
            <p className="text-sm text-slate-500 mt-2">Loading QR history…</p>
          </div>
        ) : historyError ? (
          <p className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{historyError}</p>
        ) : historyRows.length === 0 ? (
          <p className="text-sm text-slate-500 bg-slate-50 border border-slate-100 rounded-lg p-4">No QR tokens match this filter yet. Generate a QR for this terminal to create the first history entry.</p>
        ) : (
          <div className="max-h-[50vh] overflow-y-auto -mx-6 px-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-400 border-b border-slate-100">
                  <th className="py-2 pr-3 font-medium">Token</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium">Generated</th>
                  <th className="py-2 pr-3 font-medium">By</th>
                  <th className="py-2 pr-3 font-medium">Revoked</th>
                  <th className="py-2 pr-3 font-medium">Revoked by</th>
                </tr>
              </thead>
              <tbody>
                {historyRows.map((row) => (
                  <tr key={row.id} className="border-b border-slate-50 last:border-0">
                    <td className="py-3 pr-3 font-mono text-[12.5px] text-slate-700">{row.token_preview || '—'}</td>
                    <td className="py-3 pr-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${historyBadge(row.status).cls}`}>{historyBadge(row.status).label}</span>
                    </td>
                    <td className="py-3 pr-3 text-xs text-slate-500">{row.created_at ? new Date(row.created_at).toLocaleString() : '—'}</td>
                    <td className="py-3 pr-3 text-xs text-slate-500">{row.created_by_name || '—'}</td>
                    <td className="py-3 pr-3 text-xs text-slate-500">{row.revoked_at ? new Date(row.revoked_at).toLocaleString() : '—'}</td>
                    <td className="py-3 text-xs text-slate-500">{row.revoked_by_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  ) : null

  if (loading) return <LoadingState label="Loading QR attendance terminals..." />

  return (
    <div className="max-w-5xl space-y-5">
      <div>
        <p className="text-sm text-slate-500">Generate a public QR terminal link for reception or an office entrance. The QR contains only a revocable random terminal token, never employee credentials or employee data.</p>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-5">
        <div className="flex items-center gap-2">
          <QrCode className="w-5 h-5 text-[#009944]" />
          <h3 className="font-semibold text-slate-900">QR Attendance Terminal</h3>
        </div>
        <div>
          <label className={labelCls}>Terminal device</label>
          <select className={inputCls} value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
            <option value="">Create or use the default QR terminal</option>
            {devices.map((device) => <option key={device.id} value={device.id}>{device.device_name} · {device.status}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={generate} disabled={busy} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />} {terminalLink ? 'Regenerate QR' : 'Generate QR'}
          </button>
          {selectedId && <button onClick={revoke} disabled={busy} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-rose-200 text-rose-700 text-sm font-medium hover:bg-rose-50 disabled:opacity-50">Revoke QR</button>}
        </div>

        {terminalLink && (
          <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-6 items-center border-t border-slate-100 pt-5">
            <div className="bg-white border border-slate-200 rounded-xl p-4 w-fit">
              <QRCodeCanvas id="attendance-terminal-qr" value={terminalLink} size={240} level="H" includeMargin />
            </div>
            <div className="space-y-3 min-w-0">
              <p className="text-sm font-medium text-slate-800">Scan to open Attendance Terminal</p>
              <p className="text-xs text-slate-500 break-all">{terminalLink}</p>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => copyLink(terminalLink)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-slate-600 text-xs hover:bg-slate-50"><Copy className="w-3.5 h-3.5" /> Copy link</button>
                <button onClick={() => downloadQr()} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-slate-600 text-xs hover:bg-slate-50"><Download className="w-3.5 h-3.5" /> Download</button>
                <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-slate-600 text-xs hover:bg-slate-50"><Printer className="w-3.5 h-3.5" /> Print</button>
              </div>
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">Regenerating or revoking invalidates the previous QR link. Employees still provide their own employee number and device location at the terminal.</p>
            </div>
          </div>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
        <div>
          <h3 className="font-semibold text-slate-900">Terminal devices</h3>
          <p className="text-sm text-slate-500 mt-1">Every QR attendance terminal. Active terminals accept scans, suspended ones are paused with their token kept, revoked terminals are permanently disabled, and only revoked terminals can be deleted.</p>
        </div>

        {devices.length === 0 ? (
          <EmptyState title="No attendance terminals yet" description="Generate a QR above to create your first terminal." />
        ) : (
          <div className="overflow-x-auto -mx-6 px-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-400 border-b border-slate-100">
                  <th className="py-2 pr-3 font-medium">Terminal</th>
                  <th className="py-2 pr-3 font-medium">Branch</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium">Generated</th>
                  <th className="py-2 pr-3 font-medium">Last seen</th>
                  <th className="py-2 pr-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((device) => (
                  <tr key={device.id} className="border-b border-slate-50 last:border-0">
                    <td className="py-3 pr-3">
                      <p className="font-medium text-slate-800">{device.device_name}</p>
                      <p className="text-xs text-slate-400">QR terminal · {device.active === false ? 'disabled' : 'enabled'}</p>
                      {(device.custom_lat != null || device.geofence_id || device.location_id) && (
                        <p className="text-xs mt-0.5">
                          {device.geofence_id || device.location_id
                            ? <span className="text-emerald-600 font-medium">Geofence-linked</span>
                            : <span className="text-sky-600 font-medium">Custom location · {device.radius_meters || 150}m</span>}
                        </p>
                      )}
                    </td>
                    <td className="py-3 pr-3 text-xs text-slate-600">{branchLabel(device.branch_id)}</td>
                    <td className="py-3 pr-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${statusMeta(device).cls}`}>{statusMeta(device).label}</span>
                    </td>
                    <td className="py-3 pr-3 text-xs text-slate-500">{device.token_generated_at ? new Date(device.token_generated_at).toLocaleString() : '—'}</td>
                    <td className="py-3 pr-3 text-xs text-slate-500">{device.last_seen_at ? new Date(device.last_seen_at).toLocaleString() : 'Never scanned'}</td>
                    <td className="py-3">
                      {busyId === device.id ? <Loader2 className="w-4 h-4 animate-spin text-[#009944]" /> : renderActions(device)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {qrModal}
      {historyModal}

      <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold text-slate-900 flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-[#009944]" /> HR Review — cross-branch clock-ins</h3>
            <p className="text-sm text-slate-500 mt-1">Terminal clock-ins where the terminal's branch differs from the employee's assigned branch are auto-flagged and sent here. Approve legitimate entries, or raise a query for the employee to clarify (an in-app query + notification is created).</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {[['PENDING_REVIEW', 'Pending'], ['FLAGGED_QUERY_ISSUED', 'Queried'], ['APPROVED', 'Approved'], ['ALL', 'All']].map(([value, label]) => (
              <button key={value} onClick={() => { setReviewStatus(value); loadReviews(value) }}
                className={`px-3 py-1 rounded-full text-xs font-medium border ${reviewStatus === value ? 'bg-[#009944] text-white border-[#009944]' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {reviewLoading ? (
          <div className="py-8 text-center">
            <Loader2 className="w-5 h-5 mx-auto animate-spin text-[#009944]" />
            <p className="text-sm text-slate-500 mt-2">Loading HR review records…</p>
          </div>
        ) : reviews.length === 0 ? (
          <EmptyState
            title="No records to review"
            description={reviewStatus === 'PENDING_REVIEW'
              ? 'No cross-branch clock-ins awaiting review. They appear here automatically when an employee clocks in at a terminal outside their assigned branch.'
              : `No ${reviewStatus?.replace(/_/g, ' ').toLowerCase() || ''} records.`}
          />
        ) : (
          <div className="overflow-x-auto -mx-6 px-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-400 border-b border-slate-100">
                  <th className="py-2 pr-3 font-medium">Employee</th>
                  <th className="py-2 pr-3 font-medium">Original branch → Terminal</th>
                  <th className="py-2 pr-3 font-medium">Clock-in</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium">Note / comment</th>
                  {reviewStatus === 'PENDING_REVIEW' || reviewStatus === 'FLAGGED_QUERY_ISSUED' ? <th className="py-2 font-medium">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {reviews.map((record) => (
                  <tr key={record.record_id} className="border-b border-slate-50 last:border-0">
                    <td className="py-3 pr-3">
                      <p className="font-medium text-slate-800">{record.employee_name || '—'}</p>
                      <p className="text-xs text-slate-400">{record.employee_number || ''}</p>
                    </td>
                    <td className="py-3 pr-3 text-xs text-slate-600">
                      <p>{record.original_branch_name || '—'} <span className="text-slate-400">→</span> <span className="font-medium text-slate-800">{record.clocked_in_branch_name || '—'}</span></p>
                      <p className="text-slate-400 mt-0.5">{record.terminal_name}</p>
                    </td>
                    <td className="py-3 pr-3 text-xs text-slate-500">
                      {record.clock_in_at ? new Date(record.clock_in_at).toLocaleString() : '—'}
                      {record.terminal_geofence_distance != null && (
                        <p className="text-slate-400 mt-0.5">{Math.round(record.terminal_geofence_distance)}m from terminal</p>
                      )}
                    </td>
                    <td className="py-3 pr-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${
                        record.hr_review_status === 'PENDING_REVIEW' ? 'bg-amber-100 text-amber-700'
                          : record.hr_review_status === 'FLAGGED_QUERY_ISSUED' ? 'bg-rose-100 text-rose-700'
                          : 'bg-emerald-100 text-emerald-700'
                      }`}>
                        {record.hr_review_status?.replace(/_/g, ' ') || '—'}
                      </span>
                      {record.hr_reviewed_at && <p className="text-xs text-slate-400 mt-0.5">{new Date(record.hr_reviewed_at).toLocaleString()}</p>}
                    </td>
                    <td className="py-3 pr-3">
                      {record.hr_query_note && (
                        <p className="text-xs text-rose-700 bg-rose-50 border border-rose-100 rounded-lg p-2">{record.hr_query_note}</p>
                      )}
                      {record.hr_review_comment && (
                        <p className="text-xs text-slate-500 bg-slate-50 border border-slate-100 rounded-lg p-2 mt-1">{record.hr_review_comment}</p>
                      )}
                      {!record.hr_query_note && !record.hr_review_comment && <span className="text-xs text-slate-400">—</span>}
                    </td>
                    {(reviewStatus === 'PENDING_REVIEW' || reviewStatus === 'FLAGGED_QUERY_ISSUED') && (
                      <td className="py-3">
                        {reviewBusyId === record.record_id ? (
                          <Loader2 className="w-4 h-4 animate-spin text-[#009944]" />
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            <button onClick={() => approveReview(record)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-200 text-emerald-700 text-xs font-medium hover:bg-emerald-50">
                              <Check className="w-3.5 h-3.5" /> Approve
                            </button>
                            <button onClick={() => setReviewModal({ record_id: record.record_id, name: record.employee_name || 'employee', note: '' })} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rose-200 text-rose-700 text-xs font-medium hover:bg-rose-50">
                              <MessageSquare className="w-3.5 h-3.5" /> Flag query
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {reviewModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" onClick={() => setReviewModal(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-semibold text-slate-900">Flag attendance for {reviewModal.name}</h3>
                <p className="text-xs text-slate-500 mt-1">Raises an employee query (category: attendance) and notifies the employee to respond.</p>
              </div>
              <button onClick={() => setReviewModal(null)} className="p-1 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <div>
              <label className={labelCls}>Query note (minimum 5 characters)</label>
              <textarea
                className={`${inputCls} h-28 py-2`}
                value={reviewModal.note}
                onChange={(e) => setReviewModal({ ...reviewModal, note: e.target.value })}
                placeholder="Why is this clock-in being questioned?"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setReviewModal(null)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={flagReview} disabled={reviewBusyId === reviewModal.record_id || !reviewModal.note?.trim() || reviewModal.note.trim().length < 5} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-medium hover:bg-rose-700 disabled:opacity-50">
                {reviewBusyId === reviewModal.record_id ? <Loader2 className="w-4 h-4 animate-spin" /> : <MessageSquare className="w-4 h-4" />} Raise Query
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================
// DEVICE BINDING TAB — one device, one employee per day.
// HR/super-admin oversight for the QR terminal buddy-punching guard:
// inspect the active bindings, review blocked attempts, and clear a
// specific (device, date) binding when the block was a false positive.
// ============================================================
function DeviceBindingsTab({ setNotice }) {
  const [date, setDate] = useState('')
  const [bindings, setBindings] = useState(null)
  const [blocks, setBlocks] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyHash, setBusyHash] = useState(null)
  const [error, setError] = useState('')

  const load = async (d) => {
    setLoading(true)
    setError('')
    try {
      const [rows, blockRows] = await Promise.all([
        attendanceService.listDeviceBindings(d || null),
        attendanceService.listDeviceBindingBlocks(d || null, 20),
      ])
      setBindings(rows || [])
      setBlocks(blockRows || [])
    } catch (e) {
      setError(e?.message || 'Failed to load device bindings')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load(date) }, [])

  const clear = async (binding) => {
    const confirmed = window.confirm(
      `Clear the device binding for ${binding.employee_full_name || binding.employee_number || 'employee'} on ${binding.binding_date}?\n\n` +
      'The device can then be used by a different employee for this date.'
    )
    if (!confirmed) return
    setBusyHash(binding.device_fingerprint_hash)
    setError('')
    try {
      await attendanceService.clearDeviceBinding(binding.device_fingerprint_hash, binding.binding_date, 'Cleared by HR')
      setNotice({ kind: 'ok', text: `Device binding cleared for ${binding.binding_date}.` })
      await load(date)
    } catch (e) {
      setError(e?.message || 'Failed to clear device binding')
    } finally {
      setBusyHash(null)
    }
  }

  const applyDate = () => { load(date || null) }

  const shortHash = (h) => (h && h.length > 12 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h || '—')

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex flex-wrap items-end gap-3 justify-between">
        <div>
          <p className="text-sm text-slate-500">Each device fingerprint is bound to one employee per calendar day (Africa/Lagos attendance day). Another employee on the same device is blocked, including spoofed requests.</p>
        </div>
        <div className="flex items-end gap-2">
          <div>
            <label className={`${labelCls} !mb-1`}>Date (blank = today)</label>
            <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <button onClick={applyDate} className="inline-flex items-center gap-1.5 px-3 h-10 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
            <RefreshCw className="w-4 h-4" /> Load
          </button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 text-rose-700 text-sm p-3">{error}</div>}

      {loading ? (
        <LoadingState label="Loading device bindings..." />
      ) : (
        <>
          <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
            <div className="flex items-center gap-2">
              <Fingerprint className="w-5 h-5 text-[#009944]" />
              <h3 className="font-semibold text-slate-900">Device → employee bindings</h3>
            </div>
            {!bindings || bindings.length === 0 ? (
              <EmptyState title="No bindings" description="No device clock-ins on this date yet." />
            ) : (
              <div className="overflow-x-auto -mx-6 px-6">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-400 border-b border-slate-100">
                      <th className="py-2 pr-3 font-medium">Device ref</th>
                      <th className="py-2 pr-3 font-medium">Employee</th>
                      <th className="py-2 pr-3 font-medium">Attendance date</th>
                      <th className="py-2 pr-3 font-medium">First used</th>
                      <th className="py-2 pr-3 font-medium">Last seen</th>
                      <th className="py-2 pr-3 font-medium">Status</th>
                      <th className="py-2 pr-3 font-medium">Last terminal used</th>
                      <th className="py-2 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bindings.map((b) => (
                      <tr key={`${b.device_fingerprint_hash}-${b.binding_date}`} className="border-b border-slate-50 last:border-0">
                        <td className="py-3 pr-3 font-mono text-xs text-slate-500">{shortHash(b.device_fingerprint_hash)}</td>
                        <td className="py-3 pr-3">
                          <p className="font-medium text-slate-800">{b.employee_full_name || '—'}</p>
                          <p className="text-xs text-slate-400">{b.employee_number || ''}</p>
                        </td>
                        <td className="py-3 pr-3 text-xs text-slate-500">{b.binding_date || b.attendance_date || '—'}</td>
                        <td className="py-3 pr-3 text-xs text-slate-500">{b.first_used_at ? new Date(b.first_used_at).toLocaleString() : '—'}</td>
                        <td className="py-3 pr-3 text-xs text-slate-500">{b.last_seen_at ? new Date(b.last_seen_at).toLocaleString() : '—'}</td>
                        <td className="py-3 pr-3">
                          <span className="inline-flex px-2 py-0.5 rounded-full border text-xs bg-emerald-50 text-emerald-700 border-emerald-200">
                            {b.status || 'Active'}
                          </span>
                        </td>
                        <td className="py-3 pr-3 text-xs text-slate-500">{b.last_terminal_name || b.terminal_name || '—'}</td>
                        <td className="py-3">
                          <button onClick={() => clear(b)} disabled={busyHash === b.device_fingerprint_hash}
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-rose-200 text-rose-600 text-xs font-medium hover:bg-rose-50 disabled:opacity-50">
                            {busyHash === b.device_fingerprint_hash ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />} Clear
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-slate-400">Clearing a binding is audited and lets another employee use the device for this date.</p>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-amber-500" />
              <h3 className="font-semibold text-slate-900">Blocked attempts</h3>
              <span className="text-xs text-slate-400">(audit trail)</span>
            </div>
            {blocks.length === 0 ? (
              <p className="text-sm text-slate-400">No blocked attempts on this date.</p>
            ) : (
              <div className="space-y-2 max-h-80 overflow-y-auto">
                {blocks.map((blk, i) => {
                  let details = blk.details || ''
                  try { details = JSON.stringify(JSON.parse(details), null, 2) } catch (_) { /* raw text */ }
                  return (
                    <div key={i} className="rounded-lg border border-slate-100 bg-slate-50 p-3 text-xs">
                      <p className="text-slate-500">{new Date(blk.created_at).toLocaleString()} · severity: {blk.severity}</p>
                      <pre className="mt-1 whitespace-pre-wrap font-mono text-slate-600">{details}</pre>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
