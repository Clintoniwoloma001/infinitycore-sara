import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RESEND_ENDPOINT = 'https://api.resend.com/emails'
// Mirrors src/constants/roles.js — who can manage HR Training.
const TRAINING_MANAGE_ROLES = ['super_admin', 'admin', 'branch_manager']
const EMAIL_CONCURRENCY = 6
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

function formatTime(value) {
  if (!value) return ''
  const [hours, minutes] = String(value).slice(0, 5).split(':')
  const h = Number(hours)
  const suffix = h >= 12 ? 'pm' : 'am'
  const display = ((h % 12) || 12)
  return `${display}:${minutes} ${suffix}`
}

// Small bounded-concurrency queue so we do not hammer Resend with one big
// synchronous burst when inviting the whole workforce.
async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length)
  const queue = items.map((item, index) => ({ item, index }))
  const workers = []
  for (let i = 0; i < Math.min(concurrency, queue.length); i += 1) {
    workers.push((async () => {
      while (queue.length) {
        const { item, index } = queue.shift()
        try {
          results[index] = { ok: true, value: await worker(item) }
        } catch (error) {
          results[index] = { ok: false, error }
        }
      }
    })())
  }
  await Promise.all(workers)
  return results
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

  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || serviceRoleKey
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) return json({ error: 'unauthorized' }, 401)
  const { data: profile } = await userClient.from('profiles').select('role').eq('id', user.id).maybeSingle()
  if (!TRAINING_MANAGE_ROLES.includes(profile?.role)) return json({ error: 'forbidden' }, 403)

  const body = await req.json()
  const sessionId = String(body.sessionId || '')
  const employeeIds = Array.isArray(body.employeeIds) ? body.employeeIds.map((id) => String(id)).filter(Boolean) : []
  if (!sessionId || employeeIds.length === 0) return json({ error: 'session_and_employees_required' }, 400)

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })

  const { data: session } = await admin
    .from('training_sessions')
    .select('id, title, training_type, description, facilitator, training_date, start_time, end_time, duration_minutes, delivery_type, venue_name, venue_address, location, meeting_platform, meeting_url, assessment_required, certificate_enabled, attendance_token')
    .eq('id', sessionId)
    .maybeSingle()
  if (!session) return json({ error: 'session_not_found' }, 404)

  const { data: employees = [] } = await admin
    .from('employees')
    .select('id, full_name, email, user_id')
    .in('id', employeeIds)

  const siteUrl = (Deno.env.get('SITE_URL') || Deno.env.get('APP_URL') || '').replace(/\/$/, '')
  const attendanceLink = session.attendance_token ? `${siteUrl}/#/training-attendance/${encodeURIComponent(session.attendance_token)}` : ''
  const isKss = session.training_type === 'kss'
  const isVirtual = session.delivery_type === 'virtual'
  const platformLabel = session.meeting_platform === 'zoom' ? 'Zoom' : 'Google Meet'
  const deliveryLine = isVirtual
    ? `Delivery: Virtual (${session.meeting_platform ? platformLabel : 'online'})${session.meeting_url ? `\nJoin link: ${session.meeting_url}` : ''}`
    : `Delivery: Physical${session.venue_name ? `\nVenue: ${session.venue_name}${session.venue_address ? `, ${session.venue_address}` : ''}` : ''}`

  const timeLine = [formatTime(session.start_time), formatTime(session.end_time)].filter(Boolean).join(' - ')
  const dateDisplay = session.training_date ? String(session.training_date).slice(0, 10) : ''
  const detailLines = [
    `You have been assigned to the following training session:`,
    `Title: ${session.title}`,
    `Type: ${String(session.training_type).toUpperCase()}${session.assessment_required ? ' (with assessment)' : ''}`,
    `Date: ${dateDisplay}${timeLine ? ` at ${timeLine}` : ''}`,
    `Duration: ${session.duration_minutes} minutes`,
    `Facilitator: ${session.facilitator || 'TBC'}`,
    deliveryLine,
  ].filter(Boolean)
  if (session.description) detailLines.push(`Description: ${session.description}`)
  if (attendanceLink) detailLines.push(`Attendance: ${attendanceLink}`)

  const bodyText = detailLines.join('\n')
  const emailSubject = `Training invitation: ${session.title} (${String(session.training_type).toUpperCase()})`

  const baseHtml = (recipientName) =>
    [
      `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#1e293b">`,
      `<h2 style="color:#009944">Training invitation</h2>`,
      `<p>Dear ${escapeHtml(recipientName)},</p>`,
      `<p>${escapeHtml(bodyText).replace(/\n/g, '<br/>')}</p>`,
      ...(attendanceLink ? [`<p><a href="${escapeHtml(attendanceLink)}" style="display:inline-block;background:#009944;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none">Open training session</a></p>`] : []),
      `<p>Complete any required assessment before the session. Contact HR and Development if you have questions.</p>`,
      `<p>Regards,<br/>Human Resources<br/>Infinity Bank</p>`,
      `</div>`,
    ].join('')

  const from = Deno.env.get('TRAINING_FROM_EMAIL') || Deno.env.get('INTERVIEW_FROM_EMAIL') || 'careers@infinitycore.app'
  const emailConfigured = Boolean(resendKey)

  // ---- 1) In-platform: KSS goes to the KSS Announcements channel ----
  let channel = { ok: false, error: 'channel_not_available' }
  if (isKss) {
    const ensure = await userClient.rpc('ensure_kss_channel')
    const channelId = ensure.data?.channel_id
    if (ensure.error || !channelId) {
      channel = { ok: false, error: ensure.error?.message || 'channel_not_available' }
    } else {
      const post = await userClient.rpc('send_mention_message', {
        p_message_type: 'channel',
        p_context_id: channelId,
        p_body: `New KSS training assigned:\n${bodyText}`,
      })
      channel = post.error
        ? { ok: false, error: post.error.message || 'post_failed' }
        : { ok: true, messageId: post.data?.id, channelId }
    }
  }

  // ---- 2) Email each participant via Resend (bounded concurrency) ----
  const emailTargets = emailConfigured
    ? employees.filter((employee) => Boolean(employee.email))
    : []
  const emailResults = emailTargets.length
    ? await mapConcurrent(emailTargets, EMAIL_CONCURRENCY, async (employee) => {
      const response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to: employee.email,
          subject: emailSubject,
          html: baseHtml(employee.full_name || employee.email),
        }),
      })
      if (!response.ok) throw new Error(`Resend returned ${response.status}`)
      return { id: employee.id, email: employee.email }
    })
    : []

  const emailed = []
  const emailFailed = []
  emailResults.forEach((result, index) => {
    const employee = emailTargets[index]
    if (result.ok) emailed.push(result.value)
    else emailFailed.push({ id: employee.id, name: employee.full_name, email: employee.email, reason: result.error?.message || 'send_failed' })
  })

  // ---- 3) In-platform for non-KSS: individual in-app notifications ----
  let notifiedCount = 0
  let notificationError = null
  if (!isKss) {
    const notificationRows = employees
      .filter((employee) => Boolean(employee.user_id))
      .map((employee) => ({
        user_id: employee.user_id,
        title: `Training invite: ${session.title}`,
        message: bodyText,
        type: 'training',
        link: attendanceLink || null,
      }))
    if (notificationRows.length) {
      const { error } = await admin.from('notifications').insert(notificationRows)
      if (error) notificationError = error.message
      else notifiedCount = notificationRows.length
    }
  }

  await admin.from('audit_logs').insert({
    action: 'TRAINING_INVITES_SENT',
    entity_type: 'TrainingSession',
    entity_id: sessionId,
    user_name: user.email || 'HR',
    details: `Invites sent: ${emailed.length} emails, ${emailFailed.length} failed, ${isKss ? `channel=${channel.ok ? 'posted' : 'failed'}` : `${notifiedCount} notifications`}, ${employeeIds.length} selected`,
    severity: 'info',
  })

  return json({
    status: 'sent',
    session_id: sessionId,
    is_kss: isKss,
    emailConfigured,
    emailSent: emailed.length,
    emailFailed,
    emailed: emailed.map((item) => item.email),
    emailSkipped: employees.length - emailTargets.length,
    channel,
    notifiedCount,
    notificationError,
  })
})