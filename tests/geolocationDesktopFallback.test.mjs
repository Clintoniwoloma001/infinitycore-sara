import assert from 'node:assert/strict'

// ============================================================================
// "Use my location" must work on a desktop/laptop with no GPS.
//
// ROOT CAUSE OF THE REGRESSION: when the GPS calls were centralised into
// src/lib/geolocation.js the options became `maximumAge: 0` — demanding a
// brand-new fix on every press. Before that centralisation the buttons allowed
// a recent cached fix (CoverageTester: 30 s, GeofenceMapEditor: 10 s). On a
// machine with no GPS the OS serves a network fix and a strict zero-cache
// request frequently fails with POSITION_UNAVAILABLE, so every button showed
// "Your position could not be determined" — a screen its users had never seen.
//
// The contract verified here: strict request FIRST, one retry allowing a
// recent fix for POSITION_UNAVAILABLE / TIMEOUT only, and NEVER a retry for
// PERMISSION_DENIED.
// ============================================================================

// A controllable navigator.geolocation mock: each getCurrentPosition call
// consumes the next scripted outcome and records the options it was given.
// (Node 26 exposes a getter-only `navigator`, so it must be redefined.)
let script = []
let seenOptions = []
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    geolocation: {
      getCurrentPosition(resolve, reject, options) {
        seenOptions.push(options)
        const outcome = script.shift()
        if (outcome?.code == null) resolve({ coords: outcome })
        else reject(outcome)
      },
    },
  },
})

const { GPS_OPTIONS, GPS_FALLBACK_OPTIONS, requestGpsPosition } = await import(
  '../src/lib/geolocation.js'
)

const ok = (lat, lng) => ({ latitude: lat, longitude: lng })
const err = (code) => ({ code })

async function run(outcomes) {
  script = [...outcomes]
  seenOptions = []
  try {
    return { ok: true, value: await requestGpsPosition() }
  } catch (e) {
    return { ok: false, value: e }
  }
}

// 1. A good strict fix is returned directly — no fallback, no retry.
{
  const r = await run([ok(6.52, 3.37)])
  assert.equal(r.ok, true, 'a good strict fix must resolve')
  assert.equal(r.value.coords.latitude, 6.52)
  assert.equal(seenOptions.length, 1, 'a good fix must not trigger a retry')
  assert.equal(seenOptions[0].maximumAge, GPS_OPTIONS.maximumAge)
}

// 2. POSITION_UNAVAILABLE on the strict request retries with the forgiving
//    options and resolves with the network fix. This is the desktop case.
{
  const r = await run([err(2), ok(6.53, 3.38)])
  assert.equal(r.ok, true, 'the fallback fix must resolve')
  assert.equal(r.value.coords.longitude, 3.38)
  assert.equal(seenOptions.length, 2, 'code 2 must trigger exactly one retry')
  assert.equal(seenOptions[1].maximumAge, GPS_FALLBACK_OPTIONS.maximumAge)
  assert.ok(seenOptions[1].maximumAge > 0, 'the retry must allow a cached fix')
  assert.equal(seenOptions[0].maximumAge, 0, 'the first attempt stays strict')
}

// 3. TIMEOUT also retries — a slow first fix is the same failure mode.
{
  const r = await run([err(3), ok(6.54, 3.39)])
  assert.equal(r.ok, true, 'a timed-out strict request must retry')
  assert.equal(seenOptions.length, 2)
}

// 4. PERMISSION_DENIED never retries — asking again cannot change the answer.
{
  const r = await run([err(1), ok(6.55, 3.4)])
  assert.equal(r.ok, false, 'permission-denied must reject')
  assert.equal(r.value.code, 1)
  assert.equal(seenOptions.length, 1, 'permission-denied must not retry')
}

// 5. Two failures in a row surface the SECOND (real) reason, once.
{
  const r = await run([err(2), err(2)])
  assert.equal(r.ok, false, 'two failures must reject')
  assert.equal(r.value.code, 2, 'the surfaced reason is the final one')
  assert.equal(seenOptions.length, 2, 'exactly one retry, never a loop')
}

console.log('geolocation desktop fallback verified.')
