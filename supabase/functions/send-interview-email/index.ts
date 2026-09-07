// Supabase Edge Function: send-interview-email
//
// Sends a candidate interview invitation email via Resend.
// RESEND_API_KEY must be set as a function secret:
//   supabase secrets set RESEND_API_KEY=re_...
//
// The frontend NEVER sees the API key. This function authenticates
// the caller via their JWT, reads the interview record, and sends
// the email server-side.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const authHeader = req.headers.get('Authorization') || ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'unauthorized' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const resendKey = Deno.env.get('RESEND_API_KEY')
  const fromEmail = Deno.env.get('INTERVIEW_FROM_EMAIL') || 'interviews@infinitycore.app'
  const companyName = Deno.env.get('COMPANY_NAME') || 'InfinityCore'

  if (!supabaseUrl || !serviceRoleKey) return json({ error: 'env_missing' }, 500)
  if (!resendKey) return json({ status: 'not_configured', error: 'RESEND_API_KEY not set' }, 200)

  // Authenticate the caller
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) return json({ error: 'unauthorized' }, 401)

  const body = await req.json()
  const { interviewId, resend = false } = body

  if (!interviewId) return json({ error: 'interview_id_required' }, 400)

  // Use service role to read the interview (bypasses RLS for server-side ops)
  const admin = createClient(supabaseUrl, serviceRoleKey)

  const { data: interview, error: ivError } = await admin
    .from('hr_interviews')
    .select('*')
    .eq('id', interviewId)
    .single()
  if (ivError || !interview) return json({ error: 'interview_not_found' }, 404)

  if (!interview.candidate_email) return json({ error: 'no_candidate_email' }, 400)

  // Build email content
  const candidateName = interview.candidate_name || 'Candidate'
  const position = interview.position || 'the position'
  const interviewDate = interview.scheduled_date
    ? new Date(interview.scheduled_date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    : 'TBD'
  const interviewTime = interview.scheduled_date
    ? new Date(interview.scheduled_date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    : 'TBD'

  let meetingInfo = ''
  if (interview.interview_type === 'PHYSICAL') {
    meetingInfo = `<p><strong>Location:</strong><br/>${interview.location || 'TBD'}</p>`
  } else {
    meetingInfo = `<p><strong>Platform:</strong> ${interview.platform || 'Virtual'}<br/>`
    if (interview.meeting_url) {
      meetingInfo += `<strong>Meeting link:</strong> <a href="${interview.meeting_url}">${interview.meeting_url}</a></p>`
    }
  }

  const subject = `Interview Invitation — ${companyName}`
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1e293b;">
      <h2 style="color: #009944;">Interview Invitation</h2>
      <p>Dear ${candidateName},</p>
      <p>You are invited to an interview for the position of:</p>
      <p style="font-size: 18px; font-weight: 600; color: #009944;">${position}</p>
      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
      <p><strong>Date:</strong> ${interviewDate}</p>
      <p><strong>Time:</strong> ${interviewTime}</p>
      <p><strong>Interview type:</strong> ${interview.interview_type === 'PHYSICAL' ? 'Physical (In-person)' : 'Virtual'}</p>
      ${meetingInfo}
      ${interview.interview_instructions ? `<hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" /><p><strong>Instructions:</strong><br/>${interview.interview_instructions}</p>` : ''}
      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
      <p>Please contact HR if you have any difficulty accessing the interview.</p>
      <p>Regards,<br/><br/>Human Resources<br/>${companyName}</p>
    </div>
  `

  // Send via Resend
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: interview.candidate_email,
        subject,
        html,
      }),
    })

    if (!res.ok) {
      const errText = await res.text()
      // Update interview with failed status
      await admin.from('hr_interviews').update({
        notification_status: 'failed',
        notification_error: `Resend API error: ${res.status}`,
        updated_at: new Date().toISOString(),
      }).eq('id', interviewId)

      await admin.from('audit_logs').insert({
        action: 'interview_email_failed',
        entity_type: 'Interview',
        entity_id: interviewId,
        details: `Email send failed for ${candidateName}: Resend ${res.status}`,
        user_name: user.email || 'unknown',
        severity: 'warning',
      })

      return json({ status: 'failed', error: `Resend API returned ${res.status}` }, 200)
    }

    const result = await res.json()

    // Update interview with sent status
    await admin.from('hr_interviews').update({
      notification_status: 'sent',
      notification_sent_at: new Date().toISOString(),
      notification_error: null,
      updated_at: new Date().toISOString(),
    }).eq('id', interviewId)

    await admin.from('audit_logs').insert({
      action: resend ? 'interview_email_resent' : 'interview_email_sent',
      entity_type: 'Interview',
      entity_id: interviewId,
      details: `Interview invitation ${resend ? 'resent' : 'sent'} to ${interview.candidate_email}`,
      user_name: user.email || 'unknown',
      severity: 'info',
    })

    return json({ status: 'sent', messageId: result.id }, 200)
  } catch (e) {
    await admin.from('hr_interviews').update({
      notification_status: 'failed',
      notification_error: String(e.message || e),
      updated_at: new Date().toISOString(),
    }).eq('id', interviewId)

    return json({ status: 'failed', error: String(e.message || e) }, 200)
  }
})
