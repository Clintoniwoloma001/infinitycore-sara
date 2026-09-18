import { defineConfig, devices } from '@playwright/test'

// End-to-end smoke tests for the InfinityCore SPA.
//
// The unauthenticated suite (e2e/smoke.spec.js) always runs and proves the
// app boots, mounts and has no uncaught runtime errors.
//
// The authenticated suite (e2e/authenticated.spec.js) runs only when
// E2E_EMAIL / E2E_PASSWORD are provided. It logs in once via the UI and
// reuses the session. These checks are strictly read-only — they navigate
// and assert rendering, they never create payroll/letter data.
//
//   E2E_EMAIL=you@example.com E2E_PASSWORD='…' npm run test:e2e
//
// Optional: E2E_BASE_URL to target an already-running deployment instead of
// the local dev server.

const authFile = 'e2e/.auth/user.json'
const hasCreds = Boolean(process.env.E2E_EMAIL && process.env.E2E_PASSWORD)

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    ...(hasCreds
      ? [
          { name: 'setup', testMatch: /auth\.setup\.js/, use: { ...devices['Desktop Chrome'] } },
          {
            name: 'chromium-auth',
            testMatch: /(authenticated|medical-workbench)\.spec\.js/,
            use: { ...devices['Desktop Chrome'], storageState: authFile },
            dependencies: ['setup'],
          },
        ]
      : []),
    { name: 'chromium', testMatch: /(smoke|medical-public)\.spec\.js/, use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run dev -- --port 4173 --strictPort',
        url: 'http://localhost:4173',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
})
