import React, { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { CheckCircle2, Crosshair, Loader2, Radar, XCircle } from 'lucide-react'
import { gpsErrorMessage, requestGpsPosition } from '../../lib/geolocation'
import {
  geofenceService,
  geofenceErrorMessage,
  coverageErrorMessage,
} from '../../services/geofenceService'

const GREEN = '#009944'

function positionIcon() {
  return L.divIcon({
    className: 'gf-tester-pin',
    html: '<span class="gf-tester-pin__dot"></span>',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  })
}

/**
 * "Test My Coverage".
 *
 * Acquires a GPS fix (or accepts manual coordinates), places the pin on
 * the map, asks check_is_within_geofence() and renders the SERVER's
 * verdict — distance_meters is never recomputed client-side. The circle
 * pulses like a radar sweep while the check runs, and an animated modal
 * celebrates a result that lands inside. A result that lands outside
 * gets no modal, only the red badge.
 */
export default function CoverageTester({ fences = [], branchId, onBranchChange }) {
  const [manual, setManual] = useState({ lat: '', lng: '' })
  const [position, setPosition] = useState(null)
  const [running, setRunning] = useState(false)
  const [gpsBusy, setGpsBusy] = useState(false)
  const [verdict, setVerdict] = useState(null)
  const [error, setError] = useState(null)
  const [showSuccess, setShowSuccess] = useState(false)

  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const circleRef = useRef(null)
  const pinRef = useRef(null)

  const fence = fences.find((f) => f.branchId === branchId) || null

  // ---- map: created once, layers follow props/state ----
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return undefined
    const centre = fence ? [fence.latitude, fence.longitude] : [6.5244, 3.3792]

    const map = L.map(containerRef.current, {
      center: centre,
      zoom: fence ? 15 : 5,
      zoomControl: true,
      scrollWheelZoom: false,
    })
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map)

    const circle = L.circle(centre, {
      radius: fence?.radiusMeters || 150,
      color: GREEN,
      weight: 2,
      fillColor: GREEN,
      fillOpacity: 0.1,
      dashArray: '6 4',
    }).addTo(map)

    mapRef.current = map
    circleRef.current = circle

    // Leaflet has to be told the container's size once layout has actually
    // happened. Without this the map can be created while its box is still 0px
    // and then renders blank, which reads as "the map is missing".
    const raf = requestAnimationFrame(() => map.invalidateSize())

    return () => {
      cancelAnimationFrame(raf)
      map.remove()
      mapRef.current = null
      circleRef.current = null
      pinRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Circle follows the selected fence.
  useEffect(() => {
    const circle = circleRef.current
    if (!circle) return
    if (!fence || fence.latitude == null || fence.longitude == null) return
    circle.setLatLng([fence.latitude, fence.longitude])
    circle.setRadius(Number(fence.radiusMeters) > 0 ? Number(fence.radiusMeters) : 10)
    mapRef.current?.fitBounds(circle.getBounds(), { padding: [40, 40], maxZoom: 16 })
  }, [fence])

  // Pin follows the latest fix / manual entry.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !position) return
    if (!pinRef.current) {
      pinRef.current = L.marker([position.lat, position.lng], {
        icon: positionIcon(),
        zIndexOffset: 1000,
        title: 'Tested location',
      }).addTo(map)
    } else {
      pinRef.current.setLatLng([position.lat, position.lng])
    }
    map.panTo([position.lat, position.lng])
  }, [position])

  // Radar sweep: pulse the circle only while a check is in flight.
  useEffect(() => {
    const element = circleRef.current?.getElement()
    if (!element) return
    element.classList.toggle('gf-radar-pulse', running)
  }, [running])

  // Esc closes the success modal.
  useEffect(() => {
    if (!showSuccess) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') setShowSuccess(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [showSuccess])

  const runTest = async ({ lat, lng }) => {
    setRunning(true)
    setError(null)
    setVerdict(null)
    setShowSuccess(false)
    try {
      const result = await geofenceService.checkWithinGeofence({ lat, lng, branchId })
      setPosition({ lat, lng })
      setVerdict(result)
      if (result.serverError) setError(coverageErrorMessage(result))
      else if (result.within) setShowSuccess(true)
    } catch (e) {
      setError(geofenceErrorMessage(e))
    } finally {
      setRunning(false)
    }
  }

  const useMyLocation = async () => {
    if (!branchId) {
      setError('Choose a branch to test against.')
      return
    }
    setGpsBusy(true)
    setError(null)
    try {
      // Same shared acquisition as every other GPS button: bounded timeout, no
      // cached fix, and the real reason surfaced when it fails.
      const position = await requestGpsPosition()
      runTest({ lat: position.coords.latitude, lng: position.coords.longitude })
    } catch (err) {
      setGpsBusy(false)
      setError(gpsErrorMessage(err))
    }
  }

  const runManual = () => {
    if (!branchId) {
      setError('Choose a branch to test against.')
      return
    }
    const rawLat = String(manual.lat).trim()
    const rawLng = String(manual.lng).trim()
    if (rawLat === '' || rawLng === '') {
      setError('Enter both a latitude and a longitude to test manually.')
      return
    }
    const lat = Number(rawLat)
    const lng = Number(rawLng)
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      setError('Latitude must be a number between -90 and 90.')
      return
    }
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      setError('Longitude must be a number between -180 and 180.')
      return
    }
    runTest({ lat, lng })
  }

  const setManualField = (field, value) => setManual((prev) => ({ ...prev, [field]: value }))

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800">
      <style>{`
        @keyframes gf-radar-sweep {
          0%   { stroke-opacity: 0.95; stroke-width: 2; }
          55%  { stroke-opacity: 0.25; stroke-width: 9; }
          100% { stroke-opacity: 0.95; stroke-width: 2; }
        }
        .gf-radar-pulse { animation: gf-radar-sweep 1.5s ease-out infinite; }
        @keyframes gf-modal-in {
          from { opacity: 0; transform: scale(0.88); }
          to   { opacity: 1; transform: scale(1); }
        }
        .gf-modal-in { animation: gf-modal-in 220ms cubic-bezier(0.22, 1, 0.36, 1) both; }
        .gf-tester-pin, .gf-tester-pin__dot { background: transparent; border: none; }
        .gf-tester-pin__dot {
          display: block; width: 22px; height: 22px; border-radius: 9999px;
          background: #ffffff; border: 4px solid #2563eb; box-shadow: 0 1px 6px rgba(15, 23, 42, 0.45);
        }
      `}</style>

      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4 dark:border-slate-700">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100">
            <Radar className="h-5 w-5 text-[#009944]" />
            Test My Coverage
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Uses the same server check clock-in uses — your distance comes from the database, never from this page.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="gf-test-branch" className="sr-only">Branch to test</label>
          <select
            id="gf-test-branch"
            value={branchId || ''}
            onChange={(event) => onBranchChange(event.target.value || null)}
            className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700 focus:border-[#009944] focus:outline-none focus:ring-2 focus:ring-[#009944]/30 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200"
          >
            {fences.length === 0 && <option value="">No fences yet</option>}
            {fences.map((f) => (
              <option key={f.branchId} value={f.branchId}>
                {f.branchName}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-5 p-5 lg:grid-cols-2">
        <div
          ref={containerRef}
          className="relative z-0 h-72 w-full rounded-lg border border-slate-200 dark:border-slate-700"
          aria-label="Map showing the fence under test and the tested point"
        />

        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={useMyLocation}
              disabled={running || gpsBusy || !branchId}
              className="inline-flex items-center gap-2 rounded-lg bg-[#009944] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#007a36] disabled:opacity-60"
            >
              {gpsBusy || running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Crosshair className="h-4 w-4" />}
              {gpsBusy ? 'Finding you…' : running ? 'Checking…' : 'Use my location'}
            </button>
            <button
              type="button"
              onClick={runManual}
              disabled={running || !branchId}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              <XCircle className="h-4 w-4" />
              Run manual test
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="gf-test-lat" className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
                Latitude
              </label>
              <input
                id="gf-test-lat"
                type="text"
                inputMode="decimal"
                placeholder="6.524400"
                value={manual.lat}
                onChange={(event) => setManualField('lat', event.target.value)}
                className="h-10 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-[#009944] focus:outline-none focus:ring-2 focus:ring-[#009944]/30 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>
            <div>
              <label htmlFor="gf-test-lng" className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
                Longitude
              </label>
              <input
                id="gf-test-lng"
                type="text"
                inputMode="decimal"
                placeholder="3.379200"
                value={manual.lng}
                onChange={(event) => setManualField('lng', event.target.value)}
                className="h-10 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-[#009944] focus:outline-none focus:ring-2 focus:ring-[#009944]/30 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          <p className="text-xs text-slate-400 dark:text-slate-500">
            GPS unavailable? Enter coordinates by hand — the check is identical.
          </p>

          {error && (
            <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {error}
            </p>
          )}

          {running && (
            <p className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400" role="status">
              <Loader2 className="h-4 w-4 animate-spin text-[#009944]" />
              Sweeping the fence…
            </p>
          )}

          {!running && verdict && !verdict.serverError && (
            <div className="space-y-2">
              {verdict.hasGeofence === false ? (
                <div className="flex items-start gap-2 rounded-lg bg-slate-100 px-3 py-3 text-sm text-slate-600 dark:bg-slate-700 dark:text-slate-200">
                  <span className="mt-1 h-2 w-2 flex-shrink-0 rounded-full bg-slate-400" />
                  <span>
                    <strong className="font-semibold">No fence to test</strong>
                    {' — '}
                    {verdict.reason || 'no active geofence is configured for this branch.'}
                  </span>
                </div>
              ) : verdict.within ? (
                <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" />
                  <span>
                    <strong className="font-semibold">Inside {fence?.branchName || 'the fence'}</strong>
                    {verdict.distanceMeters != null && (
                      <> — {verdict.distanceMeters} m from the centre (radius {verdict.radiusMeters} m)</>
                    )}
                  </span>
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-900/40 dark:text-rose-200">
                  <XCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                  <span>
                    <strong className="font-semibold">
                      Outside by {verdict.metersOutside != null ? verdict.metersOutside : '?'} m
                    </strong>
                    {verdict.distanceMeters != null && (
                      <> — {verdict.distanceMeters} m from the centre (radius {verdict.radiusMeters} m)</>
                    )}
                  </span>
                </div>
              )}

              <p className="text-xs text-slate-400 dark:text-slate-500">
                {position && (
                  <span className="font-mono">
                    Tested {position.lat.toFixed(6)}, {position.lng.toFixed(6)} ·{' '}
                  </span>
                )}
                {verdict.source ? `answer from ${verdict.source}` : 'server verdict'}
              </p>
            </div>
          )}
        </div>
      </div>

      {showSuccess && verdict?.within && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="gf-success-title"
            className="gf-modal-in w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-2xl dark:border dark:border-slate-700 dark:bg-slate-800"
          >
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/50">
              <CheckCircle2 className="h-8 w-8 text-[#009944]" />
            </div>
            <h3 id="gf-success-title" className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              Inside {fence?.branchName || 'the fence'}
            </h3>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {verdict.distanceMeters != null ? `${verdict.distanceMeters} m from the centre` : 'Within the fence'}
              {verdict.radiusMeters != null && ` · radius ${verdict.radiusMeters} m`}
            </p>
            <button
              type="button"
              autoFocus
              onClick={() => setShowSuccess(false)}
              className="mt-5 w-full rounded-lg bg-[#009944] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#007a36]"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
