// Supabase Edge Function: ingest-audit-email-replies
//
// Scheduled every 5 minutes. Polls the audit mailbox via Zoho READ, matches
// replies to an audit finding by the [AUD-code] subject token or by the
// In-Reply-To header, sanitises the body and attachments, and ingests them
// into the finding thread (source=email). Replies whose From is not the active
// assignee are routed to the unmatched replies queue. Deduplication is on
// zoho_message_id.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ZOHO_API_BASE = Deno.env.get('ZOHO_API_BASE') || 'https://mail.zoho.com/api'
const ZOHO_ACCOUNT_ID = Deno.env.get('ZOHO_ACCOUNT_ID') || ''
const ZOHO_FOLDER_ID = Deno.env.get('ZOHO_AUDIT_FOLDER_ID') || Deno.env.get('ZOHO_FOLDER_ID') || 'inbox'
const ZOHO_ACCESS_TOKEN = Deno.env.get('ZOHO_MAIL_ACCESS_TOKEN') || Deno.env.get('ZOHO_ACCESS_TOKEN') || ''

const AUD_TOKEN_RE = /\[AUD-[0-9]{4}-[0-9]{4}\]/i

function sanitiseBody(raw: string): string {
  if (!raw) return ''
  // Strip scripts/styles and any HTML tags; collapse whitespace.
  let out = String(raw)
  out = out.replace(/<script[\s\S]*?<\/script>/gi, '')
  out = out.replace(/<style[\s\S]*?<\/style>/gi, '')
  out = out.replace(/<[^>]+>/g, ' ')
  out = out.replace(/&nbsp;/gi, ' ')
  out = out.replace(/&amp;/gi, '&')
  out = out.replace(/&lt;/gi, '<')
  out = out.replace(/&gt;/gi, '>')
  out = out.replace(/\s+/g, ' ').trim()
  return out
}

function extractAudCode(subject: string): string | null {
  const m = String(subject || '').match(AUD_TOKEN_RE)
  return m ? m[0].toUpperCase() : null
}

async function zohoFetch(path: string): Promise<any> {
  const res = await fetch(`${ZOHO_API_BASE}${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}` },
  })
  if (!res.ok) throw new Error(`zoho_read_failed_${res.status}`)
  return res.json()
}

