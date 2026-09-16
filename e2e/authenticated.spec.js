import { test, expect } from '@playwright/test'

// Authenticated HR workspace checks. Read-only: navigation + rendering only,
// no data is created. Enabled by the `chromium-auth` project, which only
// exists when E2E_EMAIL / E2E_PASSWORD are set (see playwright.config.js).

test.describe('HR payroll workspace', () => {
  test('Payroll & BankOne page renders master + push tabs', async ({ page }) => {
    await page.goto('/payroll-bankone')

    await expect(page.getByRole('heading', { name: /payroll\s*&\s*bankone/i })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Payroll Master' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'BankOne Push' })).toBeVisible()
    // BankOne config state badge is always rendered (NOT_CONFIGURED is valid).
    await expect(page.getByText(/BankOne:/)).toBeVisible()
  })

  test('Payroll Master lists the workforce with an export action', async ({ page }) => {
    await page.goto('/payroll-bankone')

    await expect(page.getByText('Payroll Master')).toBeVisible()
    const exportBtn = page.getByRole('button', { name: /export for bankone/i })
    await expect(exportBtn).toBeVisible()

    // Table renders either rows or the empty state — both are valid.
    const table = page.locator('table')
    const empty = page.getByText(/no active employees/i)
    await expect(table.or(empty).first()).toBeVisible()
  })

  test('BankOne Push tab exposes the prepare step', async ({ page }) => {
    await page.goto('/payroll-bankone')
    await page.getByRole('button', { name: 'BankOne Push' }).click()

    await expect(page.getByText(/prepare payroll/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /create request/i })).toBeVisible()
  })
})

test.describe('Employee employment letter', () => {
  test('employment letter tab is reachable from an employee profile', async ({ page }) => {
    await page.goto('/employees')

    // Wait for the page to settle, then open the first available employee.
    const firstLink = page.locator('a[href^="/employees/"]').first()
    if (!(await firstLink.isVisible({ timeout: 30_000 }).catch(() => false))) {
      test.skip(true, 'No employees available to open')
    }
    await firstLink.click()
    await page.waitForURL(/\/employees\/[0-9a-f-]+/i)

    await expect(page.getByRole('button', { name: /employment letter/i })).toBeVisible()
    await page.getByRole('button', { name: /employment letter/i }).click()
    await expect(page.getByText(/no employment letter|version/i).first()).toBeVisible()
  })
})
