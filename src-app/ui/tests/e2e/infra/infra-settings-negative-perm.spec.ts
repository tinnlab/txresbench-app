import { expect, test } from '@playwright/test'
import {
  createMember,
  loginViaUi,
  MEMBER_PASSWORD,
  ownerToken,
  waitUntilOffLoginScreen,
} from '../project/_helpers'

// TEST-23 [negative-perm][positive-control] (#63) — the Infrastructure admin page is a
// saas-only, `infra::settings::manage`-gated surface. The e2e harness drives the DEFAULT
// (saas-OFF) build, where `infra::settings::manage` is absent from the generated enum for
// EVERY user (root owner included) — so the nav entry never registers and the route never
// mounts. This spec proves that absence is GATED, not a broken app: the SAME restricted
// user's own settings load and the default settings surfaces render (the positive control
// that makes "infrastructure absent" meaningful), mirroring the billing-integration spec.

// TEST-CMNP1 [negative-perm][positive-control] (#61) — migrate-data controls are also gated.
test('a user without infra::settings::manage sees no Infrastructure page, but their own settings load', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  // A normal Users-group member: holds no infra permission — and in this saas-OFF build
  // infra::settings::manage does not exist at all.
  await createMember(request, admin, 'noinfraadmin')

  await loginViaUi(page, 'noinfraadmin', MEMBER_PASSWORD)
  await waitUntilOffLoginScreen(page)

  // ── POSITIVE CONTROL: the same user's settings load (not blank/bounced) ──
  await page.goto('/settings/profile')
  await expect(page.getByTestId('profile-account-card')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('settings-nav-menu')).toBeVisible()

  // ── NEGATIVE: the Infrastructure admin surface is absent at every layer ──
  // (1) Slot: no "Infrastructure" entry in the settings nav (path → testid).
  await expect(
    page.getByTestId('settings-nav-menu-item-infrastructure'),
  ).toHaveCount(0)

  // (2) Route: a direct deep-link never mounts the page (the route is not registered in
  //     the saas-OFF build), and no config/secret surface renders.
  await page.goto('/settings/infrastructure')
  await expect(page.getByTestId('infra-settings-page')).toHaveCount(0)
  await expect(page.getByTestId('infra-object-store-card')).toHaveCount(0)
  await expect(page.getByTestId('infra-compute-card')).toHaveCount(0)
  await expect(page.getByTestId('infra-object-store-secret-input')).toHaveCount(0)
  await expect(page.getByTestId('infra-compute-kubeconfig-input')).toHaveCount(0)
  // #61: the data-migration surface (Migrate data card + its start/retire controls) is part of
  // the same saas-only, infra::settings::manage-gated page — also absent for this user.
  await expect(page.getByTestId('infra-migrate-data-card')).toHaveCount(0)
  await expect(page.getByTestId('infra-migration-start')).toHaveCount(0)
  await expect(page.getByTestId('infra-migration-retire')).toHaveCount(0)

  // The app is still alive (not a crash) — navigating back to a real settings page works.
  await page.goto('/settings/profile')
  await expect(page.getByTestId('profile-account-card')).toBeVisible({ timeout: 30_000 })
})
