// Scorecard value formatting for the Director Intelligence deep dive.
// The RPCs return plain numbers; the browser renders them with the right
// precision and currency/percent/count suffixes. No logic here is a scoring
// formula — it only pretty-prints the server-returned numbers.

/** Amount: ₦1,234,567,890.00. */
export function formatAmount(value) {
  if (value == null || value === 0) return '—'
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

/** Currency amount: ₦1,234,567,890.00 (reuses platform currency config). */
export function formatCurrencyValue(value) {
  if (value == null) return '—'
  return `₦${formatAmount(value)}`
}

/** Delta badge for a metric card: +12.5 pts / -3.2 pts / no comparison. */
export function Delta({ current, previous = null, suffix = '' }) {
  const c = Number(current)
  const p = previous == null ? null : Number(previous)
  if (current == null || isNaN(c)) return <span className="text-slate-400 text-xs">No comparison</span>
  const d = p == null ? null : c - p
  if (d == null) return <span className="text-slate-400 text-xs">No comparison</span>
  const sign = d > 0 ? '+' : ''
  const cls =
    d > 0
      ? 'text-emerald-700'
      : d < 0
        ? 'text-rose-600'
        : 'text-slate-500'
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold ${cls}`}>
      {d > 0 ? <span className="text-emerald-600">▲</span> : d < 0 ? <span className="text-rose-600">▼</span> : <span className="text-slate-400">▶</span>}
      {sign}{Number(d).toFixed(Number(d) % 1 ? 1 : 0)}{suffix}
    </span>
  )
}

/** "No data imported" pill shown when the RPC reports no value for a metric. */
export function NoData() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-[10px] font-semibold text-slate-500 uppercase tracking-[.08em]">
      <span className="h-1 w-1 rounded-full bg-slate-400" />
      No data
    </span>
  )
}
