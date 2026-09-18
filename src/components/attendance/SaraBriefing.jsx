import React, { useEffect, useState } from 'react'
import { Sparkles, TrendingUp, AlertTriangle, Users, Clock } from 'lucide-react'
import { calculateAttendanceState, DEFAULT_ATTENDANCE_TIMEZONE, formatAttendanceTime } from '../../services/attendanceService'
import { useNetworkTime } from '../../hooks/useNetworkTime'

/**
 * SARA Attendance Briefing — deterministic analytics based on actual
 * attendance records. No AI inference, just computed stats with a
 * human-sounding summary.
 *
 * The employee's own line uses the SAME canonical calculation as the
 * clock card and the server (calculateAttendanceState) against the
 * schedule stored in the DB, evaluated in the platform timezone. It
 * never claims "on time" merely because a record exists.
 */
export default function SaraBriefing({ records, employees, isManager, myRecord = null, schedule = null, summary = null }) {
  const [briefing, setBriefing] = useState(null)
  const { now: networkNow } = useNetworkTime()

  useEffect(() => {
    if (!records) return
    compute()
  }, [records, employees, myRecord, schedule, networkNow]) // eslint-disable-line react-hooks/exhaustive-deps

  function compute() {
    if (!networkNow) return
    const timezone = schedule?.timezone || DEFAULT_ATTENDANCE_TIMEZONE
    const today = timeZoneDateKey(networkNow, timezone)
    const todayRecords = records.filter((r) => String(r.attendance_date) === today)
    const totalEmployees = isManager ? (summary?.total_employees ?? employees?.length ?? 0) : 0
    const presentToday = isManager ? (summary?.present_today ?? todayRecords.filter((r) => r.clock_in).length) : 0
    const lateToday = isManager ? (summary?.late_today ?? todayRecords.filter((r) => r.status === 'late' || (r.late_minutes || 0) > 0).length) : 0
    const notClockedIn = isManager ? (summary?.absent_today ?? Math.max(0, totalEmployees - presentToday)) : 0
    const attendancePct = isManager ? (summary?.attendance_percent ?? (totalEmployees > 0 ? Math.round((presentToday / totalEmployees) * 100) : 0)) : 0

    // Department breakdown for late arrivals
    const lateByDept = {}
    todayRecords.filter((r) => r.status === 'late' || (r.late_minutes || 0) > 0).forEach((r) => {
      const dept = r.employees?.department || 'Unknown'
      lateByDept[dept] = (lateByDept[dept] || 0) + 1
    })
    const topLateDept = Object.entries(lateByDept).sort((a, b) => b[1] - a[1])[0]

    const greeting = getGreeting(timezone, networkNow)
    const parts = []

    if (isManager) {
      if (summary?.working_day === false) parts.push('Today is not configured as a working day.')
      parts.push(`Boss, ${presentToday} of ${totalEmployees} active employees have clocked in today. ${notClockedIn} ${notClockedIn === 1 ? 'employee has' : 'employees have'} no clock-in record yet.`)
      if (lateToday > 0) parts.push(`${lateToday} employee${lateToday > 1 ? 's are' : ' is'} late.`)
      if (topLateDept) parts.push(`The highest late-arrival concentration is in ${topLateDept[0]}.`)
      if ((summary?.cross_branch_today || 0) > 0) {
        parts.push(`${summary.cross_branch_today} employee${summary.cross_branch_today === 1 ? '' : 's'} clocked in outside their assigned branch${summary.head_office_today ? `; ${summary.head_office_today} at Head Office and ${summary.other_registered_branch_today || 0} at other registered branches` : ''}.`)
      }
    } else {
      const mine = myRecord || todayRecords[0] || null
      const state = calculateAttendanceState(mine, schedule || {})
      const at = (d) => (d ? formatAttendanceTime(d, timezone) : '')
      const scheduled = minutesToLabel(state.scheduledStartMinutes)
      switch (state.state) {
        case 'not_clocked_in':
          parts.push(`You have not clocked in yet today (scheduled start ${scheduled}).`)
          break
        case 'working_on_time':
          parts.push(`You clocked in on time at ${at(state.clockInAt)}. Nice work!`)
          break
        case 'working_late':
          parts.push(`You clocked in late by ${state.lateMinutes} minute${state.lateMinutes === 1 ? '' : 's'} at ${at(state.clockInAt)} (scheduled start ${scheduled}).`)
          break
        case 'late':
          parts.push(`You clocked out after arriving late by ${state.lateMinutes} minute${state.lateMinutes === 1 ? '' : 's'}.`)
          break
        case 'early_exit':
          parts.push(`You clocked out early by ${state.earlyMinutes} minute${state.earlyMinutes === 1 ? '' : 's'}.`)
          break
        case 'on_time':
        default:
          parts.push(`You clocked in on time at ${at(state.clockInAt)} and clocked out on schedule.`)
          break
      }
    }

    if (parts.length === 0) parts.push('No attendance data available for today yet.')

    setBriefing({
      greeting,
      summary: parts.join(' '),
      stats: { totalEmployees, presentToday, lateToday, notClockedIn, attendancePct },
    })
  }

  if (!briefing) return null

  return (
    <div className="rounded-2xl border border-slate-200 overflow-hidden bg-white">
      <div className="bg-gradient-to-r from-violet-500 to-purple-500 px-5 py-3 flex items-center gap-2">
        <Sparkles className="w-5 h-5 text-white" />
        <span className="text-white font-semibold text-sm">SARA Attendance Briefing</span>
      </div>
      <div className="p-5">
        <p className="text-sm text-slate-700 leading-relaxed">
          <span className="font-medium">{briefing.greeting}</span> {briefing.summary}
        </p>
        {isManager && briefing.stats.totalEmployees > 0 && (
          <div className="grid grid-cols-4 gap-2 mt-4">
            <MiniStat icon={Users} label="Present" value={briefing.stats.presentToday} color="text-emerald-600" />
            <MiniStat icon={Clock} label="Late" value={briefing.stats.lateToday} color="text-amber-600" />
            <MiniStat icon={AlertTriangle} label="Absent" value={briefing.stats.notClockedIn} color="text-rose-600" />
            <MiniStat icon={TrendingUp} label="Rate" value={`${briefing.stats.attendancePct}%`} color="text-blue-600" />
          </div>
        )}
      </div>
    </div>
  )
}

function MiniStat({ icon: Icon, label, value, color }) {
  return (
    <div className="rounded-lg bg-slate-50 p-2.5 text-center">
      <Icon className={`w-4 h-4 mx-auto ${color}`} />
      <div className={`text-lg font-bold ${color} mt-1`}>{value}</div>
      <div className="text-xs text-slate-400">{label}</div>
    </div>
  )
}

function timeZoneDateKey(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
  } catch {
    return new Date(date).toISOString().slice(0, 10)
  }
}

function minutesToLabel(minutes) {
  if (minutes == null) return 'configured time'
  const h = Math.floor((minutes || 0) / 60)
  const m = (minutes || 0) % 60
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`
}

function getGreeting(timeZone = DEFAULT_ATTENDANCE_TIMEZONE, date = null) {
  let hour = date ? date.getHours() : 0
  try {
    hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(date || new Date()))
  } catch { /* keep the server-time fallback */ }
  if (hour < 12) return 'Good morning.'
  if (hour < 17) return 'Good afternoon.'
  return 'Good evening.'
}
