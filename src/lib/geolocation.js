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
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      ...GPS_OPTIONS,
      ...options,
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
