import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../_helpers'

// TEST-7 [acceptance][invariant: INV-1][positive-control] — the two-spec client seam (#50).
//
// The RUNTIME half of the presence-split, proven end-to-end in the DESKTOP/DEFAULT build the
// e2e harness drives (saas-OFF: `@/api-client/permissions` is the default client, billing absent).
// The permission picker (`PermissionsField`) enumerates `Object.entries(Permissions)` from the
// generated enum — the SAME source `isKnownPermission` reads — so it is the user-visible surface
// where the presence-split shows: a saas-only permission simply is not offered in a saas-OFF build,
// even to a root owner (whose `is_admin` would otherwise grant everything).
//
// Positive control (what makes "billing absent" mean GATED, not "picker broken"): the SAME picker
// DOES offer the default permissions (`users::read`). Without that control, an empty/crashed picker
// would pass this vacuously — so the spec asserts the picker rendered + enumerated real permissions
// first, then asserts billing is not among them.
test('the default (saas-OFF) build offers no billing permission in the group permission picker', async ({
  page,
}) => {
  await loginAsOwner(page)

  await page.goto('/settings/user-groups')
  const createButton = page.getByTestId('user-groups-create-button')
  await expect(createButton).toBeVisible({ timeout: 30_000 })
  await createButton.click()

  const search = page.getByTestId('user-permissions-search-input')
  await expect(search).toBeVisible({ timeout: 30_000 })

  // POSITIVE CONTROL — the picker renders and enumerates the DEFAULT client's permissions.
  await search.fill('users::read')
  await expect(page.getByTestId('user-permissions-tree')).toBeVisible()
  await expect(page.getByText('users::read', { exact: true })).toBeVisible()

  // PRESENCE-SPLIT — a saas-only permission is ABSENT from the saas-OFF enum, so the picker
  // offers nothing for it (no option row, the "no match" empty state instead).
  await search.fill('billing')
  await expect(page.getByText('No permissions match "billing"')).toBeVisible()
  await expect(page.getByText('billing::admin', { exact: true })).toHaveCount(0)
  await expect(page.getByText('billing::manage', { exact: true })).toHaveCount(0)
})
