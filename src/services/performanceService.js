import { supabase } from '../supabaseClient'

// ------------------------------------------------------------------
// Performance Engine — calculates actual vs target from the
// BankOne transaction ledger. Configurable metrics, grading bands.
// ------------------------------------------------------------------

export const PERFORMANCE_STATUS_LABELS = {
  below_target: 'Below Target',
  meets_target: 'Meets Target',
  exceeds_target: 'Exceeds Target',
  exceptional: 'Exceptional',
}

// Default grading bands (configurable per metric)
export const DEFAULT_GRADING_BANDS = [
  { label: 'Below Target', min_pct: 0, max_pct: 79 },
  { label: 'Meets Target', min_pct: 80, max_pct: 99 },
  { label: 'Exceeds Target', min_pct: 100, max_pct: 119 },
  { label: 'Exceptional', min_pct: 120, max_pct: 999 },
]

// Map a percentage to a status label using bands
export function gradeAchievement(pct, bands = DEFAULT_GRADING_BANDS) {
  for (const band of bands) {
    if (pct >= band.min_pct && pct < band.max_pct) {
      const label = band.label.toLowerCase().replace(/\s+/g, '_')
      return { label: band.label, status: label }
    }
  }
  // Above the highest band
  const last = bands[bands.length - 1]
  return { label: last.label, status: last.label.toLowerCase().replace(/\s+/g, '_') }
}

