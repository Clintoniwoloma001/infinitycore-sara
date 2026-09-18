import React, { useEffect, useState } from 'react'
import { AlertTriangle, ArrowRight, Building2, CalendarDays, CheckCircle2, Clock3, FileCheck2, ListChecks, Target, Users } from 'lucide-react'
import { Link } from 'react-router-dom'
import RoleSwitcher from '../components/RoleSwitcher'
import { EmptyState, ErrorState, LoadingState } from '../components/PageStates'
import { useAuth } from '../hooks/useAuth'
import { formatDate } from '../lib/utils'
import { getDashboardPermissions } from '../domains/dashboard/dashboardPermissions'
import { dashboardService } from '../domains/dashboard/dashboardService'
import { dashboardFilterSummary, periodRange, statusLabel } from '../domains/dashboard/dashboardSelectors'

const INITIAL_FILTERS = { branchId: '', department: '', employeeId: '', area: '', period: 'month' }

function MetricCard({ icon: Icon, label, value, detail, accent = '#009944' }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{value}</p>
          {detail && <p className="mt-1 text-xs text-slate-500">{detail}</p>}
        </div>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: `${accent}15`, color: accent }}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
    </div>
  )
}

function Section({ title, action, children }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </section>
  )
}

function Fact({ label, value }) {
  return (
    <div>
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium capitalize text-slate-800">{value || '—'}</dd>
    </div>
  )
}

function ImprovementList({ items }) {
  if (!items.length) return <p className="text-sm text-slate-500">No immediate attention items from the available data.</p>
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.label} className="flex items-start gap-2 text-sm text-slate-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  )
}

