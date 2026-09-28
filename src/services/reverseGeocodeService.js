// ============================================================================
// Reverse geocoding for the tracking map.
//
// Turns recorded coordinates into a real street address using the OpenStreetMap
// Nominatim service. Two rules are enforced here rather than left to each caller:
//
//   1. RATE LIMIT. Nominatim's usage policy allows at most ONE request per
//      second. Every call goes through one serialized queue, so opening a day
//      with 40 points can never fire 40 simultaneous requests.
//   2. CACHE + DEDUPE. A coordinate is rounded to ~1 m before lookup, so the
//      same observation is never fetched twice, and a resolved address is kept
//      for the session.
//
// Geocoding is strictly cosmetic: it never contributes to inside/outside, which
// is decided solely by resolve_employee_location() on the server. A lookup
// failure degrades to "no address" and never blocks or alters the tracking view.
// ============================================================================

const ENDPOINT = 'https://nominatim.openstreetmap.org/reverse'
const MIN_INTERVAL_MS = 1100
const PRECISION = 5 // ~1.1 m at the equator: enough to dedupe, not enough to lie

const cache = new Map()
const inflight = new Map()
let queue = Promise.resolve()
let lastRequestAt = 0

/** Same observation -> same key, so repeat renders cost nothing. */
const cacheKey = (lat, lng, zoom) =>
  `${Number(lat).toFixed(PRECISION)},${Number(lng).toFixed(PRECISION)}@${zoom}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Serialize every lookup and hold the 1 req/s floor. */
function enqueue(task) {
  const run = queue.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt)
    if (wait > 0) await sleep(wait)
    lastRequestAt = Date.now()
    return task()
  })
  // Keep the chain alive even if one lookup rejects.
  queue = run.then(() => undefined, () => undefined)
  return run
}

function shortAddress(address = {}) {
  return [
    address.amenity, address.building, address.shop, address.office,
    address.road, address.residential, address.suburb, address.town,
    address.city, address.county, address.state,
  ].filter(Boolean)[0] || null
}

/**
 * Resolve one coordinate to an address.
 * `zoom` biases granularity the way the map is zoomed (18 = house level).
 * Resolves to null on any failure - never throws into the render path.
 */
export function reverseGeocode(lat, lng, zoom = 18) {
  if (lat == null || lng == null) return Promise.resolve(null)

  const key = cacheKey(lat, lng, zoom)
  if (cache.has(key)) return Promise.resolve(cache.get(key))
  if (inflight.has(key)) return inflight.get(key)

  const task = enqueue(async () => {
    const url = `${ENDPOINT}?format=jsonv2&lat=${encodeURIComponent(lat)}`
      + `&lon=${encodeURIComponent(lng)}&zoom=${zoom}&addressdetails=1`
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        referrerPolicy: 'no-referrer-when-downgrade',
      })
      if (!res.ok) return null
      const data = await res.json()
      if (!data || data.error || !data.display_name) return null
      return {
        full: data.display_name,
        short: shortAddress(data.address) || data.display_name.split(',')[0],
      }
    } catch {
      // Offline / blocked / rate-limited: cosmetic only, so stay silent.
      return null
    }
  }).then((result) => {
    cache.set(key, result)
    inflight.delete(key)
    return result
  })

  inflight.set(key, task)
  return task
}

/**
 * Resolve a list of points, oldest first, sequentially through the shared
 * queue. `isCancelled` lets a component abandon the batch when the user changes
 * the date mid-flight.
 */
export async function reverseGeocodeAll(points, { zoom = 18, isCancelled } = {}) {
  const out = {}
  for (const p of points || []) {
    if (isCancelled?.()) break
    const id = p.id ?? `${p.latitude},${p.longitude}`
    out[id] = await reverseGeocode(p.latitude, p.longitude, zoom)
  }
  return out
}

export default { reverseGeocode, reverseGeocodeAll }
