// Pure attendance calculations shared by history views and statistics.
// The database stores these values; this is the display fallback for older
// rows where work_hours or total_minutes was not populated.
export function calculateWorkedMinutes(record) {
  if (!record?.clock_in || !record?.clock_out) return null
  const minutes = (new Date(record.clock_out).getTime() - new Date(record.clock_in).getTime()) / 60000
  return Number.isFinite(minutes) && minutes >= 0 ? Math.round(minutes) : null
}

export function calculateWorkedHours(record) {
  if (!record) return null
  const minutes = calculateWorkedMinutes(record)
  if (minutes != null) return Number((minutes / 60).toFixed(2))
  if (record.work_hours == null || record.work_hours === '') return null
  const hours = Number(record.work_hours)
  return Number.isFinite(hours) ? hours : null
}

export function formatWorkedHours(record) {
  const hours = calculateWorkedHours(record)
  return hours == null ? '—' : `${hours.toFixed(1)} hours`
}

export function normalizeWorkingDays(days = []) {
  return (Array.isArray(days) ? days : [])
    .map((day) => String(day).trim().toLowerCase().slice(0, 3))
    .filter(Boolean)
}
