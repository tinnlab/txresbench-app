import { expect, test } from '@playwright/test'
import {
  createMember,
  loginViaUi,
  MEMBER_PASSWORD,
  ownerToken,
  waitUntilOffLoginScreen,
} from '../project/_helpers'

// TEST-CUT-NP [negative-perm][positive-control] (#64) — the live object-store hot-cutover
// status/progress + cost-ack + retire-when-ready surface is part of the same saas-only,
// `infra::settings::manage`-gated Infrastructure page. The e2e harness drives the DEFAULT
// (saas-OFF) build, where `infra::settings::manage` is absent from the generated enum for EVERY
// user (root owner included) — so the module registers nothing: the nav entry never appears, the
// route never mounts, and none of the live-cutover controls render.
//
// This proves that absence is GATED, not a broken app: the SAME restricted user's OWN settings
// load (the positive control that makes "cutover surface absent" meaningful), walking the gating
// at every layer — slot → route → page. Mirrors `infra-settings-negative-perm.spec.ts`.
test('a user without infra::settings::manage sees no live-cutover surface, but their own settings load', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  await createMember(request, admin, 'nocutoveradmin')

  await loginViaUi(page, 'nocutoveradmin', MEMBER_PASSWORD)
  await waitUntilOffLoginScreen(page)

  // ── POSITIVE CONTROL: the same user's settings load (not blank/bounced) ──
  await page.goto('/settings/profile')
  await expect(page.getByTestId('profile-account-card')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('settings-nav-menu')).toBeVisible()

  // ── NEGATIVE: the Infrastructure admin surface is absent at every layer ──
  // (1) Slot: no "Infrastructure" entry in the settings nav.
  await expect(page.getByTestId('settings-nav-menu-item-infrastructure')).toHaveCount(0)

  // (2) Route: a direct deep-link never mounts the page, and no live-cutover control renders.
  await page.goto('/settings/infrastructure')
  await expect(page.getByTestId('infra-settings-page')).toHaveCount(0)
  await expect(page.getByTestId('infra-live-cutover-card')).toHaveCount(0)
  await expect(page.getByTestId('infra-cutover-phase')).toHaveCount(0)
  await expect(page.getByTestId('infra-cutover-progress')).toHaveCount(0)
  await expect(page.getByTestId('infra-cutover-cost-ack-btn')).toHaveCount(0)
  await expect(page.getByTestId('infra-cutover-retire-check')).toHaveCount(0)

  // The app is still alive (not a crash) — navigating back to a real settings page works.
  await page.goto('/settings/profile')
  await expect(page.getByTestId('profile-account-card')).toBeVisible({ timeout: 30_000 })
})

// TEST-FE3 — [negative-perm][positive-control] restricted-user cutover UI absent (#64 ITEM-8)
