import React, { useEffect, useState } from 'react'
import { BriefcaseBusiness, CalendarDays, ClipboardCheck, Users, Wallet } from 'lucide-react'
import { supabase } from '../supabaseClient'
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
      ].map(async ([key, promise]) => [key, await promise]))

      if (!active) return
      const data = {}
      const errors = []
      entries.forEach(([key, result]) => {
        data[key] = result.data
        if (result.error) errors.push(`${key}: ${result.error.message}`)
      })
      setState({ loading: false, data, errors })
    }
    load()
    return () => { active = false }
  }, [])

  if (state.loading) return <LoadingState label="Loading HR dashboard..." />

  const { employees = [], jobs = [], candidates = [], assessments = [], interviews = [], leave = [], payroll = [] } = state.data
  const activity = [
    ...candidates.slice(0, 4).map((item) => ({ id: `candidate-${item.id}`, label: `${item.full_name} entered ${String(item.application_status || 'received').replace(/_/g, ' ')}`, date: item.created_at })),
    ...interviews.slice(0, 4).map((item) => ({ id: `interview-${item.id}`, label: `${item.interview_type || 'Interview'} interview ${item.status || 'scheduled'}`, date: item.scheduled_date || item.created_at })),
    ...leave.slice(0, 4).map((item) => ({ id: `leave-${item.id}`, label: `${item.employee_name || 'Employee'} leave request ${item.status || 'pending'}`, date: item.created_at })),
  ].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)).slice(0, 6)

  const Stat = ({ icon: Icon, label, value, accent }) => (
    <div className="bg-white border border-slate-200 rounded-lg p-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
          <p className="text-2xl font-semibold text-slate-900 mt-1">{value}</p>
        </div>
        <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accent}15`, color: accent }}>
          <Icon className="w-5 h-5" />
        </div>
      </div>
    </div>
  )

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold text-slate-900">HR Dashboard</h2>
        <p className="text-sm text-slate-500 mt-1">Workforce, recruitment, interviews, leave, and payroll overview</p>
      </div>

      {state.errors.length > 0 && <div className="mb-6"><ErrorState title="Some HR datasets are not available" message={state.errors.join(' | ')} /></div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        <Stat icon={Users} label="Total Employees" value={employees.length} accent="#009944" />
        <Stat icon={Users} label="Active Employees" value={employees.filter((e) => (e.employment_status || 'active') === 'active').length} accent="#0ea5e9" />
        <Stat icon={BriefcaseBusiness} label="Pending Recruitment" value={candidates.filter((c) => ['received', 'screening', 'shortlisted'].includes(c.application_status)).length} accent="#f59e0b" />
        <Stat icon={CalendarDays} label="Interviews" value={interviews.length} accent="#6366f1" />
        <Stat icon={CalendarDays} label="Pending Leave" value={leave.filter((l) => l.status === 'pending').length} accent="#f43f5e" />
        <Stat icon={Wallet} label="Payroll Records" value={payroll.length} accent="#14b8a6" />
        <Stat icon={BriefcaseBusiness} label="Open Jobs" value={jobs.filter((j) => j.status === 'published').length} accent="#84cc16" />
        <Stat icon={ClipboardCheck} label="Assessments" value={assessments.length} accent="#a855f7" />
      </div>

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