Deno.serve(async (_req) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: 'env_missing' }), { status: 500 })
  }
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })

  if (!ZOHO_ACCESS_TOKEN || !ZOHO_ACCOUNT_ID) {
    return new Response(JSON.stringify({ status: 'not_configured', error: 'zoho_credentials_missing' }), { status: 200 })
  }

  let ingested = 0
  let unmatched = 0
  let skipped = 0

  try {
    const list = await zohoFetch(`/accounts/${ZOHO_ACCOUNT_ID}/folders/${ZOHO_FOLDER_ID}/messages?limit=50`)
    const messages = list?.data || list?.messages || []

    for (const msg of messages) {
      const messageId = String(msg.messageId || msg.id || msg.zoho_message_id || '')
      if (!messageId) { skipped++; continue }

      // Dedupe on zoho_message_id across both queues.
      const { data: existingReply } = await admin.from('audit_email_replies').select('id').eq('zoho_message_id', messageId).maybeSingle()
      const { data: existingUnmatched } = await admin.from('audit_unmatched_replies').select('id').eq('zoho_message_id', messageId).maybeSingle()
      if (existingReply || existingUnmatched) { skipped++; continue }

      // Fetch full message (body + attachments + headers).
      let full: any = msg
      try {
        full = await zohoFetch(`/accounts/${ZOHO_ACCOUNT_ID}/folders/${ZOHO_FOLDER_ID}/messages/${messageId}`)
      } catch (_e) { /* fall back to list payload */ }

      const subject = String(full?.subject || msg?.subject || '')
      const fromEmail = String(full?.fromAddress || full?.from?.email || msg?.fromAddress || '').toLowerCase().trim()
      const fromName = String(full?.from?.name || full?.senderName || '')
      const inReplyTo = String(full?.inReplyTo || full?.headers?.['In-Reply-To'] || '')
      const rawBody = String(full?.content || full?.body || full?.textBody || full?.htmlBody || msg?.content || '')
      const bodySanitised = sanitiseBody(rawBody)
      const attachments = Array.isArray(full?.attachments) ? full.attachments : []

      // Match to a finding: [AUD-code] subject token first, then In-Reply-To.
      let finding: any = null
      let matchedBy: string | null = null
      const audCode = extractAudCode(subject)
      if (audCode) {
        const { data: f } = await admin.from('audit_findings').select('id, reference, process_owner_user_id').eq('reference', audCode.replace(/[\[\]]/g, '')).maybeSingle()
        if (f) { finding = f; matchedBy = 'subject_token' }
      }
      if (!finding && inReplyTo) {
        const { data: prior } = await admin.from('audit_email_replies').select('finding_id').eq('zoho_message_id', inReplyTo).maybeSingle()
        if (prior?.finding_id) {
          const { data: f } = await admin.from('audit_findings').select('id, reference, process_owner_user_id').eq('id', prior.finding_id).maybeSingle()
          if (f) { finding = f; matchedBy = 'in_reply_to' }
        }
      }

      // Verify From is the active assignee.
      let assigneeUserId: string | null = null
      let isActiveAssignee = false
      if (finding?.process_owner_user_id) {
        const { data: profile } = await admin.from('profiles').select('id, status, email').eq('id', finding.process_owner_user_id).maybeSingle()
        if (profile && (profile.status === 'active' || !profile.status) && String(profile.email || '').toLowerCase() === fromEmail) {
          isActiveAssignee = true
          assigneeUserId = profile.id
        }
      }
      // Also allow any active profile whose email matches the finding owner email.
      if (!isActiveAssignee && finding) {
        const { data: ownerProfile } = await admin.from('profiles').select('id, status, email').ilike('email', fromEmail).maybeSingle()
        if (ownerProfile && (ownerProfile.status === 'active' || !ownerProfile.status)) {
          // confirm this profile is the finding's process owner
          if (finding.process_owner_user_id && ownerProfile.id === finding.process_owner_user_id) {
            isActiveAssignee = true
            assigneeUserId = ownerProfile.id
          }
        }
      }

      if (!finding) {
        await admin.from('audit_unmatched_replies').insert({
          zoho_message_id: messageId,
          in_reply_to: inReplyTo || null,
          from_email: fromEmail,
          from_name: fromName,
          subject,
          body_sanitised: bodySanitised,
          attachments,
          source: 'email',
          reason: 'no_matching_finding',
        })
        await admin.from('unmatched_replies').insert({
          zoho_message_id: messageId,
          in_reply_to: inReplyTo || null,
          from_email: fromEmail,
          from_name: fromName,
          subject,
          body_sanitised: bodySanitised,
          attachments,
          source: 'email',
          reason: 'no_matching_finding',
        }).then(() => {}).catch(() => {})
        await admin.from('unmatched_email_replies').insert({
          zoho_message_id: messageId,
          in_reply_to: inReplyTo || null,
          from_email: fromEmail,
          from_name: fromName,
          subject,
          body_sanitised: bodySanitised,
          attachments,
          source: 'email',
          reason: 'no_matching_finding',
        }).then(() => {}).catch(() => {})
        unmatched++
        continue
      }

      if (!isActiveAssignee) {
        await admin.from('audit_unmatched_replies').insert({
          zoho_message_id: messageId,
          in_reply_to: inReplyTo || null,
          from_email: fromEmail,
          from_name: fromName,
          subject,
          body_sanitised: bodySanitised,
          attachments,
          source: 'email',
          reason: 'from_not_active_assignee',
        })
        await admin.from('unmatched_replies').insert({
          zoho_message_id: messageId,
          in_reply_to: inReplyTo || null,
          from_email: fromEmail,
          from_name: fromName,
          subject,
          body_sanitised: bodySanitised,
          attachments,
          source: 'email',
          reason: 'from_not_active_assignee',
        }).then(() => {}).catch(() => {})
        await admin.from('unmatched_email_replies').insert({
          zoho_message_id: messageId,
          in_reply_to: inReplyTo || null,
          from_email: fromEmail,
          from_name: fromName,
          subject,
          body_sanitised: bodySanitised,
          attachments,
          source: 'email',
          reason: 'from_not_active_assignee',
        }).then(() => {}).catch(() => {})
        unmatched++
        continue
      }

      await admin.from('audit_email_replies').insert({
        finding_id: finding.id,
        zoho_message_id: messageId,
        in_reply_to: inReplyTo || null,
        from_email: fromEmail,
        from_name: fromName,
        subject,
        body_sanitised: bodySanitised,
        attachments,
        source: 'email',
        matched_by: matchedBy,
        assignee_user_id: assigneeUserId,
      })
      ingested++
    }

    return new Response(JSON.stringify({ ok: true, ingested, unmatched, skipped }), { status: 200 })
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: String(error?.message || error), ingested, unmatched, skipped }), { status: 500 })
  }
})
