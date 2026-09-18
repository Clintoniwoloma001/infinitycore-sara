const DEFAULT_APP_URL = 'https://infinitymfbcore.vercel.app'

function trimUrl(value: string) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function allowedAppOrigin(value: string) {
  try {
    const url = new URL(value)
    const isProduction = url.protocol === 'https:' && url.hostname === 'infinitymfbcore.vercel.app'
    const isLocal = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
    return isProduction || isLocal ? url.origin : null
  } catch {
    return null
  }
}

export function getAppUrl() {
  const configured = trimUrl(Deno.env.get('APP_URL'))
  // Do not let a Vercel dashboard/deployment URL (or any unrelated URL) turn
  // employee invitations into a generic Vercel sign-up link. Local URLs are
  // intentionally retained for Supabase/Vite development.
  return allowedAppOrigin(configured) || DEFAULT_APP_URL
}

export function getAuthRedirectUrl() {
  return `${getAppUrl()}/#/activate-account`
}