export const performanceService = {
  // ---- Metrics CRUD ----
  async listMetrics({ activeOnly = false } = {}) {
    let query = supabase.from('performance_metrics').select('*').order('created_at', { ascending: false })
    if (activeOnly) query = query.eq('is_active', true)
    const { data, error } = await query
    if (error) throw error
    return data || []
  },

  async createMetric(payload) {
    const { data, error } = await supabase
      .from('performance_metrics')
      .insert(payload)
      .select()
      .single()
    if (error) throw error
    return data
  },

  async updateMetric(id, payload) {
    const { data, error } = await supabase
      .from('performance_metrics')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return data
  },

  async deleteMetric(id) {
    const { error } = await supabase.from('performance_metrics').delete().eq('id', id)
    if (error) throw error
  },

  // ---- Calculate performance from BankOne transactions ----
  // Aggregates actual transaction data per employee per period
  async calculatePerformance({ periodLabel, periodStart, periodEnd, metrics, employeeId } = {}) {
    // Fetch transactions in the period
    let query = supabase
      .from('bankone_transactions')
      .select('id, employee_id, transaction_status, amount, transaction_type, branch, transaction_date')
      .gte('transaction_date', periodStart)
      .lte('transaction_date', periodEnd)
      .not('employee_id', 'is', null)

    if (employeeId) query = query.eq('employee_id', employeeId)

    const { data: transactions, error } = await query
    if (error) throw error

    // Group by employee
    const byEmployee = {}
    for (const txn of transactions || []) {
      const eid = txn.employee_id
      if (!byEmployee[eid]) {
        byEmployee[eid] = {
          employee_id: eid,
          total: 0,
          completed: 0,
          failed: 0,
          pending: 0,
          reversed: 0,
          incomplete: 0,
          totalValue: 0,
          completedValue: 0,
        }
      }
      const emp = byEmployee[eid]
      emp.total++
      const status = (txn.transaction_status || '').toLowerCase()
      if (status === 'completed') { emp.completed++; emp.completedValue += Number(txn.amount) || 0 }
      else if (status === 'failed') emp.failed++
      else if (status === 'pending') emp.pending++
      else if (status === 'reversed') emp.reversed++
      else if (status === 'incomplete') emp.incomplete++
      emp.totalValue += Number(txn.amount) || 0
    }

    // For each metric, calculate results
    const results = []
    for (const metric of metrics || []) {
      if (!metric.is_active) continue

      for (const [eid, emp] of Object.entries(byEmployee)) {
        let actualValue = 0
        const mType = metric.metric_type

        if (metric.metric_name.toLowerCase().includes('count') || mType === 'quantity') {
          actualValue = emp.total
        } else if (metric.metric_name.toLowerCase().includes('value') || mType === 'monetary') {
          actualValue = emp.totalValue
        } else if (metric.metric_name.toLowerCase().includes('success') || metric.metric_name.toLowerCase().includes('completion')) {
          actualValue = emp.total > 0 ? (emp.completed / emp.total) * 100 : 0
        } else if (metric.metric_name.toLowerCase().includes('failure')) {
          actualValue = emp.total > 0 ? (emp.failed / emp.total) * 100 : 0
        } else {
          actualValue = mType === 'monetary' ? emp.totalValue : emp.total
        }

        const targetValue = metric.target_quantity || metric.target_monetary_value || 1
        const achievementPct = targetValue > 0 ? Math.round((actualValue / targetValue) * 100 * 100) / 100 : 0

        const bands = metric.achievement_bands?.length ? metric.achievement_bands : DEFAULT_GRADING_BANDS
        const grade = gradeAchievement(achievementPct, bands)

        const score = Math.round((achievementPct / 100) * (metric.score_weight || 0) * 100) / 100

        results.push({
          employee_id: eid,
          metric_id: metric.id,
          metric_name: metric.metric_name,
          period_label: periodLabel,
          period_start: periodStart,
          period_end: periodEnd,
          target_value: targetValue,
          actual_value: actualValue,
          achievement_pct: achievementPct,
          performance_status: grade.status,
          score,
          weight: metric.score_weight || 0,
          weighted_score: score,
          source: 'bankone_import',
        })
      }
    }

    // Save results
    if (results.length > 0) {
      const CHUNK = 100
      for (let i = 0; i < results.length; i += CHUNK) {
        await supabase
          .from('performance_results')
          .upsert(results.slice(i, i + CHUNK), { onConflict: 'employee_id,metric_id,period_label' })
      }
    }

    return results
  },

  // ---- Get stored results ----
  async getResults({ periodLabel, employeeId, metricId } = {}) {
    let query = supabase.from('performance_results').select('*').order('calculated_at', { ascending: false })
    if (periodLabel) query = query.eq('period_label', periodLabel)
    if (employeeId) query = query.eq('employee_id', employeeId)
    if (metricId) query = query.eq('metric_id', metricId)
    const { data, error } = await query
    if (error) throw error
    return data || []
  },

  // ---- Get employee performance summary ----
  async getEmployeeSummary(employeeId, periodLabel) {
    const { data, error } = await supabase
      .from('performance_results')
      .select('*')
      .eq('employee_id', employeeId)
      .eq('period_label', periodLabel)
      .order('weighted_score', { ascending: false })
    if (error) throw error
    return data || []
  },

  // ---- Ranking ----
  async getRanking({ periodLabel, metricId, branch, limit = 20 } = {}) {
    let query = supabase
      .from('performance_results')
      .select(`
        employee_id,
        employee_name,
        metric_name,
        achievement_pct,
        actual_value,
        target_value,
        performance_status,
        weighted_score
      `)
      .eq('period_label', periodLabel)
      .order('achievement_pct', { ascending: false })
      .limit(limit)

    if (metricId) query = query.eq('metric_id', metricId)

    const { data, error } = await query
    if (error) throw error

    // Assign ranks
    return (data || []).map((r, i) => ({ ...r, rank: i + 1 }))
  },

  // ---- Appraisal Periods ----
  async listAppraisalPeriods() {
    const { data, error } = await supabase
      .from('appraisal_periods')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async createAppraisalPeriod(payload) {
    const { data, error } = await supabase
      .from('appraisal_periods')
      .insert(payload)
      .select()
      .single()
    if (error) throw error
    return data
  },

  // ---- Appraisal Results ----
  async listAppraisalResults({ periodId, employeeId } = {}) {
    let query = supabase.from('appraisal_results').select('*').order('updated_at', { ascending: false })
    if (periodId) query = query.eq('appraisal_period_id', periodId)
    if (employeeId) query = query.eq('employee_id', employeeId)
    const { data, error } = await query
    if (error) throw error
    return data || []
  },

  async createAppraisal(payload) {
    const { data, error } = await supabase
      .from('appraisal_results')
      .insert(payload)
      .select()
      .single()
    if (error) throw error
    return data
  },

  async updateAppraisal(id, payload) {
    const { data, error } = await supabase
      .from('appraisal_results')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return data
  },

  // ---- Transport Allowance Config ----
  async listTransportAllowances() {
    const { data, error } = await supabase
      .from('transport_allowance_config')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async createTransportAllowance(payload) {
    const { data, error } = await supabase
      .from('transport_allowance_config')
      .insert(payload)
      .select()
      .single()
    if (error) throw error
    return data
  },

  async updateTransportAllowance(id, payload) {
    const { data, error } = await supabase
      .from('transport_allowance_config')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return data
  },

  // ---- Performance Adjustments ----
  async listAdjustments({ transactionId, status } = {}) {
    let query = supabase.from('performance_adjustments').select('*').order('created_at', { ascending: false })
    if (transactionId) query = query.eq('transaction_id', transactionId)
    if (status) query = query.eq('status', status)
    const { data, error } = await query
    if (error) throw error
    return data || []
  },

  async createAdjustment(payload) {
    const { data, error } = await supabase
      .from('performance_adjustments')
      .insert(payload)
      .select()
      .single()
    if (error) throw error
    return data
  },

  async approveAdjustment(id, approverId, approverName) {
    const { data, error } = await supabase
      .from('performance_adjustments')
      .update({
        status: 'approved',
        approved_by: approverId,
        approved_by_name: approverName,
        approved_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return data
  },
}

export default performanceService
