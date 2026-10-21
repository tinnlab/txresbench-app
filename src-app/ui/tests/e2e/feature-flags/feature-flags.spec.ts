import { test, expect } from '@playwright/test'
import { loginAsOwner } from './helpers'

// TEST-10: the admin owner opens /settings/feature-flags and the page renders with the
// demonstration flag row — proving the page, its route, and the generated
// Permissions.FeaturesManage binding work end-to-end.
test('admin sees the feature flags page with the demonstration flag', async ({ page }) => {
  await loginAsOwner(page)
  await page.goto('/settings/feature-flags')

  await expect(page.getByTestId('feature-flags-card')).toBeVisible({ timeout: 15_000 })
  // The compiled registry ships one demonstration flag.
  await expect(page.getByTestId('feature-flag-row-demo.runtime_flag')).toBeVisible()
  // It is OFF by default (compiled default false, no row).
  await expect(page.getByTestId('feature-flag-effective-demo.runtime_flag')).toHaveText('Off')
})

// TEST-7 (#48): the flag list is bounded — a numbered pagination control with a
// "N-M of T flags" summary, never an unbounded fetch-all/render-all.
test('TEST-7: the flag list is paged with a bounded summary', async ({ page }) => {
  await loginAsOwner(page)
  await page.goto('/settings/feature-flags')
  const pager = page.getByTestId('feature-flags-pagination')
  await expect(pager).toBeVisible({ timeout: 15_000 })
  await expect(pager).toContainText(/of \d+ flags/)
})

// TEST-5 (#48) [acceptance INV-3]: a global toggle REQUIRES confirmation — flipping
// the Switch opens a Confirm and the effective state does NOT change while the
// dialog is open; cancelling leaves the flag unchanged.
test('TEST-5: toggling requires confirmation — cancel leaves the flag unchanged', async ({
  page,
}) => {
  await loginAsOwner(page)
  await page.goto('/settings/feature-flags')
  const badge = page.getByTestId('feature-flag-effective-demo.runtime_flag')
  await expect(badge).toHaveText('Off', { timeout: 15_000 })

  await page.getByTestId('feature-flag-switch-demo.runtime_flag').click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  // Not applied yet — still Off while the confirm is open.
  await expect(badge).toHaveText('Off')

  await dialog.getByRole('button', { name: /^Cancel$/i }).click()
  await expect(badge).toHaveText('Off')
})

// TEST-4 (#48): the admin toggles the demo flag ON through the confirm, the badge
// flips Off→On, it PERSISTS across a reload, then is restored to Off (both
// directions exercised; baseline restored so it does not pollute other specs).
test('TEST-4: admin toggles a flag on (persists across reload) and back off', async ({
  page,
}) => {
  await loginAsOwner(page)
  await page.goto('/settings/feature-flags')
  const badge = page.getByTestId('feature-flag-effective-demo.runtime_flag')
  await expect(badge).toHaveText('Off', { timeout: 15_000 })

  // Enable globally.
  await page.getByTestId('feature-flag-switch-demo.runtime_flag').click()
  await page.getByRole('alertdialog').getByRole('button', { name: /^Enable$/i }).click()
  await expect(badge).toHaveText('On')

  // Persists across a reload (a real global row was written).
  await page.reload()
  await expect(badge).toHaveText('On', { timeout: 15_000 })

  // Restore the baseline: disable globally again.
  await page.getByTestId('feature-flag-switch-demo.runtime_flag').click()
  await page.getByRole('alertdialog').getByRole('button', { name: /^Disable$/i }).click()
  await expect(badge).toHaveText('Off')
})
