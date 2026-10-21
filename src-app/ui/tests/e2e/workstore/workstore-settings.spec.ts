import { expect, test } from '@playwright/test'
import { loginAsOwner } from './helpers'

// TEST-12: the admin workstore settings page — nav present, the limits card renders,
// the form loads (seeded from the server), and an edit saves + persists on reload.

test('admin can view workstore settings, edit a limit, and it persists on reload', async ({ page }) => {
  await loginAsOwner(page)

  await page.goto('/settings/workstore')

  // Page + limits card render.
  await expect(page.getByTestId('workstore-settings-page')).toBeVisible()
  await expect(page.getByTestId('workstore-limits-card')).toBeVisible()

  // The form is seeded from the server (the GC interval has a value).
  const interval = page.getByTestId('workstore-gc-interval')
  await expect(interval).toBeVisible()

  // Edit the GC sweep cadence to a distinctive value and save. Await the PUT
  // response before navigating so the async save can't be cancelled by the reload.
  const NEW_INTERVAL = '9'
  await interval.fill(NEW_INTERVAL)
  const savePut = page.waitForResponse(
    r => r.url().includes('/api/workstore/settings') && r.request().method() === 'PUT',
  )
  await page.getByTestId('workstore-limits-save').click()
  const putResp = await savePut
  expect(putResp.ok(), `PUT settings -> ${putResp.status()}`).toBeTruthy()

  // Reload — the store refetches on mount, so the change must persist.
  await page.goto('/settings/workstore')
  await expect(page.getByTestId('workstore-gc-interval')).toHaveValue(NEW_INTERVAL)
})

// uncapped-uploads TEST-12: the two new upload-limit fields (#185 §1) are populated
// from the server, editable, save through the SAME PUT, and persist on reload — same
// choreography as the pre-existing byte-cap fields above.
test('admin sees the upload-limit fields populated, can edit and save them, and they persist on reload', async ({
  page,
}) => {
  await loginAsOwner(page)

  await page.goto('/settings/workstore')
  await expect(page.getByTestId('workstore-limits-card')).toBeVisible()

  // Populated from the server. The values are CAPTURED rather than asserted against
  // the shipped defaults, and restored at the end of the test. This backend is shared
  // across specs: hard-asserting '64'/'1024' here and then leaving 48/2048 behind
  // made this test pass only because `workers: 1` plus alphabetical file order
  // happens to run workstore-settings-restricted.spec.ts (which asserts the same
  // defaults) first — so a re-run against the same backend, or any reordering, broke
  // both. What this test is for is the round trip, not the seeded value; TEST-16
  // asserts the migration defaults, on a fresh database, where that claim belongs.
  const uploadBody = page.getByTestId('workstore-max-upload-body')
  const uploadParts = page.getByTestId('workstore-max-upload-parts')
  await expect(uploadBody).toBeVisible()
  await expect(uploadParts).toBeVisible()
  await expect(uploadBody).not.toHaveValue('')
  await expect(uploadParts).not.toHaveValue('')
  const originalBody = await uploadBody.inputValue()
  const originalParts = await uploadParts.inputValue()

  // Edit both to distinctive values and save.
  const NEW_UPLOAD_BODY_MIB = '49152'  // 48 GiB in MiB
  const NEW_UPLOAD_PARTS = '2048'
  await uploadBody.fill(NEW_UPLOAD_BODY_MIB)
  await uploadParts.fill(NEW_UPLOAD_PARTS)
  const savePut = page.waitForResponse(
    r => r.url().includes('/api/workstore/settings') && r.request().method() === 'PUT',
  )
  await page.getByTestId('workstore-limits-save').click()
  const putResp = await savePut
  expect(putResp.ok(), `PUT settings -> ${putResp.status()}`).toBeTruthy()

  // Reload — the store refetches on mount, so the change must persist.
  await page.goto('/settings/workstore')
  await expect(page.getByTestId('workstore-max-upload-body')).toHaveValue(NEW_UPLOAD_BODY_MIB)
  await expect(page.getByTestId('workstore-max-upload-parts')).toHaveValue(NEW_UPLOAD_PARTS)

  // Restore what we found, so this spec leaves the shared backend as it came. A test
  // that mutates global state and does not put it back is a trap for whatever runs
  // next — and for its own second run.
  await page.getByTestId('workstore-max-upload-body').fill(originalBody)
  await page.getByTestId('workstore-max-upload-parts').fill(originalParts)
  const restorePut = page.waitForResponse(
    r => r.url().includes('/api/workstore/settings') && r.request().method() === 'PUT',
  )
  await page.getByTestId('workstore-limits-save').click()
  const restoreResp = await restorePut
  expect(restoreResp.ok(), `restore PUT -> ${restoreResp.status()}`).toBeTruthy()

  await page.goto('/settings/workstore')
  await expect(page.getByTestId('workstore-max-upload-body')).toHaveValue(originalBody)
  await expect(page.getByTestId('workstore-max-upload-parts')).toHaveValue(originalParts)
})
