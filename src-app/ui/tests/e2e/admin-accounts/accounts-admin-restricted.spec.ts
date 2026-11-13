import { expect, test } from '@playwright/test'
import {
  createMember,
  loginViaUi,
  MEMBER_PASSWORD,
  ownerToken,
  waitUntilOffLoginScreen,
} from '../_helpers'

// TEST-8 [acceptance][invariant: INV-2][negative-perm][positive-control] (#44).
//
// A user LACKING `admin::accounts` must see NO Accounts nav entry and get an
// in-place 403 on a direct deep link — while their OWN settings still load, so
// "the Accounts surface is absent" means GATED, not never-rendered (a four-layer
// gating proof: slot filter + route guard + positive control).

test('a non-admin sees no Accounts section, but their own settings load', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  // A normal Users-group member: holds profile/account/projects perms (so their
  // app + settings load — the positive control) but NOT `admin::accounts`.
  await createMember(request, admin, 'noadminacct')

  await loginViaUi(page, 'noadminacct', MEMBER_PASSWORD)
  await waitUntilOffLoginScreen(page)

  // ── POSITIVE CONTROL: the same user's settings load (not blank/bounced) ──
  await page.goto('/settings/profile')
  await expect(page.getByTestId('profile-account-card')).toBeVisible({ timeout: 30_000 })
  // …and the settings nav renders, so an absent "Accounts" entry means gated.
  await expect(page.getByTestId('settings-nav-menu')).toBeVisible()

  // ── NEGATIVE: the Accounts admin surface is absent/gated at every layer ──
  // (1) Slot: no admin "All accounts" entry in the settings nav. Assert on the
  //     admin entry's SPECIFIC testid (the label "All accounts" and the per-user
  //     "Accounts" entry are distinct; the non-admin still sees the latter, so a
  //     name-based selector would match it and be vacuous). The admin entry's
  //     testid is derived from its path (`accounts-admin`).
  await expect(
    page.getByTestId('settings-nav-menu-item-accounts-admin'),
  ).toHaveCount(0)

  // (2) Route: a direct deep-link renders the in-place 403 panel, and the
  //     accounts page body never mounts.
  await page.goto('/settings/accounts-admin')
  await expect(page.getByTestId('settings-forbidden-result')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('accounts-admin-page')).toHaveCount(0)
})
