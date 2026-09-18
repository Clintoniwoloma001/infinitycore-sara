import { test, expect } from '@playwright/test'

// Unauthenticated coverage for the public Medical Screening Portal
// (Phase 40). No credentials and no real referral tokens are required:
// a fabricated token always resolves to the portal's error screen (invalid,
// revoked, expired, or an un-applied schema all land there), and the route
// itself must render WITHOUT being gated by the login screen.
//
// NOTE: the app uses a HashRouter, so the referral route is reached via
//   /#/medical-screening/<token>

const pageErrors = (page) => {
  const errors = []
  page.on('pageerror', (err) => errors.push(err.message))
  return errors
}

test.describe('public medical screening portal', () => {
  test('referral route is reachable without signing in', async ({ page }) => {
    const errors = pageErrors(page)

    await page.goto('/#/medical-screening/not-a-real-token')

    // The public portal shell must render — never the login gate.
    await expect(page.getByText(/Medical Screening Portal/i).first()).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('input[type="email"]')).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test('invalid referral token shows the unavailable screen', async ({ page }) => {
    await page.goto('/#/medical-screening/definitely-not-a-valid-token')

    await expect(page.getByText('Referral unavailable')).toBeVisible({ timeout: 30_000 })
    // The portal header (and thus the public shell) is rendered around the error.
    await expect(page.getByText(/Medical Screening Portal/i).first()).toBeVisible()
  })

  test('referral route cannot submit without a valid token', async ({ page }) => {
    await page.goto('/#/medical-screening/another-fake-token')

    // The landing form / submission flow must never appear for a bad token.
    await expect(page.getByText('Referral unavailable')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: /submit screening/i })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /begin medical screening/i })).toHaveCount(0)
  })
})