import { supabase } from '../supabaseClient'
import { createService } from './supabaseService'

// ------------------------------------------------------------------
// Adjust these numbers whenever company policy changes — nothing
// else in the codebase needs to change.
// ------------------------------------------------------------------
export const LEAVE_ENTITLEMENTS = {
  annual: 21,
  sick: 10,
  maternity: 90,
  paternity: 10,
  personal: 5,
  unpaid: null, // no cap — always allowed, never deducted
}

// Max unused annual days that can roll into the next year.
export const ANNUAL_CARRY_OVER_CAP = 5

export const LEAVE_TYPE_LABELS = {
  annual: 'Annual',
  sick: 'Sick',
  maternity: 'Maternity',
  paternity: 'Paternity',
  personal: 'Personal',
  unpaid: 'Unpaid',
}

const leaveBalances = createService('leave_balances')

export function currentYear() {
  return new Date().getFullYear()
}

// Fetch every balance row for one employee/year. Auto-creates any
// missing rows at the default entitlement (first-time-use case).
export async function getEmployeeBalances(employeeId, employeeName, year = currentYear()) {
  const { data, error } = await supabase
    .from('leave_balances')
    .select('*')
    .eq('employee_id', employeeId)
    .eq('year', year)
  if (error) throw error

  const existing = data || []
  const missingTypes = Object.keys(LEAVE_ENTITLEMENTS).filter(
    (t) => LEAVE_ENTITLEMENTS[t] !== null && !existing.some((b) => b.leave_type === t)
  )

  if (missingTypes.length > 0) {
    const rows = missingTypes.map((leave_type) => ({
      employee_id: employeeId,
      employee_name: employeeName,
      year,
      leave_type,
      entitled_days: LEAVE_ENTITLEMENTS[leave_type],
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

// HR-wide view: every balance row for a given year, newest employee
// name first for readability.
export async function listAllBalances(year = currentYear()) {
  const { data, error } = await supabase
    .from('leave_balances')
    .select('*')
    .eq('year', year)
    .order('employee_name', { ascending: true })
  if (error) throw error
  return data || []
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
