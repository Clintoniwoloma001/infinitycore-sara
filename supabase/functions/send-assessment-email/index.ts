import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RESEND_ENDPOINT = 'https://api.resend.com/emails'
const HR_ROLES = ['super_admin', 'admin', 'head_of_human_resources', 'hr_officer']
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } })
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]))
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  const authorization = req.headers.get('Authorization') || ''
  if (!authorization.startsWith('Bearer ')) return json({ error: 'unauthorized' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!supabaseUrl || !serviceRoleKey) return json({ error: 'env_missing' }, 500)
  if (!resendKey) return json({ status: 'not_configured', error: 'RESEND_API_KEY not set' })

  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || serviceRoleKey
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) return json({ error: 'unauthorized' }, 401)
  const { data: profile } = await userClient.from('profiles').select('role').eq('id', user.id).maybeSingle()
  if (!HR_ROLES.includes(profile?.role)) return json({ error: 'forbidden' }, 403)

  const body = await req.json()
  const assignmentId = String(body.assignmentId || '')
  const invitationToken = String(body.invitationToken || '')
  if (!assignmentId || !invitationToken) return json({ error: 'assignment_and_token_required' }, 400)

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
  const { data: assignment, error: assignmentError } = await admin.from('hr_assessments').select('id, test_name, expires_at, candidate_id, job_id').eq('id', assignmentId).single()
  if (assignmentError || !assignment) return json({ error: 'assessment_not_found' }, 404)
  const { data: candidate } = await admin.from('hr_candidates').select('full_name, email, applied_role').eq('id', assignment.candidate_id).maybeSingle()
  if (!candidate?.email) return json({ status: 'not_configured', error: 'candidate_email_missing' })
  const { data: job } = await admin.from('hr_jobs').select('job_title').eq('id', assignment.job_id).maybeSingle()
  const siteUrl = (Deno.env.get('SITE_URL') || Deno.env.get('APP_URL') || '').replace(/\/$/, '')
  const assessmentUrl = `${siteUrl}/#/careers/assessment/${encodeURIComponent(invitationToken)}`
  const candidateName = escapeHtml(candidate.full_name || 'Candidate')
  const title = escapeHtml(assignment.test_name || 'Recruitment assessment')
  const role = escapeHtml(job?.job_title || candidate.applied_role || 'the position')
  const expiry = assignment.expires_at ? new Date(assignment.expires_at).toLocaleString('en-US') : 'the stated deadline'

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: Deno.env.get('ASSESSMENT_FROM_EMAIL') || Deno.env.get('INTERVIEW_FROM_EMAIL') || 'careers@infinitycore.app',
        to: candidate.email,
        subject: `Assessment invitation for ${role}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#1e293b"><h2 style="color:#009944">Assessment invitation</h2><p>Dear ${candidateName},</p><p>You have been invited to complete <strong>${title}</strong> for <strong>${role}</strong>.</p><p><a href="${assessmentUrl}" style="display:inline-block;background:#009944;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none">Start assessment</a></p><p>This invitation expires ${escapeHtml(expiry)}. Please complete the assessment independently and contact HR if you have access problems.</p><p>Regards,<br/>Human Resources<br/>Infinity Bank</p></div>`,
      }),
    })
    if (!response.ok) {
      await admin.from('hr_assessments').update({ notification_status: 'failed', updated_at: new Date().toISOString() }).eq('id', assignmentId)
      return json({ status: 'failed', error: `Resend returned ${response.status}` })
    }
    const result = await response.json()
    await admin.from('hr_assessments').update({ notification_status: 'sent', updated_at: new Date().toISOString() }).eq('id', assignmentId)
    await admin.from('audit_logs').insert({ action: 'ASSESSMENT_SENT', entity_type: 'Assessment', entity_id: assignmentId, user_name: user.email || 'HR', details: `Assessment invitation sent to ${candidate.email}`, severity: 'info' })
    return json({ status: 'sent', messageId: result.id, url: assessmentUrl })
  } catch (error) {
    await admin.from('hr_assessments').update({ notification_status: 'failed', updated_at: new Date().toISOString() }).eq('id', assignmentId)
    return json({ status: 'failed', error: String(error?.message || error) })
  }
})
