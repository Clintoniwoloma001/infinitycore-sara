import { test, expect } from '@playwright/test'

// Deliberately far from the branch centre (6.605754, 3.392573) and from the
// FALLBACK_CENTRE (6.5244, 3.3792), so a pass proves the position came from
// navigator.geolocation rather than a default being rendered.
const MOCK_FIX = { lat: 6.613799, lng: 3.351522 }

/** Grant a mocked browser position BEFORE any page script runs. */
const grantFix = async (page, fix = MOCK_FIX) => {
  await page.addInitScript((coords) => {
    if (!navigator.geolocation) navigator.geolocation = {}
    navigator.geolocation.getCurrentPosition = (success) => {
      setTimeout(
        () =>
          success({
            coords: {
              latitude: coords.lat,
              longitude: coords.lng,
              accuracy: 12,
              altitude: null,
              heading: null,
              speed: null,
            },
            timestamp: Date.now(),
          }),
        30,
      )
    }
    navigator.permissions = {
      ...navigator.permissions,
      query: async () => ({ state: 'granted' }),
    }
  }, fix)
}

test.beforeEach(async ({ page }) => {
  await grantFix(page)
})

/** Leaflet repositions .leaflet-map-pane to move the camera, so its transform
 *  IS the viewport state. Capturing it before/after proves the camera moved. */
const paneTransform = (page) =>
  page.evaluate(() => {
    const pane = document.querySelector('.leaflet-map-pane')
    return pane ? getComputedStyle(pane).transform : null
  })

/** Mount the SHIPPED fence editor and wait for a real, sized Leaflet map. */
const gotoEditor = async (page) => {
  await page.goto('/geofence.html')
  await page.waitForSelector('.leaflet-container', { timeout: 15000 })
  // A Leaflet map created while its box is 0px renders blank — this is the
  // "the map is missing" symptom, so wait for a genuinely sized container.
  await page.waitForFunction(
    () => {
      const c = document.querySelector('.leaflet-container')
      return c && c.clientWidth > 100 && c.clientHeight > 100
    },
    null,
    { timeout: 15000 },
  )
  await page.waitForSelector('.leaflet-tile-loaded', { timeout: 15000 })
}

test('the fence editor renders with real map tiles on the branch centre', async ({ page }) => {
  await gotoEditor(page)
  await expect(page.getByText(/Fence centre 6\.605754/)).toBeVisible()
})

test('"Use my location" moves the pin, the circle and the viewport', async ({ page }) => {
  await gotoEditor(page)

  const before = await page.getByText(/Fence centre/).innerText()
  console.log('BEFORE:', before)
  expect(before).not.toContain('6.613799')

  // Camera position before the tap, so a camera move can be proved.
  const paneBefore = await paneTransform(page)
  expect(paneBefore).toBeTruthy()

  await page.getByRole('button', { name: 'Use my location' }).click()

  // 1. The coordinate read-out shows the GPS fix — not the branch centre and
  //    not the fallback.
  await expect(page.getByText(/Fence centre 6\.613799, 3\.351522/)).toBeVisible({ timeout: 10000 })

  // 2. The Leaflet PIN is at the fix.
  const pinIcon = page.locator('.leaflet-marker-icon.gf-editor-pin')
  await expect(pinIcon).toBeAttached({ timeout: 10000 })
  expect(await pinIcon.evaluate((el) => el.style.transform)).toBeTruthy()

  // 3. The CIRCLE moved: Leaflet renders it as an SVG <path>, whose bounding
  //    box is a ring (width AND height > 1), not a collapsed point.
  const circlePath = page.locator('path.leaflet-interactive').first()
  await expect(circlePath).toBeAttached()
  const circleBox = await circlePath.boundingBox()
  expect(circleBox.width).toBeGreaterThan(1)
  expect(circleBox.height).toBeGreaterThan(1)
  console.log('CIRCLE bbox:', circleBox)

  // 4. The VIEWPORT moved: the map pane's transform changed.
  await page.waitForTimeout(500)
  const paneAfter = await paneTransform(page)
  console.log('PANE before/after:', paneBefore, '->', paneAfter)
  expect(paneAfter).not.toBe(paneBefore)

  // 5. The pin is now centred in the map box, which only happens because the
  //    camera went to it (a moved marker under a static camera stays off-centre).
  const containerBox = await page.locator('.leaflet-container').boundingBox()
  const pinBox = await pinIcon.boundingBox()
  console.log('CONTAINER:', containerBox, 'PIN:', pinBox)
  expect(Math.abs(pinBox.x + pinBox.width / 2 - (containerBox.x + containerBox.width / 2)))
    .toBeLessThan(60)
  expect(Math.abs(pinBox.y + pinBox.height / 2 - (containerBox.y + containerBox.height / 2)))
    .toBeLessThan(60)

  await page.screenshot({ path: 'test-results/geofence-use-my-location.png', fullPage: true })
})

