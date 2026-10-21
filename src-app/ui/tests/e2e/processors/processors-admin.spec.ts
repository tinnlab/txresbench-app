import { expect, test } from '@playwright/test'
import { loginAsOwner } from './helpers'

// TEST-18 [ITEM-14/15] [acceptance] [invariant: INV-11]: the admin Processors page
// — the nav entry is present, the discovered seed packages render with per-package
// Loaded badges + a count, and Reload re-scans the folder (busy → success) with the
// packages still present. Real backend, no page.route() mocking. The malformed
// drop-in → skipped-with-error reflection is proven at the integration tier
// (extensions/reload_api_test.rs) since the browser can't write the server's
// processors folder.

test('admin views discovered processors with load status and reloads', async ({ page }) => {
  await loginAsOwner(page)

  // The settings nav offers a "Processors" entry (slot is perm-gated to admins).
  await page.goto('/settings/general')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Processors' })).toBeVisible()

  await page.goto('/settings/processors')

  // Page + list card render.
  await expect(page.getByTestId('processors-settings-page')).toBeVisible()
  await expect(page.getByTestId('processors-list-card')).toBeVisible()

  // The discovered set is non-empty (the boot-extracted seed packages) and the
  // count reflects it.
  await expect(page.getByTestId('processors-list')).toBeVisible()
  const rows = page.locator('[data-testid^="processor-row-"]')
  await expect(rows.first()).toBeVisible()
  const count = await rows.count()
  expect(count).toBeGreaterThan(0)

  // A known seed package (anndata-import) is Loaded.
  await expect(page.getByTestId('processor-row-anndata-import')).toBeVisible()
  await expect(page.getByTestId('processor-status-anndata-import')).toHaveText('Loaded')

  // Reload re-scans the folder — await the POST so the async reflect can't be
  // cancelled, then assert the list is still populated (busy → success feedback).
  const reloadPost = page.waitForResponse(
    r => r.url().includes('/api/processors/reload') && r.request().method() === 'POST',
  )
  await page.getByTestId('processors-reload').click()
  const resp = await reloadPost
  expect(resp.ok(), `reload -> ${resp.status()}`).toBeTruthy()

  // Success toast, and the seed package is still Loaded after the reflect.
  // "Reloaded processors" is the app's USER-FACING toast copy (`ProcessorsListCard.tsx`), not a
  // path: ITEM-69 renamed the source TREE and its path strings only, and explicitly did NOT
  // claim the vocabulary (the `/api/processors` route, the `processors` FE module, this prose).
  // The mechanical sweep rewrote it here anyway — the guard normalises `processors`/`packages`
  // to one placeholder, so a prose token reads exactly like a moved directory — and this
  // assertion went red against copy that never changed.
  await expect(page.getByText(/Reloaded processors/i)).toBeVisible()
  await expect(page.getByTestId('processor-status-anndata-import')).toHaveText('Loaded')
})
