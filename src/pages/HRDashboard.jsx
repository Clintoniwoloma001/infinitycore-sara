import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BriefcaseBusiness, CalendarDays, ClipboardCheck, CheckCircle2, Sparkles, Users, Wallet } from 'lucide-react'
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
  const navigate = useNavigate()
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
        ['submissions', safeList('employee_onboarding_submissions')],
        ['verifications', safeList('guarantor_verifications')],
        ['workTasks', safeList('work_tasks')],
        ['targets', safeList('targets')],
        ['kpis', safeList('employee_kpis')],
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

  const { employees = [], jobs = [], candidates = [], assessments = [], interviews = [], leave = [], payroll = [], submissions = [], verifications = [], workTasks = [], targets = [], kpis = [] } = state.data

  // SARA intelligence metrics — derived from real data
  const pendingReviews = submissions.filter((s) => ['submitted', 'under_review', 'pending_guarantor', 'guarantor_submitted', 'correction_requested'].includes(s.onboarding_status)).length
  const pendingGuarantors = verifications.filter((v) => ['link_sent', 'submitted', 'under_review'].includes(v.status)).length
  const completedAssessments = assessments.filter((a) => a.status === 'completed' || a.status === 'graded').length
  const pendingAssessments = assessments.filter((a) => a.status === 'pending' || a.status === 'in_progress').length
  const todayStr = new Date().toISOString().slice(0, 10)
  const interviewsToday = interviews.filter((i) => (i.scheduled_date || '').slice(0, 10) === todayStr).length

  // SARA work intelligence metrics
  const taskSubmissionsPending = workTasks.filter((t) => t.status === 'submitted').length
  const overdueTasks = workTasks.filter((t) => t.due_date && new Date(t.due_date) < new Date() && !['completed', 'cancelled', 'submitted'].includes(t.status)).length
  const belowTargetKpis = kpis.filter((k) => k.target_value > 0 && Number(k.actual_value || 0) < Number(k.target_value)).length
  const activeTargets = targets.filter((t) => t.status === 'active').length
  const achievedTargets = targets.filter((t) => t.status === 'achieved').length

  // SARA interview intelligence metrics
  const tomorrowStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  const interviewsTomorrow = interviews.filter((i) => (i.scheduled_date || '').slice(0, 10) === tomorrowStr).length
  const virtualInterviewsToday = interviews.filter((i) => (i.scheduled_date || '').slice(0, 10) === todayStr && i.interview_type === 'VIRTUAL').length
  const failedEmailInterviews = interviews.filter((i) => i.notification_status === 'failed').length
  const pendingEmailInterviews = interviews.filter((i) => i.notification_status === 'pending' && i.candidate_email).length
  const upcomingInterviews = interviews.filter((i) => ['scheduled', 'confirmed'].includes(i.status) && new Date(i.scheduled_date) >= new Date())
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

      {/* SARA HR Intelligence */}
      <div className="rounded-xl border border-slate-200 overflow-hidden mb-6 bg-white">
        <div className="bg-gradient-to-r from-[#009944] to-[#00b050] px-5 py-3 flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-white" />
          <span className="text-white font-semibold text-sm tracking-wide">SARA HR Intelligence</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-0 divide-x divide-slate-100">
          {[
            { label: 'Pending HR Reviews', value: pendingReviews, path: '/onboarding-links', color: 'text-amber-600' },
            { label: 'Guarantor Pending', value: pendingGuarantors, path: '/onboarding-links', color: 'text-blue-600' },
            { label: 'Interviews Today', value: interviewsToday, path: '/interviews', color: 'text-violet-600' },
            { label: 'Assessments Pending', value: pendingAssessments, path: '/assessments', color: 'text-rose-600' },
            { label: 'Assessments Done', value: completedAssessments, path: '/assessments', color: 'text-emerald-600' },
            { label: 'Pending Leave', value: leave.filter((l) => l.status === 'pending').length, path: '/leave-requests', color: 'text-slate-700' },
          ].map((metric) => (
            <button
              key={metric.label}
              onClick={() => navigate(metric.path)}
              className="px-4 py-4 text-left hover:bg-slate-50 transition-colors"
            >
              <div className={`text-2xl font-bold ${metric.color}`}>{metric.value}</div>
              <div className="text-xs text-slate-500 mt-0.5">{metric.label}</div>
            </button>
          ))}
        </div>
      </div>

      {/* SARA Work Intelligence */}
      {(taskSubmissionsPending > 0 || overdueTasks > 0 || belowTargetKpis > 0) && (
        <div className="rounded-xl border border-slate-200 overflow-hidden mb-6 bg-white">
          <div className="bg-gradient-to-r from-violet-500 to-purple-500 px-5 py-3 flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-white" />
            <span className="text-white font-semibold text-sm tracking-wide">SARA Work Intelligence</span>
          </div>
          <div className="p-5 space-y-2">
            {taskSubmissionsPending > 0 && (
              <p className="text-sm text-slate-700">You have <span className="font-semibold">{taskSubmissionsPending} task submission{taskSubmissionsPending > 1 ? 's' : ''}</span> awaiting your review.</p>
            )}
            {overdueTasks > 0 && (
              <p className="text-sm text-slate-700"><span className="font-semibold text-rose-600">{overdueTasks} task{overdueTasks > 1 ? 's' : ''}</span> are overdue across your team.</p>
            )}
            {belowTargetKpis > 0 && (
              <p className="text-sm text-slate-700"><span className="font-semibold text-amber-600">{belowTargetKpis} KPI{belowTargetKpis > 1 ? 's' : ''}</span> are currently below target.</p>
            )}
            {achievedTargets > 0 && (
              <p className="text-sm text-slate-700"><span className="font-semibold text-emerald-600">{achievedTargets} target{achievedTargets > 1 ? 's' : ''}</span> have been achieved. Great work!</p>
            )}
            <button onClick={() => navigate('/work-management')} className="text-sm font-medium text-violet-600 hover:underline mt-2">View Work Management →</button>
          </div>
        </div>
      )}

      {/* SARA Interview Intelligence */}
      {(interviewsToday > 0 || interviewsTomorrow > 0 || failedEmailInterviews > 0 || pendingEmailInterviews > 0) && (
        <div className="rounded-xl border border-slate-200 overflow-hidden mb-6 bg-white">
          <div className="bg-gradient-to-r from-indigo-500 to-blue-500 px-5 py-3 flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-white" />
            <span className="text-white font-semibold text-sm tracking-wide">SARA Interview Intelligence</span>
          </div>
          <div className="p-5 space-y-2">
            {interviewsToday > 0 && (
              <p className="text-sm text-slate-700">You have <span className="font-semibold text-indigo-600">{interviewsToday} interview{interviewsToday > 1 ? 's' : ''}</span> scheduled today{virtualInterviewsToday > 0 ? ` (${virtualInterviewsToday} virtual)` : ''}.</p>
            )}
            {interviewsTomorrow > 0 && (
              <p className="text-sm text-slate-700">You have <span className="font-semibold">{interviewsTomorrow} interview{interviewsTomorrow > 1 ? 's' : ''}</span> scheduled tomorrow.</p>
            )}
            {pendingEmailInterviews > 0 && (
              <p className="text-sm text-slate-700"><span className="font-semibold text-amber-600">{pendingEmailInterviews} candidate{pendingEmailInterviews > 1 ? 's have' : ' has'}</span> not yet been sent an interview invitation.</p>
            )}
            {failedEmailInterviews > 0 && (
              <p className="text-sm text-slate-700"><span className="font-semibold text-rose-600">{failedEmailInterviews} interview invitation{failedEmailInterviews > 1 ? 's' : ''}</span> failed to send.</p>
            )}
            {upcomingInterviews.length > 0 && upcomingInterviews[0] && (
              <p className="text-sm text-slate-700">Next interview: <span className="font-medium">{upcomingInterviews[0].candidate_name}</span> for {upcomingInterviews[0].position || 'a position'} on {formatDate(upcomingInterviews[0].scheduled_date)}.</p>
            )}
            <button onClick={() => navigate('/interviews')} className="text-sm font-medium text-indigo-600 hover:underline mt-2">View Interviews →</button>
          </div>
        </div>
      )}

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
