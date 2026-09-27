// ============================================================================
// Leave Schedule Planner service (Phase 70)
// ============================================================================
// Every call is a SECURITY DEFINER RPC. The capacity engine, the working-day
// engine and the availability checker all live in Postgres, so the browser and
// the mobile app cannot compute leave duration or capacity two different ways.
//
// The UI never decides whether a rule passes. It renders the server's verdict,
// the server's conflicts and the server's explanations.
import { supabase } from '../supabaseClient'

const unwrap = (data, error, fallback) => {
  if (error) {
    const message = error.message || String(error)
    const forbidden = /LEAVE_(CONFIG_)?FORBIDDEN/.test(message)
    const detail = message.split(/:(.+)/s).slice(1).join(':').trim() || message
    const err = new Error(detail)
    err.forbidden = forbidden
    err.raw = message
    throw err
  }
  return data ?? fallback
}

export const leavePlannerService = {
  /**
   * The whole planner in one aggregated read: timeline entries, the overview
   * counters and the capacity heatmap. Computed server-side, so the browser
   * never pulls the company database to work it out.
   */
  async planner(filters = {}) {
    const {
      from, to, department = null, branchId = null, area = null,
      role = null, employeeId = null, leaveType = null, status = null,
    } = filters
    const { data, error } = await supabase.rpc('get_leave_planner', {
      p_from: from, p_to: to,
      p_department: department, p_branch_id: branchId, p_area: area,
      p_role: role, p_employee_id: employeeId,
      p_leave_type: leaveType, p_status: status,
    })
    return unwrap(data, error, { entries: [], summary: {}, capacity: [] })
  },

  /**
   * Deterministic availability check. Returns AVAILABLE / WARNING / CONFLICT
   * plus explained alternatives. `forUpdate` asks the server to take a
   * transaction-scoped advisory lock, which is what prevents two people
   * grabbing the last remaining slot at the same moment.
   */
  async checkAvailability({ employeeIds, leaveType, start, end, forUpdate = false }) {
    const { data, error } = await supabase.rpc('check_leave_availability', {
      p_employee_ids: employeeIds,
      p_leave_type: leaveType,
      p_start: start,
      p_end: end,
      p_for_update: forUpdate,
      p_depth: 0,
    })
    return unwrap(data, error, {
      verdict: 'UNKNOWN', conflicts: [], warnings: [], alternatives: [],
    })
  },

  /** Working days in a range, using the platform's own configured calendar. */
  async workingDays(start, end, branchId = null) {
    const { data, error } = await supabase.rpc('leave_working_days', {
      p_start: start, p_end: end, p_branch_id: branchId,
    })
    return unwrap(data, error, 0)
  },

  /** The configured leave year window. */
  async leaveYearWindow(year) {
    const { data, error } = await supabase.rpc('leave_year_window', { p_year: year })
    return unwrap(data, error, { leave_year: year, start: null, end: null })
  },

  /** Capacity rules, ordered by the precedence that actually applies. */
  async listRules() {
    const { data, error } = await supabase.rpc('list_leave_capacity_rules')
    return unwrap(data, error, { rules: [] }).rules || []
  },

  async saveRule(rule) {
    const { data, error } = await supabase.rpc('upsert_leave_capacity_rule', {
      p_id: rule.id ?? null,
      p_name: rule.name,
      p_scope_type: rule.scope_type,
      p_branch_id: rule.branchId ?? null,
      p_department: rule.department ?? null,
      p_area: rule.area ?? null,
      p_role: rule.role ?? null,
      p_team: rule.team ?? null,
      p_scope_value: rule.scopeValue ?? null,
      p_max_people_on_leave: rule.maxPeopleOnLeave ?? null,
      p_min_people_on_duty: rule.minPeopleOnDuty ?? null,
      p_max_percent_on_leave: rule.maxPercentOnLeave ?? null,
      p_min_staffing_percent: rule.minStaffingPercent ?? null,
      p_critical_role_restriction: !!rule.criticalRoleRestriction,
      p_leave_types: rule.leaveTypes?.length ? rule.leaveTypes : ['*'],
      p_priority_number: rule.priorityNumber ?? null,
      p_effective_from: rule.effectiveFrom ?? null,
      p_effective_to: rule.effectiveTo ?? null,
      p_notes: rule.notes ?? null,
    })
    return unwrap(data, error, {})
  },

  async deleteRule(id) {
    const { data, error } = await supabase.rpc('delete_leave_capacity_rule', { p_id: id })
    return unwrap(data, error, {})
  },
}

// ---------------------------------------------------------------------------
// Presentation helpers (formatting only - no leave arithmetic here)
// ---------------------------------------------------------------------------

export const PLANNER_STATE = {
  on_leave: { label: 'On leave', chip: 'bg-slate-800 text-white', icon: '●' },
  upcoming: { label: 'Upcoming approved', chip: 'bg-emerald-100 text-emerald-800', icon: '✓' },
  pending: { label: 'Pending', chip: 'bg-amber-100 text-amber-800', icon: '!' },
  completed: { label: 'Completed', chip: 'bg-slate-100 text-slate-500', icon: '·' },
}

/** "15 - 25 Oct 2026" */
export function formatLeaveRange(start, end) {
  if (!start) return '—'
  const s = new Date(`${start}T00:00:00`)
  if (Number.isNaN(s.getTime())) return String(start)
  const full = { day: 'numeric', month: 'short', year: 'numeric' }
  if (!end || end === start) return s.toLocaleDateString(undefined, full)
  const to = new Date(`${end}T00:00:00`)
  return `${s.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} - ${to.toLocaleDateString(undefined, full)}`
}

/** Every date in an inclusive range, for the timeline header. */
export function eachDay(from, to) {
  const out = []
  const start = new Date(`${from}T00:00:00`)
  const end = new Date(`${to}T00:00:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return out
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}

export const isoToday = () => new Date().toISOString().slice(0, 10)
export const isoDayOffset = (days) =>
  new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)
