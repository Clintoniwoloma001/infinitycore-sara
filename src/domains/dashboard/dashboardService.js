import { supabase } from '../../supabaseClient'
import { attendanceService, calculateAttendanceState } from '../../services/attendanceService'
import { currentYear } from '../../services/leaveBalanceService'
import { kpiService } from '../../services/kpiService'
import { targetService } from '../../services/targetService'
import { workTaskService } from '../../services/workTaskService'
import onboardingStatusService from '../../services/onboardingStatusService'
import { summarizeKpis } from './dashboardSelectors'

const RPC_NOT_FOUND = 'PGRST202'

function isMissingRpc(error) {
  return error?.code === RPC_NOT_FOUND || /schema cache|could not find the function/i.test(error?.message || '')
}

async function read(query, fallback = []) {
  try {
    const { data, error } = await query
    if (error) throw error
    return data ?? fallback
  } catch {
    return fallback
  }
}

async function getSelfSnapshot(userId) {
  const employee = await read(
    supabase
      .from('employees')
      .select('id, user_id, full_name, email, phone, department, position, branch, branch_id, area, employment_status, employee_number, staff_id, confirmation_status, branches(id, branch_name, branch_code)')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle(),
    null,
  )

  const onboarding = await onboardingStatusService.getMyStatus(userId)
  if (!employee) {
    return {
      scope: 'self',
      employee: null,
      onboarding,
      attendance: null,
      attendanceToday: null,
      leave: { balances: [], requests: [], pendingCount: 0 },
      performance: { kpis: [], summary: summarizeKpis([]) },
      work: { tasks: [], pendingCount: 0, overdueCount: 0, submittedCount: 0 },
      alerts: [],
      sectionErrors: [],
    }
  }

  const [requirements, today, history, leaveRequests, leaveBalances, kpis, targets, tasks, notifications] = await Promise.all([
    attendanceService.getAttendanceRequirements().catch(() => null),
    attendanceService.getToday(employee.id).catch(() => null),
    attendanceService.getHistory(employee.id, { limit: 31 }).catch(() => []),
    read(supabase.from('leave_requests').select('*').eq('created_by', userId).order('created_at', { ascending: false }).limit(8)),
    read(supabase.from('leave_balances').select('leave_type, entitled_days, used_days, year').eq('employee_id', userId).eq('year', currentYear())),
    kpiService.list({ employeeId: employee.id }).catch(() => []),
    targetService.list({ employeeId: employee.id }).catch(() => []),
    workTaskService.list({ assignedTo: userId }).catch(() => []),
    read(supabase.from('notifications').select('id, title, message, link, read, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(5)),
  ])

  const schedule = attendanceService.scheduleFor(employee, requirements)
  const attendanceState = calculateAttendanceState(today, schedule)
  const lateCount = history.filter((row) => Number(row.late_minutes || 0) > 0 || row.status === 'late').length
  const presentCount = history.filter((row) => row.clock_in).length
  const pendingLeave = leaveRequests.filter((row) => row.status === 'pending')
  const overdueTasks = tasks.filter((task) => task.due_date && new Date(task.due_date) < new Date() && !['completed', 'cancelled', 'submitted'].includes(task.status))
  const pendingTasks = tasks.filter((task) => ['assigned', 'accepted', 'in_progress'].includes(task.status))
  const submittedTasks = tasks.filter((task) => ['submitted', 'under_review'].includes(task.status))

  return {
    scope: 'self',
    employee,
    onboarding,
    attendanceToday: { ...attendanceState, record: today },
    attendance: { history, presentCount, lateCount, attendancePct: history.length ? Math.round((presentCount / history.length) * 100) : null },
    leave: { balances: leaveBalances, requests: leaveRequests, pendingCount: pendingLeave.length },
    performance: { kpis, targets, summary: summarizeKpis(kpis) },
    work: { tasks, pendingCount: pendingTasks.length, overdueCount: overdueTasks.length, submittedCount: submittedTasks.length },
    notifications,
    alerts: [],
    sectionErrors: [],
  }
}

export const dashboardService = {
  async getSnapshot(userId, filters = {}) {
    const range = {
      p_branch_id: filters.branchId || null,
      p_department: filters.department || null,
      p_employee_id: filters.employeeId || null,
      p_area: filters.area || null,
      p_start_date: filters.startDate || null,
      p_end_date: filters.endDate || null,
    }
    const { data, error } = await supabase.rpc('get_dashboard_snapshot', range)
    if (!error && data) {
      if (data.scope === 'management') {
        // Do not let an unavailable summary silently turn a real attendance
        // record into the dashboard's "No data" state. The scoped RPC is the
        // canonical source; the legacy summary keeps already-deployed schemas
        // functional until the additive migration is applied.
        const today = await attendanceService.getDashboardToday(filters)
          .catch(() => attendanceService.getManagementSummary().catch(() => null))
        return today ? { ...data, attendance_today: today } : data
      }
      return data
    }
    if (!filters.branchId && !filters.department && !filters.employeeId && !filters.area && isMissingRpc(error)) {
      return getSelfSnapshot(userId)
    }
    throw error || new Error('Dashboard data is unavailable.')
  },

  async getFilterOptions(filters = {}) {
    const { data, error } = await supabase.rpc('get_dashboard_filter_options', {
      p_branch_id: filters.branchId || null,
      p_department: filters.department || null,
      p_area: filters.area || null,
    })
    if (error) throw error
    return data || { branches: [], departments: [], areas: [], employees: [] }
  },
}

export default dashboardService
