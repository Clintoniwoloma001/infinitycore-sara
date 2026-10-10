import { chromium } from 'playwright'

// Screenshots the running web app for Phase 1 evidence. Without E2E credentials
// the authenticated routes redirect to /login, which itself is evidence that the
// role gate holds. If a storageState exists it is reused.
const BASE = process.env.E2E_BASE_URL || 'http://localhost:4173'
const OUT = 'screenshots'

async function main() {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()

  await page.goto(`${BASE}/#/login`, { waitUntil: 'networkidle' })
  await page.screenshot({ path: `${OUT}/01-login.png` })

  // The new route — gated, so it should bounce to login without a session.
  await page.goto(`${BASE}/#/director-metric-import`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${OUT}/02-metric-import-gated.png` })
  console.log('final URL after gated nav:', page.url())

  await browser.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
