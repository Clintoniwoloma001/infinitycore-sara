import { supabase } from '../supabaseClient.js'
import { createService } from './supabaseService.js'
import {
  LEAVE_TYPE_LABELS,
  LEAVE_ENTITLEMENTS,
  ANNUAL_CARRY_OVER_CAP,
  balanceFor,
} from '../domains/leave/entitlements.js'

// ------------------------------------------------------------------
// Leave entitlements are DATABASE-BACKED via the leave_rules table.
// These constants are FALLBACKS used only when the DB table is not yet
// available. HR can update policy values from Settings without code changes.
//
// Actual HR policy:
//   Annual: Normal Staff = 10, Management = 15, MD = 20
//   Maternity = 90 days (3 months)
//   Examination = 5 days
//   Paternity = 2 days
//   No Sick Leave. No Personal Leave.
// ------------------------------------------------------------------
export { LEAVE_TYPE_LABELS, LEAVE_ENTITLEMENTS, ANNUAL_CARRY_OVER_CAP, balanceFor }

const leaveBalances = createService('leave_balances')

export function currentYear() {
  return new Date().getFullYear()
}

// Cache for leave rules fetched within the same render cycle.
let _rulesCache = null
let _rulesCacheTime = 0

async function fetchDbEntitlements() {
  // Cache for 30 seconds to avoid repeated queries
  if (_rulesCache && Date.now() - _rulesCacheTime < 30000) return _rulesCache
  try {
    const { data, error } = await supabase
      .from('leave_rules')
      .select('leave_type, employee_category, entitled_days')
      .eq('is_active', true)
    if (error) return null
    _rulesCache = data || []
    _rulesCacheTime = Date.now()
    return _rulesCache
  } catch {
    return null
  }
}

// Clear the cache when rules are updated from Settings
export function clearRulesCache() {
  _rulesCache = null
  _rulesCacheTime = 0
}

// Get the effective entitlement for a leave type + employee category.
// This is the SINGLE SOURCE OF TRUTH for entitlements.
// Both LeaveRequests and LeaveBalances use this.
export async function getEffectiveEntitlement(leaveType, employeeCategory = 'normal_staff') {
  if (leaveType === 'unpaid') return null
  const dbRules = await fetchDbEntitlements()
  if (dbRules && dbRules.length > 0) {
    const specific = dbRules.find((r) => r.leave_type === leaveType && r.employee_category === employeeCategory)
    if (specific) return Number(specific.entitled_days)
    const general = dbRules.find((r) => r.leave_type === leaveType && r.employee_category === null)
    if (general) return Number(general.entitled_days)
  }
  // Fallback to constants
  return LEAVE_ENTITLEMENTS[leaveType] || 0
}

// Get all effective entitlements for a category at once.
export async function getEffectiveEntitlements(employeeCategory = 'normal_staff') {
  const dbRules = await fetchDbEntitlements()
  const entitlements = { ...LEAVE_ENTITLEMENTS }
  if (dbRules) {
    for (const leaveType of Object.keys(LEAVE_ENTITLEMENTS)) {
      if (leaveType === 'unpaid') continue
      const specific = dbRules.find((r) => r.leave_type === leaveType && r.employee_category === employeeCategory)
      if (specific) { entitlements[leaveType] = Number(specific.entitled_days); continue }
      const general = dbRules.find((r) => r.leave_type === leaveType && r.employee_category === null)
      if (general) { entitlements[leaveType] = Number(general.entitled_days); continue }
    }
  }
  return entitlements
}

// Centralized per-employee leave entitlement. Returns:
// { default_entitlement, manual_override, effective_entitlement, used_days, pending_days }
export async function getEmployeeLeaveEntitlement(employeeId, leaveType) {
  const { data, error } = await supabase.rpc('get_employee_leave_entitlement', {
    p_employee_id: employeeId,
    p_leave_type: leaveType,
  })
  if (error) throw error
  return data || {}
}

// Fetch every balance row for one employee/year. Auto-creates any
// missing rows using the centralized entitlement engine.
// Existing manual overrides are NEVER clobbered.
export async function getEmployeeBalances(employeeId, employeeName, year = currentYear()) {
  const { data, error } = await supabase
    .from('leave_balances')
    .select('*')
    .eq('employee_id', employeeId)
    .eq('year', year)
  if (error) throw error

  const existing = data || []

  // Create missing rows using the centralized entitlement engine.
  const missingTypes = Object.keys(LEAVE_ENTITLEMENTS).filter(
    (t) => t !== 'unpaid' && !existing.some((b) => b.leave_type === t)
  )

  if (missingTypes.length > 0) {
    const rows = []
    for (const leave_type of missingTypes) {
      const ent = await getEmployeeLeaveEntitlement(employeeId, leave_type)
      rows.push({
        employee_id: employeeId,
        employee_name: employeeName,
        year,
        leave_type,
        entitled_days: ent.effective_entitlement,
        default_entitlement: ent.default_entitlement,
        effective_entitlement: ent.effective_entitlement,
        used_days: 0,
        pending_days: 0,
      })
    }
    const { data: created, error: insertError } = await supabase
      .from('leave_balances')
      .upsert(rows, { onConflict: 'employee_id,year,leave_type', ignoreDuplicates: true })
      .select()
    if (insertError) throw insertError
    return [...existing, ...(created || [])]
  }

  return existing
}

