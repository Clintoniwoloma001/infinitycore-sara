import React, { useEffect, useState } from 'react'
import { Sparkles, TrendingUp, AlertTriangle, Users, Clock } from 'lucide-react'
import { supabase } from '../../supabaseClient'

/**
 * SARA Attendance Briefing — deterministic analytics based on actual
 * attendance records. No AI inference, just computed stats with
 * a human-sounding summary.
 */
export default function SaraBriefing({ records, employees, isManager }) {
  const [briefing, setBriefing] = useState(null)

  useEffect(() => {
    if (!records) return
    compute()
  }, [records, employees]) // eslint-disable-line react-hooks/exhaustive-deps

  function compute() {
    const today = new Date().toISOString().slice(0, 10)
    const todayRecords = records.filter((r) => String(r.attendance_date) === today)
    const totalEmployees = isManager ? (employees?.length || 0) : 0
    const presentToday = todayRecords.filter((r) => r.clock_in && (r.status === 'present' || r.status === 'late')).length
    const lateToday = todayRecords.filter((r) => r.status === 'late').length
    const notClockedIn = isManager ? totalEmployees - presentToday : 0
    const attendancePct = totalEmployees > 0 ? Math.round((presentToday / totalEmployees) * 100) : 0

    // Department breakdown for late arrivals
    const lateByDept = {}
    todayRecords.filter((r) => r.status === 'late').forEach((r) => {
      const dept = r.employees?.department || 'Unknown'
      lateByDept[dept] = (lateByDept[dept] || 0) + 1
    })
    const topLateDept = Object.entries(lateByDept).sort((a, b) => b[1] - a[1])[0]

    const greeting = getGreeting()
    const parts = []

    if (isManager) {
      if (attendancePct > 0) parts.push(`${attendancePct}% of employees have clocked in today.`)
      if (lateToday > 0) parts.push(`${lateToday} employee${lateToday > 1 ? 's are' : ' is'} currently late.`)
      if (topLateDept) parts.push(`The highest late-arrival concentration is in ${topLateDept[0]}.`)
      if (notClockedIn > 0) parts.push(`${notClockedIn} employee${notClockedIn > 1 ? 's have' : ' has'} not clocked in.`)
    } else {
      const myLate = todayRecords.filter((r) => r.status === 'late').length
      if (myLate > 0) parts.push(`You were ${todayRecords[0]?.late_minutes || 0} minutes late today.`)
      else if (todayRecords.length > 0) parts.push('You clocked in on time today. Nice work!')
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

function getGreeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning.'
  if (h < 17) return 'Good afternoon.'
  return 'Good evening.'
}
