import { expect, test } from '@playwright/test'
import {
  createMember,
  loginViaUi,
  MEMBER_PASSWORD,
  ownerToken,
  waitUntilOffLoginScreen,
} from '../project/_helpers'

// TEST-10 [negative-perm][positive-control] (#65) — the "Cancel / revert migration" control is part
// of the same saas-only, `infra::settings::manage`-gated live-cutover card. The e2e harness drives
// the DEFAULT (saas-OFF) build, where `infra::settings::manage` is absent from the generated enum for
// EVERY user (root owner included) — so the module registers nothing and the revert control never
// renders. This proves that absence is GATED, not a broken app: the SAME user's OWN settings load
// (the positive control that makes "revert control absent" meaningful). Mirrors #64's
// `live-cutover-negative-perm.spec.ts`.
test('a user without infra::settings::manage sees no revert-migration control, but their own settings load', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  await createMember(request, admin, 'norevertadmin')

  await loginViaUi(page, 'norevertadmin', MEMBER_PASSWORD)
  await waitUntilOffLoginScreen(page)

  // ── POSITIVE CONTROL: the same user's settings load (not blank/bounced) ──
  await page.goto('/settings/profile')
  await expect(page.getByTestId('profile-account-card')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('settings-nav-menu')).toBeVisible()

  // ── NEGATIVE: the Infrastructure surface + the revert control are absent at every layer ──
  // (1) Slot: no "Infrastructure" entry in the settings nav.
  await expect(page.getByTestId('settings-nav-menu-item-infrastructure')).toHaveCount(0)

  // (2) Route: a direct deep-link never mounts the page, and the revert control never renders.
  await page.goto('/settings/infrastructure')
  await expect(page.getByTestId('infra-settings-page')).toHaveCount(0)
  await expect(page.getByTestId('infra-live-cutover-card')).toHaveCount(0)
  await expect(page.getByTestId('infra-cutover-abandon')).toHaveCount(0)
  await expect(page.getByTestId('infra-cutover-abandon-confirm')).toHaveCount(0)
  await expect(page.getByTestId('infra-cutover-abandon-result')).toHaveCount(0)

  // The app is still alive (not a crash) — navigating back to a real settings page works.
  await page.goto('/settings/profile')
  await expect(page.getByTestId('profile-account-card')).toBeVisible({ timeout: 30_000 })
})
