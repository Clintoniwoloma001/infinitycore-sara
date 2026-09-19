// One application URL source for all client-side auth redirects.
// VITE_APP_URL should be set to the canonical production URL in Vercel.
//
// Auth emails (sign-up confirmation, password reset) derive their redirect
// target from APP_URL. A generic Vercel preview/deployment origin would make
// those links open a generic Vercel page, so we mirror the edge-function
// allowlist: only the canonical production host (or a local dev origin) is
// ever accepted. Anything else — including a stray preview URL — falls back
// to the canonical production URL.
export const PRODUCTION_APP_URL = 'https://infinitymfbcore.vercel.app'

const PRODUCTION_HOST = 'infinitymfbcore.vercel.app'
const LOCAL_DEV_HOSTS = new Set(['localhost', '127.0.0.1'])

function normalizeUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function allowedOrigin(value) {
  try {
    const url = new URL(normalizeUrl(value))
    if (url.protocol === 'https:' && url.hostname === PRODUCTION_HOST) return url.origin
    if (url.protocol === 'http:' && LOCAL_DEV_HOSTS.has(url.hostname)) return url.origin
    return null
  } catch {
    return null
  }
}

function configureAppUrl() {
  const configured = allowedOrigin(import.meta.env.VITE_APP_URL)
  if (configured) return configured

  if (typeof window !== 'undefined' && window.location?.origin) {
    const origin = allowedOrigin(window.location.origin)
    if (origin) return origin
  }

  return PRODUCTION_APP_URL
}

export const APP_URL = configureAppUrl()
export const AUTH_REDIRECT_URL = `${APP_URL}/#/activate-account`
export const SIGNUP_REDIRECT_URL = `${APP_URL}/#/login`
