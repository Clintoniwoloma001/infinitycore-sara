import { supabase } from '../supabaseClient'

// ------------------------------------------------------------------
// SARA Intelligence Layer — Smart Automated Reporting & Approval Assistant
//
// Rules/data-driven intelligence. No external LLM required.
// Queries real application data, detects issues, recommends actions.
// Structured so a real LLM can be connected later without rewriting.
// ------------------------------------------------------------------

// Query real data for SARA responses
export async function queryPendingApprovals() {
  try {
    const { data, error } = await supabase
      .from('leave_requests')
      .select('id, employee_name, leave_type, days, start_date, end_date, created_at, status')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
    if (error) return { count: 0, items: [] }
    return { count: data.length, items: data }
  } catch {
    return { count: 0, items: [] }
  }
}

export async function queryPendingOnboardingReviews() {
  try {
    const { data, error } = await supabase
      .from('employee_onboarding_submissions')
      .select('id, candidate_name, email, status, onboarding_status, created_at, link_id')
      .in('status', ['submitted', 'under_review'])
      .order('created_at', { ascending: false })
    if (error) return { count: 0, items: [] }
    return { count: data.length, items: data }
  } catch {
    return { count: 0, items: [] }
  }
}

export async function queryActiveEmployees() {
  try {
    const { count, error } = await supabase
      .from('employees')
      .select('id', { count: 'exact', head: true })
      .eq('employment_status', 'active')
    if (error) return { count: 0 }
    return { count: count || 0 }
  } catch {
    return { count: 0 }
  }
}

export async function queryInterviewsToday() {
  try {
    const today = new Date().toISOString().split('T')[0]
    const { data, error } = await supabase
      .from('hr_interviews')
      .select('id, candidate_name, interview_date, interview_time, status, location')
      .eq('interview_date', today)
      .order('interview_time', { ascending: true })
    if (error) return { count: 0, items: [] }
    return { count: data.length, items: data }
  } catch {
    return { count: 0, items: [] }
  }
}

export async function queryPendingUsers() {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, full_name, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
    if (error) return { count: 0, items: [] }
    return { count: data.length, items: data }
  } catch {
    return { count: 0, items: [] }
  }
}

// Format a natural-language response from real data
export function formatPendingApprovalsResponse({ count, items }) {
  if (count === 0) return "You have no pending leave approvals."
  const oldest = items[0]
  const daysWaiting = oldest?.created_at
    ? Math.floor((Date.now() - new Date(oldest.created_at).getTime()) / 86400000)
    : 0
  let msg = `You have ${count} leave approval${count === 1 ? '' : 's'} pending.`
  if (daysWaiting > 0) msg += ` The oldest has been waiting for ${daysWaiting} day${daysWaiting === 1 ? '' : 's'}.`
  return msg
}

export function formatOnboardingResponse({ count, items }) {
  if (count === 0) return "There are no pending onboarding reviews."
  const names = items.slice(0, 3).map(i => i.candidate_name || i.email || 'Unknown').join(', ')
  let msg = `There ${count === 1 ? 'is' : 'are'} ${count} pending onboarding review${count === 1 ? '' : 's'}.`
  if (names) msg += ` Recent: ${names}${count > 3 ? ' and others' : ''}.`
  return msg
}

export function formatEmployeesResponse({ count }) {
  if (count === 0) return "There are no active employees currently."
  return `There ${count === 1 ? 'is' : 'are'} currently ${count} active employee${count === 1 ? '' : 's'}.`
}

export function formatInterviewsResponse({ count, items }) {
  if (count === 0) return "There are no interviews scheduled for today."
  let msg = `There ${count === 1 ? 'is' : 'are'} ${count} interview${count === 1 ? '' : 's'} scheduled for today.`
  if (items.length > 0) {
    const details = items.slice(0, 3).map(i =>
      `${i.candidate_name || 'Candidate'} at ${i.interview_time || 'TBD'}${i.location ? ` (${i.location})` : ''}`
    ).join('; ')
    msg += ` ${details}${count > 3 ? ' and more' : ''}.`
  }
  return msg
}

export function formatPendingUsersResponse({ count, items }) {
  if (count === 0) return "There are no pending user approvals."
  let msg = `There ${count === 1 ? 'is' : 'are'} ${count} pending user approval${count === 1 ? '' : 's'}.`
  if (items.length > 0) {
    const names = items.slice(0, 3).map(u => u.full_name || u.email).join(', ')
    msg += ` Waiting: ${names}${count > 3 ? ' and others' : ''}.`
  }
  return msg
}

// Match leave requests for batch approval by criteria
export async function matchLeaveForApproval(filters) {
  try {
    let q = supabase
      .from('leave_requests')
      .select('id, employee_name, leave_type, days, start_date, end_date, created_at, status')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })

    if (filters.leave_type) q = q.eq('leave_type', filters.leave_type)
    if (typeof filters.max_days === 'number') q = q.lte('days', filters.max_days)
    if (typeof filters.min_days === 'number') q = q.gte('days', filters.min_days)

    const { data, error } = await q
    if (error) return []
    return data || []
  } catch {
    return []
  }
}

// Execute batch approval through the secure RPC
export async function executeBatchApproval(requestIds, comments) {
  try {
    const { data, error } = await supabase.rpc('sara_batch_approve_leave', {
      p_request_ids: requestIds,
      p_comments: comments || 'Approved via SARA voice command',
    })
    if (error) throw error
    return data
  } catch (e) {
    return { ok: false, error: e?.message || 'Failed to execute batch approval' }
  }
}

// Log SARA action for audit trail
export async function logSaraAction({ command, intent, action, affectedRecords, result, confirmed }) {
  try {
    await supabase.rpc('sara_log_action', {
      p_command: command,
      p_intent: intent,
      p_action: action,
      p_affected_records: affectedRecords || null,
      p_result: result || null,
      p_confirmed: confirmed || false,
    })
  } catch {
    // best-effort — don't break the flow
  }
}

// Extended intent matching for new SARA commands
export function matchExtendedIntent(text) {
  const t = (text || '').toLowerCase().trim()

  if (/onboarding.*review|review.*onboarding|pending.*onboarding|onboarding.*pending/.test(t))
    return { intent: 'PENDING_ONBOARDING' }

  if (/how many.*active.*employee|active.*employee.*count|how many.*employee/.test(t))
    return { intent: 'ACTIVE_EMPLOYEES' }

  if (/interview.*today|today.*interview|scheduled.*today/.test(t))
    return { intent: 'INTERVIEWS_TODAY' }

  if (/pending.*user|user.*pending|pending.*approval|new.*signup|new.*user/.test(t))
    return { intent: 'PENDING_USERS' }

  if (/auto.*approve|approve.*all|batch.*approve/.test(t))
    return { intent: 'BATCH_APPROVE_LEAVE' }

  return null
}
