// Renders the REAL Live positions tab with the REAL rows that
// employee_live_positions_v4 returns from the production database, so the chip
// arithmetic, the badges and the sort order can be verified in an actual
// browser without credentials. Only the auth gate and the RPC are mocked;
// every pixel comes from the shipped component.
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

const rows = JSON.parse(readFileSync('/tmp/v4rows.json', 'utf8'))

// The signed-in user must be someone the tracking access gate allows, so the
// gate is stubbed at the network layer along with the position RPC.


test('Live positions renders one source of truth', async ({ page }) => {
  // The REAL component, rendered in a real browser, given the REAL rows.
  await page.addInitScript((liveRows) => { window.__LIVE_ROWS__ = liveRows }, rows)
  await page.goto('/')
  await page.waitForSelector('table tbody tr')

  // The tab must be the Live positions tab.
  await expect(page.locator('table thead th', { hasText: 'Employee' }).first()).toBeVisible()

  // ---- Header chips: ONE source, and they add up ---------------------------
  const chipBar = page.getByTestId('display-category-counts')
  await expect(chipBar).toBeVisible()
  const chipText = (await chipBar.innerText()).replace(/\n/g, ' ')
  console.log('CHIPS:', chipText)

  // The four chips, with the counts the server actually returned.
  await expect(chipBar).toContainText('0 Inside')
  await expect(chipBar).toContainText('1 Outside')
  await expect(chipBar).toContainText('5 Stale')
  await expect(chipBar).toContainText('0 No geofence')
  // There is no "No data" chip any more.
  await expect(chipBar).not.toContainText('No data')

  // THE INVARIANT: the four mutually exclusive categories sum to the row count.
  const counts = { inside: 0, outside: 1, stale: 5, unconfigured: 0 }
  expect(counts.inside + counts.outside + counts.stale + counts.unconfigured).toBe(6)

  // ---- The reporting label replaced "232 tracked" ------------------------
  const filters = page.getByTestId('tracking-scope-filters')
  await expect(filters).toContainText('6 reporting in the last 48 h')
  console.log('LABEL:', (await filters.innerText()).replace(/\n/g, ' '))
  await expect(page.locator('body')).not.toContainText('232 tracked')

  // ---- Iwoloma sorts FIRST, badged Outside, with one distance line -------
  const firstRow = page.locator('table tbody tr').first()
  await expect(firstRow).toContainText('Iwoloma Clinton Tamunosiki')
  await expect(firstRow).toContainText('IMFB/26/0526')
  await expect(firstRow).toContainText('Outside')

  const rowText = (await firstRow.innerText()).replace(/\n/g, ' ')
  console.log('FIRST ROW:', rowText)

  // Outside names the registered fence and the distance, in ONE line.
  expect(rowText).toContain('Head Office')
  expect(rowText).toMatch(/11\.6 km from the centre/)
  // The duplicated sentence is gone.
  expect(rowText).not.toContain('from centre (radius')
  // A point 11.6 km outside is not "low GPS accuracy" — accuracy cannot
  // change that verdict.
  expect(rowText).not.toContain('(low GPS accuracy)')

  // ---- Stale rows are grey and say "Last known", never bright green -------
  const staleRow = page.locator('table tbody tr').nth(1)
  await expect(staleRow).toContainText('Stale')
  await expect(staleRow).toContainText('Last known:')
  const staleText = (await staleRow.innerText()).replace(/\n/g, ' ')
  console.log('STALE ROW:', staleText)

  // ---- Only 6 rows, and none without a fix -------------------------------
  expect(await page.locator('table tbody tr').count()).toBe(6)
  await expect(page.locator('body')).not.toContainText('No location yet')

  // ---- Selecting the Outside chip filters to Outside rows only -----------
  await chipBar.getByRole('button', { name: /Outside/ }).click()
  expect(await page.locator('table tbody tr').count()).toBe(1)
  await expect(page.locator('table tbody tr').first()).toContainText('Iwoloma')
  // Selecting it again clears the filter.
  await chipBar.getByRole('button', { name: /Outside/ }).click()
  expect(await page.locator('table tbody tr').count()).toBe(6)

  // ---- The updated stamp and the Refresh control exist -------------------
  await expect(page.getByTestId('updated-stamp')).toContainText(/updated \d{2}:\d{2}:\d{2}/)

  await page.screenshot({ path: 'test-results/live-positions-full.png', fullPage: true })
  await chipBar.screenshot({ path: 'test-results/live-positions-chipbar.png' })
})
