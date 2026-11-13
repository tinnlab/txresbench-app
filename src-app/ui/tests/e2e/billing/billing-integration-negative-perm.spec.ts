import { expect, test } from '@playwright/test'
import {
  createMember,
  loginViaUi,
  MEMBER_PASSWORD,
  ownerToken,
  waitUntilOffLoginScreen,
} from '../_helpers'

// TEST-14 [negative-perm][positive-control] (#60) — the Billing-integration admin page
// is a saas-only, `billing::admin`-gated surface. The e2e harness drives the DEFAULT
// (saas-OFF) build, where `billing::admin` is absent from the generated enum for EVERY
// user (root owner included) — so the nav entry never registers and the route never
// mounts. This spec proves that absence is GATED, not a broken app: the SAME restricted
// user's own settings load and the default settings surfaces render (the positive
// control that makes "billing-integration absent" meaningful, mirroring
// account-detail-restricted.spec.ts and saas-client-presence-split.spec.ts).

test('a user without billing::admin sees no Billing-integration page, but their own settings load', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  // A normal Users-group member: holds billing::read/manage via the Users group but NOT
  // billing::admin — and in this saas-OFF build billing::admin does not exist at all.
  await createMember(request, admin, 'nobillingadmin')

  await loginViaUi(page, 'nobillingadmin', MEMBER_PASSWORD)
  await waitUntilOffLoginScreen(page)

  // ── POSITIVE CONTROL: the same user's settings load (not blank/bounced) ──
  await page.goto('/settings/profile')
  await expect(page.getByTestId('profile-account-card')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('settings-nav-menu')).toBeVisible()

  // ── NEGATIVE: the Billing-integration admin surface is absent at every layer ──
  // (1) Slot: no "Billing integration" entry in the settings nav (path → testid).
  await expect(
    page.getByTestId('settings-nav-menu-item-billing-integration'),
  ).toHaveCount(0)

  // (2) Route: a direct deep-link never mounts the page (the route is not registered in
  //     the saas-OFF build), and no secret-config surface renders.
  await page.goto('/settings/billing-integration')
  await expect(page.getByTestId('billing-integration-page')).toHaveCount(0)
  await expect(page.getByTestId('billing-integration-card')).toHaveCount(0)
  await expect(page.getByTestId('billing-integration-secret-input')).toHaveCount(0)

  // The app is still alive (not a crash) — navigating back to a real settings page works.
  await page.goto('/settings/profile')
  await expect(page.getByTestId('profile-account-card')).toBeVisible({ timeout: 30_000 })
})
