import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../_helpers'

// TEST-11 [covers ITEM-8]: the /settings/accounts page renders the personal-account
// card for a real user, and reflows at a narrow (~390px) viewport with no horizontal
// page scroll (the responsive gate). The org members-list needs an org (not creatable
// in Phase 2 e2e) — it is covered by the backend members API test.
test('the account settings page shows the personal account and is responsive', async ({
  page,
}) => {
  await loginAsOwner(page)
  await page.goto('/settings/accounts')

  // The card list renders with the personal account (kind "Personal", active marker).
  await expect(page.getByTestId('account-settings-list')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('account-kind-personal').first()).toBeVisible()
  await expect(page.getByTestId('account-active-marker').first()).toBeVisible()

  // Narrow viewport (~390px): the page must not scroll horizontally.
  await page.setViewportSize({ width: 390, height: 780 })
  await expect(page.getByTestId('account-settings-list')).toBeVisible()
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow, 'no horizontal page scroll at 390px').toBeLessThanOrEqual(1)
})