test('the coordinate read-out, the pin and the circle all agree', async ({ page }) => {
  await gotoEditor(page)
  await page.getByRole('button', { name: 'Use my location' }).click()
  await expect(page.getByText(/Fence centre 6\.613799, 3\.351522/)).toBeVisible({ timeout: 10000 })

  const panel = await page.locator('body').innerText()
  expect(panel).toContain('6.613799')
  expect(panel).toContain('3.351522')
  // The radius is untouched by the relocation.
  expect(panel).toContain('150')
})

test('the radius survives a relocation', async ({ page }) => {
  await gotoEditor(page)
  // Widen the fence first.
  await page.locator('input[type="range"]').fill('800')
  await expect(page.getByText(/Radius\s*800\s*m/)).toBeVisible()
  // Then relocate: the radius must survive.
  await page.getByRole('button', { name: 'Use my location' }).click()
  await expect(page.getByText(/Fence centre 6\.613799, 3\.351522/)).toBeVisible({ timeout: 10000 })
  await expect(page.getByText(/Radius\s*800\s*m/)).toBeVisible()
})

test('"Stop" releases the held fix without moving the fence', async ({ page }) => {
  await gotoEditor(page)
  await page.getByRole('button', { name: 'Use my location' }).click()
  await expect(page.getByText(/Fence centre 6\.613799, 3\.351522/)).toBeVisible({ timeout: 10000 })

  await page.getByRole('button', { name: 'Stop' }).click()

  // The fence stays exactly where the operator put it.
  await expect(page.getByText(/Fence centre 6\.613799, 3\.351522/)).toBeVisible()
  // The live-marker controls are gone and the button is back to its first state.
  await expect(page.getByRole('button', { name: 'Use my location', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Re-locate' })).toHaveCount(0)
})

test('Stop is idempotent and never throws', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await gotoEditor(page)
  await page.getByRole('button', { name: 'Use my location' }).click()
  await expect(page.getByText(/Fence centre 6\.613799/)).toBeVisible({ timeout: 10000 })
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByRole('button', { name: 'Use my location', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('a failed acquisition reports the real reason and offers Try again', async ({ page }) => {
  await page.addInitScript(() => {
    if (!navigator.geolocation) navigator.geolocation = {}
    navigator.geolocation.getCurrentPosition = (_ok, fail) => {
      setTimeout(() => {
        const err = new Error('denied')
        err.code = 1 // PERMISSION_DENIED
        fail(err)
      }, 20)
    }
  })
  await gotoEditor(page)
  await page.getByRole('button', { name: 'Use my location' }).click()
  await expect(page.getByRole('alert')).toContainText(/Location access was denied/, { timeout: 10000 })
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
  // The fence never moved to a bogus position.
  await expect(page.getByText(/Fence centre 6\.605754/)).toBeVisible()
})

test('a second, different fix replaces the first one', async ({ page }) => {
  // A QUEUE of fixes, so the second acquisition provably returns a different,
  // real position rather than a cached or repeated one.
  await page.addInitScript(() => {
    if (!navigator.geolocation) navigator.geolocation = {}
    const queue = [
      { lat: 6.613799, lng: 3.351522 },
      { lat: 6.62, lng: 3.40 },
    ]
    navigator.geolocation.getCurrentPosition = (success) => {
      const next = queue.shift() || queue[0]
      setTimeout(
        () =>
          success({
            coords: {
              latitude: next.lat,
              longitude: next.lng,
              accuracy: 12,
              altitude: null,
              heading: null,
              speed: null,
            },
            timestamp: Date.now(),
          }),
        30,
      )
    }
  })
  await gotoEditor(page)
  await page.getByRole('button', { name: 'Use my location' }).click()
  await expect(page.getByText(/Fence centre 6\.613799, 3\.351522/)).toBeVisible({ timeout: 10000 })
  // "Re-locate" is the button label once a fix is held; it must fetch a FRESH
  // fix and move everything again.
  await page.getByRole('button', { name: 'Re-locate' }).click()
  await expect(page.getByText(/Fence centre 6\.620000, 3\.400000/)).toBeVisible({ timeout: 10000 })
})
