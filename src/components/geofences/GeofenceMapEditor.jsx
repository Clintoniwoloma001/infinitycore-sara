import React, { useEffect, useReducer, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Lock, LockOpen, Loader2, Save, XCircle, Move, MapPin } from 'lucide-react'
import RadiusControl from './RadiusControl'
import {
  createFenceGeometry,
  fenceGeometryReducer,
  fenceCircleCentre,
  parseRadius,
} from '../../services/geofenceService'

const GREEN = '#009944'

function pinIcon() {
  return L.divIcon({
    className: 'gf-editor-pin',
    html: '<span class="gf-editor-pin__dot"></span>',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  })
}

function handleIcon() {
  return L.divIcon({
    className: 'gf-editor-handle',
    html: '<span class="gf-editor-handle__ring"></span>',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  })
}

/**
 * Fence editor.
 *
 * Mirror of TrackingMap's Leaflet setup (same tiles, same container
 * styling) plus the three editing affordances:
 *   * a draggable PIN — the test/user location;
 *   * the fence CIRCLE — anchored to the pin while the lock is ON (the
 *     default), and independently draggable via the ring handle when the
 *     lock is OFF;
 *   * the radius slider (10–5000 m, m/km units).
 *
 * The lock behaviour is the pure state machine exported from
 * geofenceService, so the page, the tests and this component cannot
 * drift apart.
 */
