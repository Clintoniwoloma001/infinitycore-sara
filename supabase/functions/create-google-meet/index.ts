// Supabase Edge Function: create-google-meet
//
// Creates a Google Calendar event with Google Meet conference data.
// Requires Google OAuth tokens stored in integration_connections.
//
// Secrets needed:
//   supabase secrets set GOOGLE_CLIENT_ID=...
//   supabase secrets set GOOGLE_CLIENT_SECRET=...
//
// The frontend calls this via supabase.functions.invoke().
// OAuth tokens are stored in integration_connections (service-role only).

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
  const googleClientId = Deno.env.get('GOOGLE_CLIENT_ID')
  const googleClientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')

  if (!supabaseUrl || !serviceRoleKey) return json({ error: 'env_missing' }, 500)
  if (!googleClientId || !googleClientSecret) return json({ status: 'not_configured', error: 'GOOGLE_CLIENT_ID/SECRET not set' }, 200)

  // Authenticate caller
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) return json({ error: 'unauthorized' }, 401)

  const body = await req.json()
  const { summary, description, startDateTime, endDateTime, attendeeEmail, interviewId } = body

  if (!summary || !startDateTime) return json({ error: 'summary_and_start_required' }, 400)

  const admin = createClient(supabaseUrl, serviceRoleKey)

  // Get the user's Google OAuth tokens
  const { data: conn, error: connError } = await admin
    .from('integration_connections')
    .select('*')
    .eq('user_id', user.id)
    .eq('provider', 'google_calendar')
    .eq('connected', true)
    .single()

  if (connError || !conn) return json({ status: 'not_connected', error: 'Google Calendar not connected' }, 200)

  // Refresh token if expired
  let accessToken = conn.access_token
  if (conn.token_expires_at && new Date(conn.token_expires_at) <= new Date()) {
    if (!conn.refresh_token) return json({ status: 'not_connected', error: 'Token expired, reconnection needed' }, 200)

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: googleClientId,
        client_secret: googleClientSecret,
        refresh_token: conn.refresh_token,
        grant_type: 'refresh_token',
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
      token_expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }).eq('id', conn.id)
  }

  // Create Google Calendar event with Meet conference
  const eventBody = {
    summary,
    description: description || '',
    start: { dateTime: startDateTime, timeZone: 'UTC' },
    end: { dateTime: endDateTime || new Date(new Date(startDateTime).getTime() + 30 * 60000).toISOString(), timeZone: 'UTC' },
    attendees: attendeeEmail ? [{ email: attendeeEmail }] : [],
    conferenceData: {
      createRequest: {
        requestId: `iv-${interviewId || Date.now()}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 24 * 60 },
        { method: 'email', minutes: 60 },
      ],
    },
  }

  try {
    const calRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(eventBody),
    })

    if (!calRes.ok) {
      const errText = await calRes.text()
      await admin.from('audit_logs').insert({
        action: 'google_meet_creation_failed',
        entity_type: 'Interview',
        entity_id: interviewId || '',
        details: `Google Calendar API error: ${calRes.status}`,
        user_name: user.email || 'unknown',
        severity: 'warning',
      })
      return json({ status: 'failed', error: `Google Calendar API returned ${calRes.status}: ${errText}` }, 200)
    }

    const event = await calRes.json()
    const meetUrl = event.conferenceData?.entryPoints?.find((ep) => ep.entryPointType === 'video')?.uri
    const eventId = event.id

    await admin.from('audit_logs').insert({
      action: 'google_meet_created',
      entity_type: 'Interview',
      entity_id: interviewId || '',
      details: `Google Meet created: ${meetUrl || 'no URL'}`,
      user_name: user.email || 'unknown',
      severity: 'info',
    })

    return json({
      status: 'created',
      meetingUrl: meetUrl,
      externalEventId: eventId,
      externalMeetingId: eventId,
    }, 200)
  } catch (e) {
    return json({ status: 'failed', error: String(e.message || e) }, 200)
  }
})
