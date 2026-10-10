// ============================================================================
// Geofence: modal overlap, "Use my location", Stop and Re-locate
// ============================================================================
// THREE DEFECTS WERE REPORTED ON THE WEB BUILD (web only — mobile works):
//
//   1. Opening "Add fence" let the map behind paint OVER the modal's branch
//      list and its Add buttons.
//   2. "Use my location" did not move the map, the pin or the circle; only the
//      small green dot moved.
//   3. "Stop" did nothing at all, and "Re-locate" shared defect 2.
//
// ROOT CAUSES, each of which this file pins:
//
//   1. Leaflet's panes are z-index 200–700 and its controls 800–1000. The map
//      containers declared NEITHER `position` NOR `z-index`, so they never
//      formed a stacking context and those values escaped into the ROOT
//      stacking context, competing directly with the dialog's z-50. 400 > 50,
//      so the map always won. Fixed by `relative z-0` on the container (which
//      traps the pane z-indexes) plus an overlay z-index above Leaflet's 1000.
//
//   2. `set-my-position` updated `myPosition` and `circle` but NOT `pin`, while
//      `fenceCircleCentre()` renders from `state.pin` whenever the circle is
//      locked — and locked is the default. The reducer therefore moved the dot
//      and left the pin, the circle and the map exactly where they were. The
//      map also had no recentre, so even a correct state change would not have
//      moved the viewport.
//
//   3. Stop dispatched `set-my-position` with a null centre. `toCentre()`
//      returns null for that, and the reducer's `if (!myPosition) return state`
//      guard made the action a complete no-op.
// ============================================================================
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failed = 0
const check = (label, fn) => {
  try {
    fn()
    console.log(`  ok  ${label}`)
  } catch (e) {
    failed += 1
    console.log(`  FAIL ${label}`)
    console.log(`       ${e.message}`)
  }
}

// The reducer + fenceCircleCentre, straight from the shipped source.
const svc = await import(
  `data:text/javascript,${encodeURIComponent(read('src/services/geofenceService.js').replace(/import[\s\S]*?from '[^']*'\s*/g, '').replace(/export async function/g, 'async function'))}`,
)

const { createFenceGeometry, fenceGeometryReducer, fenceCircleCentre } = svc

const leafletCss = read('node_modules/leaflet/dist/leaflet.css')

console.log('\n1. The map can no longer paint over a dialog')
check('every Leaflet container forms its own stacking context', () => {
  const editor = read('src/components/geofences/GeofenceMapEditor.jsx')
  const tester = read('src/components/geofences/CoverageTester.jsx')
  const trackingMap = read('src/components/tracking/TrackingMap.jsx')

  for (const [name, src] of [
    ['GeofenceMapEditor', editor],
    ['CoverageTester', tester],
    ['TrackingMap', trackingMap],
  ]) {
    // A container must be positioned AND declare z-index, or Leaflet's pane
    // z-indexes (200–700) and control z-indexes (800–1000) escape into the ROOT
    // stacking context and beat any dialog's z-50. Accept either a quoted or a
    // template-literal className, since both styles exist in this codebase.
    const scoped =
      /className=(?:"|\{`)[^"`]*\brelative\b[^"`]*\bz-0\b/.test(src)
      || /className=(?:"|\{`)[^"`]*\bz-0\b[^"`]*\brelative\b/.test(src)
      || /isolation:\s*isolate/.test(src)
    assert.ok(
      scoped,
      `${name} must establish a stacking context around its Leaflet panes`,
    )
  }
})

check('the overlay z-index is above Leaflet\'s highest control', () => {
  const modal = read('src/components/geofences/Modal.jsx')
  // Leaflet's controls live at 1000 in the root context.
  const leafletMax = Math.max(
    ...[...leafletCss.matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1])),
  )
  const overlay = Number(/z-\[(\d+)\]/.exec(modal)?.[1])
  assert.ok(overlay > leafletMax, `overlay z-${overlay} must beat Leaflet's z-${leafletMax}`)
})

console.log('\n2. "Use my location" moves the pin, the circle and the viewport')
const start = createFenceGeometry({ lat: 6.5244, lng: 3.3792, radiusMeters: 150 })

check('the acquired fix moves the PIN, not just the dot', () => {
  const next = fenceGeometryReducer(start, {
    type: 'set-my-position',
    center: { lat: 6.6057, lng: 3.3925 },
  })
  assert.deepEqual(next.pin, { lat: 6.6057, lng: 3.3925 })
  assert.deepEqual(next.myPosition, { lat: 6.6057, lng: 3.3925 })
  // Locked (the default) — so the rendered circle follows the pin.
  assert.deepEqual(next.circle, { lat: 6.6057, lng: 3.3925 })
  assert.deepEqual(fenceCircleCentre(next), { lat: 6.6057, lng: 3.3925 })
})

