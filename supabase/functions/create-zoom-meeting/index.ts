// Supabase Edge Function: create-zoom-meeting
//
// Creates a Zoom meeting via the Zoom API.
// Requires Zoom OAuth tokens stored in integration_connections.
//
// Secrets needed:
//   supabase secrets set ZOOM_CLIENT_ID=...
//   supabase secrets set ZOOM_CLIENT_SECRET=...
//
// The frontend calls this via supabase.functions.invoke().

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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
  const zoomClientId = Deno.env.get('ZOOM_CLIENT_ID')
  const zoomClientSecret = Deno.env.get('ZOOM_CLIENT_SECRET')

  if (!supabaseUrl || !serviceRoleKey) return json({ error: 'env_missing' }, 500)
  if (!zoomClientId || !zoomClientSecret) return json({ status: 'not_configured', error: 'ZOOM_CLIENT_ID/SECRET not set' }, 200)

  // Authenticate caller
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) return json({ error: 'unauthorized' }, 401)

  const body = await req.json()
  const { topic, description, startDateTime, durationMinutes, interviewId } = body

  if (!topic || !startDateTime) return json({ error: 'topic_and_start_required' }, 400)

  const admin = createClient(supabaseUrl, serviceRoleKey)

  // Get the user's Zoom OAuth tokens
  const { data: conn, error: connError } = await admin
    .from('integration_connections')
    .select('*')
    .eq('user_id', user.id)
    .eq('provider', 'zoom')
    .eq('connected', true)
    .single()

  if (connError || !conn) return json({ status: 'not_connected', error: 'Zoom not connected' }, 200)

  // Refresh token if expired
  let accessToken = conn.access_token
  if (conn.token_expires_at && new Date(conn.token_expires_at) <= new Date()) {
    if (!conn.refresh_token) return json({ status: 'not_connected', error: 'Token expired, reconnection needed' }, 200)

    // Zoom uses Basic auth for token refresh
    const credentials = btoa(`${zoomClientId}:${zoomClientSecret}`)
    const tokenRes = await fetch('https://zoom.us/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: conn.refresh_token,
      }),
    })

    if (!tokenRes.ok) {
      await admin.from('integration_connections').update({ connected: false }).eq('id', conn.id)
      return json({ status: 'not_connected', error: 'Token refresh failed' }, 200)
    }

    const tokens = await tokenRes.json()
    accessToken = tokens.access_token
    const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString()
    await admin.from('integration_connections').update({
      access_token: accessToken,
      refresh_token: tokens.refresh_token || conn.refresh_token,
      token_expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }).eq('id', conn.id)
  }

  // Create Zoom meeting
  const meetingBody = {
    topic: topic,
    type: 2, // Scheduled meeting
    start_time: new Date(startDateTime).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    duration: durationMinutes || 30,
    timezone: 'UTC',
    agenda: description || '',
    settings: {
      host_video: true,
      participant_video: true,
      join_before_host: false,
      mute_upon_entry: true,
      waiting_room: true,
    },
  }

  try {
    // Get user's Zoom user ID from /users/me
    const userRes = await fetch('https://api.zoom.us/v2/users/me', {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    })

    if (!userRes.ok) {
      return json({ status: 'failed', error: `Zoom user lookup failed: ${userRes.status}` }, 200)
    }

    const zoomUser = await userRes.json()

    const meetingRes = await fetch(`https://api.zoom.us/v2/users/${zoomUser.id}/meetings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(meetingBody),
    })

    if (!meetingRes.ok) {
      const errText = await meetingRes.text()
      await admin.from('audit_logs').insert({
        action: 'zoom_meeting_creation_failed',
        entity_type: 'Interview',
        entity_id: interviewId || '',
        details: `Zoom API error: ${meetingRes.status}`,
        user_name: user.email || 'unknown',
        severity: 'warning',
      })
      return json({ status: 'failed', error: `Zoom API returned ${meetingRes.status}: ${errText}` }, 200)
    }

    const meeting = await meetingRes.json()

    await admin.from('audit_logs').insert({
      action: 'zoom_meeting_created',
      entity_type: 'Interview',
      entity_id: interviewId || '',
      details: `Zoom meeting created: ${meeting.id}`,
      user_name: user.email || 'unknown',
      severity: 'info',
    })

    return json({
      status: 'created',
      meetingUrl: meeting.join_url,
      externalMeetingId: String(meeting.id),
      meetingStartUrl: meeting.start_url,
    }, 200)
  } catch (e) {
    return json({ status: 'failed', error: String(e.message || e) }, 200)
  }
})
