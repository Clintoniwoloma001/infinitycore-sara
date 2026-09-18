import { supabase } from '../supabaseClient'
import { userInvitationService } from './userInvitationService'

// ------------------------------------------------------------------
// User Provisioning Service — Phase 30.
// Composes read-only eligibility + invite history with the server-side
// `invite-employees` Edge Function. Nothing privileged runs in the
// browser: account creation/linking happens server-side where the
// service-role key lives.
// ------------------------------------------------------------------

const RESULT_META = {
  SUCCESS: { label: 'Invited', color: 'text-emerald-600 bg-emerald-50' },
  RESENT: { label: 'Invitation resent', color: 'text-emerald-600 bg-emerald-50' },
  ALREADY_EXISTS: { label: 'Already has account', color: 'text-amber-600 bg-amber-50' },
  INVALID_EMAIL: { label: 'No email', color: 'text-slate-500 bg-slate-100' },
  EMPLOYEE_EMAIL_MISSING: { label: 'No email', color: 'text-slate-500 bg-slate-100' },
  USER_ALREADY_EXISTS: { label: 'Account exists', color: 'text-amber-600 bg-amber-50' },
  INVITE_FAILED: { label: 'Failed', color: 'text-rose-600 bg-rose-50' },
  FAILED: { label: 'Failed', color: 'text-rose-600 bg-rose-50' },
}

export const userProvisioningService = {
  // Employees eligible for an account: no linked user_id, has an email.
  async getEligibleEmployees() {
    return userInvitationService.listUninvited()
  },

  // Historical invite records (for status/audit display).
  async getInviteHistory(limit = 200) {
    return userInvitationService.listInvites(limit)
  },

  // Compose an account-status summary for the User Management header.
  async getAccountSummary() {
    const [eligible, invites, profiles] = await Promise.all([
      userInvitationService.listUninvited(),
      userInvitationService.listInvites(500).catch(() => []),
      supabase.from('profiles').select('email, status, role').then(({ data }) => data || []).catch(() => []),
    ])

    const accountMap = {}
    profiles.forEach((p) => { if (p.email) accountMap[p.email.toLowerCase()] = p })

    const alreadyLinked = eligible.filter((e) => e.email && accountMap[e.email.toLowerCase()]).length
    const invitedSuccess = invites.filter((i) => i.result === 'SUCCESS').length
    const pendingApproval = profiles.filter((p) => !p.status || p.status === 'pending').length

    return {
      eligibleWithoutAccounts: eligible.length,
      alreadyLinked,
      invited: invitedSuccess,
      pendingApproval,
    }
  },

  // Single or bulk invite. employees: array of eligible employee rows.
  // Returns the server result payload: { ok, results }.
  async inviteEmployees(employees, { role = 'staff', reason = null } = {}) {
    if (!Array.isArray(employees) || employees.length === 0) throw new Error('Select at least one employee.')
    const invalid = employees.find((employee) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(employee?.email || '').trim()))
    if (invalid) throw new Error('This employee does not have a valid email address. Update the employee record before creating the user account.')
    return userInvitationService.inviteEmployees(employees.map((e) => e.id), role, reason)
  },

  async resendInvitation(employee, { role = 'staff', reason = null } = {}) {
    if (!employee?.id) throw new Error('Select an employee to resend the invitation.')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(employee.email || '').trim())) throw new Error('This employee does not have a valid email address. Update the employee record before creating the user account.')
    return userInvitationService.resendInvitation(employee.id, role, reason)
  },

  resultMeta(result) {
    return RESULT_META[result] || RESULT_META.FAILED
  },

  // Helpers for the provisioning modal
  summarizeResults(results) {
    const summary = { SUCCESS: 0, RESENT: 0, ALREADY_EXISTS: 0, INVALID_EMAIL: 0, EMPLOYEE_EMAIL_MISSING: 0, USER_ALREADY_EXISTS: 0, INVITE_FAILED: 0, FAILED: 0 }
    ;(results || []).forEach((r) => {
      const key = r?.result || r?.code || 'FAILED'
      summary[key] = (summary[key] || 0) + 1
    })
    return summary
  },
}

export default userProvisioningService
