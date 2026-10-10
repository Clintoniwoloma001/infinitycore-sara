// ============================================================================
// Period filters for the Performance dashboard — PURE domain logic.
//
// Extracted so Node can test it directly (the page itself is JSX). Everything
// here is timezone-safe and deterministic given `now`:
//
//   * periodRange(preset, custom)  preset or explicit From/To -> [start, end]
//   * isoDate(ms)                  LOCAL calendar date (never toISOString)
//   * rangeOf(filter)              the {startDate, endDate} that travels with
//                                   a request (snapshot as-of END, flow window)
//   * asRange(v, fallback)         ignores React onClick event objects
//   * filterFromParams(params)     #/performance?... -> filter object (or null)
//   * rowInRange(row, range)       overlap test for performance_results
//
// THE BUG THIS FIXES: a custom range of 28->28 Sep 2026 used to end at
// 30 Sep (end of the month), silently pulling two extra days of data into
// every filter, PAR card and disbursement total.
// ============================================================================

export function periodRange(preset, custom) {
  const now = new Date()
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const y = now.getFullYear(), m = now.getMonth()
  const day = (offsetDays) => startOfDay(new Date(now)) - offsetDays * 86400000
  const begin = (yy, mm) => new Date(yy, mm, 1).getTime()
  const endOf = (yy, mm) => new Date(yy, mm + 1, 0).getTime()
  const maps = {
    today: [day(0), day(0) + 86399999],
    week: [day(now.getDay()), day(now.getDay()) + 86399999 + (6 - now.getDay()) * 86400000],
    month: [begin(y, m), endOf(y, m)],
    prevMonth: [begin(y, m - 1), endOf(y, m - 1)],
    quarter: [begin(y, m - (m % 3)), endOf(y, m - (m % 3) + 2)],
    year: [begin(y, 0), endOf(y, 11)],
  }
  if (preset === 'custom' && custom && custom.from && custom.to) {
    // Inclusive end = the LAST INSTANT of the chosen `to` day. It must never
    // roll up to the end of the month (28→28 Sep stayed 1–30 Sep before).
    return [startOfDay(new Date(custom.from)), startOfDay(new Date(custom.to)) + 86399999]
  }
  return maps[preset] || maps.month
}

// Plain LOCAL calendar date (YYYY-MM-DD). Never `toISOString()`: in Africa/Lagos
// (UTC+1) it shifts the day and would drop the first/last day of a range.
export function isoDate(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function formatDay(iso) {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

// The range that travels with a request: snapshot/PAR reads are as-of the END
// date, flow sums are windowed by [startDate, endDate].
export function rangeOf(filter) {
  if (!filter?.preset) return null
  const [a, b] = periodRange(filter.preset, filter.custom)
  return { startDate: isoDate(a), endDate: isoDate(b) }
}

// React may hand an onClick handler an event instead of a range — only a real
// range object (or an explicit null) overrides the caller's current state.
export function asRange(v, fallback) {
  if (v === null) return null
  if (v && typeof v === 'object' && typeof v.startDate === 'string') return v
  return fallback
}

// ---- URL <-> filter: #/performance?preset=custom&from=…&to=…&branch=… ----
// The applied range/scopes are shareable and survive a reload; with no params
// the page keeps its data-derived default (behaviour unchanged).
export function filterFromParams(params) {
  if (![...params.keys()].length) return null
  const from = params.get('from') || ''
  const to = params.get('to') || ''
  const preset = params.get('preset') || (from && to ? 'custom' : 'month')
  return {
    preset,
    custom: { from, to },
    branchF: params.get('branch') || '',
    areaF: params.get('area') || '',
    deptF: params.get('dept') || '',
    empF: params.get('employee') || '',
    classF: params.get('status') || '',
  }
}

export function rowInRange(r, range) {
  if (!range) return true
  const [a, b] = range
  let s = r.period_start ? new Date(r.period_start) : null
  let e = r.period_end ? new Date(r.period_end) : null
  if (s) s = s.getTime()
  if (e) e = e.getTime()
  if (s && e) return !(e < a) && !(s > b)
  if (s) return s >= a && s <= b
  if (e) return e >= a && e <= b
  const label = (r.period_label || '').match(/^\d{4}-\d{2}/)
  if (label) { const t = new Date(Number(label[0].slice(0, 4)), Number(label[0].slice(5, 7)) - 1, 15).getTime(); return t >= a && t <= b }
  return true
}
