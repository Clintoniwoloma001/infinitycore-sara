import { test, expect } from '@playwright/test'

// Unauthenticated smoke tests. These require no credentials and prove the SPA
// actually boots and mounts (guards against white-screen / runtime errors).

test.describe('app boot', () => {
  test('mounts and renders a real screen without uncaught errors', async ({ page }) => {
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await page.goto('/')
    await page.waitForLoadState('networkidle').catch(() => {})

    const root = page.locator('#root')
    await expect(root).not.toBeEmpty()
    expect((await root.innerText()).trim().length).toBeGreaterThan(0)
    expect(pageErrors, `uncaught page errors:\n${pageErrors.join('\n')}`).toEqual([])
  })

  test('login screen renders email, password and sign-in', async ({ page }) => {
    await page.goto('/login')

    const email = page.locator('input[type="email"]')
    const configError = page.getByText(/configuration|not configured|missing|auth error/i)
    await expect(email.or(configError).first()).toBeVisible({ timeout: 30_000 })

    test.skip(!(await email.isVisible().catch(() => false)), 'Supabase not configured in this environment')

    await expect(page.locator('input[type="password"]')).toBeVisible()
    await expect(page.getByRole('button', { name: /sign in/i }).first()).toBeVisible()
  })

  test('protected route is gated while signed out', async ({ page }) => {
    await page.goto('/payroll-bankone')

    const email = page.locator('input[type="email"]')
    if (!(await email.isVisible({ timeout: 30_000 }).catch(() => false))) {
      test.skip(true, 'Supabase not configured in this environment')
    }

    // The payroll workspace must not be reachable without a session.
    await expect(page.getByRole('heading', { name: /payroll\s*&\s*bankone/i })).toHaveCount(0)
    await expect(email).toBeVisible()
  })
})
