import { supabase } from '../supabaseClient'
import { parseSaraCommand } from './saraCommandParser'
import { APPROVER_ROLES } from './leaveApprovalsService'

// ------------------------------------------------------------------
// SARA NLU — hybrid approach.
//
// 1. Deterministic parser first (offline, free, predictable).
// 2. Only when that fails, ask the server-side `sara-intent` Edge
//    Function (OpenAI) to extract {intent, entities, criteria, ...}.
//
// The Edge Function AUTHENTICATES the caller and derives the allowed
// intent list server-side from the user's own permissions. It returns
// a structured parse — it NEVER executes anything. All execution still
// goes through agentService → existing authorization → Supabase RLS.
// If the function is missing/unreachable we degrade gracefully.
// ------------------------------------------------------------------

// Intents the deterministic parser emits.
export const LOCAL_INTENTS = ['SHOW_PENDING', 'COUNT_PENDING', 'APPROVE_LEAVE', 'REJECT_LEAVE', 'CONFIRM', 'CANCEL', 'HELP', 'NAVIGATE', 'ROLE_CHANGE_DENIED', 'UNKNOWN']

// Intents the Edge Function may return on top of the local set.
export const AI_INTENTS = ['DASHBOARD_SUMMARY', 'PENDING_ATTENTION', 'PENDING_LOANS']

export const ALL_INTENTS = [...new Set([...LOCAL_INTENTS, ...AI_INTENTS])]

// Writes that must NEVER run without the user's own permission set.
export const CONSEQUENTIAL_INTENTS = ['APPROVE_LEAVE', 'REJECT_LEAVE']

// Reads that are safe to run once the authenticated user can reach them —
// record access still comes from RLS-scoped queries.
export const READ_INTENTS = ['SHOW_PENDING', 'COUNT_PENDING', 'DASHBOARD_SUMMARY', 'PENDING_ATTENTION', 'PENDING_LOANS', 'NAVIGATE']

// Read intents never need extra gates — record access still comes from
// RLS-scoped queries. Write intents require either the leave-management
// permission, an admin role, or an APPROVER role (way into the chain for
// that request), matching canActOnRequest/currentStage. The real scope
// gate is still the authenticated pool (myQueue) that agentService matches
// against, and RLS on the actual write.
export const INTENT_PERMISSION_GATES = {
  APPROVE_LEAVE: ['hr.leave.manage'],
  REJECT_LEAVE: ['hr.leave.manage'],
}

export function isConsequentialIntent(intent) {
  return CONSEQUENTIAL_INTENTS.includes(intent)
}

export function canExecuteIntent(intent, ctx) {
  if (READ_INTENTS.includes(intent)) return true
  const gates = INTENT_PERMISSION_GATES[intent]
  if (!gates) return false
  if (ctx?.isAdmin || APPROVER_ROLES.includes(ctx?.role)) return true
  const perms = ctx?.permissions || []
  return gates.some((p) => perms.includes(p))
}

// Build the compact intent whitelist handed to the server so the model
// can only suggest things this user could plausibly do. The function
// re-derives the same list server-side — this copy is advisory.
export function intentWhitelist(ctx) {
  const list = [...READ_INTENTS]
  if (canExecuteIntent('APPROVE_LEAVE', ctx)) list.push('APPROVE_LEAVE', 'REJECT_LEAVE')
  return list
}

async function callAiNlu(text, ctx) {
  const { data, error } = await supabase.functions.invoke('sara-intent', {
    body: {
      text,
      route: ctx?.route || '',
      permissions: intentWhitelist(ctx),
    },
  })
  if (error) throw error
  return data || null
}

// Normalize whatever the AI service returned into our canonical shape.
// Untrusted! Validate every field; never pass raw values through.
function sanitizeAiResult(raw) {
  if (!raw || typeof raw !== 'object') return null
  const intent = String(raw.intent || '').toUpperCase()
  if (!ALL_INTENTS.includes(intent)) return null
  const filters = {}
  if (raw.entities && typeof raw.entities === 'object') {
    const e = raw.entities
    if (typeof e.employee_name === 'string' && e.employee_name) filters.employee = e.employee_name
    if (typeof e.leave_type === 'string' && e.leave_type) filters.leave_type = e.leave_type
    if (typeof e.branch === 'string' && e.branch) filters.branch = e.branch
    if (Array.isArray(e.traits) && e.traits.length) filters.traits = e.traits
  }
  if (typeof raw.criteria?.max_days === 'number') filters.max_days = raw.criteria.max_days
  if (typeof raw.criteria?.min_days === 'number') filters.min_days = raw.criteria.min_days
  if (typeof raw.criteria?.exact_days === 'number') filters.exact_days = raw.criteria.exact_days
  if (raw.all === true) filters.all = true
  filters.status = 'pending'
  return { intent, filters, source: 'ai', confidence: Number(raw.confidence) || 0.5 }
}

export async function analyzeIntent(raw, ctx = {}) {
  const text = (raw || '').trim()
  if (!text) return { intent: 'UNKNOWN', filters: {}, source: 'none', confidence: 0 }

  // Deterministic pass first — fast, predictable, offline-safe.
  const local = parseSaraCommand(text)
  if (local.intent !== 'UNKNOWN') {
    // Gate: if the local parser says approve/reject but the user can't,
    // say so loudly rather than silently escalating later.
    if (isConsequentialIntent(local.intent) && !canExecuteIntent(local.intent, ctx)) {
      return { ...local, source: 'local', confidence: 0.95, blocked: 'permission' }
    }
    return { ...local, source: 'local', confidence: 0.9 }
  }

  // Weak match — try the server-side NLU when enabled and available.
  if (ctx.aiEnabled !== false) {
    try {
      const ai = sanitizeAiResult(await callAiNlu(text, ctx))
      if (ai) {
        if (isConsequentialIntent(ai.intent) && !canExecuteIntent(ai.intent, ctx)) {
          return { ...ai, blocked: 'permission' }
        }
        return ai
      }
    } catch { /* function not deployed / network — fall through to UNKNOWN */ }
  }

  return { intent: 'UNKNOWN', filters: {}, source: 'none', confidence: 0 }
}