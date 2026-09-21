// ------------------------------------------------------------------
// Leave Entitlements — pure domain helpers.
// No Supabase/React imports; safe to import from node tests.
// ------------------------------------------------------------------

export const LEAVE_TYPE_LABELS = {
  annual: 'Annual Leave',
  maternity: 'Maternity Leave',
  examination: 'Examination Leave',
  paternity: 'Paternity Leave',
  unpaid: 'Unpaid Leave',
}

// Fallback entitlements used only when the DB has no rule yet.
// Annual leave defaults are driven by designation in production.
export const LEAVE_ENTITLEMENTS = {
  annual: 10,
  maternity: 90,
  examination: 5,
  paternity: 2,
  unpaid: null, // no cap — always allowed, never deducted
}

// Max unused annual days that can roll into the next year.
export const ANNUAL_CARRY_OVER_CAP = 5

// Determine employee category from designation/position per Infinity Bank policy:
//   MD/CEO  -> 20 days
//   MD      -> 15 days
//   HEAD    -> 15 days
//   others  -> 10 days
export function getEmployeeCategory(employee) {
  if (!employee) return 'normal_staff'
  const designation = String(employee.designation || employee.position || employee.role || '').trim().toUpperCase()

  // MD/CEO (and common variants) gets the top tier.
  if (/(^|\/)\s*MD\s*\/\s*CEO\s*$/i.test(designation) || designation === 'MD/CEO' || designation === 'MD / CEO') return 'md'

  // Standalone MD is management tier.
  if (designation === 'MD' || designation === 'M.D' || designation === 'M.D.' || designation.includes('MANAGING DIRECTOR')) return 'management_staff'

  // Any designation containing HEAD is management tier.
  if (designation.includes('HEAD')) return 'management_staff'

  return 'normal_staff'
}

// Calculate balance for a leave type from the balance rows.
// effective_entitlement is the source of truth (manual override or system default).
export function balanceFor(balances, leaveType) {
  if (leaveType === 'unpaid') return { entitled_days: null, used_days: 0, pending_days: 0, remaining: Infinity }
  const b = balances.find((x) => x.leave_type === leaveType)
  if (!b) return { entitled_days: LEAVE_ENTITLEMENTS[leaveType] || 0, used_days: 0, pending_days: 0, remaining: LEAVE_ENTITLEMENTS[leaveType] || 0 }
  const entitled = Number(b.effective_entitlement ?? b.entitled_days ?? 0)
  const used = Number(b.used_days ?? 0)
  const pending = Number(b.pending_days ?? 0)
  return { ...b, entitled_days: entitled, used_days: used, pending_days: pending, remaining: entitled - used - pending }
}
