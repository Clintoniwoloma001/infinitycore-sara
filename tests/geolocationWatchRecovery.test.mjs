import assert from 'node:assert/strict'

// ============================================================================
// The third GPS channel: a live watchPosition used only after BOTH one-shot
// attempts have failed with POSITION_UNAVAILABLE / TIMEOUT.
//
// WHY IT EXISTS
//   Safari throttles repeated one-shot getCurrentPosition calls (a second
//   request after a failure returns POSITION_UNAVAILABLE for minutes), and a
//   one-shot request dies permanently at its timeout even when the OS produces
//   a fix a moment later. On a desktop whose network fix is merely SLOW, the
//   only channel that keeps listening is a watch.
//
// WHAT THIS PINS
//   1. After two one-shot failures, the watch starts and its FIRST fix wins.
//   2. The watch is cleared the moment it settles (no dangling watch).
//   3. If the overall budget expires, the rejection carries the SECOND
//      one-shot error — the real reason — and the watch is cleared.
//   4. A watch error never rejects: the deadline decides, so a slow provider
//      still gets its chance.
//   5. PERMISSION_DENIED never reaches the watch.
//   6. A non-secure origin rejects immediately, before any acquisition.
//   7. Without watchPosition (jsdom / older browsers) the second one-shot
//      reason is surfaced and nothing hangs.
//
// The overall-budget setTimeout is compressed by the shim below so the suite
// stays fast; watch events fire as immediate microtasks, which is how a live
// provider answers — before any timer.
// ============================================================================

let oneShotScript = [] // queued one-shot outcomes: {code} or {latitude, longitude}
let seenOptions = []
let watchCalls = []
let clearWatchCalls = []
let watchPlans = [] // per-watch-call event plans: ['error','fix'], [] means silent
let watchErrors = 0

const realSetTimeout = globalThis.setTimeout
// Compress ONLY the module's multi-second budget; leave sub-second timers
// (used by the mock to sequence events) at their real duration.
globalThis.setTimeout = (fn, ms) => realSetTimeout(fn, ms > 1000 ? 5 : ms)

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    geolocation: {
      getCurrentPosition(resolve, reject, options) {
        seenOptions.push(options)
        const outcome = oneShotScript.shift()
        if (outcome == null || outcome.code == null) resolve({ coords: outcome ?? {} })
        else reject(outcome)
      },
      watchPosition(success, _error, options) {
        watchCalls.push(options)
        const plan = watchPlans.shift() || []
        for (const event of plan) {
          Promise.resolve().then(() => {
            if (event === 'fix') success({ coords: { latitude: 6.5255, longitude: 3.3899 } })
            else if (event === 'error') watchErrors += 1
          })
        }
        return watchCalls.length
      },
      clearWatch(id) {
        clearWatchCalls.push(id)
      },
    },
  },
})

// A window stub whose secure-context answer the test controls.
let secure = true
globalThis.window = { get isSecureContext() { return secure } }

const { GPS_OPTIONS, GPS_FALLBACK_OPTIONS, GPS_WATCH_OPTIONS, GPS_TOTAL_BUDGET_MS, requestGpsPosition } =
  await import('../src/lib/geolocation.js')

const ok = (lat, lng) => ({ latitude: lat, longitude: lng })
const err = (code) => ({ code })

function reset({ oneShots = [], watch = [], isSecure = true } = {}) {
  oneShotScript = [...oneShots]
  watchPlans = watch.map((plan) => [...plan])
  seenOptions = []
  watchCalls = []
  clearWatchCalls = []
  watchErrors = 0
  secure = isSecure
}

// 1. Two one-shot failures, then the watch delivers the first fix.
{
  reset({ oneShots: [err(3), err(2)], watch: [['fix']] })
  const r = await requestGpsPosition()
  assert.equal(r.coords.latitude, 6.5255, 'the fix comes from the watch')
  assert.equal(watchCalls.length, 1, 'exactly one watch is started')
  assert.equal(clearWatchCalls.length, 1, 'the watch is cleared once it settles')
  assert.equal(seenOptions.length, 2, 'both one-shot attempts still run first')
  assert.equal(seenOptions[0].maximumAge, GPS_OPTIONS.maximumAge)
  assert.equal(seenOptions[1].maximumAge, GPS_FALLBACK_OPTIONS.maximumAge)
  assert.equal(
    watchCalls[0].maximumAge,
    GPS_WATCH_OPTIONS.maximumAge,
    'the watch runs on the forgiving options',
  )
  assert.equal(watchCalls[0].timeout, undefined, 'the watch has no timeout of its own')
}

// 2. The budget expiring rejects with the SECOND one-shot error — the real
//    reason — and clears the watch.
{
  reset({ oneShots: [err(2), err(2)], watch: [[]] })
  let caught = null
  try {
    await requestGpsPosition()
  } catch (e) {
    caught = e
  }
  assert.ok(caught, 'a silent watch must not hang the caller')
  assert.equal(caught.code, 2, 'the surfaced reason is the final one-shot reason')
  assert.equal(clearWatchCalls.length, 1, 'the expired watch is cleared')
}

// 3. Watch errors are advisory: an error, then a later fix still resolves.
{
  reset({ oneShots: [err(2), err(2)], watch: [['error', 'fix']] })
  const r = await requestGpsPosition()
  assert.equal(r.coords.longitude, 3.3899, 'a watch error must not end the acquisition')
  assert.equal(watchErrors, 1)
  assert.equal(watchCalls.length, 1, 'no second watch is started after an error')
}

// 4. PERMISSION_DENIED rejects on the first one-shot and never starts a watch.
{
  reset({ oneShots: [err(1), ok(6.5, 3.4)] })
  let caught = null
  try {
    await requestGpsPosition()
  } catch (e) {
    caught = e
  }
  assert.equal(caught?.code, 1)
  assert.equal(watchCalls.length, 0, 'permission-denied must not retry at all')
}

// 5. A non-secure origin fails fast — before any acquisition call.
{
  reset({ oneShots: [ok(6.5, 3.4)], isSecure: false })
  let caught = null
  try {
    await requestGpsPosition()
  } catch (e) {
    caught = e
  }
  assert.equal(caught?.code, 3, 'insecure origin reports as a timeout')
  assert.equal(seenOptions.length, 0, 'no geolocation call is made on an insecure origin')
  assert.equal(watchCalls.length, 0)
}

// 6. A browser without watchPosition reports the second one-shot reason.
//    (This is the jsdom / node-mock case the original contract pins.)
{
  const savedWatch = globalThis.navigator.geolocation.watchPosition
  const savedClear = globalThis.navigator.geolocation.clearWatch
  delete globalThis.navigator.geolocation.watchPosition
  delete globalThis.navigator.geolocation.clearWatch
  reset({ oneShots: [err(2), err(3)] })
  let caught = null
  try {
    await requestGpsPosition()
  } catch (e) {
    caught = e
  }
  assert.equal(caught?.code, 3, 'the final one-shot reason is surfaced')
  globalThis.navigator.geolocation.watchPosition = savedWatch
  globalThis.navigator.geolocation.clearWatch = savedClear
}

globalThis.setTimeout = realSetTimeout

// 7. The overall budget is a sane positive number and is what bounds the UI.
assert.ok(GPS_TOTAL_BUDGET_MS >= 20000, 'the budget must cover both one-shot timeouts')
assert.ok(GPS_TOTAL_BUDGET_MS <= 120000, 'the budget must not leave the UI spinning')

console.log('geolocation watch recovery verified.')
