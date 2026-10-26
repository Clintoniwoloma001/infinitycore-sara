// Shared helpers for Phase 6 email reply ingestion (audit mailbox / Zoho READ).

export const AUD_TOKEN_RE = /\[AUD-[0-9]{4}-[0-9]{4}\]/i

export function sanitiseBody(raw) {
  if (!raw) return ''
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

export function sanitizeBody(raw) {
  return sanitiseBody(raw)
}

export function extractAudCode(subject) {
  const m = String(subject || '').match(AUD_TOKEN_RE)
  return m ? m[0].toUpperCase() : null
}

export function extractAuditCode(subject) {
  return extractAudCode(subject)
}

export function matchBySubjectToken(subject) {
  return extractAudCode(subject)
}

export function isUnmatchedReply({ finding, isActiveAssignee }) {
  return !finding || !isActiveAssignee
}

export function isZohoMessageDuplicate(existingReply, existingUnmatched) {
  return Boolean(existingReply || existingUnmatched)
}

export function dedupeOnZohoMessageId(messages) {
  const seen = new Set()
  const out = []
  for (const m of messages || []) {
    const id = String(m?.zoho_message_id || m?.messageId || m?.id || '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(m)
  }
  return out
}

export default {
  AUD_TOKEN_RE,
  sanitiseBody,
  sanitizeBody,
  extractAudCode,
  extractAuditCode,
  matchBySubjectToken,
  isUnmatchedReply,
  isZohoMessageDuplicate,
  dedupeOnZohoMessageId,
}
