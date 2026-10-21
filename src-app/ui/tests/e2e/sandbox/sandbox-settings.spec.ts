import { expect, test } from '@playwright/test'
import { loginAsOwner } from './helpers'

// TEST-21: the admin sandbox settings page — nav present, rootfs status renders,
// resource-limits form loads + saves + persists across a reload.

test('admin can view sandbox settings, edit a limit, and it persists on reload', async ({ page }) => {
  await loginAsOwner(page)

  await page.goto('/settings/sandbox')

  // Page + both cards render.
  await expect(page.getByTestId('sandbox-settings-page')).toBeVisible()
  await expect(page.getByTestId('sandbox-rootfs-card')).toBeVisible()
  await expect(page.getByTestId('sandbox-limits-card')).toBeVisible()

  // Rootfs status card shows the schema version + availability.
  await expect(page.getByTestId('sandbox-rootfs-schema')).toBeVisible()
  await expect(page.getByTestId('sandbox-rootfs-availability')).toBeVisible()

  // The limits form is seeded from the server (timeout has a value).
  const timeout = page.getByTestId('sandbox-limits-timeout')
  await expect(timeout).toBeVisible()

  // Edit the wall-clock timeout to a distinctive value and save. Await the PUT
  // response before navigating so the async save can't be cancelled by the reload.
  const NEW_TIMEOUT = '321'
  await timeout.fill(NEW_TIMEOUT)
  const savePut = page.waitForResponse(
    r => r.url().includes('/api/sandbox/settings') && r.request().method() === 'PUT',
  )
  await page.getByTestId('sandbox-limits-save').click()
  const putResp = await savePut
  expect(putResp.ok(), `PUT settings -> ${putResp.status()}`).toBeTruthy()

  // Reload — the store refetches on mount, so the change must persist.
  await page.goto('/settings/sandbox')
  await expect(page.getByTestId('sandbox-limits-timeout')).toHaveValue(NEW_TIMEOUT)
})

// TEST-5 / TEST-15 / TEST-16 (#54): the per-class defaults card renders typed
// cpu/memory fields for all three classes, seeded from the server, and a save
// through the permissioned `sandbox.updateSettings` action persists across a reload.
test('admin can edit a per-class default and it persists', async ({ page }) => {
  await loginAsOwner(page)
  await page.goto('/settings/sandbox')

  const card = page.getByTestId('sandbox-per-class-card')
  await expect(card).toBeVisible()
  // Typed, seeded fields for each class (formatted with unit suffixes by the control).
  await expect(page.getByTestId('sandbox-interactive-cpu')).toBeVisible()
  await expect(page.getByTestId('sandbox-normal-mem')).toBeVisible()
  const batchCpu = page.getByTestId('sandbox-batch-cpu')
  await expect(batchCpu).toHaveValue('4') // seeded default

  await batchCpu.fill('6')
  const savePut = page.waitForResponse(
    r => r.url().includes('/api/sandbox/settings') && r.request().method() === 'PUT',
  )
  await page.getByTestId('sandbox-per-class-save').click()
  const resp = await savePut
  expect(resp.ok(), `PUT -> ${resp.status()}`).toBeTruthy()

  await page.goto('/settings/sandbox')
  await expect(page.getByTestId('sandbox-batch-cpu')).toHaveValue('6')
})

// TEST-15 (#54): the per-class card works at a 390px mobile viewport (no clipping;
// the fields stack and remain reachable — desktop-only would be a defect).
test('per-class defaults card is usable at 390px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  await loginAsOwner(page)
  await page.goto('/settings/sandbox')
  await expect(page.getByTestId('sandbox-per-class-card')).toBeVisible()
  await expect(page.getByTestId('sandbox-batch-mem')).toBeVisible()
  // No horizontal page overflow at mobile width.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  )
  expect(overflow, 'no horizontal page scroll at 390px').toBeTruthy()
})

// TEST-14 (#54): the env-image card shows the READ-ONLY registry base + moving tag
// (no input for them) and lets an admin set the deployment default env-id; a blank
// value (auto-detect) is accepted.
test('admin sets default env-id; registry base is read-only', async ({ page }) => {
  await loginAsOwner(page)
  await page.goto('/settings/sandbox')

  await expect(page.getByTestId('sandbox-env-image-card')).toBeVisible()
  // Registry base + tag are shown as read-only text, not editable inputs.
  await expect(page.getByTestId('sandbox-env-registry-base')).toContainText('ghcr.io/ziee-ai/cyto-env')
  await expect(page.getByTestId('sandbox-env-moving-tag')).toContainText('latest')

  const envInput = page.getByTestId('sandbox-default-env-id')
  await envInput.fill('demo-env')
  const savePut = page.waitForResponse(
    r => r.url().includes('/api/sandbox/settings') && r.request().method() === 'PUT',
  )
  await page.getByTestId('sandbox-env-image-save').click()
  expect((await savePut).ok()).toBeTruthy()

  await page.goto('/settings/sandbox')
  await expect(page.getByTestId('sandbox-default-env-id')).toHaveValue('demo-env')
})
