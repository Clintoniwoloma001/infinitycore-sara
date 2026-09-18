import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Activity, BriefcaseBusiness, CalendarDays, ClipboardCheck, CheckCircle2, DollarSign, Sparkles, Stethoscope, TrendingUp, UserMinus, UserPlus, Users, Wallet } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { attendanceEngineService } from '../services/attendanceEngineService'
import medicalScreeningService from '../services/medicalScreeningService'
import { EmptyState, ErrorState, LoadingState } from '../components/PageStates'
import DrillDownModal from '../components/DrillDownModal'
import { formatDate } from '../lib/utils'
import { trainingService } from '../services/trainingService'

const safeList = async (table, orderBy = 'created_at') => {
  let query = supabase.from(table).select('*')
  if (orderBy) query = query.order(orderBy, { ascending: false })
  const { data, error } = await query
  return { data: data || [], error }
}

export default function HRDashboard() {
  const navigate = useNavigate()
  const [state, setState] = useState({ loading: true, data: {}, errors: [] })
  const [activeDrill, setActiveDrill] = useState(null)

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
        ['medicalReferrals', safeList('medical_referrals')],
      ].map(async ([key, promise]) => [key, await promise]))

      // HR metrics
      let hrMetrics = null
      try { hrMetrics = await attendanceEngineService.getHRMetrics() } catch { hrMetrics = null }
      let trainingDashboard = null
      try { trainingDashboard = await trainingService.getDashboard({ startDate: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10), endDate: new Date().toISOString().slice(0, 10) }) } catch { trainingDashboard = null }

      if (!active) return
      const data = {}
      const errors = []
      entries.forEach(([key, result]) => {
        data[key] = result.data
        if (result.error) errors.push(`${key}: ${result.error.message}`)
      })
      data.hrMetrics = hrMetrics
      data.trainingDashboard = trainingDashboard
      setState({ loading: false, data, errors })
      // Opportunistic expiry alarms for the medical screening workflow.
      medicalScreeningService.notifyExpiring().catch(() => {})
    }
    load()
    return () => { active = false }
  }, [])

  if (state.loading) return <LoadingState label="Loading HR dashboard..." />

  const { employees: allEmployees = [], jobs = [], candidates = [], assessments = [], interviews = [], leave = [], payroll = [], submissions = [], verifications = [], workTasks = [], targets = [], kpis = [], medicalReferrals = [], hrMetrics = null, trainingDashboard = null } = state.data

  // Deleted employees are archived (is_archived = true). Exclude them so a
  // deleted record never appears in any count or drill-down row.
  const employees = allEmployees.filter((e) => !e.is_archived)

  // Filters are stored once so each metric count and its drill-down share the
  // SAME in-memory array (DrillDownModal contract: count === rows.length).
  const pendingRecruitment = candidates.filter((c) => ['received', 'screening', 'shortlisted'].includes(c.application_status))
  const publishedJobs = jobs.filter((j) => j.status === 'published')
  const pendingLeave = leave.filter((l) => l.status === 'pending')

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

  // SARA Medical Screening metrics — derived from the referral lifecycle.
  const medicalNow = new Date()
  const medicalCompletedStatuses = ['cleared', 'cleared_with_restrictions', 'further_review', 'not_cleared', 'revoked']
  const medicalAwaitingHospital = medicalReferrals.filter((r) => ['draft', 'issued', 'qr_opened'].includes(r.status) && !(r.expires_at && new Date(r.expires_at) < medicalNow)).length
  const medicalInProgress = medicalReferrals.filter((r) => r.status === 'screening_started').length
  const medicalAwaitingReview = medicalReferrals.filter((r) => ['submitted', 'under_review'].includes(r.status)).length
  const medicalCleared = medicalReferrals.filter((r) => ['cleared', 'cleared_with_restrictions'].includes(r.status)).length
  const medicalExpiringSoon = medicalReferrals.filter((r) => r.status === 'issued' && r.expires_at && new Date(r.expires_at) > medicalNow && new Date(r.expires_at) - medicalNow < 7 * 86400000).length
  const medicalCompleted = medicalReferrals.filter((r) => medicalCompletedStatuses.includes(r.status)).length

  // Workforce / hire-exit metrics — derived from the employees master and,
  // as a fallback when the employees list is empty, from the server-side
  // hr_metrics_view. No figures are fabricated.
  const activeEmployees = employees.filter((e) => e.employment_status && e.employment_status !== 'terminated')
  const terminatedEmployees = employees.filter((e) => e.employment_status === 'terminated')
  const usesEmployeeBase = employees.length > 0
  const totalEmployees = employees.length || hrMetrics?.total_employees || 0
  const monthKeyNow = new Date().toISOString().slice(0, 7)
  const hiredThisMonth = employees.filter((e) => e.hire_date && String(e.hire_date).slice(0, 7) === monthKeyNow)
  const terminatedThisMonth = employees.filter((e) => e.employment_status === 'terminated' && e.updated_at && String(e.updated_at).slice(0, 7) === monthKeyNow)
  const activeCount = activeEmployees.length || hrMetrics?.active_employees || 0
  const hiredCount = hiredThisMonth.length || hrMetrics?.hired_this_month || 0
  const termThisCount = terminatedThisMonth.length || hrMetrics?.terminated_this_month || 0
  const termTotalCount = terminatedEmployees.length || hrMetrics?.terminated_employees || 0
  const hireRate = totalEmployees ? Math.round((hiredCount / totalEmployees) * 100) : 0
  const fireRate = totalEmployees ? Math.round((termThisCount / totalEmployees) * 100) : 0
  const turnoverRate = totalEmployees ? Math.round((termTotalCount / totalEmployees) * 100) : 0
  // No recruitment-spend source feeds this dashboard — show an honest "—".
  const costPerHire = null

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

  const Stat = ({ icon: Icon, label, value, accent, subtitle, onClick }) => (
    <div onClick={onClick} className={`bg-white border border-slate-200 rounded-lg p-5 ${onClick ? 'cursor-pointer hover:border-[#009944]/40 hover:shadow-sm transition-shadow' : ''}`}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
          <p className="text-2xl font-semibold text-slate-900 mt-1">{value}</p>
          {subtitle && <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>}
          {onClick && <p className="text-xs text-[#009944] mt-1 opacity-70">View records →</p>}
        </div>
        <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accent}15`, color: accent }}>
          <Icon className="w-5 h-5" />
        </div>
      </div>
    </div>
  )

  const MetricCard = ({ icon: Icon, label, value, trend, accent, onClick }) => (
    <div onClick={onClick} className={`bg-gradient-to-br from-white to-slate-50 border border-slate-200 rounded-xl p-5 ${onClick ? 'cursor-pointer hover:border-[#009944]/40 hover:shadow-sm transition-shadow' : ''}`}>
      <div className="flex items-center gap-3 mb-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accent}15`, color: accent }}>
          <Icon className="w-4.5 h-4.5" />
        </div>
        <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
      </div>
      <p className="text-3xl font-bold text-slate-900">{value}</p>
      {trend && <p className="text-xs mt-1" style={{ color: accent }}>{trend}</p>}
      {onClick && <p className="text-[11px] text-[#009944] mt-1.5 opacity-70">View records →</p>}
    </div>
  )

  const statusText = (v) => String(v || '—').replace(/_/g, ' ')
  const employeeColumns = [
    { key: 'full_name', label: 'Employee', render: (r) => <span className="font-medium text-slate-900">{r.full_name || '—'}</span> },
    { key: 'employee_code', label: 'Work ID', render: (r) => r.employee_code || r.employee_number || r.staff_id || '—' },
    { key: 'department', label: 'Department', render: (r) => r.department || '—' },
    { key: 'position', label: 'Position', render: (r) => r.position || '—' },
    { key: 'employment_status', label: 'Status', render: (r) => statusText(r.employment_status) },
    { key: 'hire_date', label: 'Joined', render: (r) => r.hire_date ? formatDate(r.hire_date) : '—' },
  ]
  const candidateColumns = [
    { key: 'full_name', label: 'Candidate', render: (r) => <span className="font-medium text-slate-900">{r.full_name || '—'}</span> },
    { key: 'email', label: 'Email', render: (r) => r.email || '—' },
    { key: 'position', label: 'Position', render: (r) => r.position || r.job_title || '—' },
    { key: 'application_status', label: 'Status', render: (r) => statusText(r.application_status) },
    { key: 'created_at', label: 'Applied', render: (r) => r.created_at ? formatDate(r.created_at) : '—' },
  ]
  const interviewColumns = [
    { key: 'candidate_name', label: 'Candidate', render: (r) => <span className="font-medium text-slate-900">{r.candidate_name || '—'}</span> },
    { key: 'position', label: 'Position', render: (r) => r.position || '—' },
    { key: 'interview_type', label: 'Type', render: (r) => statusText(r.interview_type) },
    { key: 'scheduled_date', label: 'Date/Time', render: (r) => r.scheduled_date ? formatDate(r.scheduled_date) : '—' },
    { key: 'status', label: 'Status', render: (r) => statusText(r.status) },
  ]
  const leaveColumns = [
    { key: 'employee_name', label: 'Employee', render: (r) => <span className="font-medium text-slate-900">{r.employee_name || '—'}</span> },
    { key: 'leave_type', label: 'Type', render: (r) => statusText(r.leave_type) },
    { key: 'start_date', label: 'From', render: (r) => r.start_date ? formatDate(r.start_date) : '—' },
    { key: 'end_date', label: 'To', render: (r) => r.end_date ? formatDate(r.end_date) : '—' },
    { key: 'status', label: 'Status', render: (r) => statusText(r.status) },
  ]
  const payrollColumns = [
    { key: 'employee_name', label: 'Employee', render: (r) => <span className="font-medium text-slate-900">{r.employee_name || '—'}</span> },
    { key: 'payroll_period', label: 'Period', render: (r) => r.payroll_period || r.period_label || '—' },
    { key: 'status', label: 'Status', render: (r) => statusText(r.status) },
    { key: 'created_at', label: 'Added', render: (r) => r.created_at ? formatDate(r.created_at) : '—' },
  ]
  const jobColumns = [
    { key: 'job_title', label: 'Job Title', render: (r) => <span className="font-medium text-slate-900">{r.job_title || '—'}</span> },
    { key: 'department', label: 'Dept', render: (r) => r.department || '—' },
    { key: 'location', label: 'Location', render: (r) => r.location || '—' },
    { key: 'employment_type', label: 'Type', render: (r) => statusText(r.employment_type) },
    { key: 'status', label: 'Status', render: (r) => statusText(r.status) },
  ]
  const assessmentColumns = [
    { key: 'candidate_name', label: 'Candidate', render: (r) => <span className="font-medium text-slate-900">{r.candidate_name || '—'}</span> },
    { key: 'test_name', label: 'Assessment', render: (r) => r.test_name || r.title || '—' },
    { key: 'assessment_type', label: 'Type', render: (r) => statusText(r.assessment_type) },
    { key: 'status', label: 'Status', render: (r) => statusText(r.status) },
    { key: 'created_at', label: 'Created', render: (r) => r.created_at ? formatDate(r.created_at) : '—' },
  ]
  const serverMetricNote = {
    emptyTitle: 'Record-level breakdown unavailable',
    emptyMessage: 'This count is sourced from the server-side HR metrics view, so the individual records are not available to drill into. Open the Employees page to see the full employee list.',
  }
  const drills = {
    totalEmployees: {
      title: 'Total Employees', subtitle: `${totalEmployees} employee records on file`, accent: '#009944',
      rows: employees, columns: employeeColumns,
      ...(usesEmployeeBase ? {} : serverMetricNote),
    },
    activeEmployees: {
      title: 'Active Employees', subtitle: `${activeCount} employees currently active`, accent: '#0ea5e9',
      rows: activeEmployees, columns: employeeColumns,
      ...(usesEmployeeBase ? {} : serverMetricNote),
    },
    pendingRecruitment: {
      title: 'Pending Recruitment', subtitle: `${pendingRecruitment.length} candidates in the recruitment pipeline`, accent: '#f59e0b',
      rows: pendingRecruitment, columns: candidateColumns,
    },
    interviews: {
      title: 'Interviews', subtitle: `${interviews.length} scheduled interviews`, accent: '#6366f1',
      rows: interviews, columns: interviewColumns,
    },
    pendingLeave: {
      title: 'Pending Leave', subtitle: `${pendingLeave.length} leave requests awaiting approval`, accent: '#f43f5e',
      rows: pendingLeave, columns: leaveColumns,
    },
    payroll: {
      title: 'Payroll Records', subtitle: `${payroll.length} payroll records`, accent: '#14b8a6',
      rows: payroll, columns: payrollColumns,
    },
    openJobs: {
      title: 'Open Jobs', subtitle: `${publishedJobs.length} published job openings`, accent: '#84cc16',
      rows: publishedJobs, columns: jobColumns,
    },
    assessments: {
      title: 'Assessments', subtitle: `${assessments.length} assessments`, accent: '#a855f7',
      rows: assessments, columns: assessmentColumns,
    },
    hiredThisMonth: {
      title: 'Hired This Month', subtitle: `${hiredCount} employees hired in ${monthKeyNow}`, accent: '#009944',
      rows: hiredThisMonth, columns: employeeColumns,
      ...(usesEmployeeBase ? {} : serverMetricNote),
    },
    exitsThisMonth: {
      title: 'Exits This Month', subtitle: `${termThisCount} employment records terminated in ${monthKeyNow}`, accent: '#ef4444',
      rows: terminatedThisMonth, columns: employeeColumns,
      ...(usesEmployeeBase ? {} : serverMetricNote),
    },
    turnover: {
      title: 'Exits (All Time)', subtitle: `${termTotalCount} terminated employment records`, accent: '#6366f1',
      rows: terminatedEmployees, columns: employeeColumns,
      ...(usesEmployeeBase ? {} : serverMetricNote),
    },
  }
  const openDrill = (key) => setActiveDrill(drills[key] || null)

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
          <MetricCard icon={UserPlus} label="Hire Rate" value={`${hireRate}%`} trend={`${hiredCount} hired this month`} accent="#009944" onClick={() => openDrill('hiredThisMonth')} />
          <MetricCard icon={UserMinus} label="Fire / Exit Rate" value={`${fireRate}%`} trend={`${termThisCount} exits this month`} accent="#ef4444" onClick={() => openDrill('exitsThisMonth')} />
          <MetricCard icon={DollarSign} label="Cost Per Hire" value={costPerHire == null ? '—' : `₦${Number(costPerHire).toLocaleString()}`} trend="No recruitment cost data" accent="#f59e0b" />
          <MetricCard icon={Activity} label="Turnover Rate" value={`${turnoverRate}%`} trend={`${termTotalCount} total exits`} accent="#6366f1" onClick={() => openDrill('turnover')} />
        </div>
      </div>

      {/* WORKFORCE STATS */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        <Stat icon={Users} label="Total Employees" value={totalEmployees} accent="#009944" onClick={() => openDrill('totalEmployees')} />
        <Stat icon={Users} label="Active Employees" value={activeCount} accent="#0ea5e9" onClick={() => openDrill('activeEmployees')} />
        <Stat icon={BriefcaseBusiness} label="Pending Recruitment" value={pendingRecruitment.length} accent="#f59e0b" onClick={() => openDrill('pendingRecruitment')} />
        <Stat icon={CalendarDays} label="Interviews" value={interviews.length} accent="#6366f1" onClick={() => openDrill('interviews')} />
        <Stat icon={CalendarDays} label="Pending Leave" value={pendingLeave.length} accent="#f43f5e" onClick={() => openDrill('pendingLeave')} />
        <Stat icon={Wallet} label="Payroll Records" value={payroll.length} accent="#14b8a6" onClick={() => openDrill('payroll')} />
        <Stat icon={BriefcaseBusiness} label="Open Jobs" value={publishedJobs.length} accent="#84cc16" onClick={() => openDrill('openJobs')} />
        <Stat icon={ClipboardCheck} label="Assessments" value={assessments.length} accent="#a855f7" onClick={() => openDrill('assessments')} />
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
            { label: 'Pending Leave', value: pendingLeave.length, path: '/leave-requests', color: 'text-slate-700' },
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

      {trainingDashboard?.summary && (
        <div className="rounded-xl border border-slate-200 overflow-hidden mb-6 bg-white">
          <div className="bg-gradient-to-r from-[#007a4a] to-[#00a85a] px-5 py-3 flex items-center justify-between gap-3">
            <span className="text-white font-semibold text-sm tracking-wide">Training &amp; Development</span>
            <button onClick={() => navigate('/training')} className="text-xs text-white/80 hover:text-white">Open training dashboard →</button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-slate-100">
            {[
              ['Training hours', `${trainingDashboard.summary.training_hours || 0}h`],
              ['Training man-hours', `${trainingDashboard.summary.training_man_hours || 0}h`],
              ['Employees trained', trainingDashboard.summary.employees_trained || 0],
              ['Completion', `${trainingDashboard.summary.completion_percentage || 0}%`],
            ].map(([label, value]) => <button key={label} onClick={() => navigate('/training')} className="px-4 py-4 text-left hover:bg-slate-50"><div className="text-2xl font-bold text-[#007a4a]">{value}</div><div className="text-xs text-slate-500 mt-0.5">{label}</div></button>)}
          </div>
        </div>
      )}

      {/* Medical Screening */}
      {medicalReferrals.length > 0 && (
        <div className="rounded-xl border border-slate-200 overflow-hidden mb-6 bg-white">
          <div className="bg-gradient-to-r from-teal-500 to-emerald-500 px-5 py-3 flex items-center gap-2">
            <Stethoscope className="w-5 h-5 text-white" />
            <span className="text-white font-semibold text-sm tracking-wide">Medical Screening</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-0 divide-x divide-slate-100">
            {[
              { label: 'Total Referrals', value: medicalReferrals.length, color: 'text-slate-700', tab: 'all' },
              { label: 'Awaiting Hospital', value: medicalAwaitingHospital, color: 'text-blue-600', tab: 'pending' },
              { label: 'In Progress', value: medicalInProgress, color: 'text-violet-600', tab: 'progress' },
              { label: 'Awaiting Review', value: medicalAwaitingReview, color: 'text-amber-600', tab: 'review' },
              { label: 'Cleared', value: medicalCleared, color: 'text-emerald-600', tab: 'completed' },
              { label: 'Expiring Soon (7d)', value: medicalExpiringSoon, color: 'text-rose-600', tab: 'expiring' },
            ].map((metric) => (
              <button
                key={metric.label}
                onClick={() => navigate('/medical-management', { state: { tab: metric.tab } })}
                className="px-4 py-4 text-left hover:bg-slate-50 transition-colors"
              >
                <div className={`text-2xl font-bold ${metric.color}`}>{metric.value}</div>
                <div className="text-xs text-slate-500 mt-0.5">{metric.label}</div>
              </button>
            ))}
          </div>
          <div className="px-5 py-3 border-t border-slate-100 text-xs text-slate-500">
            {medicalCompleted} completed screening{medicalCompleted === 1 ? '' : 's'} in total.
            <button onClick={() => navigate('/medical-management')} className="ml-1 font-medium text-teal-600 hover:underline">Open Medical Screening Center →</button>
          </div>
        </div>
      )}

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

      {activeDrill && (
        <DrillDownModal
          open
          onClose={() => setActiveDrill(null)}
          {...activeDrill}
        />
      )}
    </div>
  )
}
