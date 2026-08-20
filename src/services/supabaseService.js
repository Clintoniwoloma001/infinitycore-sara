import { supabase } from '../supabaseClient'

// Generic CRUD service factory backed by Supabase.
// Each entity table mirrors the Base44 schema (see README for SQL).
export function createService(table) {
  return {
    async list(limit = 500) {
      const { data, error } = await supabase.from(table).select('*').order('created_at', { ascending: false }).limit(limit)
      if (error) throw error
      return data || []
    },
    async create(payload) {
      const { data, error } = await supabase.from(table).insert(payload).select().single()
      if (error) throw error
      return data
    },
    async update(id, payload) {
      const { data, error } = await supabase.from(table).update(payload).eq('id', id).select().single()
      if (error) throw error
      return data
    },
    async remove(id) {
      const { error } = await supabase.from(table).delete().eq('id', id)
      if (error) throw error
    },
  }
}

export const customers = createService('customers')
export const loanApplications = createService('loan_applications')
export const loans = createService('loans')
export const repayments = createService('repayments')
export const leaveRequests = createService('leave_requests')
export const auditLogs = createService('audit_logs')
export const notifications = createService('notifications')

// Audit helper — best-effort log of critical actions.
export async function logAction({ action, entityType = '', entityId = '', details = '', severity = 'info', userName = '' }) {
  try {
    await auditLogs.create({
      action,
      entity_type: entityType,
      entity_id: entityId,
      details,
      user_name: userName,
      severity,
    })
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('Audit log failed:', e?.message || e)
  }
}

// Superadmin email — auto-promoted to admin on signup/login (mirrors the
// Base44 promoteSuperadmin backend function). Uses the regular client: RLS
// allows a user to update their own profile row.
const SUPERADMIN_EMAIL = 'tamunosikiiwolomaclinton@gmail.com'
export async function promoteSuperadmin(email) {
  const e = (email || '').toLowerCase().trim()
  if (e !== SUPERADMIN_EMAIL) return { promoted: false }
const { data, error } = await supabase
    .from('profiles')
    .update({ role: 'super_admin' })
    .eq('email', e)
    .select()
    .single()
  if (error) return { promoted: false, error: error.message }
  return { promoted: true }
}

// Decision email — mirrors the Base44 sendDecisionEmail backend function.
// Supabase has no built-in transactional email API, so this resolves the
// recipient's email, records an in-app notification, and logs the send. To
// deliver real email in production, point this at a Supabase Edge Function
// backed by Resend/SMTP (see CHANGELOG.md).
export async function sendDecisionEmail({ recipientId, subject, message }) {
  try {
    if (!recipientId || !subject || !message) return { sent: false }
    const { data: profile } = await supabase
      .from('profiles')
      .select('email')
      .eq('id', recipientId)
      .single()
    const to = profile?.email
    if (!to) return { sent: false, reason: 'recipient email unavailable' }
    await notifications.create({ user_id: recipientId, title: subject, message, type: 'workflow' })
    // eslint-disable-next-line no-console
    console.info(`[email] to=${to} subject="${subject}"`)
    return { sent: true, sentTo: to }
  } catch (e) {
    return { sent: false, error: e?.message || String(e) }
  }
}
