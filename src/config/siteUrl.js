// Central site/redirect configuration for Supabase auth flows.
//
// Production app: https://infinitymfbcore.vercel.app
// Local development: http://localhost:5173 (Vite default)
//
// Using `window.location.origin` as the fallback means auth redirects always
// return the user to wherever the app is actually running (localhost in dev,
// the Vercel domain in production, or a preview domain) with zero per-env
// configuration. `VITE_SITE_URL` exists only as an explicit override for
// cases where the rendered origin is not the canonical app URL.
//
// NOTE: The Supabase Dashboard must have BOTH origins in the Auth > URL
// Configuration redirect allowlist for confirmations to work in every
// environment (see docs/supabase-auth-settings.md).

const configureSiteUrl = () => {
  const configured = import.meta.env.VITE_SITE_URL
  if (configured) return configured.replace(/\/+$/, '')
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin
  }
  return 'https://infinitymfbcore.vercel.app'
}

export const SITE_URL = configureSiteUrl()
