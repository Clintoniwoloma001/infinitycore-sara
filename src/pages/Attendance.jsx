import React, { useEffect, useState, useMemo } from 'react'
import { Calendar, TrendingUp, Clock, CheckCircle2, AlertTriangle, XCircle, Activity } from 'lucide-react'
import { attendanceService } from '../services/attendanceService'
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

export default function Attendance() {
  const [employee, setEmployee] = useState(null)
  const [record, setRecord] = useState(null)
  const [history, setHistory] = useState([])
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
    try {
      const r = await attendanceService.clockIn(geo)
      setMessage({ kind: 'ok', text: `Clocked in at ${new Date(r.clock_in_at).toLocaleTimeString()}.${r.late_minutes > 0 ? ` You are ${r.late_minutes} minutes late.` : ''}` })
      await load()
    } catch (e) {
      setMessage({ kind: 'error', text: e?.message || 'Clock in failed' })
    } finally {
      setBusy(false)
    }
  }

  const doClockOut = async (geo) => {
    setBusy(true)
    setMessage({})
    try {
      const r = await attendanceService.clockOut(record?.id, geo)
      setMessage({ kind: 'ok', text: `Clocked out at ${new Date(r.clock_out_at).toLocaleTimeString()}. Worked ${r.work_hours} hours.` })
      await load()
    } catch (e) {
      setMessage({ kind: 'error', text: e?.message || 'Clock out failed' })
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
