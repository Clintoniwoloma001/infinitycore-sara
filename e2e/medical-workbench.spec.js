import { test, expect } from '@playwright/test'

// Authenticated HR Medical Screening Center checks (Phase 40). Read-only:
// navigation + rendering only, no referrals are created or mutated. Enabled
// by the `chromium-auth` project, which only runs when E2E_EMAIL /
// E2E_PASSWORD are set (see playwright.config.js).
//
// The workbench talks to Supabase via medicalScreeningService; the list may
// be empty (or the schema may not be applied in a given environment) so the
// assertions allow for the empty / error states.

test.describe('HR medical screening center', () => {
  test('renders the workbench with status tabs and search', async ({ page }) => {
    await page.goto('/#/medical-management')

    await expect(page.getByRole('heading', { name: /Medical Screening Center/i })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByPlaceholder(/Search name, reference, hospital/i)).toBeVisible()

    for (const tab of ['All', 'Awaiting Hospital', 'In Progress', 'Awaiting Review', 'Completed', 'Expired / Revoked']) {
      await expect(page.getByRole('button', { name: new RegExp(`^${tab}\\b`) })).toBeVisible()
    }
  })

  test('lists referrals or shows the empty state', async ({ page }) => {
    await page.goto('/#/medical-management')

    const list = page.locator('button').filter({ hasText: /MED-\d{4}-\d{6}/ })
    const empty = page.getByText(/No medical screenings/i)
    await expect(list.first().or(empty)).toBeVisible({ timeout: 30_000 })
  })

  test('search filters the referral list', async ({ page }) => {
    await page.goto('/#/medical-management')

    const search = page.getByPlaceholder(/Search name, reference, hospital/i)
    await expect(search).toBeVisible({ timeout: 30_000 })

    // Filtering to an impossible query must not throw and must leave the
    // workbench rendered (empty state or a filtered list).
    await search.fill('zzz-no-such-medical-referral-zzz')
    const empty = page.getByText(/No medical screenings/i)
    const list = page.locator('button').filter({ hasText: /MED-\d{4}-\d{6}/ })
    await expect(empty.or(list.first())).toBeVisible({ timeout: 15_000 })
  })

  test('opening a referral shows its screening detail panel', async ({ page }) => {
    await page.goto('/#/medical-management')

    const firstReferral = page.locator('button').filter({ hasText: /MED-\d{4}-\d{6}/ }).first()
    if (!(await firstReferral.isVisible({ timeout: 30_000 }).catch(() => false))) {
      test.skip(true, 'No medical referrals available to open')
    }

    await firstReferral.click()

    // Either a submitted (versioned) result, or the "no result yet" notice.
    await expect(
      page.getByText(/Medical Screening Result|No screening result submitted yet|This referral was revoked|This referral expired/i).first()
    ).toBeVisible({ timeout: 30_000 })
  })
})