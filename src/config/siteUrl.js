// One application URL source for all client-side auth redirects.
// VITE_APP_URL should be set to the canonical production URL in Vercel. The
// browser-origin fallback keeps local Vite development on its actual port.
export const PRODUCTION_APP_URL = 'https://infinitymfbcore.vercel.app'

function normalizeUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function configureAppUrl() {
  const configured = normalizeUrl(import.meta.env.VITE_APP_URL)
  if (configured) return configured

  if (typeof window !== 'undefined' && window.location?.origin) {
    return normalizeUrl(window.location.origin)
  }

  return PRODUCTION_APP_URL
}

export const APP_URL = configureAppUrl()
export const AUTH_REDIRECT_URL = `${APP_URL}/#/activate-account`
export const SIGNUP_REDIRECT_URL = `${APP_URL}/#/login`
