import { supabase } from '../supabaseClient'
import { createService, logAction } from './supabaseService'
import { performanceService } from './performanceService'
import { payrollProfileService } from './payrollProfileService'

const pips = createService('performance_improvement_plans')
const pipMetrics = createService('pip_metrics')
const pipAdjustments = createService('pip_allowance_adjustments')

export const pipService = {
  // ---- PIP CRUD ----

  async list({ status = null } = {}) {
    let query = supabase
      .from('performance_improvement_plans')
      .select(`
        *,
        employee:employee_id (id, full_name, employee_code, position, department, branch, user_id),
        metrics:pip_metrics (*)
      `)
      .order('created_at', { ascending: false })
    if (status) query = query.eq('status', status)
    const { data, error } = await query
    if (error) throw error
    return data || []
  },

  async get(id) {
    const { data, error } = await supabase
      .from('performance_improvement_plans')
      .select(`
        *,
        employee:employee_id (id, full_name, employee_code, position, department, branch, user_id),
        metrics:pip_metrics (*),
        adjustments:pip_allowance_adjustments (*)
      `)
      .eq('id', id)
      .single()
    if (error) throw error
    return data
  },

  async create({ employeeId, periodMonths = 3, startDate, nextSteps = '', metrics = [], createdBy }) {
    const endDate = new Date(startDate)
    endDate.setMonth(endDate.getMonth() + Number(periodMonths))
    const endDateStr = endDate.toISOString().split('T')[0]

    const { data: pip, error } = await supabase
      .from('performance_improvement_plans')
      .insert({
        employee_id: employeeId,
        period_months: Number(periodMonths),
        start_date: startDate,
        end_date: endDateStr,
        next_steps: nextSteps,
        created_by: createdBy,
        status: 'active',
      })
      .select()
      .single()
    if (error) throw error

    if (metrics.length > 0) {
      const metricRows = metrics.map((m) => ({
        pip_id: pip.id,
        metric_id: m.metric_id,
        metric_name: m.metric_name,
        target_value: Number(m.target_value),
      }))
      const { data: createdMetrics, error: mErr } = await supabase.from('pip_metrics').insert(metricRows).select()
      if (mErr) throw mErr
      pip.metrics = createdMetrics || []
    }

    return pip
  },

  async update(id, { nextSteps, status, verdict }) {
    const patch = {}
    if (nextSteps !== undefined) patch.next_steps = nextSteps
    if (status !== undefined) patch.status = status
    if (verdict !== undefined) {
      patch.verdict = verdict
      patch.verdict_at = verdict ? new Date().toISOString() : null
      patch.verdict_by = verdict ? (await supabase.auth.getUser()).data.user?.id : null
      if (verdict) patch.status = 'completed'
    }
    const { data, error } = await supabase.from('performance_improvement_plans').update(patch).eq('id', id).select().single()
    if (error) throw error
    return data
  },

  async close(id, verdict, reason, userName) {
    const { data, error } = await supabase.rpc('close_performance_improvement_plan', {
      p_pip_id: id,
      p_verdict: verdict,
      p_reason: reason || null,
    })
    if (error) throw error
    await logAction({
      action: 'PIP_VERDICT_APPLIED',
      entityType: 'PerformanceImprovementPlan',
      entityId: id,
      details: `Verdict: ${verdict}${reason ? ` — ${reason}` : ''}`,
      userName,
    })
    return data
  },

  // ---- Metrics / trends ----

  async listMetrics(activeOnly = true) {
    return performanceService.listMetrics({ activeOnly })
  },

  async getTrendData({ pip, metricIds = null } = {}) {
    if (!pip) return []
    const ids = (metricIds || pip.metrics?.map((m) => m.metric_id) || []).filter(Boolean)
    if (ids.length === 0) return []

    const { data, error } = await supabase
      .from('performance_results')
      .select('*')
      .eq('employee_id', pip.employee_id)
      .in('metric_id', ids)
      .gte('period_start', pip.start_date)
      .lte('period_end', pip.end_date)
      .order('period_start', { ascending: true })
    if (error) throw error
    return data || []
  },

  async getOverviewTrendData({ pipIds, metricIds = null } = {}) {
    if (!pipIds || pipIds.length === 0) return []
    const { data: pipsData, error: pipsError } = await supabase
      .from('performance_improvement_plans')
      .select('employee_id, start_date, end_date, metrics:pip_metrics(metric_id)')
      .in('id', pipIds)
    if (pipsError) throw pipsError

    const employeeIds = [...new Set(pipsData.map((p) => p.employee_id))]
    const allMetricIds = new Set()
    for (const p of pipsData) {
      for (const m of p.metrics || []) {
        if ((metricIds == null || metricIds.includes(m.metric_id)) && m.metric_id) allMetricIds.add(m.metric_id)
      }
    }
    if (employeeIds.length === 0 || allMetricIds.size === 0) return []

    const minStart = pipsData.reduce((a, b) => (a < b.start_date ? a : b.start_date), pipsData[0]?.start_date)
    const maxEnd = pipsData.reduce((a, b) => (a > b.end_date ? a : b.end_date), pipsData[0]?.end_date)

    const { data, error } = await supabase
      .from('performance_results')
      .select('*')
      .in('employee_id', employeeIds)
      .in('metric_id', [...allMetricIds])
      .gte('period_start', minStart)
      .lte('period_end', maxEnd)
      .order('period_start', { ascending: true })
    if (error) throw error
    return data || []
  },

  // ---- Allowance adjustments at verdict ----

  async getCurrentCompensation(employeeId) {
    return payrollProfileService.getEmployeeCompensation(employeeId)
  },

  async applyAllowanceAdjustments({ pipId, employeeId, adjustments, verdict, reason, signature = null, ipAddress = null, userName, actorRole }) {
    // Fetch current compensation
    const comp = await payrollProfileService.getEmployeeCompensation(employeeId)
    const basic = Number(comp?.basic_monthly ?? comp?.snapshot?.basic_monthly ?? 0)
    const currentAllowances = (comp?.packages || [])
      .filter((p) => p.active && p.payroll_salary_components?.component_type === 'allowance')
      .map((p) => ({
        component_id: p.component_id,
        name: p.payroll_salary_components.name,
        amount: Number(p.amount),
      }))
    const currentDeductions = (comp?.packages || [])
      .filter((p) => p.active && p.payroll_salary_components?.component_type === 'deduction')
      .map((p) => ({
        component_id: p.component_id,
        name: p.payroll_salary_components.name,
        amount: Number(p.amount),
      }))

    // Map allowance names to current amounts
    const allowanceMap = new Map(currentAllowances.map((a) => [a.name, a]))
    const auditRows = []
    const nextAllowances = currentAllowances.map((a) => ({ ...a }))

    for (const adj of adjustments || []) {
      const name = adj.component_name
      const existing = nextAllowances.find((a) => a.name === name)
      const oldValue = existing ? existing.amount : 0
      let newValue = oldValue

      if (adj.mode === 'manual') {
        newValue = Number(adj.value)
      } else if (adj.mode === 'percent_achievement') {
        const pct = Number(adj.percent)
        const achievement = Number(adj.achievement_pct || 0) / 100
        newValue = oldValue + oldValue * (pct / 100) * achievement
      } else if (adj.mode === 'percent_previous') {
        const pct = Number(adj.percent)
        newValue = oldValue + oldValue * (pct / 100)
      }

      newValue = Math.round(newValue * 100) / 100

      if (existing) {
        existing.amount = newValue
      } else {
        nextAllowances.push({ name, amount: newValue })
      }

      auditRows.push({
        pip_id: pipId,
        component_name: name,
        component_type: 'allowance',
        old_value: oldValue,
        new_value: newValue,
        basis: adj.mode === 'manual' ? 'manual' : adj.mode === 'percent_achievement' ? 'percent_achievement' : 'percent_previous',
        percent: adj.percent || null,
        achievement_pct: adj.achievement_pct || null,
        reason: reason || null,
        adjusted_by: (await supabase.auth.getUser()).data.user?.id,
      })
    }

    // Persist via canonical compensation RPC
    const allowancesPayload = nextAllowances.map((a) => ({
      component_id: a.component_id || null,
      name: a.name,
      amount: a.amount,
    }))
    await payrollProfileService.upsertEmployeeCompensation({
      employeeId,
      basic,
      allowances: allowancesPayload,
      deductions: currentDeductions.map((d) => ({ component_id: d.component_id || null, name: d.name, amount: d.amount })),
      reason: reason || `PIP ${verdict} adjustment`,
      signature,
      ipAddress,
    })

    // Save PIP adjustment audit rows
    if (auditRows.length > 0) {
      const { error } = await supabase.from('pip_allowance_adjustments').insert(auditRows)
      if (error) throw error
    }

    await logAction({
      action: 'PIP_ALLOWANCE_ADJUSTMENTS_APPLIED',
      entityType: 'PerformanceImprovementPlan',
      entityId: pipId,
      details: `${auditRows.length} allowance adjustment(s) applied for ${verdict}${actorRole ? ` by ${actorRole}` : ''}`,
      userName,
    })

    return auditRows
  },
}

export default pipService