check('relocating keeps the configured radius, the lock and the branch', () => {
  const wide = fenceGeometryReducer(start, { type: 'radius-set', meters: 800 })
  const moved = fenceGeometryReducer(wide, {
    type: 'set-my-position',
    center: { lat: 6.7, lng: 3.5 },
  })
  assert.equal(moved.radiusMeters, 800, 'the radius must survive a relocation')
  assert.equal(moved.locked, start.locked)
})

check('relocating moves the pin; an UNLOCKED circle keeps its own centre', () => {
  // Unlocked is the documented "circle followed the pin and walked with the
  // user" mode: the pin is the test position, the circle is the fence the
  // operator anchored. Relocating the pin therefore must NOT drag an
  // independently-anchored fence — that would silently move a fence the admin
  // had already placed. In the default LOCKED mode the circle DOES come along,
  // which is the case "Use my location" is asked about.
  const unlocked = fenceGeometryReducer(start, { type: 'toggle-lock' })
  assert.equal(unlocked.locked, false)
  const moved = fenceGeometryReducer(unlocked, {
    type: 'set-my-position',
    center: { lat: 6.6057, lng: 3.3925 },
  })
  assert.deepEqual(moved.pin, { lat: 6.6057, lng: 3.3925 }, 'the pin follows the user')
  assert.deepEqual(moved.circle, unlocked.circle, 'the anchored fence is left alone')
  assert.deepEqual(fenceCircleCentre(moved), unlocked.circle)
})

check('a junk fix is refused, never coerced to null island', () => {
  for (const junk of [{ lat: null, lng: null }, { lat: '', lng: '' }, { lat: 'x', lng: 'y' }, {}]) {
    const next = fenceGeometryReducer(start, { type: 'set-my-position', center: junk })
    assert.deepEqual(next, start, `${JSON.stringify(junk)} must be ignored`)
  }
})

