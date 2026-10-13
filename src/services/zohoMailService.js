import { supabase } from '../supabaseClient'

// ============================================================================
// Zoho Mail connection service (Audit Automation).
//
// This is intentionally THIN. All OAuth logic is server-side (requirement 1):
// the authorize URL is BUILT by the zoho-oauth-start Edge Function and the code
// exchange + token storage happen in zoho-oauth-callback. The browser only:
//   1. asks the server for the authorize URL and opens it in a popup, and
//   2. reads a MASKED connection status / runs a no-send verification test.
//
// The client NEVER sees the Client Secret, the refresh token, the access token,
// or the encryption key. It never assembles the Zoho authorize request.
// ============================================================================

// Kick off the server-based OAuth flow. Returns { opened, ok } and resolves
// when the popup reports back (or immediately if it could not be opened).
export async function connectZohoMail() {
  let payload
  try {
    const { data, error } = await supabase.functions.invoke('zoho-oauth-start', { body: {} })
    if (error) throw new Error(error.message || 'Failed to start Zoho authorization.')
    payload = data
  } catch (e) {
    return { opened: false, ok: false, error: e.message || String(e) }
  }

  if (payload?.status === 'not_configured') {
    return {
      opened: false,
      ok: false,
      error: 'Zoho Mail is not configured on the server yet (missing ZOHO_CLIENT_ID). An administrator must set the server secrets first.',
    }
  }
  if (!payload?.authorizeUrl) {
    return { opened: false, ok: false, error: 'The server did not return an authorization URL.' }
  }

  // Open the SERVER-BUILT URL in a popup. We do not build or modify it.
  const width = 520
  const height = 640
  const left = window.screenX + (window.outerWidth - width) / 2
  const top = window.screenY + (window.outerHeight - height) / 2
  const popup = window.open(
    payload.authorizeUrl,
    'zoho_oauth',
    `width=${width},height=${height},left=${left},top=${top}`,
  )
  if (!popup) {
    return { opened: false, ok: false, error: 'Popup blocked. Allow popups for this site and try again.' }
  }

  return new Promise((resolve) => {
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      window.removeEventListener('message', onMessage)
      clearInterval(poll)
      resolve(result)
    }
    const onMessage = (event) => {
      if (event.data?.type !== 'zoho_oauth_complete') return
      done({ opened: true, ok: Boolean(event.data.success) })
    }
    window.addEventListener('message', onMessage)
    // Fallback: detect the popup closing without a message (e.g. user closed it).
    const poll = setInterval(() => {
      if (popup.closed) done({ opened: true, ok: false, cancelled: true })
    }, 800)
    // Safety timeout (5 min) so a hung flow never leaves a pending promise.
    setTimeout(() => done({ opened: true, ok: false, timeout: true }), 5 * 60 * 1000)
  })
}

// Read the (masked) connection status. No network call to Zoho.
export async function getZohoMailStatus() {
  try {
    const { data, error } = await supabase.functions.invoke('zoho-mail-status', { body: { _check: true } })
    if (error) return { configured: false, connected: false, error: error.message }
    return data || { configured: false, connected: false }
  } catch (e) {
    return { configured: false, connected: false, error: e.message || String(e) }
  }
}

// Run the backend verification test: refreshes the token server-side and reads
// the sending accountId + permitted From addresses. STILL SENDS NO EMAIL.
export async function testZohoMailConnection() {
  const { data, error } = await supabase.functions.invoke('zoho-mail-status', { body: { test: true } })
  if (error) throw new Error(error.message || 'Connection test failed.')
  return data
}
