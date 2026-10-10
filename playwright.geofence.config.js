import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  use: {
    baseURL: 'http://localhost:4175',
    viewport: { width: 1440, height: 1200 },
    permissions: ['geolocation'],
    geolocation: { latitude: 6.613799, longitude: 3.351522 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx vite preview --config vite.geofence.config.js --port 4175 --strictPort',
    url: 'http://localhost:4175',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