check('the component recentres the map on a real centre change only', () => {
  const editor = read('src/components/geofences/GeofenceMapEditor.jsx')
  assert.match(editor, /viewCentreRef/)
  // The camera may move for a genuine relocation, never for a radius drag.
  assert.match(editor, /map\.setView\(\[centre\.lat, centre\.lng\]/)
  assert.match(
    editor,
    /Math\.abs\(viewCentreRef\.current\.lat - centre\.lat\) > 1e-9/,
    'a radius edit or a lock toggle must not yank the viewport',
  )
})

check('a fix acquired before the map exists is held, not dropped', () => {
  const editor = read('src/components/geofences/GeofenceMapEditor.jsx')
  assert.match(editor, /pendingCentre/)
  // The map is not up yet -> hold the fix rather than dropping it.
  assert.match(editor, /if \(mapRef\.current\) \{/)
  assert.match(editor, /setPendingCentre\(centre\)/)
  // Applied the moment the map exists, and the viewport goes there.
  assert.match(editor, /const held = pendingCentre \?\? start\.myPosition \?\? null/)
  assert.match(editor, /map\.setView\(\[at\.lat, at\.lng\]/)
  // And the held value is cleared so it cannot re-apply on a later mount.
  assert.match(editor, /setPendingCentre\(null\)/)
})

check('the map recalculates its size once layout has happened', () => {
  // A Leaflet map created while its container is still 0px renders blank.
  for (const [name, src] of [
    ['GeofenceMapEditor', read('src/components/geofences/GeofenceMapEditor.jsx')],
    ['CoverageTester', read('src/components/geofences/CoverageTester.jsx')],
  ]) {
    assert.match(src, /invalidateSize\(\)/, `${name} must invalidateSize after mount`)
  }
})

check('the camera ref is seeded with the OPENING centre', () => {
  // The whole bug class this guards: the ref drives "did the centre actually
  // change", so it must start from where the camera is, not from the held fix.
  // Seeding it from the fix made the first — and most important — relocation
  // look like a no-op, and the camera stayed on the branch.
  const editor = read('src/components/geofences/GeofenceMapEditor.jsx')
  assert.match(editor, /viewCentreRef\.current = \{ lat: centre\.lat, lng: centre\.lng \}/)
})

console.log('\n3. "Stop" and "Re-locate"')
check('Stop has its own action and actually clears the held fix', () => {
  const reducerSource = read('src/services/geofenceService.js')
  assert.match(reducerSource, /case 'clear-my-position'/)
  // The old action fell through the null guard and did nothing.
  assert.match(reducerSource, /myPosition: null/)

  const held = fenceGeometryReducer(start, {
    type: 'set-my-position',
    center: { lat: 6.6057, lng: 3.3925 },
  })
  assert.ok(held.myPosition, 'sanity: a fix is held first')
  const cleared = fenceGeometryReducer(held, { type: 'clear-my-position' })
  assert.equal(cleared.myPosition, null, 'Stop must release the fix')
  // The fence itself stays exactly where the operator placed it.
  assert.deepEqual(cleared.pin, held.pin)
  assert.deepEqual(cleared.circle, held.circle)
})

check('Stop does not move the fence the operator placed', () => {
  const held = fenceGeometryReducer(start, {
    type: 'set-my-position',
    center: { lat: 6.6057, lng: 3.3925 },
  })
  const stopped = fenceGeometryReducer(held, { type: 'clear-my-position' })
  assert.deepEqual(stopped, { ...held, myPosition: null, locating: false })
})

check('the component dispatches clear-my-position, not a null centre', () => {
  const editor = read('src/components/geofences/GeofenceMapEditor.jsx')
  assert.match(editor, /dispatch\(\{ type: 'clear-my-position' \}\)/)
  assert.ok(
    !/dispatch\(\{ type: 'set-my-position', center: \{ lat: null, lng: null \} \}\)/.test(editor),
    'a null centre is swallowed by the reducer and does nothing',
  )
})

check('Stop is idempotent and never throws', () => {
  const once = fenceGeometryReducer(start, { type: 'clear-my-position' })
  const twice = fenceGeometryReducer(once, { type: 'clear-my-position' })
  assert.deepEqual(twice, once)
})

check('Re-locate uses the same shared acquisition and a fresh fix', () => {
  const editor = read('src/components/geofences/GeofenceMapEditor.jsx')
  assert.match(editor, /await requestGpsPosition\(\)/)
  // One shared path for every GPS button: bounded, maximumAge 0.
  const geo = read('src/lib/geolocation.js')
  assert.match(geo, /maximumAge: 0/)
  assert.match(geo, /timeout: 15000/)
})

check('both buttons are disabled while a fix is in flight', () => {
  const editor = read('src/components/geofences/GeofenceMapEditor.jsx')
  assert.match(editor, /disabled=\{locating\}/)
})

console.log('\n4. The dialog itself is scroll-safe and pins its footer')
check('the dialog is capped to the viewport', () => {
  const modal = read('src/components/geofences/Modal.jsx')
  assert.match(modal, /max-h-\[calc\(100dvh-2rem\)\]/)
  assert.match(modal, /style=\{\{ maxHeight: '100dvh' \}\}/, 'or a dvh fallback')
})
check('the body is the only scrolling region and the footer is not', () => {
  const modal = read('src/components/geofences/Modal.jsx')
  const dialog = read('src/components/geofences/AddFenceDialog.jsx')
  // Modal wraps children in the scroller and the footer OUTSIDE it.
  assert.match(modal, /min-h-0 flex-1 overflow-y-auto/)
  assert.match(modal, /shrink-0 border-t border-slate-100/)
  // The branch picker uses that footer slot rather than inlining Cancel.
  assert.match(dialog, /footer=\{footer\}/)
  assert.ok(
    !/<Modal[^>]*>\s*[\s\S]*<div className="mt-4 flex justify-end">/.test(dialog),
    'Cancel must live in the pinned footer, not in the scrolling body',
  )
})
check('the page behind the modal cannot scroll while it is open', () => {
  const modal = read('src/components/geofences/Modal.jsx')
  assert.match(modal, /document\.body\.style\.overflow = 'hidden'/)
})
check('the branch list scrolls on its own and keeps every Add button', () => {
  const dialog = read('src/components/geofences/AddFenceDialog.jsx')
  assert.match(dialog, /overflow-y-auto/)
  assert.match(dialog, /max-h-\[40vh\]/)
  // No old 55vh cap on the whole panel that would squeeze the rows.
  assert.ok(!/max-h-\[55vh\]/.test(dialog))
})
check('the close button sits above the dialog content', () => {
  const modal = read('src/components/geofences/Modal.jsx')
  assert.match(modal, /absolute right-3 top-3 z-10/)
})

console.log('')
if (failed > 0) {
  console.log(`${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('All geofence web fixes verified.')
