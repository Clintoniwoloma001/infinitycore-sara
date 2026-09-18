import { test, expect } from '@playwright/test'

async function mockVerificationAndCamera(page, mode = 'ready') {
  await page.route('**/rest/v1/rpc/get_guarantor_verification_details', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      status: 'started',
      guarantor_name: 'Test Guarantor',
      guarantor_email: 'guarantor@example.com',
      guarantor_relationship: 'Parent',
      employee_name: 'Test Employee',
      position: 'Loan Officer',
      documents: [],
      corrections: [],
    }),
  }))

  await page.addInitScript((initialMode) => {
    window.__cameraTest = { mode: initialMode, calls: [], stopCount: 0 }
    const mediaDevices = navigator.mediaDevices || {}
    Object.defineProperty(mediaDevices, 'getUserMedia', {
      configurable: true,
      writable: true,
      value: async (constraints) => {
        window.__cameraTest.calls.push(constraints)
        if (window.__cameraTest.mode === 'deny') {
          const error = new Error('permission denied')
          error.name = 'NotAllowedError'
          throw error
        }
        if (window.__cameraTest.mode === 'busy') {
          const error = new Error('camera busy')
          error.name = 'NotReadableError'
          throw error
        }
        if (window.__cameraTest.mode === 'fallback' && constraints.video !== true) {
          const error = new Error('constraints unsupported')
          error.name = 'OverconstrainedError'
          throw error
        }
        const track = {
          kind: 'video',
          readyState: 'live',
          stop() {
            this.readyState = 'ended'
            window.__cameraTest.stopCount += 1
          },
        }
        const stream = { getTracks: () => [track] }
        return stream
      },
    })
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices })
    }

    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      configurable: true,
      get() { return this.__cameraSrcObject || null },
      set(stream) {
        this.__cameraSrcObject = stream
        if (stream) {
          queueMicrotask(() => {
            this.dispatchEvent(new Event('loadedmetadata'))
            this.dispatchEvent(new Event('loadeddata'))
            this.dispatchEvent(new Event('canplay'))
            this.dispatchEvent(new Event('playing'))
          })
        }
      },
    })
    Object.defineProperty(HTMLVideoElement.prototype, 'readyState', {
      configurable: true,
      get() { return this.__cameraSrcObject ? 4 : 0 },
    })
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', {
      configurable: true,
      get() { return this.__cameraSrcObject ? 640 : 0 },
    })
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', {
      configurable: true,
      get() { return this.__cameraSrcObject ? 480 : 0 },
    })
    HTMLVideoElement.prototype.play = () => Promise.resolve()
    HTMLCanvasElement.prototype.getContext = () => ({
      save() {},
      translate() {},
      scale() {},
      drawImage() {},
      restore() {},
      clearRect() {},
      setTransform() {},
      beginPath() {},
      closePath() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
    })
    HTMLCanvasElement.prototype.toBlob = function toBlob(callback, type) {
      callback(new Blob(['camera-test'], { type: type || 'image/jpeg' }))
    }
  }, mode)
}

async function openSelfieStep(page) {
  await page.goto('/#/guarantor-verification/camera-test')
  const configError = page.getByText(/Authentication system not initialized/i)
  if (await configError.isVisible().catch(() => false)) return false
  await expect(page.getByText(/Guarantor Verification for Test Employee/i)).toBeVisible()
  await page.getByRole('button', { name: 'Selfie' }).click()
  return true
}

test.describe('selfie camera lifecycle', () => {
  test('starts only on the selfie step, captures, retakes, and stops on navigation', async ({ page }) => {
    await mockVerificationAndCamera(page)
    if (!(await openSelfieStep(page))) test.skip(true, 'Supabase is not configured in this environment')

    await expect(page.getByText('Camera ready - position your face inside the frame.')).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.__cameraTest.calls.length)).toBe(1)
    const constraints = await page.evaluate(() => window.__cameraTest.calls[0])
    expect(constraints).toEqual({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    })

    await page.getByRole('button', { name: 'Capture Photo' }).click()
    await expect(page.getByAltText('Captured selfie')).toBeVisible()
    await page.getByRole('button', { name: 'Retake' }).click()
    await expect(page.getByText('Camera ready - position your face inside the frame.')).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.__cameraTest.calls.length)).toBe(2)

    await page.getByRole('button', { name: 'Capture Photo' }).click()
    await page.getByRole('button', { name: 'Confirm Photo' }).click()
    await expect(page.getByText('Selfie captured')).toBeVisible()
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('Electronic Signature')).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.__cameraTest.stopCount)).toBe(2)

    await page.getByRole('button', { name: 'Back' }).click()
    await page.getByRole('button', { name: 'Retake selfie' }).click()
    await expect(page.getByText('Camera ready - position your face inside the frame.')).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.__cameraTest.calls.length)).toBe(3)
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect.poll(() => page.evaluate(() => window.__cameraTest.stopCount)).toBe(3)
  })

  test('shows permission help and retries after permission is restored', async ({ page }) => {
    await mockVerificationAndCamera(page, 'deny')
    if (!(await openSelfieStep(page))) test.skip(true, 'Supabase is not configured in this environment')

    await expect(page.getByText('Camera access was blocked. Allow camera access in your browser settings and try again.').first()).toBeVisible()
    await expect(page.getByText('How to allow camera')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry Camera' })).toBeVisible()

    await page.evaluate(() => { window.__cameraTest.mode = 'ready' })
    await page.getByRole('button', { name: 'Retry Camera' }).click()
    await expect(page.getByText('Camera ready - position your face inside the frame.')).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.__cameraTest.calls.length)).toBe(2)
  })

  test('falls back to a basic video constraint when ideal constraints are rejected', async ({ page }) => {
    await mockVerificationAndCamera(page, 'fallback')
    if (!(await openSelfieStep(page))) test.skip(true, 'Supabase is not configured in this environment')

    await expect(page.getByText('Camera ready - position your face inside the frame.')).toBeVisible()
    const calls = await page.evaluate(() => window.__cameraTest.calls)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual({ video: true, audio: false })
  })
})
