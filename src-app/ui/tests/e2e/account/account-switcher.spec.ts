import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'

// TEST-9 [covers ITEM-3/4]: the account switcher's HIDDEN-AT-ONE rule, end-to-end.
//
// Phase 2 has no org-create surface (and the e2e harness has no DB seam), so the ONLY
// drivable account state is a real user with exactly ONE (personal) account — for whom
// the switcher must render NOTHING. The switcher's WORKING state at ≥2 accounts is
// covered by the mounted component test (AccountSwitcher.test.tsx) + the store unit
// tests. This spec proves the chrome stays clean for the modal invisible-tenancy user
// while the app + Accounts store load for real.
test('a single-account user sees no account switcher in the chrome', async ({ page }) => {
  await loginAsOwner(page) // lands on /projects with the sidebar mounted
  await page.getByTestId('projects-page').waitFor({ state: 'visible', timeout: 20_000 })

  // The Accounts store has loaded (the owner has one personal account) → the switcher
  // renders null (≤1 account). Its absence is the hidden-at-one rule, not a crash: the
  // rest of the sidebar (primary actions / nav) is present.
  await expect(page.getByTestId('account-switcher')).toHaveCount(0)
  await expect(page.getByTestId('layout-sidebar-nav-menu')).toBeVisible()
})
