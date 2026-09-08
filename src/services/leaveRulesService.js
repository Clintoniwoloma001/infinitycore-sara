import { supabase } from '../supabaseClient'

// ------------------------------------------------------------------
// Leave Rules Service — database-backed leave policy configuration.
// Replaces the hardcoded LEAVE_ENTITLEMENTS in leaveBalanceService.
//
// HR can update policy values from Settings without changing code.
// The system determines the employee category/role and applies the
// appropriate rule.
// ----------------------------------------------------------------

export const LEAVE_TYPE_LABELS = {
  annual: 'Annual Leave',
  maternity: 'Maternity Leave',
  examination: 'Examination Leave',
  paternity: 'Paternity Leave',
  sick: 'Sick Leave',
  personal: 'Personal Leave',
  unpaid: 'Unpaid Leave',
}

export const EMPLOYEE_CATEGORIES = {
  normal_staff: 'Normal Staff',
  management_staff: 'Management Staff',
  md: 'MD',
}

// Fallback defaults (used only if DB has no rules yet)
export const FALLBACK_ENTITLEMENTS = {
  annual: { normal_staff: 20, management_staff: 15, md: 20 },
  maternity: 90,
  examination: 5,
  paternity: 2,
  sick: 10,
  personal: 5,
  unpaid: null,
}

// Determine employee category from role/position
export function getEmployeeCategory(employee) {
  if (!employee) return 'normal_staff'
  const role = (employee.role || '').toLowerCase()
  const position = (employee.position || '').toLowerCase()

  if (role === 'md' || position.includes('managing director') || position === 'md') return 'md'
  if (['super_admin', 'admin', 'hr_manager', 'branch_manager', 'area_manager', 'head_of_business', 'operations_manager'].includes(role)) return 'management_staff'
  if (position.includes('manager') || position.includes('head') || position.includes('director')) return 'management_staff'
  return 'normal_staff'
}

export const leaveRulesService = {
  // Fetch all leave rules from DB
  async listRules() {
    const { data, error } = await supabase
      .from('leave_rules')
      .select('*')
      .eq('is_active', true)
      .order('leave_type', { ascending: true })
    if (error) throw error
    return data || []
  },

  async listAllRules() {
    const { data, error } = await supabase
      .from('leave_rules')
      .select('*')
      .order('leave_type', { ascending: true })
    if (error) throw error
    return data || []
  },

  async createRule(payload) {
    const { data, error } = await supabase
      .from('leave_rules')
      .insert(payload)
      .select()
      .single()
    if (error) throw error
    return data
  },

  async updateRule(id, payload) {
    const { data, error } = await supabase
      .from('leave_rules')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return data
  },

  async deleteRule(id) {
    const { error } = await supabase.from('leave_rules').delete().eq('id', id)
    if (error) throw error
  },

  // Get entitled days for a specific leave type and employee category
  async getEntitledDays(leaveType, employeeCategory = 'normal_staff') {
    // Try category-specific rule first
    const { data: specific } = await supabase
      .from('leave_rules')
      .select('entitled_days')
      .eq('leave_type', leaveType)
      .eq('employee_category', employeeCategory)
      .eq('is_active', true)
      .maybeSingle()

    if (specific) return Number(specific.entitled_days)

    // Try general rule (employee_category is null)
    const { data: general } = await supabase
      .from('leave_rules')
      .select('entitled_days')
      .eq('leave_type', leaveType)
      .is('employee_category', null)
      .eq('is_active', true)
      .maybeSingle()

    if (general) return Number(general.entitled_days)

    // Fallback to hardcoded defaults
    const fallback = FALLBACK_ENTITLEMENTS[leaveType]
    if (typeof fallback === 'object') return fallback[employeeCategory] || fallback.normal_staff
    return fallback
  },

  // Get all entitlements for an employee category at once
  async getEntitlementsForCategory(employeeCategory = 'normal_staff') {
    const rules = await this.listRules()
    const entitlements = {}

    for (const leaveType of Object.keys(LEAVE_TYPE_LABELS)) {
      if (leaveType === 'unpaid') { entitlements[leaveType] = null; continue }

      // Find category-specific rule
      const specific = rules.find((r) => r.leave_type === leaveType && r.employee_category === employeeCategory)
      if (specific) { entitlements[leaveType] = Number(specific.entitled_days); continue }

      // Find general rule
      const general = rules.find((r) => r.leave_type === leaveType && r.employee_category === null)
      if (general) { entitlements[leaveType] = Number(general.entitled_days); continue }

      // Fallback
      const fb = FALLBACK_ENTITLEMENTS[leaveType]
      if (typeof fb === 'object') entitlements[leaveType] = fb[employeeCategory] || fb.normal_staff
      else entitlements[leaveType] = fb
    }

    return entitlements
  },
}

export default leaveRulesService
