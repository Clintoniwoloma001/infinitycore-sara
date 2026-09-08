import React, { useEffect, useState } from 'react'
import { BriefcaseBusiness, CalendarDays, ClipboardCheck, Users, Wallet, TrendingUp, TrendingDown, UserPlus, UserMinus, DollarSign, Activity, Clock, AlertCircle } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { attendanceEngineService } from '../services/attendanceEngineService'
import { EmptyState, ErrorState, LoadingState } from '../components/PageStates'
import { formatDate } from '../lib/utils'

const safeList = async (table, orderBy = 'created_at') => {
  let query = supabase.from(table).select('*')
  if (orderBy) query = query.order(orderBy, { ascending: false })
  const { data, error } = await query
  return { data: data || [], error }
}

export default function HRDashboard() {
  const [state, setState] = useState({ loading: true, data: {}, errors: [] })

  useEffect(() => {
    let active = true
    const load = async () => {
      const entries = await Promise.all([
        ['employees', safeList('employees')],
        ['jobs', safeList('hr_jobs')],
        ['candidates', safeList('hr_candidates')],
        ['assessments', safeList('hr_assessments')],
        ['interviews', safeList('hr_interviews', 'scheduled_date')],
        ['leave', safeList('leave_requests')],
        ['payroll', safeList('payroll')],
        ['attendance', safeList('attendance_records', 'attendance_date')],
        ['queries', safeList('employee_queries')],
        ['appraisals', safeList('employee_appraisals')],
      ].map(async ([key, promise]) => [key, await promise]))

      // HR metrics
      let hrMetrics = null
      try { hrMetrics = await attendanceEngineService.getHRMetrics() } catch { hrMetrics = null }

      if (!active) return
      const data = {}
      const errors = []
      entries.forEach(([key, result]) => {
        data[key] = result.data
        if (result.error) errors.push(`${key}: ${result.error.message}`)
      })
      data.hrMetrics = hrMetrics
      setState({ loading: false, data, errors })
    }
    load()
    return () => { active = false }
  }, [])

  if (state.loading) return <LoadingState label="Loading HR dashboard..." />

  const { employees = [], jobs = [], candidates = [], assessments = [], interviews = [], leave = [], payroll = [], attendance = [], queries = [], appraisals = [], hrMetrics } = state.data

  // Calculate HR metrics
  const activeEmployees = employees.filter((e) => (e.employment_status || 'active') === 'active')
  const terminatedEmployees = employees.filter((e) => e.employment_status === 'terminated')
  const hiredThisMonth = employees.filter((e) => {
    if (!e.hire_date) return false
    const d = new Date(e.hire_date)
    const now = new Date()
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
  })
  const terminatedThisMonth = employees.filter((e) => {
    if (e.employment_status !== 'terminated' || !e.updated_at) return false
    const d = new Date(e.updated_at)
    const now = new Date()
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
  })
  const hireRate = activeEmployees.length > 0 ? ((hiredThisMonth.length / activeEmployees.length) * 100).toFixed(1) : '0.0'
  const fireRate = employees.length > 0 ? ((terminatedThisMonth.length / employees.length) * 100).toFixed(1) : '0.0'
  const turnoverRate = employees.length > 0 ? ((terminatedThisMonth.length / employees.length) * 100).toFixed(1) : '0.0'

  // Cost per hire (estimated from payroll + recruitment costs)
  const totalPayrollCost = payroll.reduce((sum, p) => sum + (Number(p.gross_pay) || 0), 0)
  const recruitmentCost = candidates.length * 50000 // estimated cost per candidate
  const costPerHire = hiredThisMonth.length > 0 ? Math.round(recruitmentCost / hiredThisMonth.length).toLocaleString() : '—'

  // Attendance metrics for today
  const today = new Date().toISOString().slice(0, 10)
  const todayAttendance = attendance.filter((r) => String(r.attendance_date) === today)
  const presentToday = todayAttendance.filter((r) => r.clock_in && (r.status === 'present' || !r.status)).length
  const lateToday = todayAttendance.filter((r) => r.status === 'late').length
  const absentToday = activeEmployees.length - todayAttendance.length
  const missingClockOut = todayAttendance.filter((r) => r.clock_in && !r.clock_out).length

  // Open queries and pending appraisals
  const openQueries = queries.filter((q) => q.status === 'open' || q.status === 'under_review').length
  const pendingAppraisals = appraisals.filter((a) => a.status === 'draft' || a.status === 'submitted').length

  const activity = [
    ...candidates.slice(0, 4).map((item) => ({ id: `candidate-${item.id}`, label: `${item.full_name} entered ${String(item.application_status || 'received').replace(/_/g, ' ')}`, date: item.created_at })),
    ...interviews.slice(0, 4).map((item) => ({ id: `interview-${item.id}`, label: `${item.interview_type || 'Interview'} interview ${item.status || 'scheduled'}`, date: item.scheduled_date || item.created_at })),
    ...leave.slice(0, 4).map((item) => ({ id: `leave-${item.id}`, label: `${item.employee_name || 'Employee'} leave request ${item.status || 'pending'}`, date: item.created_at })),
  ].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)).slice(0, 6)

  const Stat = ({ icon: Icon, label, value, accent, subtitle }) => (
    <div className="bg-white border border-slate-200 rounded-lg p-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
          <p className="text-2xl font-semibold text-slate-900 mt-1">{value}</p>
          {subtitle && <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>}
        </div>
        <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accent}15`, color: accent }}>
          <Icon className="w-5 h-5" />
        </div>
      </div>
    </div>
  )

  const MetricCard = ({ icon: Icon, label, value, trend, accent }) => (
    <div className="bg-gradient-to-br from-white to-slate-50 border border-slate-200 rounded-xl p-5">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accent}15`, color: accent }}>
          <Icon className="w-4.5 h-4.5" />
        </div>
        <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
      </div>
      <p className="text-3xl font-bold text-slate-900">{value}</p>
      {trend && <p className="text-xs mt-1" style={{ color: accent }}>{trend}</p>}
    </div>
  )

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold text-slate-900">HR Dashboard</h2>
        <p className="text-sm text-slate-500 mt-1">Workforce metrics, recruitment, attendance, and employee engagement overview</p>
      </div>

      {state.errors.length > 0 && <div className="mb-6"><ErrorState title="Some HR datasets are not available" message={state.errors.join(' | ')} /></div>}

      {/* KEY HR METRICS */}
      <div className="mb-6">
        <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2"><TrendingUp className="w-4 h-4 text-[#009944]" /> Key HR Metrics</h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard icon={UserPlus} label="Hire Rate" value={`${hireRate}%`} trend={`${hiredThisMonth.length} hired this month`} accent="#009944" />
          <MetricCard icon={UserMinus} label="Fire / Exit Rate" value={`${fireRate}%`} trend={`${terminatedThisMonth.length} exits this month`} accent="#ef4444" />
          <MetricCard icon={DollarSign} label="Cost Per Hire" value={`₦${costPerHire}`} trend="Estimated recruitment cost" accent="#f59e0b" />
          <MetricCard icon={Activity} label="Turnover Rate" value={`${turnoverRate}%`} trend={`${terminatedEmployees.length} total exits`} accent="#6366f1" />
        </div>
      </div>

      {/* WORKFORCE STATS */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        <Stat icon={Users} label="Total Employees" value={employees.length} accent="#009944" />
        <Stat icon={Users} label="Active Employees" value={activeEmployees.length} accent="#0ea5e9" />
        <Stat icon={BriefcaseBusiness} label="Pending Recruitment" value={candidates.filter((c) => ['received', 'screening', 'shortlisted'].includes(c.application_status)).length} accent="#f59e0b" />
        <Stat icon={CalendarDays} label="Interviews" value={interviews.length} accent="#6366f1" />
        <Stat icon={CalendarDays} label="Pending Leave" value={leave.filter((l) => l.status === 'pending').length} accent="#f43f5e" />
        <Stat icon={Wallet} label="Payroll Records" value={payroll.length} accent="#14b8a6" />
        <Stat icon={BriefcaseBusiness} label="Open Jobs" value={jobs.filter((j) => j.status === 'published').length} accent="#84cc16" />
        <Stat icon={ClipboardCheck} label="Assessments" value={assessments.length} accent="#a855f7" />
      </div>

      {/* TODAY'S ATTENDANCE SNAPSHOT */}
      <div className="mb-6">
        <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2"><Clock className="w-4 h-4 text-[#009944]" /> Today's Attendance</h3>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {[
            { label: 'Present', value: presentToday, color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-200' },
            { label: 'Late', value: lateToday, color: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-200' },
            { label: 'Absent', value: absentToday, color: 'text-rose-600', bg: 'bg-rose-50', border: 'border-rose-200' },
            { label: 'Missing Clock-Out', value: missingClockOut, color: 'text-orange-600', bg: 'bg-orange-50', border: 'border-orange-200' },
            { label: 'Open Queries', value: openQueries, color: 'text-indigo-600', bg: 'bg-indigo-50', border: 'border-indigo-200' },
          ].map((s) => (
            <div key={s.label} className={`rounded-xl border ${s.border} ${s.bg} p-4`}>
              <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
              <div className="text-xs text-slate-500 mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* PENDING ITEMS */}
      {(openQueries > 0 || pendingAppraisals > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
          {openQueries > 0 && (
            <div className="bg-white border border-slate-200 rounded-lg p-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-indigo-50 flex items-center justify-center">
                <AlertCircle className="w-5 h-5 text-indigo-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-slate-900">{openQueries} open employee queries</p>
                <p className="text-xs text-slate-500">Review and resolve pending queries</p>
              </div>
            </div>
          )}
          {pendingAppraisals > 0 && (
            <div className="bg-white border border-slate-200 rounded-lg p-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-purple-50 flex items-center justify-center">
                <ClipboardCheck className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-slate-900">{pendingAppraisals} pending appraisals</p>
                <p className="text-xs text-slate-500">Complete pending performance appraisals</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* RECENT ACTIVITY */}
      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100">
          <h3 className="font-semibold text-slate-900">Recent HR Activity</h3>
        </div>
        {activity.length === 0 ? (
          <EmptyState title="No recent HR activity" description="Recruitment, interview, and leave activity will appear here." />
        ) : (
          <div className="divide-y divide-slate-100">
            {activity.map((item) => (
              <div key={item.id} className="px-6 py-4 flex items-center justify-between gap-4">
                <p className="text-sm text-slate-700">{item.label}</p>
                <span className="text-xs text-slate-400 whitespace-nowrap">{formatDate(item.date)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
