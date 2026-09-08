import { supabase } from '../supabaseClient'

// ------------------------------------------------------------------
// SARA read helpers — always RLS-scoped. These return plain counts for
// entities the authenticated user is permitted to see; a failed read
// returns null (never throws) so SARA can say "I couldn't fetch that"
// instead of lying or crashing.
// ------------------------------------------------------------------

// filters: { status } style equality map. Reference-scoped by RLS.
// ------------------------------------------------------------------
// Phase 10: Workforce operations stats for SARA
// ------------------------------------------------------------------

// Pending attendance exceptions (late reasons awaiting review)
export async function countPendingAttendanceExceptions() {
  return countRows('attendance_exceptions', { status: 'pending' })
}

// Pending attendance issues (employee-reported issues awaiting review)
export async function countPendingAttendanceIssues() {
  return countRows('attendance_issues', { status: 'pending' })
}

// Pending task progress reports awaiting review
export async function countPendingTaskReports() {
  return countRows('task_progress_reports', { status: 'pending' })
}

// Pending KPI submissions awaiting review
export async function countPendingKpiSubmissions() {
  return countRows('kpi_submissions', { status: 'pending' })
}

// Pending user approvals
export async function countPendingUsers() {
  return countRows('profiles', { status: 'pending' })
}

// Fetch all workforce stats in one call for SARA
export async function getWorkforceStats() {
  const [exceptions, issues, taskReports, kpiSubs, pendingUsers] = await Promise.all([
    countPendingAttendanceExceptions(),
    countPendingAttendanceIssues(),
    countPendingTaskReports(),
    countPendingKpiSubmissions(),
    countPendingUsers(),
  ])
  return { exceptions, issues, taskReports, kpiSubs, pendingUsers }
}

export async function countRows(table, filters = null, _ctx = {}) {
  try {
    let q = supabase.from(table).select('id', { count: 'exact', head: true })
    if (filters) {
      for (const [col, val] of Object.entries(filters)) {
        const [field, op] = col.split('__')
        if (op === 'gte') q = q.gte(field, val)
        else if (op === 'lte') q = q.lte(field, val)
        else q = q.eq(field, val)
      }
    }
    const { count, error } = await q
    if (error) return null
    return count || 0
  } catch {
    return null
  }
}