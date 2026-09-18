const DEFAULT_APP_URL = 'https://infinitymfbcore.vercel.app'

function trimUrl(value: string) {
  return String(value || '').trim().replace(/\/+$/, '')
}

export function getAppUrl() {
  return trimUrl(Deno.env.get('APP_URL')) || DEFAULT_APP_URL
}

export function getAuthRedirectUrl() {
  return `${getAppUrl()}/#/activate-account`
}
