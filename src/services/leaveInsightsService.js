// Decision-support insights for approvers reviewing a leave request.
//
// This is intentionally computed from real Supabase data with plain
// aggregation logic — no external AI API call, no API key to manage,
// nothing that can fail or time out mid-demo. The "intelligence" is
// the historical pattern detection itself, not the sentence generator.
//
// UPGRADE PATH: if you later want a real LLM to phrase the summary
// (e.g. via the Anthropic API), do it ONLY inside generateSummaryText()
// below — every other function here stays the same. Never hardcode an
// API key in this file; read it from an environment variable and call
// it from a server-side function, not directly from the browser.

import { LEAVE_TYPE_LABELS } from './leaveBalanceService'

const WEEKS = 7 * 24 * 60 * 60 * 1000

function daysBetween(s, e) {
  return Math.max(Math.ceil((new Date(e) - new Date(s)) / 86400000) + 1, 0)
}

// allRequests: full leave_requests list (already loaded by the page).
// target: the specific request currently being decided.
export function computeLeaveInsights(allRequests, target) {
  const sameEmployee = allRequests.filter((r) => r.created_by === target.created_by && r.id !== target.id)
  const thisYear = new Date().getFullYear()
  const sameEmployeeThisYear = sameEmployee.filter((r) => new Date(r.start_date).getFullYear() === thisYear)

  const sameTypeThisYear = sameEmployeeThisYear.filter((r) => r.leave_type === target.leave_type)
  const approvedSameTypeThisYear = sameTypeThisYear.filter((r) => r.status === 'approved')
  const totalDaysThisYearSameType = approvedSameTypeThisYear.reduce((sum, r) => sum + (r.days || 0), 0)

  const last6Weeks = sameEmployee.filter((r) => {
    const t = new Date(r.created_at || r.start_date).getTime()
    return Date.now() - t <= 6 * WEEKS
  })
  const last6WeeksSameType = last6Weeks.filter((r) => r.leave_type === target.leave_type)

  // Weekend-adjacency check: does this request start on a Mon/Fri, or
  // end on a Fri/Mon — a soft signal worth surfacing, not a verdict.
  const startDay = new Date(target.start_date).getDay()
  const endDay = new Date(target.end_date).getDay()
  const weekendAdjacent = [1, 5].includes(startDay) || [1, 5].includes(endDay)

  const flags = []
  if (last6WeeksSameType.length >= 2) {
    flags.push(`${last6WeeksSameType.length + 1}${ordinal(last6WeeksSameType.length + 1)} ${LEAVE_TYPE_LABELS[target.leave_type] || target.leave_type} leave request in the last 6 weeks`)
  }
  if (weekendAdjacent && target.leave_type === 'sick') {
    flags.push('Request is adjacent to a weekend')
  }

  const requestedDays = target.days || daysBetween(target.start_date, target.end_date)

  return {
    requestCountThisYearSameType: sameTypeThisYear.length,
    approvedDaysThisYearSameType: totalDaysThisYearSameType,
    recentRequestsCount: last6WeeksSameType.length,
    flags,
    summary: generateSummaryText(target, requestedDays, sameTypeThisYear.length, totalDaysThisYearSameType, flags),
    suggestion: generateSuggestion(flags, requestedDays),
  }
}

function ordinal(n) {
  if (n === 1) return 'st'
  if (n === 2) return 'nd'
  if (n === 3) return 'rd'
  return 'th'
}

function generateSummaryText(target, requestedDays, priorCountThisYear, priorDaysThisYear, flags) {
  const typeLabel = LEAVE_TYPE_LABELS[target.leave_type] || target.leave_type
  let text = `Requesting ${requestedDays} day${requestedDays === 1 ? '' : 's'} of ${typeLabel.toLowerCase()} leave, ${formatRange(target.start_date, target.end_date)}.`
  if (priorCountThisYear > 0) {
    text += ` This is their ${priorCountThisYear + 1}${ordinal(priorCountThisYear + 1)} ${typeLabel.toLowerCase()} request this year (${priorDaysThisYear} day${priorDaysThisYear === 1 ? '' : 's'} already taken).`
  } else {
    text += ` This is their first ${typeLabel.toLowerCase()} request this year.`
  }
  if (flags.length > 0) {
    text += ` ${flags.join('. ')}.`
  }
  return text
}

function generateSuggestion(flags, requestedDays) {
  if (flags.length === 0) {
    return { level: 'ok', text: 'Consistent with entitlement and history — no concerns.' }
  }
  return { level: 'flag', text: `Worth a quick look before deciding: ${flags[0].toLowerCase()}.` }
}

function formatRange(s, e) {
  const opts = { month: 'short', day: 'numeric' }
  const sd = new Date(s).toLocaleDateString(undefined, opts)
  const ed = new Date(e).toLocaleDateString(undefined, opts)
  return sd === ed ? sd : `${sd} – ${ed}`
}
