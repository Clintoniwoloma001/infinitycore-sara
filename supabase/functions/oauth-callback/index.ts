// Supabase Edge Function: oauth-callback
//
// Handles OAuth callbacks for Google Calendar and Zoom.
// Exchanges the authorization code for tokens and stores them
// in integration_connections (service-role only).
//
// Secrets needed:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
//   ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET
//   OAUTH_REDIRECT_BASE (e.g. https://your-app.supabase.co)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const provider = url.searchParams.get('provider') || state?.split(':')[0]
  const userId = state?.split(':')[1]
  const error = url.searchParams.get('error')

  if (error) return json({ error: `OAuth error: ${error}` }, 400)
  if (!code || !provider || !userId) return json({ error: 'missing_params' }, 400)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const redirectBase = Deno.env.get('OAUTH_REDIRECT_BASE') || supabaseUrl

  if (!supabaseUrl || !serviceRoleKey) return json({ error: 'env_missing' }, 500)

  const admin = createClient(supabaseUrl, serviceRoleKey)

  let tokenUrl, clientId, clientSecret, redirectUri, scopes

  if (provider === 'google_calendar') {
    clientId = Deno.env.get('GOOGLE_CLIENT_ID')
    clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')
    redirectUri = `${redirectBase}/functions/v1/oauth-callback?provider=google_calendar`
    tokenUrl = 'https://oauth2.googleapis.com/token'
    scopes = 'https://www.googleapis.com/auth/calendar'
  } else if (provider === 'zoom') {
    clientId = Deno.env.get('ZOOM_CLIENT_ID')
    clientSecret = Deno.env.get('ZOOM_CLIENT_SECRET')
    redirectUri = `${redirectBase}/functions/v1/oauth-callback?provider=zoom`
    tokenUrl = 'https://zoom.us/oauth/token'
  } else {
    return json({ error: 'unknown_provider' }, 400)
  }

  if (!clientId || !clientSecret) return json({ error: `${provider}_not_configured` }, 500)

  // Exchange code for tokens
  let tokenRes
  if (provider === 'google_calendar') {
    tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    })
  } else {
    // Zoom uses Basic auth
    const credentials = btoa(`${clientId}:${clientSecret}`)
    tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    })
  }

  if (!tokenRes.ok) {
    const errText = await tokenRes.text()
    return json({ error: `token_exchange_failed: ${tokenRes.status}: ${errText}` }, 400)
  }

  const tokens = await tokenRes.json()

  // Store tokens in integration_connections
  const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString()

  // Upsert connection
  const { data: existing } = await admin
    .from('integration_connections')
    .select('id')
    .eq('user_id', userId)
    .eq('provider', provider)
    .maybeSingle()

  if (existing) {
    await admin.from('integration_connections').update({
      connected: true,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }).eq('id', existing.id)
  } else {
    await admin.from('integration_connections').insert({
      user_id: userId,
      provider,
      connected: true,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: expiresAt,
    })
  }

  await admin.from('audit_logs').insert({
    action: `${provider}_connected`,
    entity_type: 'IntegrationConnection',
    entity_id: userId,
    details: `${provider} integration connected`,
    user_name: userId,
    severity: 'info',
  })

  // Return a simple HTML page that closes the popup
  return new Response(
    `<html><body style="font-family: sans-serif; text-align: center; padding: 40px;">
      <h2 style="color: #009944;">✓ ${provider === 'google_calendar' ? 'Google Calendar' : 'Zoom'} Connected</h2>
      <p>You can close this window and return to the interview scheduling form.</p>
      <script>setTimeout(() => window.close(), 2000);</script>
    </body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html' } }
  )
})
