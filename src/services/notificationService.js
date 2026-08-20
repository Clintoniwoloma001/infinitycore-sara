import { notifications as notificationsSvc } from './supabaseService'

// In-app notifications — REAL, backed by the existing `notifications` table.
export async function sendInAppNotification({ userId, title, message, link, type = 'system' }) {
  return notificationsSvc.create({ user_id: userId, title, message, link, type, read: false })
}

// Email — architecture-ready. No provider is configured in this frontend
// project (and never should be — sending real email needs a server-side
// key, e.g. a Supabase Edge Function calling Resend/SendGrid/SES). This
// intentionally does NOT pretend to send anything.
export async function sendEmailNotification({ recipientEmail, subject, message }) {
  // eslint-disable-next-line no-console
  console.info('[notificationService] Email integration not yet configured.', { recipientEmail, subject })
  return { sent: false, channel: 'email', status: 'integration_ready', reason: 'No email provider configured. Wire a Supabase Edge Function + provider (Resend/SendGrid/SES) here.' }
}

// WhatsApp — architecture-ready, same reasoning as email. A real
// implementation needs a verified WhatsApp Business API sender and a
// server-side webhook — see agentService.js for the inbound side.
export async function sendWhatsAppNotification({ recipientPhone, message }) {
  // eslint-disable-next-line no-console
  console.info('[notificationService] WhatsApp integration not yet configured.', { recipientPhone })
  return { sent: false, channel: 'whatsapp', status: 'integration_ready', reason: 'No WhatsApp Business API sender configured yet.' }
}