export default function GeofenceMapEditor({ branch, initial, isActive = true, busy = false, onSave, onCancel, initialMyPosition }) {
  const [state, dispatch] = useReducer(
    fenceGeometryReducer,
    initial,
    (init) => createFenceGeometry(init),
  )

  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const pinRef = useRef(null)
  const circleRef = useRef(null)
  const handleRef = useRef(null)
  const myMarkerRef = useRef(null)

  // ---- GPS / "Use my location" state -------------------------------------
  const [locationError, setLocationError] = useState(null)

  const useMyLocation = async () => {
    if (navigator.geolocation == null) {
      setLocationError('Geolocation is not supported by this browser.')
      return
    }
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 20000,
          maximumAge: 10000,
        })
      })
      const center = { lat: pos.coords.latitude, lng: pos.coords.longitude }
      setLocationError(null)
      // Snap the fence circle onto the user's location so the fence starts
      // exactly where the admin is, and clear any previous error.
      dispatch({ type: 'set-my-position', center })
    } catch (err) {
      setLocationError('Could not get a GPS fix. Drag the pin manually on the map.')
    }
  }

  const stopMyLocation = () => {
    dispatch({ type: 'set-my-position', center: { lat: null, lng: null } })
    setLocationError(null)
  }

  // Create the map, pin, circle and (unlocked) handle exactly once.
  // Later geometry changes are pushed into the layers by the effect below.
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return undefined
    const start = createFenceGeometry(initial)

    // If the Add-Fence dialog handed down a held "my position" (from the
    // "Use my location" button), pin the green marker there immediately so
    // the fence circle is drawn around the user the moment the editor opens.
    if (initialMyPosition != null) {
      const centre = toCentre(initialMyPosition)
      if (centre) dispatch({ type: 'set-my-position', center: centre })
    }

    const map = L.map(containerRef.current, {
      center: [start.pin.lat, start.pin.lng],
      zoom: 16,
      zoomControl: true,
      scrollWheelZoom: false, // do not hijack page scroll
    })
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map)

    const circle = L.circle([start.circle.lat, start.circle.lng], {
      radius: start.radiusMeters,
      color: GREEN,
      weight: 2,
      fillColor: GREEN,
      fillOpacity: 0.12,
      dashArray: '6 4',
    }).addTo(map)

    const pin = L.marker([start.pin.lat, start.pin.lng], {
      draggable: true,
      icon: pinIcon(),
      zIndexOffset: 1000,
      title: 'Your location — drag to move',
    }).addTo(map)
    pin.on('dragend', () => {
      const ll = pin.getLatLng()
      dispatch({ type: 'pin-move', center: { lat: ll.lat, lng: ll.lng } })
    })

    const handle = L.marker([start.circle.lat, start.circle.lng], {
      draggable: true,
      icon: handleIcon(),
      zIndexOffset: 900,
      title: 'Fence centre — drag to move it independently of the pin',
    })
    handle.on('dragend', () => {
      const ll = handle.getLatLng()
      dispatch({ type: 'circle-move', center: { lat: ll.lat, lng: ll.lng } })
    })

    // The green "your live position" marker. It renders on the branch's stored
    // centre until the admin taps "Use my location", then it follows the
    // device fix so the fence circle can be placed around the user.
    const myLat = start.myPosition?.lat ?? state.pin.lat
    const myLng = start.myPosition?.lng ?? state.pin.lng
    const myMarker = L.marker([myLat, myLng], {
      icon: L.divIcon({
        className: 'gf-editor-my-position',
        html: '<span class="gf-editor-my-position__dot"></span>',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      }),
      zIndexOffset: 800,
      title: 'Your live location',
    }).addTo(map)
    myMarkerRef.current = myMarker

    map.fitBounds(circle.getBounds(), { padding: [40, 40], maxZoom: 17 })

    mapRef.current = map
    pinRef.current = pin
    circleRef.current = circle
    handleRef.current = handle
    if (state.myPosition) {
      myMarker.setLatLng([state.myPosition.lat, state.myPosition.lng])
    }

    return () => {
      map.remove()
      mapRef.current = null
      pinRef.current = null
      circleRef.current = null
      handleRef.current = null
      myMarkerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Push reducer state into the Leaflet layers.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    pinRef.current?.setLatLng([state.pin.lat, state.pin.lng])

    const centre = fenceCircleCentre(state)
    const radius = Number(state.radiusMeters) > 0 ? Number(state.radiusMeters) : 10
    circleRef.current?.setLatLng([centre.lat, centre.lng])
    circleRef.current?.setRadius(radius)

    const handle = handleRef.current
    if (handle) {
      handle.setLatLng([state.circle.lat, state.circle.lng])
      if (state.locked && map.hasLayer(handle)) map.removeLayer(handle)
      if (!state.locked && !map.hasLayer(handle)) map.addLayer(handle)
    }

    const myMarker = myMarkerRef.current
    if (myMarker) {
      myMarker.setLatLng([state.myPosition?.lat ?? state.pin.lat, state.myPosition?.lng ?? state.pin.lng])
    }
  }, [state])

  const centre = fenceCircleCentre(state) || state.pin
  const radius = parseRadius(state.radiusMeters, 'm')

  const handleSave = () => {
    if (radius.error || busy) return
    onSave({ latitude: centre.lat, longitude: centre.lng, radiusMeters: state.radiusMeters })
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800">
      <style>{`
        .gf-editor-pin, .gf-editor-handle { background: transparent; border: none; }
        .gf-editor-pin__dot {
          display: block; width: 22px; height: 22px; border-radius: 9999px;
          background: #ffffff; border: 4px solid ${GREEN}; box-shadow: 0 1px 6px rgba(15, 23, 42, 0.45);
        }
        .gf-editor-handle__ring {
          display: block; width: 24px; height: 24px; border-radius: 9999px;
          background: rgba(255, 255, 255, 0.85); border: 3px dashed ${GREEN};
          box-shadow: 0 1px 4px rgba(15, 23, 42, 0.35);
        }
        .gf-editor-my-position { background: transparent; border: none; }
        .gf-editor-my-position__dot {
          display: block; width: 22px; height: 22px; border-radius: 9999px;
          background: #009944; box-shadow: 0 0 0 3px rgba(0, 153, 68, 0.25), 0 2px 6px rgba(0, 0, 0, 0.35);
        }
      `}</style>

      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4 dark:border-slate-700">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {branch?.branchName || 'Fence editor'}
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {branch?.branchCode ? `${branch.branchCode} · ` : ''}
            {isActive ? 'Active fence' : 'Inactive fence'} · saving writes branch_geofences and mirrors it everywhere
          </p>
        </div>

        <button
          type="button"
          aria-pressed={state.locked}
          aria-label={state.locked ? 'Unlock the fence circle' : 'Lock the fence circle to the pin'}
          onClick={() => dispatch({ type: 'toggle-lock' })}
          className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
            state.locked
              ? 'border-[#009944] bg-emerald-50 text-[#009944] dark:bg-emerald-900/30'
              : 'border-slate-300 text-slate-600 hover:border-slate-400 dark:border-slate-600 dark:text-slate-200'
          }`}
        >
          {state.locked ? <Lock className="w-4 h-4" /> : <LockOpen className="w-4 h-4" />}
          {state.locked ? 'Circle locked' : 'Circle unlocked'}
        </button>
      </header>

      <div
        ref={containerRef}
        className="h-[420px] w-full border-b border-slate-100 dark:border-slate-700"
        aria-label={`Map editor for the ${branch?.branchName || ''} branch fence`}
      />

      <div className="space-y-4 p-5">
        <p className="flex items-start gap-2 text-xs text-slate-500 dark:text-slate-400">
          <Move className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          {state.locked
            ? 'Locked: the circle follows the pin — drag the pin to place the fence.'
            : 'Unlocked: drag the dashed ring handle to move the fence; the pin stays where it is (pin = test location).'}
        </p>

        <RadiusControl
          value={state.radiusMeters}
          onChange={(meters) => dispatch({ type: 'radius-set', meters })}
          disabled={busy}
        />

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">
          <span>
            Fence centre{' '}
            <span className="font-mono text-slate-700 dark:text-slate-200">
              {centre.lat.toFixed(6)}, {centre.lng.toFixed(6)}
            </span>
          </span>
          <span>
            Radius <span className="font-semibold text-slate-700 dark:text-slate-200">{state.radiusMeters} m</span>
          </span>
        </div>

        {/* ---- GPS / "Use my location" ---- */}
        {locationError ? (
          <p className="text-xs text-rose-600 dark:text-rose-400">{locationError}</p>
        ) : state.myPosition ? (
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={useMyLocation}
              className="inline-flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800 hover:bg-emerald-100 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200"
            >
              <Save className="w-3.5 h-3.5" />
              Re-locate
            </button>
            <button
              type="button"
              onClick={stopMyLocation}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300"
            >
              <XCircle className="w-3.5 h-3.5" />
              Stop
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={useMyLocation}
            className="inline-flex items-center gap-2 rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white hover:bg-[#007a36] disabled:opacity-60"
          >
            <MapPin className="w-4 h-4" />
            Use my location
          </button>
        )}

        <div className="flex flex-wrap justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            <XCircle className="w-4 h-4" />
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={busy || Boolean(radius.error)}
            className="inline-flex items-center gap-2 rounded-lg bg-[#009944] px-5 py-2 text-sm font-medium text-white hover:bg-[#007a36] disabled:opacity-60"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save fence
          </button>
        </div>
      </div>
    </div>
  )
}
