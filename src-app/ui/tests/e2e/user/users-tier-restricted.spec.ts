import { expect, test } from '@playwright/test'
import {
  createMember,
  loginAsOwner,
  loginViaUi,
  MEMBER_PASSWORD,
  ownerToken,
  waitUntilOffLoginScreen,
} from '../_helpers'

// TEST-A2 [acceptance][invariant: INV-1][negative-perm][positive-control] (#43).
//
// The tier/premium column + its grant controls presence-gate on `billing::admin`
// (INV-1). The e2e harness drives the DEFAULT (saas-OFF) build, so `billing::admin`
// is absent from the generated enum for EVERY user — including a root admin. This
// proves, end-to-end:
//   (1) a user holding `users::read` but NOT `billing::admin` (the owner in this
//       build) LOADS the Users page (positive control) yet sees NO tier column and
//       NO premium/grant control;
//   (2) a user LACKING `users::read` (a normal member) gets NO Users page at all,
//       while their own settings still load (the positive control that makes the
//       absence mean GATED, not never-rendered).

test('users::read owner loads the Users page but sees no tier/premium column (billing::admin absent)', async ({
  page,
}) => {
  await loginAsOwner(page)

  // ── POSITIVE CONTROL: the Users admin page loads for a users::read holder ──
  await page.goto('/settings/users')
  await expect(page.getByTestId('user-list-card')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('settings-nav-menu-item-users')).toBeVisible()

  // ── NEGATIVE: the whole tier column + every control is absent (INV-1) ──
  await expect(page.locator('[data-testid^="user-tier-row-"]')).toHaveCount(0)
  await expect(page.locator('[data-testid^="user-tier-premium-switch-"]')).toHaveCount(0)
  await expect(page.locator('[data-testid^="user-tier-grant-credit-button-"]')).toHaveCount(0)
  await expect(page.locator('[data-testid^="user-tier-none-"]')).toHaveCount(0)
})

test('a user without users::read gets no Users page, but their own settings load', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  // A normal member holds projects::use but NOT users::read.
  await createMember(request, admin, 'notieruser')

  await loginViaUi(page, 'notieruser', MEMBER_PASSWORD)
  await waitUntilOffLoginScreen(page)

  // ── POSITIVE CONTROL: their own settings load (not blank/bounced) ──
  await page.goto('/settings/profile')
  await expect(page.getByTestId('settings-nav-menu')).toBeVisible({ timeout: 30_000 })

  // ── NEGATIVE: no Users nav entry, and a deep-link never mounts the users card ──
  await expect(page.getByTestId('settings-nav-menu-item-users')).toHaveCount(0)
  await page.goto('/settings/users')
  await expect(page.getByTestId('user-list-card')).toHaveCount(0)
  // The settings shell still renders (the user is not thrown out of the app).
  await expect(page.getByTestId('settings-nav-menu')).toBeVisible({ timeout: 30_000 })
})
