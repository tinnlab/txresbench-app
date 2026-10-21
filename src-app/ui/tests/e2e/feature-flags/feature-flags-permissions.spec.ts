import { test, expect } from '@playwright/test'
import {
  loginAsOwner,
  loginAs,
  ownerToken,
  createRestrictedUser,
  featureFlagsNavEntry,
} from './helpers'

// TEST-9 [negative-perm] [positive-control] (A10): a user LACKING features::manage
// sees NO Feature Flags UI at any gating layer — no settings-admin nav entry
// (slot / usePermission) and no /settings/feature-flags page (route). The positive
// control (the Settings heading renders) proves the app LOADED for that user, so
// "absent" means "gated", not "never rendered".
test('a user without features::manage sees no Feature Flags UI anywhere', async ({
  page,
  request,
}) => {
  // Owner sets up + creates a restricted user via the admin API.
  await loginAsOwner(page)
  const admin = await ownerToken(page)
  const creds = await createRestrictedUser(request, admin, 'restricted-ff')

  // Log in AS the restricted user.
  await loginAs(page, creds.username, creds.password)
  await page.goto('/settings/general')
  // POSITIVE CONTROL: the app is usable (profile perms) — the settings heading renders.
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({
    timeout: 15_000,
  })

  // Layer 1 (slot) + Layer 4 (usePermission): NO "Feature Flags" entry in the settings
  // admin nav.
  await expect(featureFlagsNavEntry(page)).toHaveCount(0)

  // Layer 2 (route): navigating to /settings/feature-flags does NOT render the page.
  await page.goto('/settings/feature-flags')
  await expect(page.getByTestId('feature-flags-card')).toHaveCount(0)
  await expect(page.getByTestId('feature-flags-list')).toHaveCount(0)

  // TEST-6 (#48) [acceptance INV-2] — Layer 3 (control): the GLOBAL toggle Switch is
  // absent too, so a restricted user can neither see nor reach the enable/disable
  // affordance (the positive control above proves the app itself loaded for them).
  await expect(page.getByTestId('feature-flag-switch-demo.runtime_flag')).toHaveCount(0)

  // TEST-10 (#53) [negative-perm] [positive-control] [acceptance INV-4] — the PER-ACCOUNT
  // section is equally absent: no per-account card, no account picker, no per-account
  // switch, and no "Clear override" control. (Same positive control as above: the app
  // loaded for this user, so "absent" means "gated", not "never rendered".)
  await expect(page.getByTestId('feature-flags-account-card')).toHaveCount(0)
  await expect(page.getByTestId('feature-flags-account-picker')).toHaveCount(0)
  await expect(page.getByTestId('feature-flag-account-switch-demo.runtime_flag')).toHaveCount(0)
  await expect(page.getByTestId('feature-flag-clear-demo.runtime_flag')).toHaveCount(0)
})
