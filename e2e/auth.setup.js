import { test as setup } from '@playwright/test'

// Logs in once through the real UI and stores the session for the
// authenticated suite. Only runs when E2E_EMAIL / E2E_PASSWORD are set.

const authFile = 'e2e/.auth/user.json'

setup('authenticate', async ({ page }) => {
  await page.goto('/login')

  await page.locator('input[type="email"]').fill(process.env.E2E_EMAIL)
  await page.locator('input[type="password"]').fill(process.env.E2E_PASSWORD)
  await page.getByRole('button', { name: /^sign in$/i }).first().click()

  // A successful sign-in leaves /login. Pending/suspended accounts are held
  // on a blocked screen but still signed in — treat any non-login URL as ok.
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 45_000 })

  await page.context().storageState({ path: authFile })
})
