// PERFORMANCE domain — period defaults.
//
// The dashboard used to hard-code "This Month" as its active Period filter.
// When the stored performance rows belong to a different month (a published
// BankOne snapshot dated in the past, or a month that has not closed yet) the
// range filter drops every row and the page reads "Awaiting Data" even though
// results exist. The default period is therefore DERIVED from the rows
// themselves — pure, node-testable, no React.

const pad = (n) => String(n).padStart(2, '0')

export const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** Bounds of one result row: explicit period_start/end first, then the label. */
export function rowPeriodBounds(row) {
  if (!row) return null
  const parse = (v) => {
    if (!v) return null
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const s = parse(row.period_start)
  const e = parse(row.period_end)
  if (s || e) return { start: s || e, end: e || s }
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(String(row.period_label || ''))
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2]) - 1
  if (mo < 0 || mo > 11) return null
  if (m[3]) {
    const day = new Date(y, mo, Number(m[3]))
    return { start: day, end: day }
  }
  return { start: new Date(y, mo, 1), end: new Date(y, mo + 1, 0) }
}

/**
 * Default active Period filter for the dashboard.
 *
 * - latest data month == current system month  → 'month'
 * - latest data month == previous month        → 'prevMonth'
 * - anything else                              → 'custom' bounded to that month
 * - no rows at all                             → 'month' (empty-state view)
 *
 * @param {Array} results performance_results rows
 * @param {Date}  now      injectable clock (tests)
 * @returns {{ preset: string, custom: { from: string, to: string } | null }}
 */
export function deriveDefaultPeriod(results, now = new Date()) {
  const fallback = { preset: 'month', custom: null }
  let latest = null
  for (const row of results || []) {
    const bounds = rowPeriodBounds(row)
    if (!bounds || Number.isNaN(bounds.end.getTime())) continue
    if (!latest || bounds.end.getTime() > latest.end.getTime()) latest = bounds
  }
  if (!latest) return fallback

  const y = latest.end.getFullYear()
  const m = latest.end.getMonth()
  const ny = now.getFullYear()
  const nm = now.getMonth()
  if (y === ny && m === nm) return { preset: 'month', custom: null }

  const prevM = nm === 0 ? 11 : nm - 1
  const prevY = nm === 0 ? ny - 1 : ny
  if (y === prevY && m === prevM) return { preset: 'prevMonth', custom: null }

  return { preset: 'custom', custom: { from: isoDate(latest.start), to: isoDate(latest.end) } }
}
