/**
 * ============================================================================
 * MPR report data access
 * ============================================================================
 *
 * Loads one period's MPR inputs and returns them in the shape
 * src/domains/performance/mprEngine.js expects, so the page never touches
 * database column names and the engine stays the only place a score is derived.
 *
 * All scoring authority lives in the SECURITY DEFINER RPC compute_mpr_score()
 * (migration 20261101000007); this reads the raw inputs and calls the engine, so
 * the browser shows exactly what the server would compute. The RPC result is
 * also requested and kept on the row as `serverEvaluation` for verification.
 */
import { supabase } from '../supabaseClient'

/** The metric_code keys the engine understands, and their max points. */
export const MPR_METRIC_CODES = [
  'disbursement_value',
  'total_outstanding_principal',
  'pass_watch',
  'substandard',
  'doubtful',
  'lost',
  'case_load',
]

/** Default to the current calendar month, e.g. "2026-06". */
export function currentPeriodLabel(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** Most recent period that actually has data, so the page is not blank. */
export async function latestPeriodWithData() {
  const { data, error } = await supabase
    .from('mpr_targets')
    .select('period_label')
    .order('period_label', { ascending: false })
    .limit(1)
  if (error) throw error
  return data && data.length ? data[0].period_label : currentPeriodLabel()
}

/**
 * Fetch one period of MPR inputs, pivoted into engine-shaped rows.
 * @returns {Promise<Array<object>>}
 */
export async function loadMprRows(periodLabel, { branchId = null } = {}) {
  const query = supabase
    .from('mpr_targets')
    .select('employee_id, metric_code, target_value, actual_value, branch_id, status')
    .eq('period_label', periodLabel)
  if (branchId) query.eq('branch_id', branchId)

  const { data: targets, error } = await query
  if (error) throw error
  if (!targets || !targets.length) return []

  const employeeIds = [...new Set(targets.map((t) => t.employee_id))]

  // Pull identity (name / staff id / branch) for the involved employees in one
  // round trip rather than one query per employee.
  const { data: employees, error: empErr } = await supabase
    .from('employees')
    .select('id, first_name, middle_name, last_name, staff_id, branch_id, position')
    .in('id', employeeIds)
  if (empErr) throw empErr

  // Resolve branch labels in one query.
  const branchIds = [...new Set((employees || []).map((e) => e.branch_id).filter(Boolean))]
  const { data: branches } = branchIds.length
    ? await supabase.from('branches').select('id, branch_name').in('id', branchIds)
    : { data: [] }
  const branchById = new Map((branches || []).map((b) => [b.id, b.branch_name]))

  const empById = new Map((employees || []).map((e) => [e.id, e]))

  // Pivot the long (employee x metric) rows into one object per employee.
  const byEmployee = new Map()
  for (const t of targets) {
    if (!byEmployee.has(t.employee_id)) byEmployee.set(t.employee_id, {})
    const bucket = byEmployee.get(t.employee_id)
    const value = t.actual_value ?? t.target_value
    switch (t.metric_code) {
      case 'disbursement_value':
        bucket.targetDisbursementValue = t.target_value
        if (t.actual_value !== null) bucket.actualDisbursementValue = t.actual_value
        break
      case 'case_load':
        bucket.targetCaseloadCount = t.target_value
        if (t.actual_value !== null) bucket.activeClientLoanCount = t.actual_value
        break
      case 'total_outstanding_principal':
        bucket.totalOutstandingPrincipal = value
        break
      case 'pass_watch':
        bucket.passWatch = value
        break
      case 'substandard':
        bucket.substandard = value
        break
      case 'doubtful':
        bucket.doubtful = value
        break
      case 'lost':
        bucket.lost = value
        break
      default:
        break
    }
  }

  const fullName = (e) =>
    [e.first_name, e.middle_name, e.last_name].filter(Boolean).join(' ').trim()

  return [...byEmployee.entries()].map(([employeeId, inputs]) => {
    const e = empById.get(employeeId) || {}
    return {
      employeeId,
      staffName: fullName(e) || '(unnamed)',
      staffId: e.staff_id || '',
      branch: branchById.get(e.branch_id) || 'Unassigned',
      ...inputs,
    }
  })
}