function ManagementFilters({ filters, setFilters, options, snapshot, access, onClear }) {
  const set = (patch) => setFilters((current) => ({ ...current, ...patch }))
  const branchName = options.branches?.find((branch) => branch.id === filters.branchId)?.branch_name
  const currentScope = access.actualRole === 'super_admin' ? 'All organization' : (branchName || 'Authorized scope')

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Dashboard context</h2>
          <p className="mt-0.5 text-xs text-slate-500">{dashboardFilterSummary(filters, options)} · {filters.period === 'quarter' ? 'Last 3 months' : 'Current month'}</p>
        </div>
        <button type="button" onClick={onClear} className="text-xs font-medium text-[#009944] hover:underline">Clear filters</button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <label className="text-xs font-medium text-slate-500">
          Organization
          <select value={currentScope} disabled className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-normal text-slate-600">
            <option>{currentScope}</option>
          </select>
        </label>
        <label className="text-xs font-medium text-slate-500">
          Branch
          <select value={filters.branchId} onChange={(event) => set({ branchId: event.target.value, department: '', employeeId: '' })} className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-normal text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#009944]">
            <option value="">All branches</option>
            {(options.branches || []).map((branch) => <option key={branch.id} value={branch.id}>{branch.branch_name}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-slate-500">
          Area
          <select value={filters.area} onChange={(event) => set({ area: event.target.value, branchId: '', department: '', employeeId: '' })} className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-normal text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#009944]">
            <option value="">All areas</option>
            {(options.areas || []).map((area) => <option key={area.id || area.area_code} value={area.area_code}>{area.area_name || area.area_code}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-slate-500">
          Department
          <select value={filters.department} onChange={(event) => set({ department: event.target.value, employeeId: '' })} className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-normal text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#009944]">
            <option value="">All departments</option>
            {(options.departments || []).map((department) => <option key={department.id || department.name} value={department.name}>{department.name}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-slate-500">
          Employee
          <select value={filters.employeeId} onChange={(event) => set({ employeeId: event.target.value })} className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-normal text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#009944]">
            <option value="">All employees</option>
            {(options.employees || []).map((employee) => <option key={employee.id} value={employee.id}>{employee.full_name}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-slate-500">
          Period
          <select value={filters.period} onChange={(event) => set({ period: event.target.value })} className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-normal text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#009944]">
            <option value="month">This month</option>
            <option value="quarter">This quarter</option>
            <option value="week">This week</option>
          </select>
        </label>
      </div>
      {snapshot?.filtering_allowed === false && <p className="mt-3 text-xs text-slate-500">Filters are limited to the organizational scope assigned to your role.</p>}
    </div>
  )
}

function SelfDashboard({ snapshot, name }) {
  const employee = snapshot.employee
  const attendance = snapshot.attendance || {}
  const today = snapshot.attendanceToday
  const leave = snapshot.leave || {}
  const performance = snapshot.performance || {}
  const work = snapshot.work || {}
  const attendanceHistory = snapshot.attendance_recent || attendance.history || []
  const balances = snapshot.leave_balances || leave.balances || []
  const kpis = snapshot.kpis || performance.kpis || []
  const tasks = snapshot.recent_tasks || work.tasks || []
  const improvements = []

  if (snapshot.onboarding?.state === 'in_progress' && snapshot.onboarding.progress_pct < 100) improvements.push({ label: `Onboarding is ${snapshot.onboarding.progress_pct}% complete.` })
  if ((attendance.lateCount || attendance.late || 0) > 0) improvements.push({ label: `Attendance: ${attendance.lateCount || attendance.late} late arrival${(attendance.lateCount || attendance.late) === 1 ? '' : 's'} in this period.` })
  if ((attendance.issues_pending || 0) > 0 || (attendance.exceptions_pending || 0) > 0) improvements.push({ label: `Attendance: ${(attendance.issues_pending || 0) + (attendance.exceptions_pending || 0)} issue${(attendance.issues_pending || 0) + (attendance.exceptions_pending || 0) === 1 ? '' : 's'} awaiting review.` })
  if ((leave.pendingCount || leave.pending || 0) > 0) improvements.push({ label: `${leave.pendingCount || leave.pending} leave request${(leave.pendingCount || leave.pending) === 1 ? '' : 's'} awaiting action.` })
  if ((performance.summary?.belowTarget || performance.below_target || 0) > 0) improvements.push({ label: `KPI achievement: ${performance.summary?.belowTarget || performance.below_target} KPI${(performance.summary?.belowTarget || performance.below_target) === 1 ? '' : 's'} below target.` })
  if ((work.overdueCount || work.overdue || 0) > 0) improvements.push({ label: `${work.overdueCount || work.overdue} overdue task${(work.overdueCount || work.overdue) === 1 ? '' : 's'}.` })

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Welcome, {(name || employee?.full_name || 'there').split(' ')[0]}</h1>
          <p className="mt-1 text-sm text-slate-500">Your InfinityCore work, attendance, leave, and performance context.</p>
        </div>
        <Link to="/profile" className="text-sm font-medium text-[#009944] hover:underline">Open my profile <ArrowRight className="inline h-3.5 w-3.5" /></Link>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Employee context</p>
            <h2 className="mt-1 text-xl font-semibold text-slate-900">{employee?.full_name || name || 'Employee profile'}</h2>
            <p className="mt-1 text-sm text-slate-500">{employee?.position || 'Designation not recorded'} · {employee?.department || 'Department not recorded'}</p>
          </div>
          <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium capitalize text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" /> {statusLabel(employee?.employment_status || 'active')}</span>
        </div>
        <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Fact label="Employee ID" value={employee?.employee_number || employee?.staff_id} />
          <Fact label="Branch" value={employee?.branches?.branch_name || employee?.branch} />
          <Fact label="Area" value={employee?.area} />
          <Fact label="Onboarding" value={snapshot.onboarding?.state === 'pending_review' ? 'Awaiting HR review' : snapshot.onboarding?.state} />
        </dl>
      </section>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={Clock3} label="Today's attendance" value={today?.label || 'No record'} detail={today?.clockInAt ? `Clocked in ${new Date(today.clockInAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Clock in through Attendance'} accent="#2563eb" />
        <MetricCard icon={CalendarDays} label="Attendance this period" value={attendance.attendancePct == null ? 'No data' : `${attendance.attendancePct}%`} detail={attendance.lateCount ? `${attendance.lateCount} late arrival${attendance.lateCount === 1 ? '' : 's'}` : 'No late arrivals recorded'} accent="#f59e0b" />
        <MetricCard icon={ListChecks} label="Leave pending" value={leave.pendingCount || 0} detail="Requests awaiting action" accent="#8b5cf6" />
        <MetricCard icon={Target} label="Active work" value={work.pendingCount || 0} detail={work.overdueCount ? `${work.overdueCount} overdue` : 'No overdue tasks'} accent="#009944" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Section title="Attendance" action={<Link to="/attendance" className="text-xs font-medium text-[#009944] hover:underline">Open attendance</Link>}>
          {attendanceHistory.length ? (
            <>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="rounded-lg bg-emerald-50 p-3"><p className="text-xl font-semibold text-emerald-700">{attendance.presentCount}</p><p className="text-xs text-slate-500">Days present</p></div>
              <div className="rounded-lg bg-amber-50 p-3"><p className="text-xl font-semibold text-amber-700">{attendance.lateCount}</p><p className="text-xs text-slate-500">Late days</p></div>
              <div className="rounded-lg bg-slate-50 p-3"><p className="text-xl font-semibold text-slate-700">{attendanceHistory.length}</p><p className="text-xs text-slate-500">Recent records</p></div>
            </div>
            <div className="mt-4 space-y-2">{attendanceHistory.slice(0, 5).map((record) => <div key={record.id} className="flex items-center justify-between text-xs"><span className="text-slate-500">{formatDate(record.attendance_date)}</span><span className="capitalize text-slate-700">{statusLabel(record.status || (record.clock_in ? 'present' : 'absent'))}{record.late_minutes > 0 ? ` · ${record.late_minutes}m late` : ''}</span></div>)}</div>
            </>
          ) : <EmptyState title="No attendance trend yet" description="Attendance history will appear here after records are created." />}
        </Section>

        <Section title="Leave" action={<Link to="/leave-requests" className="text-xs font-medium text-[#009944] hover:underline">Manage leave</Link>}>
          {balances.length ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {balances.slice(0, 4).map((balance) => <div key={balance.leave_type} className="rounded-lg bg-slate-50 p-3"><p className="truncate text-xs capitalize text-slate-500">{statusLabel(balance.leave_type)}</p><p className="mt-1 text-lg font-semibold text-slate-800">{Number(balance.entitled_days || 0) - Number(balance.used_days || 0)}</p><p className="text-xs text-slate-400">remaining</p></div>)}
            </div>
          ) : <EmptyState title="Leave balance not available" description="No balance record is available for the current year." />}
          {leave.requests?.[0] && <p className="mt-4 text-xs text-slate-500">Recent request: <span className="font-medium capitalize text-slate-700">{statusLabel(leave.requests[0].status)}</span> · {formatDate(leave.requests[0].start_date)}</p>}
        </Section>

        <Section title="KPI and performance" action={<Link to="/my-work" className="text-xs font-medium text-[#009944] hover:underline">Open My Work</Link>}>
          {kpis.length ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-lg bg-slate-50 p-3"><span className="text-sm text-slate-600">Average achievement</span><span className="font-semibold text-[#009944]">{performance.summary?.avgAchievement == null ? 'No data' : `${performance.summary.avgAchievement}%`}</span></div>
              {kpis.slice(0, 3).map((kpi) => <div key={kpi.id} className="flex items-center justify-between gap-3 text-sm"><span className="truncate text-slate-700">{kpi.kpi_name}</span><span className="shrink-0 text-slate-500">{kpi.actual_value ?? '—'} / {kpi.target_value ?? '—'} {kpi.unit || ''}</span></div>)}
            </div>
          ) : <EmptyState title="KPI data not yet available" description="Assigned KPIs will appear here when they are recorded." />}
        </Section>

        <Section title="Work and actions" action={<Link to="/my-work" className="text-xs font-medium text-[#009944] hover:underline">View work</Link>}>
          {tasks.length ? <div className="space-y-3">{tasks.slice(0, 4).map((task) => <div key={task.id} className="flex items-start justify-between gap-3"><div><p className="text-sm font-medium text-slate-800">{task.title}</p><p className="mt-0.5 text-xs text-slate-500">{task.due_date ? `Due ${formatDate(task.due_date)}` : 'No due date'}</p></div><span className="shrink-0 text-xs capitalize text-slate-500">{statusLabel(task.status)}</span></div>)}</div> : <EmptyState title="No assigned work" description="Tasks assigned to you will appear here." />}
        </Section>
      </div>

      <Section title="Areas requiring attention">
        <ImprovementList items={improvements} />
      </Section>
    </div>
  )
}

function ManagementDashboard({ snapshot, filters, setFilters, options, access, onClear }) {
  const headcount = snapshot.headcount || {}
  const onboarding = snapshot.onboarding || {}
  const attendance = snapshot.attendance || {}
  const leave = snapshot.leave || {}
  const performance = snapshot.performance || {}
  const work = snapshot.work || {}
  const recruitment = snapshot.recruitment
  const improvements = []
  if ((onboarding.pending_review || 0) > 0) improvements.push({ label: `${onboarding.pending_review} onboarding submission${onboarding.pending_review === 1 ? '' : 's'} awaiting HR review.` })
  if ((attendance.late || 0) > 0) improvements.push({ label: `${attendance.late} late attendance record${attendance.late === 1 ? '' : 's'} in the selected period.` })
  if ((attendance.issues_pending || 0) > 0 || (attendance.exceptions_pending || 0) > 0) improvements.push({ label: `${(attendance.issues_pending || 0) + (attendance.exceptions_pending || 0)} attendance issue${(attendance.issues_pending || 0) + (attendance.exceptions_pending || 0) === 1 ? '' : 's'} awaiting review.` })
  if ((performance.below_target || 0) > 0) improvements.push({ label: `${performance.below_target} KPI record${performance.below_target === 1 ? '' : 's'} below target.` })
  if ((work.overdue || 0) > 0) improvements.push({ label: `${work.overdue} overdue work task${work.overdue === 1 ? '' : 's'}.` })

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div><h1 className="text-2xl font-semibold text-slate-900">Aware management dashboard</h1><p className="mt-1 text-sm text-slate-500">Operational intelligence for the role and organizational scope assigned to you.</p></div>
        <span className="text-xs font-medium uppercase tracking-wide text-slate-400">{statusLabel(access.actualRole)}</span>
      </div>

      {access.canFilterOrganization && <ManagementFilters filters={filters} setFilters={setFilters} options={options} snapshot={snapshot} access={access} onClear={onClear} />}

      {snapshot.selected_employee && (
        <section className="rounded-xl border border-blue-200 bg-blue-50 p-4"><p className="text-xs font-medium uppercase tracking-wide text-blue-600">Selected employee context</p><p className="mt-1 text-lg font-semibold text-slate-900">{snapshot.selected_employee.full_name}</p><p className="text-sm text-slate-600">{snapshot.selected_employee.position || '—'} · {snapshot.selected_employee.department || '—'} · {snapshot.selected_employee.branch || '—'}</p></section>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={Users} label="Employees" value={headcount.total ?? 0} detail={`${headcount.active ?? 0} active${headcount.unconfirmed != null ? ` · ${headcount.unconfirmed} unconfirmed` : ''}`} />
        <MetricCard icon={FileCheck2} label="Onboarding complete" value={onboarding.complete ?? 'No data'} detail={onboarding.pending_review != null ? `${onboarding.pending_review} awaiting review` : null} accent="#2563eb" />
        <MetricCard icon={Clock3} label="Attendance late" value={attendance.late ?? 0} detail={`${attendance.records ?? 0} records in period`} accent="#f59e0b" />
        <MetricCard icon={CalendarDays} label="Leave pending" value={leave.pending ?? 0} detail="Requests awaiting action" accent="#8b5cf6" />
        <MetricCard icon={Target} label="KPI achievement" value={performance.avg_achievement == null ? 'No data' : `${performance.avg_achievement}%`} detail={performance.kpi_count ? `${performance.kpi_count} KPI records` : 'KPI data not yet available'} accent="#009944" />
        <MetricCard icon={ListChecks} label="Work overdue" value={work.overdue ?? 0} detail={`${work.submitted ?? 0} submitted for review`} accent="#ef4444" />
        {recruitment && <MetricCard icon={Users} label="Recruitment pipeline" value={recruitment.active ?? 0} detail={`${recruitment.total ?? 0} applications total`} accent="#6366f1" />}
        <MetricCard icon={Building2} label="Branches in scope" value={snapshot.branch_breakdown?.length ?? 0} detail="Authorized branch context" accent="#0f766e" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Section title="Branch overview">
          {snapshot.branch_breakdown?.length ? <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="text-left text-xs text-slate-500"><tr><th className="pb-2 font-medium">Branch</th><th className="pb-2 font-medium">Employees</th><th className="pb-2 font-medium">Active</th></tr></thead><tbody className="divide-y divide-slate-100">{snapshot.branch_breakdown.map((branch) => <tr key={branch.branch}><td className="py-2 font-medium text-slate-700">{branch.branch}</td><td className="py-2 text-slate-600">{branch.employees}</td><td className="py-2 text-slate-600">{branch.active}</td></tr>)}</tbody></table></div> : <EmptyState title="No branch data" description="Branch relationships are not available for this scope." />}
        </Section>
        <Section title="Department overview">
          {snapshot.department_breakdown?.length ? <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="text-left text-xs text-slate-500"><tr><th className="pb-2 font-medium">Department</th><th className="pb-2 font-medium">Employees</th><th className="pb-2 font-medium">Active</th></tr></thead><tbody className="divide-y divide-slate-100">{snapshot.department_breakdown.map((department) => <tr key={department.department}><td className="py-2 font-medium text-slate-700">{department.department}</td><td className="py-2 text-slate-600">{department.employees}</td><td className="py-2 text-slate-600">{department.active}</td></tr>)}</tbody></table></div> : <EmptyState title="No department data" description="Department relationships are not available for this scope." />}
        </Section>
      </div>

      <Section title="Areas requiring attention">
        <ImprovementList items={improvements} />
      </Section>
    </div>
  )
}

export default function Dashboard() {
  const auth = useAuth()
  const [snapshot, setSnapshot] = useState(null)
  const [options, setOptions] = useState({ branches: [], departments: [], areas: [], employees: [] })
  const [filters, setFilters] = useState(INITIAL_FILTERS)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [optionsError, setOptionsError] = useState('')
  const [name, setName] = useState(auth.name)

  const access = getDashboardPermissions(auth, snapshot?.employee || snapshot?.selected_employee)
  const management = snapshot?.scope === 'management'

  useEffect(() => {
    let active = true
    const load = async () => {
      if (!auth.user?.id) return
      setLoading(true)
      setError('')
      try {
        const range = periodRange(filters.period)
        const data = await dashboardService.getSnapshot(auth.user.id, {
          ...filters,
          ...range,
        })
        if (!active) return
        setSnapshot(data)
        setName(data?.employee?.full_name || data?.selected_employee?.full_name || auth.name)
      } catch (e) {
        if (active) setError(e?.message || 'Unable to load dashboard data.')
      } finally {
        if (active) setLoading(false)
      }
    }
    load()
    return () => { active = false }
  }, [auth.name, auth.user?.id, filters.area, filters.branchId, filters.department, filters.employeeId, filters.period])

  useEffect(() => {
    let active = true
    if (!auth.user?.id || !management) return undefined
    const loadOptions = async () => {
      setOptionsError('')
      try {
        const data = await dashboardService.getFilterOptions(filters)
        if (active) setOptions(data)
      } catch (e) {
        if (active) setOptionsError(e?.message || 'Filter options are unavailable.')
      }
    }
    loadOptions()
    return () => { active = false }
  }, [auth.user?.id, filters.area, filters.branchId, filters.department, management])

  const clearFilters = () => setFilters(INITIAL_FILTERS)

  if (loading) return <LoadingState label="Loading your aware dashboard..." />
  if (error && !snapshot) return <ErrorState title="Unable to load dashboard" message={error} />
  if (!snapshot) return <EmptyState title="Dashboard data not available" description="There is no dashboard context available for this account yet." />

  return (
    <div>
      {error && <div className="mb-5"><ErrorState title="Some dashboard sections are unavailable" message={error} /></div>}
      {optionsError && management && <div className="mb-5"><ErrorState title="Filters unavailable" message={optionsError} /></div>}
      <div className="mb-5"><RoleSwitcher /></div>
      {management ? <ManagementDashboard snapshot={snapshot} filters={filters} setFilters={setFilters} options={options} access={access} onClear={clearFilters} /> : <SelfDashboard snapshot={snapshot} name={name} />}
    </div>
  )
}
