export function periodRange(period, now = new Date()) {
  const end = new Date(now)
  const start = new Date(now)
  if (period === 'week') start.setDate(start.getDate() - 6)
  else if (period === 'quarter') start.setMonth(start.getMonth() - 2, 1)
  else start.setDate(1)
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  }
}

export function summarizeKpis(rows = []) {
  const measurable = rows.filter((row) => row.target_value != null && Number(row.target_value) !== 0)
  if (measurable.length === 0) return { count: rows.length, avgAchievement: null, belowTarget: 0 }
  const achievements = measurable.map((row) => (Number(row.actual_value || 0) / Number(row.target_value)) * 100)
  return {
    count: rows.length,
    avgAchievement: Math.round((achievements.reduce((sum, value) => sum + value, 0) / achievements.length) * 10) / 10,
    belowTarget: measurable.filter((row) => Number(row.actual_value || 0) < Number(row.target_value)).length,
  }
}

export function statusLabel(value) {
  return String(value || '—').replace(/_/g, ' ')
}

export function dashboardFilterSummary(filters, options = {}) {
  const labels = []
  if (filters.branchId) labels.push(options.branches?.find((item) => item.id === filters.branchId)?.branch_name || 'Selected branch')
  if (filters.area) labels.push(filters.area)
  if (filters.department) labels.push(filters.department)
  if (filters.employeeId) labels.push(options.employees?.find((item) => item.id === filters.employeeId)?.full_name || 'Selected employee')
  return labels.length ? labels.join(' / ') : 'All organization'
}
