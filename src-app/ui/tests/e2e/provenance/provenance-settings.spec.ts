import { expect, test } from '@playwright/test'
import { loginAsOwner } from './_helpers'

// TEST-30: an admin opens /settings/provenance, edits a field (export retention
// days), saves, reloads, and the persisted value is reflected (the settings-card
// twin of the sandbox settings page).
test('admin edits a provenance setting, saves, and it persists on reload', async ({ page }) => {
  await loginAsOwner(page)

  await page.goto('/settings/provenance')

  // Page + card render.
  await expect(page.getByTestId('provenance-settings-page')).toBeVisible()
  await expect(page.getByTestId('provenance-settings-card')).toBeVisible()

  // The retention field is seeded from the server.
  const retention = page.getByTestId('provenance-settings-retention')
  await expect(retention).toBeVisible()

  // Edit to a distinctive value and save. Await the PUT response before navigating
  // so the async save can't be cancelled by the reload.
  const NEW_RETENTION = '77'
  await retention.fill(NEW_RETENTION)
  const savePut = page.waitForResponse(
    r => r.url().includes('/api/provenance/settings') && r.request().method() === 'PUT',
  )
  await page.getByTestId('provenance-settings-save').click()
  const putResp = await savePut
  expect(putResp.ok(), `PUT settings -> ${putResp.status()}`).toBeTruthy()

  // Reload — the store refetches on mount, so the change must persist.
  await page.goto('/settings/provenance')
  await expect(page.getByTestId('provenance-settings-retention')).toHaveValue(NEW_RETENTION)
})

// TEST-13 (#54): an admin edits the rootfs-cache GC controls (sweep interval in hours, cache
// size in images), saves, the PUT carries the seconds/count (hours→secs conversion), and the
// values persist on reload.
test('admin edits the rootfs-cache GC settings, saves, and they persist', async ({ page }) => {
  await loginAsOwner(page)
  await page.goto('/settings/provenance')

  await expect(page.getByTestId('provenance-settings-card')).toBeVisible()
  const interval = page.getByTestId('provenance-settings-gc-interval')
  const cacheSize = page.getByTestId('provenance-settings-cache-size')
  await expect(interval).toBeVisible()
  await expect(cacheSize).toBeVisible()
  // Seeded from the byte-preserving defaults (6h, 4 images).
  await expect(interval).toHaveValue('6')
  await expect(cacheSize).toHaveValue('4')

  // Edit: 2 hours, 6 images.
  await interval.fill('2')
  await cacheSize.fill('6')
  const savePut = page.waitForResponse(
    r => r.url().includes('/api/provenance/settings') && r.request().method() === 'PUT',
  )
  await page.getByTestId('provenance-settings-save').click()
  const putResp = await savePut
  expect(putResp.ok(), `PUT settings -> ${putResp.status()}`).toBeTruthy()

  // The payload converted hours→seconds and carried the image count.
  const body = JSON.parse(putResp.request().postData() ?? '{}')
  expect(body.rootfs_gc_interval_secs, 'hours→secs conversion').toBe(7200)
  expect(body.rootfs_cache_max_digests).toBe(6)

  // Persisted on reload.
  await page.goto('/settings/provenance')
  await expect(page.getByTestId('provenance-settings-gc-interval')).toHaveValue('2')
  await expect(page.getByTestId('provenance-settings-cache-size')).toHaveValue('6')
})
