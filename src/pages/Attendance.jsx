import React, { useEffect, useState, useMemo } from 'react'
import { Calendar, TrendingUp, Clock, CheckCircle2, AlertTriangle, XCircle, Activity } from 'lucide-react'
import { attendanceService } from '../services/attendanceService'
import { attendanceEngineService } from '../services/attendanceEngineService'
import { useAuth } from '../hooks/useAuth'
import { LoadingState, EmptyState } from '../components/PageStates'
import ClockCard from '../components/attendance/ClockCard'
import TrendChart from '../components/attendance/TrendChart'
import SaraBriefing from '../components/attendance/SaraBriefing'

const FILTERS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This Week' },
  { key: 'month', label: 'This Month' },
  { key: 'prev_month', label: 'Previous Month' },
  { key: 'quarter', label: 'Quarter' },
]

function dateRange(filter) {
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  switch (filter) {
    case 'today':
      return { start: today, end: today }
    case 'week': {
      const day = now.getDay() || 7
      const monday = new Date(now)
      monday.setDate(now.getDate() - day + 1)
      const sunday = new Date(monday)
      sunday.setDate(monday.getDate() + 6)
      return { start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) }
    }
    case 'month':
      return { start: new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10), end: new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10) }
    case 'prev_month': {
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      return { start: prev.toISOString().slice(0, 10), end: new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10) }
    }
    case 'quarter': {
      const q = Math.floor(now.getMonth() / 3)
      return { start: new Date(now.getFullYear(), q * 3, 1).toISOString().slice(0, 10), end: new Date(now.getFullYear(), q * 3 + 3, 0).toISOString().slice(0, 10) }
    }
    default:
      return { start: today, end: today }
  }
}

const LATE_REASONS = [
  { key: 'traffic', label: 'Traffic' },
  { key: 'transport_delay', label: 'Transport delay' },
  { key: 'medical', label: 'Medical' },
  { key: 'personal_emergency', label: 'Personal emergency' },
  { key: 'official_assignment', label: 'Official assignment' },
  { key: 'approved_exception', label: 'Approved exception' },
  { key: 'other', label: 'Other' },
]

const ISSUE_TYPES = [
  { key: 'forgot_clock_in', label: 'Forgot to clock in' },
  { key: 'forgot_clock_out', label: 'Forgot to clock out' },
  { key: 'gps_problem', label: 'GPS problem' },
  { key: 'fingerprint_not_recognized', label: 'Fingerprint not recognized' },
  { key: 'device_unavailable', label: 'Device unavailable' },
  { key: 'network_failure', label: 'Network failure' },
  { key: 'wrong_time', label: 'Wrong attendance time' },
  { key: 'wrong_location', label: 'Wrong location' },
  { key: 'other', label: 'Other' },
]