// Deduct days from a balance on approval. Atomic-ish: re-reads the
// current row and writes the new used_days in one update.
export async function deductBalance(employeeId, leaveType, days, year = currentYear()) {
  if (leaveType === 'unpaid' || !days) return null
  const { data: row, error } = await supabase
    .from('leave_balances')
    .select('*')
    .eq('employee_id', employeeId)
    .eq('year', year)
    .eq('leave_type', leaveType)
    .single()
  if (error) throw error
  const { data: updated, error: updateError } = await supabase
    .from('leave_balances')
    .update({ used_days: Number(row.used_days) + Number(days) })
    .eq('id', row.id)
    .select()
    .single()
  if (updateError) throw updateError
  return updated
}

// Restore days to a balance on rejection/cancellation of a previously
// approved request.
export async function restoreBalance(employeeId, leaveType, days, year = currentYear()) {
  if (leaveType === 'unpaid' || !days) return null
  const { data: row, error } = await supabase
    .from('leave_balances')
    .select('*')
    .eq('employee_id', employeeId)
    .eq('year', year)
    .eq('leave_type', leaveType)
    .single()
  if (error) throw error
  const nextUsed = Math.max(0, Number(row.used_days) - Number(days))
  const { data: updated, error: updateError } = await supabase
    .from('leave_balances')
    .update({ used_days: nextUsed })
    .eq('id', row.id)
    .select()
    .single()
  if (updateError) throw updateError
  return updated
}

// HR-wide view: every balance row for a given year.
// Leave_balances is the per-employee source of truth for entitled_days
// and used_days; HR edits in LeaveBalances are authoritative.
export async function listAllBalances(year = currentYear()) {
  const { data: rows, error } = await supabase
    .from('leave_balances')
    .select('*')
    .eq('year', year)
    .order('employee_name', { ascending: true })
  if (error) throw error

  return rows || []
}

// Manual HR correction of a specific balance row.
// Supports two modes:
//   1. Legacy: pass entitled_days / used_days directly (treated as raw row edits)
//   2. Override: pass manual_override + override_reason to set a per-employee
//      entitlement override. effective_entitlement and entitled_days are kept in sync.
export async function adjustBalance(id, { entitled_days, used_days, pending_days, manual_override, override_reason, resetToDefault = false }) {
  const { data: current, error: fetchError } = await supabase.from('leave_balances').select('*').eq('id', id).single()
  if (fetchError) throw fetchError

  const patch = {}
  if (used_days !== undefined) patch.used_days = Number(used_days)
  if (pending_days !== undefined) patch.pending_days = Number(pending_days)

  if (resetToDefault) {
    patch.manual_override = null
    patch.override_reason = override_reason || 'Reset to system default'
    patch.override_updated_at = new Date().toISOString()
    patch.override_updated_by = (await supabase.auth.getUser()).data.user?.id
    patch.effective_entitlement = current.default_entitlement
    patch.entitled_days = current.default_entitlement
  } else if (manual_override !== undefined) {
    const overrideVal = manual_override === '' || manual_override === null ? null : Number(manual_override)
    patch.manual_override = overrideVal
    patch.override_reason = override_reason || null
    patch.override_updated_at = new Date().toISOString()
    patch.override_updated_by = (await supabase.auth.getUser()).data.user?.id
    patch.effective_entitlement = overrideVal ?? current.default_entitlement
    patch.entitled_days = patch.effective_entitlement
  } else if (entitled_days !== undefined) {
    // Legacy raw edit: keep entitlement fields aligned
    patch.entitled_days = Number(entitled_days)
    patch.effective_entitlement = Number(entitled_days)
    if (current.manual_override != null) {
      patch.manual_override = Number(entitled_days)
    }
  }

  const { data, error } = await supabase.from('leave_balances').update(patch).eq('id', id).select().single()
  if (error) throw error

  // Audit the change
  try {
    await supabase.rpc('audit_leave_entitlement_change', {
      p_balance_id: id,
      p_old: current,
      p_new: data,
      p_reason: patch.override_reason || null,
    })
  } catch {
    // Audit failure should not block the save
  }

  return data
}

// Reset an employee's entitlement for a leave type to the system default.
export async function resetLeaveEntitlement(id, reason) {
  return adjustBalance(id, { resetToDefault: true, override_reason: reason })
}

export default leaveBalances
