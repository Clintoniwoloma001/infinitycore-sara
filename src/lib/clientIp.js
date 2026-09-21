// Best-effort caller IP for the payroll audit trail. No server is in the
// picture (pure SPA → Supabase), so we resolve the browser's public IP
// through a public endpoint when reachable, falling back to 'unknown' on
// any failure, timeout or privacy blocker. Never throws.
let cached

export async function getClientIp() {
  if (cached !== undefined) return cached
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2500)
    const res = await fetch('https://api.ipify.org?format=json', { signal: controller.signal })
    clearTimeout(timer)
    const json = await res.json()
    cached = json?.ip || 'unknown'
  } catch {
    cached = 'unknown'
  }
  return cached
}

export default getClientIp