export default function Attendance() {
  const { name } = useAuth()
  const [employee, setEmployee] = useState(null)
  const [record, setRecord] = useState(null)
  const [history, setHistory] = useState([])
  const [config, setConfig] = useState(null)
  const [geofences, setGeofences] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState({ kind: '', text: '' })
  const [filter, setFilter] = useState('month')

  const load = async () => {
    setLoading(true)
    try {
      const emp = await attendanceService.getMyEmployee()
      setEmployee(emp)
      if (emp) {
        const today = await attendanceService.getToday(emp.id)
        setRecord(today)
        const range = dateRange(filter)
        const hist = await attendanceService.getHistory(emp.id, range)
        setHistory(hist)
      }
      try {
        const cfg = await attendanceEngineService.getConfig()
        setConfig(cfg)
        if (cfg?.geofence_enabled) {
          const gf = await attendanceEngineService.listGeofences()
          setGeofences(gf.filter((g) => g.active))
        }
      } catch { /* config may not exist yet */ }
    } catch (e) {
      setMessage({ kind: 'error', text: e?.message || 'Unable to load attendance' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [filter])

  const doClockIn = async (geo) => {
    setBusy(true)
    setMessage({})
    setClockAnim(true)
    setGeofenceBlocked(null)
    try {
      const r = await attendanceService.clockIn(geo)
      setMessage({ kind: 'ok', text: `Clocked in at ${new Date(r.clock_in_at).toLocaleTimeString()}.${r.late_minutes > 0 ? ` You are ${r.late_minutes} minutes late.` : ''}` })
      await load()
    } catch (e) {
      setMessage({ kind: 'error', text: e?.message || 'Clock in failed' })
    } finally {
      setBusy(false)
      setTimeout(() => setClockAnim(false), 600)
    }
  }

  const doClockOut = async (geo) => {
    setBusy(true)
    setMessage({})
    setClockAnim(true)
    try {
      const r = await attendanceService.clockOut(record?.id, geo)
      setMessage({ kind: 'ok', text: `Clocked out at ${new Date(r.clock_out_at).toLocaleTimeString()}. Worked ${r.work_hours} hours.` })
      await load()
    } catch (e) {
      setMessage({ kind: 'error', text: e?.message || 'Clock out failed' })
    } finally {
      setBusy(false)
      setTimeout(() => setClockAnim(false), 600)
    }
  }

  const submitLateReason = async (reason, customExplanation) => {
    setBusy(true)
    try {
      await attendanceService.submitException({
        attendanceId: lateModal.attendanceId,
        employeeId: lateModal.employeeId,
        exceptionType: 'late_arrival',
        reason,
        customExplanation,
        expectedTime: lateModal.expectedTime,
        actualTime: lateModal.actualTime,
      })
      setMessage({ kind: 'ok', text: 'Late reason submitted for HR review.' })
      setLateModal(null)
    } catch (e) {
      setMessage({ kind: 'error', text: e?.message || 'Failed to submit reason' })
    } finally {
      setBusy(false)
    }
  }

  const submitIssue = async (issueData) => {
    setBusy(true)
    try {
      await attendanceService.submitIssue({
        employeeId: employee.id,
        issueDate: issueData.date,
        issueType: issueData.type,
        explanation: issueData.explanation,
      })
      setMessage({ kind: 'ok', text: 'Attendance issue submitted for HR review.' })
      setIssueModal(false)
    } catch (e) {
      setMessage({ kind: 'error', text: e?.message || 'Failed to submit issue' })
    } finally {
      setBusy(false)
    }
  }

  // Compute stats
  const stats = useMemo(() => {
    if (!history.length) return { present: 0, absent: 0, late: 0, onTime: 0, earlyDep: 0, avgHours: 0, pct: 0, streak: 0 }
    const present = history.filter((r) => r.clock_in).length
    const late = history.filter((r) => r.status === 'late').length
    const onTime = history.filter((r) => r.status === 'present' && r.clock_in).length
    const earlyDep = history.filter((r) => r.status === 'early_exit').length
    const withHours = history.filter((r) => r.work_hours != null)
    const avgHours = withHours.length > 0 ? (withHours.reduce((s, r) => s + parseFloat(r.work_hours), 0) / withHours.length).toFixed(1) : 0
    const workingDays = history.length
    const pct = workingDays > 0 ? Math.round((present / workingDays) * 100) : 0
    // Streak: consecutive days with clock_in, most recent first
    let streak = 0
    for (const r of history) {
      if (r.clock_in) streak++
      else break
    }
    return { present, absent: workingDays - present, late, onTime, earlyDep, avgHours, pct, streak }
  }, [history])

  // Trend data for chart
  const trendData = useMemo(() => {
    const days = [...history].reverse().slice(-14)
    return days.map((r) => ({
      label: new Date(r.attendance_date).toLocaleDateString('en-US', { weekday: 'short' }).charAt(0),
      value: r.work_hours ? parseFloat(r.work_hours) : 0,
      color: r.status === 'late' ? '#f59e0b' : r.status === 'early_exit' ? '#f97316' : r.clock_in ? '#009944' : '#e2e8f0',
    }))
  }, [history])

  if (loading) return <LoadingState label="Loading attendance..." />

  if (!employee) {
    return (
      <div>
        <h2 className="text-2xl font-semibold text-slate-900 mb-4">My Attendance</h2>
        <EmptyState
          title="No employee profile linked"
          description="Your account is not yet linked to an employee record. Ask HR to link your profile so you can clock in and out."
        />
      </div>
    )
  }

  return (
    <div className="max-w-5xl">
      <h2 className="text-2xl font-semibold text-slate-900 mb-1">My Attendance</h2>
      <p className="text-sm text-slate-500 mb-6">Clock in, clock out, and track your attendance.</p>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* Clock card — takes 2 columns */}
        <div className="lg:col-span-2">
          <ClockCard
            record={record}
            employee={employee}
            onClockIn={doClockIn}
            onClockOut={doClockOut}
            busy={busy}
            message={message}
          />
        </div>

        {/* SARA briefing */}
        <div>
          <SaraBriefing records={history} isManager={false} />
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
        <StatCard icon={CheckCircle2} label="Days Present" value={stats.present} color="text-emerald-600" />
        <StatCard icon={XCircle} label="Days Absent" value={stats.absent} color="text-rose-600" />
        <StatCard icon={AlertTriangle} label="Late Days" value={stats.late} color="text-amber-600" />
        <StatCard icon={Clock} label="On-Time" value={stats.onTime} color="text-blue-600" />
        <StatCard icon={Activity} label="Early Dep." value={stats.earlyDep} color="text-orange-600" />
        <StatCard icon={TrendingUp} label="Avg Hours" value={stats.avgHours} color="text-violet-600" />
        <StatCard icon={Calendar} label="Attendance %" value={`${stats.pct}%`} color="text-[#009944]" />
      </div>

      {/* Trend chart */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 mb-6">
        <h3 className="text-sm font-semibold text-slate-700 mb-4">Attendance Trend — Hours Worked</h3>
        <TrendChart data={trendData} />
      </div>

      {/* Filter + History table */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-slate-900">Attendance History</h3>
        <div className="flex gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap ${filter === f.key ? 'bg-[#009944] text-white' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {history.length === 0 ? (
        <EmptyState title="No attendance records" description="Your attendance history will appear here once you start clocking in." />
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                <th className="px-5 py-3 font-medium">Date</th>
                <th className="px-5 py-3 font-medium">Clock In</th>
                <th className="px-5 py-3 font-medium">Clock Out</th>
                <th className="px-5 py-3 font-medium">Hours</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Late</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {history.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3 text-slate-700">{new Date(r.attendance_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
                  <td className="px-5 py-3 text-slate-700 tabular-nums">{r.clock_in ? new Date(r.clock_in).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                  <td className="px-5 py-3 text-slate-700 tabular-nums">{r.clock_out ? new Date(r.clock_out).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                  <td className="px-5 py-3 text-slate-700 tabular-nums">{r.work_hours || '—'}</td>
                  <td className="px-5 py-3"><StatusPill status={r.status} /></td>
                  <td className="px-5 py-3 text-slate-600">{r.late_minutes > 0 ? `${r.late_minutes}m` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Late Arrival Modal */}
      {lateModal && <LateModal data={lateModal} onSubmit={submitLateReason} onClose={() => setLateModal(null)} busy={busy} />}

      {/* Attendance Issue Modal */}
      {issueModal && <IssueModal onSubmit={submitIssue} onClose={() => setIssueModal(false)} busy={busy} />}
    </div>
  )
}

// Source badge component
function SourceBadge({ source }) {
  const config = {
    WEB: { label: 'Web', color: 'bg-blue-50 text-blue-700' },
    MOBILE: { label: 'Mobile', color: 'bg-cyan-50 text-cyan-700' },
    FINGERPRINT: { label: 'Fingerprint', color: 'bg-purple-50 text-purple-700' },
    BIOMETRIC_DEVICE: { label: 'Biometric', color: 'bg-indigo-50 text-indigo-700' },
    ATTENDANCE_TERMINAL: { label: 'Terminal', color: 'bg-slate-100 text-slate-700' },
    ADMIN: { label: 'Admin', color: 'bg-amber-50 text-amber-700' },
    API: { label: 'API', color: 'bg-emerald-50 text-emerald-700' },
    IMPORT: { label: 'Import', color: 'bg-orange-50 text-orange-700' },
  }
  const s = (source || 'WEB').toUpperCase()
  const c = config[s] || config.WEB
  return <span className={`text-xs px-2 py-0.5 rounded-full ${c.color}`}>{c.label}</span>
}

// ============================================================
// LATE ARRIVAL MODAL
// ============================================================
function LateModal({ data, onSubmit, onClose, busy }) {
  const [reason, setReason] = useState('')
  const [custom, setCustom] = useState('')

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 animate-[fadeIn_0.15s_ease]">
      <div className="bg-white rounded-xl w-full max-w-md p-6 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
              <Clock3 className="w-5 h-5 text-amber-600" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-slate-900">You're clocking in late</h3>
              <p className="text-sm text-slate-500">Please provide a reason</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="rounded-lg bg-slate-50 p-3">
            <p className="text-xs text-slate-400">Expected time</p>
            <p className="text-lg font-semibold text-slate-700">{data.expectedTime}</p>
          </div>
          <div className="rounded-lg bg-amber-50 p-3">
            <p className="text-xs text-amber-500">Current time</p>
            <p className="text-lg font-semibold text-amber-700">{data.actualTime}</p>
          </div>
        </div>

        <div className="space-y-2 mb-4">
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Reason</label>
          {LATE_REASONS.map((r) => (
            <button
              key={r.key}
              onClick={() => setReason(r.key)}
              className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg border text-sm text-left transition ${reason === r.key ? 'border-[#009944] bg-emerald-50' : 'border-slate-200 hover:bg-slate-50'}`}
            >
              <div className={`w-4 h-4 rounded-full border-2 ${reason === r.key ? 'border-[#009944] bg-[#009944]' : 'border-slate-300'}`} />
              {r.label}
            </button>
          ))}
        </div>

        {reason === 'other' && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Custom explanation</label>
            <textarea
              className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]"
              rows={2}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="Please explain..."
            />
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Skip</button>
          <button
            onClick={() => onSubmit(reason, custom)}
            disabled={busy || !reason}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Submit Reason
          </button>
        </div>
      </div>
    </div>
  )
}

function StatCard({ icon: Icon, label, value, color }) {
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
