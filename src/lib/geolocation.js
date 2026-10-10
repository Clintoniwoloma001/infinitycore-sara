// ============================================================================
// GPS acquisition — ONE place that talks to navigator.geolocation.
// ============================================================================
// Every "Use my location" button on the web (Geofence Settings, the fence
// editor and the coverage tester) goes through here, so they all fail the same
// way and all say what actually happened.
//
// WHY THIS FILE EXISTS
//   The buttons previously called getCurrentPosition with `enableHighAccuracy:
//   true` and a 20 s timeout and then threw the error away, rendering one
//   sentence — "Could not get a GPS fix" — for permission-denied,
//   position-unavailable, timeout and insecure-context alike. On a browser
//   where GPS is allowed but the OS fix is slow (or the page is not a secure
//   context), that reads as "the button does nothing", which is exactly what
//   was reported.
//
// WHAT IT GUARANTEES
//   * A promise, never a callback that can be silently dropped.
//   * `maximumAge: 0` — a fence centre or a tested point must be the CURRENT
//     position, never a cached one from earlier in the session.
//   * A bounded timeout (default 15 s) so the UI can never hang on "Finding
//     you…" forever: a timed-out request is reported, not swallowed.
//   * An actionable message per GeolocationPositionError code, plus the
//     insecure-context case (browsers refuse geolocation entirely on a
//     non-HTTPS origin, and that is not the user's fault).
// ============================================================================

export const GPS_OPTIONS = {
  enableHighAccuracy: true,
  // 0: a stale cached fix is useless for placing a fence or testing coverage.
  maximumAge: 0,
  // Bounded so the caller can always recover instead of waiting indefinitely.
  timeout: 15000,
}

// Retry options — the behaviour the buttons had BEFORE they were centralised
// (CoverageTester used maximumAge 30 s, GeofenceMapEditor 10 s). A desktop or
// laptop has no GPS: the OS serves a network fix, and a strict
// `maximumAge: 0` request frequently fails with POSITION_UNAVAILABLE even
// though a recent fix is sitting in the browser's cache and is perfectly good
// for placing a fence or testing coverage. So the strict request is only the
// FIRST attempt — if it fails for a reason that means "no fresh fix right
// now", we retry once allowing a recent network fix instead of surfacing an
// error the user never saw before.
export const GPS_FALLBACK_OPTIONS = {
  enableHighAccuracy: false,
  // Recent enough to be this session's own position, not yesterday's.
  maximumAge: 60000,
  timeout: 20000,
}

/** One actionable sentence for a failed GPS acquisition. */
export function gpsErrorMessage(error) {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return 'Location is blocked because this page is not served over HTTPS. Open the app on its secure address, or enter coordinates manually.'
  }
  if (typeof navigator === 'undefined' || navigator.geolocation == null) {
    return 'This browser does not support location detection. Enter coordinates manually.'
  }
  switch (error?.code) {
    // PERMISSION_DENIED
    case 1:
      return 'Location access was denied. Allow location for this site in your browser (and check your operating system\'s location settings), or enter coordinates manually.'
    // POSITION_UNAVAILABLE
    case 2:
      return 'Your position could not be determined. Make sure location services and GPS are enabled for this device, or enter coordinates manually.'
    // TIMEOUT
    case 3:
      return 'The location request timed out. Move to a place with a clearer GPS signal and try again, or enter coordinates manually.'
    default:
      return 'Unable to get your location. Please try again, or enter coordinates manually.'
  }
}

/**
 * Acquire one current position.
 *
 * Two attempts, in order:
 *   1. Strict — high accuracy, no cached fix (`GPS_OPTIONS`). On a GPS device
 *      this is the fence-grade fix we want.
 *   2. Fallback — only if attempt 1 failed with POSITION_UNAVAILABLE or
 *      TIMEOUT (never for PERMISSION_DENIED or an unsupported browser): retry
 *      allowing a recent network fix (`GPS_FALLBACK_OPTIONS`). This is the
 *      behaviour the buttons had before they were centralised, and without it
 *      every desktop/laptop — which has no GPS and often cannot produce a
 *      brand-new fix on demand — reports "Your position could not be
 *      determined" even though the browser knows exactly where it is.
 *
 * Rejects with a GeolocationPositionError-shaped object, so callers only need
 * `gpsErrorMessage(err)` — distinct reasons stay distinct.
 */
export function requestGpsPosition(options = {}) {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || navigator.geolocation == null) {
      const err = new Error('Geolocation is not supported by this browser.')
      err.code = 0
      reject(err)
      return
    }
    const ask = (opts) =>
      new Promise((res, rej) => {
        navigator.geolocation.getCurrentPosition(res, rej, opts)
      })
    ask({ ...GPS_OPTIONS, ...options }).then(resolve, (err) => {
      // code 2 = POSITION_UNAVAILABLE, code 3 = TIMEOUT. Both mean "no fresh
      // fix right now", which is exactly the case a recent cached / low-power
      // network fix answers. code 1 (PERMISSION_DENIED) must never retry.
      if (err && (err.code === 2 || err.code === 3)) {
        ask({ ...GPS_OPTIONS, ...GPS_FALLBACK_OPTIONS, ...options }).then(resolve, reject)
      } else {
        reject(err)
      }
    })
  })
}

/** { lat, lng } from a GeolocationPosition. */
export function positionToCentre(position) {
  return {
    lat: Number(position.coords.latitude),
    lng: Number(position.coords.longitude),
  }
}
