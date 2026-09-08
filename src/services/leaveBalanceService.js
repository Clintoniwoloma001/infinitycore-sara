import { supabase } from '../supabaseClient'
import { createService } from './supabaseService'
import { getEmployeeCategory } from './leaveRulesService'

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
export const LEAVE_ENTITLEMENTS = {
  annual: 10,
  maternity: 90,
  examination: 5,
  paternity: 2,
  unpaid: null, // no cap — always allowed, never deducted
}

// Max unused annual days that can roll into the next year.
export const ANNUAL_CARRY_OVER_CAP = 5

export const LEAVE_TYPE_LABELS = {
  annual: 'Annual Leave',
  maternity: 'Maternity Leave',
  examination: 'Examination Leave',
  paternity: 'Paternity Leave',
  unpaid: 'Unpaid Leave',
}

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

// Fetch every balance row for one employee/year. Auto-creates any
// missing rows AND syncs existing rows' entitled_days with leave_rules.
export async function getEmployeeBalances(employeeId, employeeName, year = currentYear(), employeeCategory = 'normal_staff') {
  const { data, error } = await supabase
    .from('leave_balances')
    .select('*')
    .eq('employee_id', employeeId)
    .eq('year', year)
  if (error) throw error

  const existing = data || []

  // Get the authoritative entitlements from leave_rules
  const entitlements = await getEffectiveEntitlements(employeeCategory)

  // Sync existing rows: update entitled_days to match current leave_rules
  const updates = []
  for (const row of existing) {
    if (row.leave_type === 'unpaid') continue
    const correctEntitlement = entitlements[row.leave_type]
    if (correctEntitlement !== undefined && Number(row.entitled_days) !== Number(correctEntitlement)) {
      updates.push({
        id: row.id,
        entitled_days: correctEntitlement,
      })
    }
  }

  if (updates.length > 0) {
    for (const u of updates) {
      await supabase.from('leave_balances').update({ entitled_days: u.entitled_days }).eq('id', u.id)
    }
    // Update the in-memory copies
    for (const u of updates) {
      const row = existing.find((r) => r.id === u.id)
      if (row) row.entitled_days = u.entitled_days
    }
  }

  // Create missing rows
  const missingTypes = Object.keys(entitlements).filter(
    (t) => entitlements[t] !== null && !existing.some((b) => b.leave_type === t)
  )

  if (missingTypes.length > 0) {
    const rows = missingTypes.map((leave_type) => ({
      employee_id: employeeId,
      employee_name: employeeName,
      year,
      leave_type,
      entitled_days: entitlements[leave_type],
      used_days: 0,
    }))
    const { data: created, error: insertError } = await supabase
      .from('leave_balances')
      .upsert(rows, { onConflict: 'employee_id,year,leave_type', ignoreDuplicates: true })
      .select()
    if (insertError) throw insertError
    return [...existing, ...(created || [])]
  }

  return existing
}

// Calculate balance for a leave type from the balance rows.
// entitled_days comes from the (now-synced) database row.
export function balanceFor(balances, leaveType) {
  if (leaveType === 'unpaid') return { entitled_days: null, used_days: 0, remaining: Infinity }
  const b = balances.find((x) => x.leave_type === leaveType)
  if (!b) return { entitled_days: LEAVE_ENTITLEMENTS[leaveType] || 0, used_days: 0, remaining: LEAVE_ENTITLEMENTS[leaveType] || 0 }
  return { ...b, remaining: Number(b.entitled_days) - Number(b.used_days) }
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
// Overrides entitled_days with values from leave_rules based on
// each employee's category (from profiles.role).
export async function listAllBalances(year = currentYear()) {
  const { data: rows, error } = await supabase
    .from('leave_balances')
    .select('*')
    .eq('year', year)
    .order('employee_name', { ascending: true })
  if (error) throw error

  if (!rows || rows.length === 0) return []

  // Fetch leave rules to override stale entitled_days
  const dbRules = await fetchDbEntitlements()

  // Fetch all profiles to determine employee category
  const employeeIds = [...new Set(rows.map((r) => r.employee_id))]
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, role')
    .in('id', employeeIds)

  const profileMap = new Map()
  for (const p of profiles || []) {
    profileMap.set(p.id, p)
  }

  // Override entitled_days with authoritative values from leave_rules
  const result = rows.map((row) => {
    if (row.leave_type === 'unpaid') return row
    const profile = profileMap.get(row.employee_id)
    const category = getEmployeeCategory(profile)
    let correctEntitlement = null
    if (dbRules && dbRules.length > 0) {
      const specific = dbRules.find((r) => r.leave_type === row.leave_type && r.employee_category === category)
      if (specific) correctEntitlement = Number(specific.entitled_days)
      else {
        const general = dbRules.find((r) => r.leave_type === row.leave_type && r.employee_category === null)
        if (general) correctEntitlement = Number(general.entitled_days)
      }
    }
    if (correctEntitlement !== null && Number(row.entitled_days) !== Number(correctEntitlement)) {
      return { ...row, entitled_days: correctEntitlement }
    }
    return row
  })

  return result
}

// Manual HR correction of a specific balance row.
export async function adjustBalance(id, { entitled_days, used_days }) {
  const patch = {}
  if (entitled_days !== undefined) patch.entitled_days = entitled_days
  if (used_days !== undefined) patch.used_days = used_days
  const { data, error } = await supabase.from('leave_balances').update(patch).eq('id', id).select().single()
  if (error) throw error
  return data
}

export default leaveBalances
