// JSX-free core of the Director Intelligence scorecard formatters.
// These are pure functions (no React) and can be unit-tested in Node without
// a renderer or a Supabase connection.
//
// formatScorecard.js (the React component file) imports from this module for
// the shared value-formatting logic.

/** Amount: 1,234,567.89 (null -> em dash). */
export function formatAmount(value) {
  if (value == null) return '—'
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value))
}

/** Percent: 0.73% (value is already a percentage point). */
export function formatPercent(value) {
  if (value == null) return '—'
  return `${Number(value).toFixed(2)}%`
}

/** Count: 202. */
export function formatCount(value) {
  if (value == null) return '—'
  return Number(value).toLocaleString('en-US')
}

/** Currency: ₦1,234,567.89 (reuses platform currency config). */
export function formatCurrencyValue(value) {
  if (value == null) return '—'
  return `₦${formatAmount(value)}`
}

/** Pure delta logic (no JSX): 110 vs 100 -> '+10.0 pts'. */
export function formatDelta({ current, previous = null, suffix = '' }) {
  const c = Number(current)
  const p = previous == null ? null : Number(previous)
  if (current == null || isNaN(c)) return 'No comparison'
  const d = p == null ? null : c - p
  if (d == null) return 'No comparison'
  const sign = d > 0 ? '+' : ''
  const v = Number(d).toFixed(Number(d) % 1 ? 1 : 0)
  const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '▶'
  return `${arrow} ${sign}${v}${suffix}`
}

/** Pure string for the 'No data imported' pill. */
export function formatNoData() {
  return 'No data imported'
}
