import { supabase } from '../supabaseClient'
import { userInvitationService } from './userInvitationService'
import { filterDepartmentOptions } from '../constants/departments'

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

  // Resolve the Employee record behind a pending profile: linked first
  // (user_id / employee_id), then email. Returns the enriched employee row
  // or null when there is no matching record (self-registration fallback).
  async findEmployeeForProfile(profile) {
    if (!profile) return null
    let employee = null

    if (profile.id || profile.employee_id) {
      const filters = []
      if (profile.id) filters.push(`user_id.eq.${profile.id}`)
      if (profile.employee_id) filters.push(`id.eq.${profile.employee_id}`)
      const { data } = await supabase
        .from('employees')
        .select('*')
        .or(filters.join(','))
        .limit(5)
      employee = data?.[0] || null
    }

    if (!employee && profile.email) {
      const { data } = await supabase
        .from('employees')
        .select('*')
        .ilike('email', profile.email)
        .limit(10)
      const needle = String(profile.email).trim().toLowerCase()
      employee = (data || []).find((e) => String(e.email || '').trim().toLowerCase() === needle) || data?.[0] || null
    }

    if (!employee) return null
    try {
      const [enriched] = await userInvitationService.enrichEmployeeLocations([employee])
      return enriched || employee
    } catch {
      return employee
    }
  },

  // Re-send the activation invitation for a pending profile using the exact
  // same invite-employees mechanism (resend: true). Rejects when no employee
  // record backs the profile — re-invites are for employee-derived invites,
  // never a delete-and-recreate of the account.
  async resendInvitationForProfile(profile, { role = 'staff', reason = null } = {}) {
    const employee = await this.findEmployeeForProfile(profile)
    if (!employee) throw new Error('No matching employee record. Send a fresh invitation from "Create Users from Employees".')
    return this.resendInvitation(employee, { role, reason })
  },

  // Distinct Department and Branch values actually in use, unioned with the
  // authoritative master lists (departments + branches tables). Sorted for
  // the Review Registration dropdowns. No normalization — values are exactly
  // as stored so an auto-fill always finds its source value.
  async getDepartmentBranchOptions() {
    const [employeeDepts, employeeBranches, masterDepts, masterBranches] = await Promise.all([
      supabase.from('employees').select('department').not('department', 'is', null).neq('department', ''),
      supabase.from('employees').select('branch').not('branch', 'is', null).neq('branch', ''),
      supabase.from('departments').select('name').eq('is_active', true),
      supabase.from('branches').select('branch_name'),
    ])

    const clean = (values) => [...new Set(values.filter(Boolean).map((v) => String(v).trim()))]

    return {
      // Executive titles (MD/CEO, Chairman, Director…) are roles, never
      // departments — they must not be offered in the approval dropdown.
      departments: filterDepartmentOptions(clean([
        ...(employeeDepts.data || []).map((r) => r.department),
        ...(masterDepts.data || []).map((r) => r.name),
      ])).sort((a, b) => a.localeCompare(b)),
      branches: clean([
        ...(employeeBranches.data || []).map((r) => r.branch),
        ...(masterBranches.data || []).map((r) => r.branch_name),
      ]).sort((a, b) => a.localeCompare(b)),
    }
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
