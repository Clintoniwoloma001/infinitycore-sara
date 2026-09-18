import React, { useEffect, useState, useMemo, useCallback } from 'react'
import { Calendar, TrendingUp, Clock, Clock3, CheckCircle2, AlertTriangle, AlertCircle, XCircle, Activity, X, Loader2, Send, Building2, Users, Search, ArrowRight, Shield, Plus } from 'lucide-react'
import { useNavigate, Link } from 'react-router-dom'
import { attendanceService, DEFAULT_ATTENDANCE_TIMEZONE, formatAttendanceTime, formatWorkedHours, getNetworkTime, platformDateKey } from '../services/attendanceService'
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

// Date-range math on YYYY-MM-DD keys (pure UTC arithmetic) so period
// boundaries stay correct regardless of the browser's timezone.
function keyParts(key) {
  const [y, m, d] = key.split('-').map(Number)
  return { y, m, d }
}

function addDays(key, delta) {
  const { y, m, d } = keyParts(key)
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10)
}

function monthKey(key, deltaMonths, day) {
  const { y, m } = keyParts(key)
  const dt = new Date(Date.UTC(y, m - 1 + deltaMonths, day))
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

function dateRange(filter, referenceDate = new Date(), timeZone = DEFAULT_ATTENDANCE_TIMEZONE) {
  const today = platformDateKey(referenceDate, timeZone)
  switch (filter) {
    case 'today':
      return { start: today, end: today }
    case 'week': {
      const { y, m, d } = keyParts(today)
      const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7
      const monday = addDays(today, -(dow - 1))
      return { start: monday, end: addDays(monday, 6) }
    }
    case 'month':
      return { start: monthKey(today, 0, 1), end: monthKey(today, 1, 0) }
    case 'prev_month':
      return { start: monthKey(today, -1, 1), end: monthKey(today, 0, 0) }
    case 'quarter': {
      const { y, m } = keyParts(today)
      const qStart = Math.floor((m - 1) / 3) * 3 + 1
      const first = `${y}-${String(qStart).padStart(2, '0')}-01`
      return { start: first, end: monthKey(first, 2, 0) }
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
  const { name, role, isAdmin, hasPermission } = useAuth()
  const navigate = useNavigate()
  const [employee, setEmployee] = useState(null)
  const [record, setRecord] = useState(null)
  const [history, setHistory] = useState([])
  const [config, setConfig] = useState(null)
  const [requirements, setRequirements] = useState(null)
  const [attendanceToday, setAttendanceToday] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState({ kind: '', text: '' })
  const [filter, setFilter] = useState('month')
  const [lateModal, setLateModal] = useState(null)
  const [issueModal, setIssueModal] = useState(false)
  const [clockAnim, setClockAnim] = useState(false)
  const [geofenceBlocked, setGeofenceBlocked] = useState(null)

  // Role-scoped views
  const isBranchManager = role === 'branch_manager' || hasPermission('attendance.branch.read')
  const isAreaManager = role === 'area_manager' || hasPermission('attendance.area.read')
  const isHRorAdmin = ['super_admin', 'admin', 'hr_manager', 'hr_officer'].includes(role) || isAdmin
  const [viewScope, setViewScope] = useState('my') // 'my' | 'branch' | 'area'
  const [teamRows, setTeamRows] = useState([])
  const [teamLoading, setTeamLoading] = useState(false)
  const [teamDate, setTeamDate] = useState('')
  const [teamSearch, setTeamSearch] = useState('')

  const loadTeamAttendance = useCallback(async () => {
    if (viewScope === 'my') return
    setTeamLoading(true)
    try {
      const data = await attendanceService.listAll({
        startDate: teamDate,
        endDate: teamDate,
        branchId: viewScope === 'branch' ? employee?.branch_id : undefined,
      })
      let filtered = data || []
      if (viewScope === 'branch' && employee?.branch) {
        filtered = filtered.filter((r) => r.branch_id === employee.branch_id || r.employees?.branch === employee.branch)
      }
      setTeamRows(filtered)
    } catch (e) {
      console.warn('Failed to load team attendance:', e)
    } finally {
      setTeamLoading(false)
    }
  }, [viewScope, teamDate, employee])

  useEffect(() => {
    if (viewScope !== 'my') {
      loadTeamAttendance()
    }
  }, [viewScope, teamDate, loadTeamAttendance])

  const load = async () => {
    setLoading(true)
    try {
      // Reconcile yesterday's open sessions before reading today's record.
      // The database RPC is idempotent and closes sessions platform-wide.
      try {
        await attendanceService.reconcileAutoClockouts()
      } catch (e) {
        console.warn('Attendance auto-clockout reconciliation unavailable:', e)
      }
      const req = await attendanceService.getAttendanceRequirements()
      setRequirements(req)
      const networkTime = await getNetworkTime()
      const networkToday = platformDateKey(new Date(networkTime.serverTimeMs), req.appTimezone)
      setAttendanceToday(networkToday)
      setTeamDate((current) => current || networkToday)
      const emp = await attendanceService.getMyEmployee()
      setEmployee(emp)
      if (emp) {
        const today = await attendanceService.getToday(emp.id)
        setRecord(today)
        const range = dateRange(filter, new Date(networkTime.serverTimeMs), req.appTimezone)
        const hist = await attendanceService.getHistory(emp.id, { startDate: range.start, endDate: range.end })
        setHistory(hist)
      }
      try {
        const cfg = await attendanceEngineService.getConfig()
        setConfig(cfg)
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
      setMessage({ kind: 'ok', text: `Clocked in at ${formatAttendanceTime(r.clock_in_at, schedule.timezone)}.${r.late_minutes > 0 ? ` You are ${r.late_minutes} minutes late.` : ''}` })
      if (r.late_minutes > 0) {
        setLateModal({
          attendanceId: r.attendance_id,
          employeeId: employee.id,
           expectedTime: config?.expected_start_time || schedule?.workStartTime || 'configured time',
          actualTime: formatAttendanceTime(r.clock_in_at, schedule.timezone),
        })
      }
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
      setMessage({ kind: 'ok', text: `Clocked out at ${formatAttendanceTime(r.clock_out_at, schedule.timezone)}. Worked ${r.work_hours} hours.` })
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
    const late = history.filter((r) => r.status === 'late' || (r.late_minutes || 0) > 0).length
    const onTime = history.filter((r) => r.clock_in && !(r.status === 'late' || (r.late_minutes || 0) > 0)).length
    const earlyDep = history.filter((r) => r.status === 'early_exit').length
    const withHours = history.filter((r) => r.clock_in && r.clock_out)
    const avgHours = withHours.length > 0 ? (withHours.reduce((s, r) => s + (r.computed_work_hours ?? (Number(r.work_hours) || 0)), 0) / withHours.length).toFixed(1) : 0
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

  const schedule = useMemo(
    () => attendanceService.scheduleFor(employee, requirements),
    [employee, requirements],
  )

  // Must be declared before any early return so hook count is stable.
  const searchedTeamRows = useMemo(() => {
    if (!teamSearch.trim()) return teamRows
    const q = teamSearch.toLowerCase()
    return teamRows.filter((r) =>
      r.employees?.full_name?.toLowerCase().includes(q) ||
      r.employees?.department?.toLowerCase().includes(q) ||
      r.employees?.position?.toLowerCase().includes(q) ||
      r.status?.toLowerCase().includes(q)
    )
  }, [teamRows, teamSearch])

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
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900 mb-1">
            {viewScope === 'branch' ? `Branch Attendance — ${employee?.branch || 'My Branch'}` : viewScope === 'area' ? 'Area Attendance' : 'My Attendance'}
          </h2>
          <p className="text-sm text-slate-500">
            {viewScope === 'branch'
              ? 'Attendance records and daily oversight for team members in your branch.'
              : viewScope === 'area'
              ? 'Attendance tracking and oversight across branches in your area.'
              : 'Clock in, clock out, and track your individual attendance health and analysis.'}
          </p>
        </div>

        {/* View Scope Switcher for Branch Managers, Area Managers, HR & Admins */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setViewScope('my')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${viewScope === 'my' ? 'bg-[#009944] text-white shadow-sm' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}
          >
            My Attendance
          </button>
          {isBranchManager && (
            <button
              onClick={() => setViewScope('branch')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${viewScope === 'branch' ? 'bg-[#009944] text-white shadow-sm' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}
            >
              <Building2 className="w-3.5 h-3.5" /> Branch Attendance
            </button>
          )}
          {isAreaManager && (
            <button
              onClick={() => setViewScope('area')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${viewScope === 'area' ? 'bg-[#009944] text-white shadow-sm' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}
            >
              <Users className="w-3.5 h-3.5" /> Area Attendance
            </button>
          )}
          {isHRorAdmin && (
            <Link
              to="/attendance-management"
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-[#009944] border border-[#009944]/30 bg-emerald-50/50 hover:bg-emerald-50 transition"
            >
              <Shield className="w-3.5 h-3.5" /> Full Management <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          )}
        </div>
      </div>

      {viewScope !== 'my' ? (
        <div className="space-y-5">
          {/* Team Filter Bar */}
          <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-3 w-full sm:w-auto">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Date</label>
                <input
                  type="date"
                  className="h-9 px-3 text-xs rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#009944]"
                  value={teamDate}
                  onChange={(e) => setTeamDate(e.target.value)}
                />
              </div>
              <button
                onClick={loadTeamAttendance}
                disabled={teamLoading}
                className="mt-4 px-3 py-2 rounded-lg border border-slate-300 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
              >
                {teamLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Refresh'}
              </button>
            </div>
            <div className="relative w-full sm:w-64">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
              <input
                type="text"
                placeholder="Search staff, dept, position..."
                className="w-full h-9 pl-9 pr-3 text-xs rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#009944]"
                value={teamSearch}
                onChange={(e) => setTeamSearch(e.target.value)}
              />
            </div>
          </div>

          {/* Team Table */}
          {teamLoading ? (
            <LoadingState label="Loading team attendance records..." />
          ) : searchedTeamRows.length === 0 ? (
            <EmptyState
              title="No attendance records for this date"
              description={`No staff clock-in records found for ${teamDate}.`}
            />
          ) : (
            <div className="bg-white rounded-2xl border border-slate-200 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-left">
                  <tr>
                    <th className="px-5 py-3 font-medium">Employee</th>
                    <th className="px-5 py-3 font-medium">Department</th>
                    <th className="px-5 py-3 font-medium">Branch</th>
                    <th className="px-5 py-3 font-medium">Clock In</th>
                    <th className="px-5 py-3 font-medium">Clock Out</th>
                     <th className="px-5 py-3 font-medium">Hours</th>
                     <th className="px-5 py-3 font-medium">Clocking Location</th>
                    <th className="px-5 py-3 font-medium">Status</th>
                    <th className="px-5 py-3 font-medium">Late</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {searchedTeamRows.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-5 py-3 font-medium text-slate-800">
                        {r.employees?.full_name || 'Staff Member'}
                        <div className="text-xs text-slate-400 font-normal">{r.employees?.position || ''}</div>
                      </td>
                      <td className="px-5 py-3 text-slate-600">{r.employees?.department || '—'}</td>
                      <td className="px-5 py-3 text-slate-600">{r.branches?.branch_name || r.employees?.branch || '—'}</td>
                      <td className="px-5 py-3 text-slate-700 tabular-nums">
                         {r.clock_in ? formatAttendanceTime(r.clock_in, schedule.timezone) : '—'}
                      </td>
                      <td className="px-5 py-3 text-slate-700 tabular-nums">
                         {r.clock_out ? formatAttendanceTime(r.clock_out, schedule.timezone) : '—'}
                      </td>
                       <td className="px-5 py-3 text-slate-700 tabular-nums">{formatWorkedHours(r)}</td>
                       <td className="px-5 py-3 text-slate-600">{r.clock_in_event?.metadata?.actual_location_name || r.clock_out_event?.metadata?.actual_location_name || '—'}</td>
                      <td className="px-5 py-3"><StatusPill status={r.status} /></td>
                      <td className="px-5 py-3 text-slate-600">{r.late_minutes > 0 ? `${r.late_minutes}m` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <>

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
            geofenceEnabled={requirements?.geofenceEnabled !== false}
            requireGpsClockIn={requirements?.requireGpsClockIn !== false}
            requireGpsClockOut={requirements?.requireGpsClockOut !== false}
            defaultGeofenceRadius={requirements?.defaultGeofenceRadius}
            timeZone={requirements?.appTimezone || schedule.timezone}
          />
        </div>

        {/* SARA briefing */}
        <div>
          <SaraBriefing records={history} isManager={false} myRecord={record} schedule={schedule} />
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
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setIssueModal(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 text-xs font-medium hover:bg-slate-50"
          >
            <AlertCircle className="w-3.5 h-3.5" /> Report Attendance Issue
          </button>
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
      </div>

      {history.length === 0 ? (
        <EmptyState title="No attendance records" description="Your attendance history will appear here once you start clocking in." />
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                    <th className="px-5 py-3 font-medium">Assigned Branch</th>
                    <th className="px-5 py-3 font-medium">Date</th>
                <th className="px-5 py-3 font-medium">Clock In</th>
                <th className="px-5 py-3 font-medium">Clock Out</th>
                <th className="px-5 py-3 font-medium">Hours</th>
                <th className="px-5 py-3 font-medium">Status</th>
                    <th className="px-5 py-3 font-medium">Late</th>
                    <th className="px-5 py-3 font-medium">Clocking Location</th>
                    <th className="px-5 py-3 font-medium">Location Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {history.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50 transition-colors">
                   <td className="px-5 py-3 text-slate-700">{employee.branches?.branch_name || employee.branch || '—'}</td>
                   <td className="px-5 py-3 text-slate-700">{new Date(r.attendance_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
                   <td className="px-5 py-3 text-slate-700 tabular-nums">{r.clock_in ? formatAttendanceTime(r.clock_in, schedule.timezone) : '—'}</td>
                   <td className="px-5 py-3 text-slate-700 tabular-nums">{r.clock_out ? formatAttendanceTime(r.clock_out, schedule.timezone) : '—'}</td>
                   <td className="px-5 py-3 text-slate-700 tabular-nums">{formatWorkedHours(r)}</td>
                  <td className="px-5 py-3"><StatusPill status={r.status} /></td>
                   <td className="px-5 py-3 text-slate-600">{r.late_minutes > 0 ? `${r.late_minutes}m` : '—'}</td>
                   <td className="px-5 py-3 text-slate-600">{r.clock_in_event?.metadata?.actual_location_name || r.clock_out_event?.metadata?.actual_location_name || '—'}</td>
                   <td className="px-5 py-3 text-slate-600 capitalize">{r.clock_out_event?.location_status || r.clock_in_event?.location_status || r.location_status || 'unknown'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </>
      )}

      {/* Late Arrival Modal */}
      {lateModal && <LateModal data={lateModal} onSubmit={submitLateReason} onClose={() => setLateModal(null)} busy={busy} />}

      {/* Attendance Issue Modal */}
      {issueModal && <IssueModal defaultDate={attendanceToday} onSubmit={submitIssue} onClose={() => setIssueModal(false)} busy={busy} />}
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

// ============================================================
// ATTENDANCE ISSUE MODAL
// ============================================================
function IssueModal({ defaultDate, onSubmit, onClose, busy }) {
  const [issueType, setIssueType] = useState('')
  const [issueDate, setIssueDate] = useState(defaultDate || '')
  const [explanation, setExplanation] = useState('')

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 animate-[fadeIn_0.15s_ease]">
      <div className="bg-white rounded-xl w-full max-w-md p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-full bg-rose-100 flex items-center justify-center">
              <AlertCircle className="w-5 h-5 text-rose-600" />
            </div>
            <h3 className="text-lg font-semibold text-slate-900">Report Attendance Issue</h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Date</label>
            <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} className="w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Issue Type</label>
            <select value={issueType} onChange={(e) => setIssueType(e.target.value)} className="w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]">
              <option value="">Select issue type...</option>
              {ISSUE_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Explanation</label>
            <textarea
              className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]"
              rows={3}
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
              placeholder="Describe what happened..."
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
          <button
            onClick={() => onSubmit({ date: issueDate, type: issueType, explanation })}
            disabled={busy || !issueType}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Submit Issue
          </button>
        </div>
      </div>
    </div>
  )
}
