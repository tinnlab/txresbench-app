import { expect, test } from '@playwright/test'
import { loginAsOwner } from './helpers'

// TEST-14 [covers ITEM-9/10/11]: the admin MCP settings page — nav present, the
// limits card renders, the form loads (seeded from the server), and an edit saves
// (via the `mcp.updateSettings` action → PUT) + persists on reload.

test('admin can view MCP settings, edit a cap, and it persists on reload', async ({ page }) => {
  await loginAsOwner(page)

  await page.goto('/settings/mcp')

  // Page + limits card render.
  await expect(page.getByTestId('mcp-settings-page')).toBeVisible()
  await expect(page.getByTestId('mcp-limits-card')).toBeVisible()

  // The form is seeded from the server (the in-flight cap has a value).
  const inflight = page.getByTestId('mcp-max-inflight')
  await expect(inflight).toBeVisible()

  // Edit the per-user in-flight cap to a distinctive value and save. Await the PUT
  // response before navigating so the async save can't be cancelled by the reload.
  const NEW_INFLIGHT = '48'
  await inflight.fill(NEW_INFLIGHT)
  const savePut = page.waitForResponse(
    r => r.url().includes('/api/mcp/settings') && r.request().method() === 'PUT',
  )
  await page.getByTestId('mcp-limits-save').click()
  const putResp = await savePut
  expect(putResp.ok(), `PUT settings -> ${putResp.status()}`).toBeTruthy()

  // Reload — the store refetches on mount, so the change must persist.
  await page.goto('/settings/mcp')
  await expect(page.getByTestId('mcp-max-inflight')).toHaveValue(NEW_INFLIGHT)
})
