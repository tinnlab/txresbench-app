import { expect, test } from '@playwright/test'
import { createRestrictedUser, loginAs, loginAsOwner, logout } from './helpers'

// TEST-22 [negative-perm]: a user WITHOUT sandbox::settings::read must not see
// the Sandbox settings nav entry AND cannot render /settings/sandbox (route
// permission-gated → the 403 "Not authorized" panel). Frontend-hidden (A10) on
// top of backend-deny (the integration TEST-18 proves the 403).

const RESTRICTED = {
  username: 'e2e-restricted',
  email: 'restricted@cyto.test',
  password: 'restrictedP0!x',
}

test('a user without sandbox permission sees no Sandbox settings and is denied the route', async ({
  page,
}) => {
  // Admin creates a restricted (no-permission) user.
  const token = await loginAsOwner(page)
  await createRestrictedUser(page, token, RESTRICTED)

  // Become the restricted user.
  await logout(page)
  await loginAs(page, RESTRICTED.username, RESTRICTED.password)

  // The settings nav must NOT offer a "Sandbox" entry (slot is perm-gated).
  await page.goto('/settings/general')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Sandbox' })).toHaveCount(0)

  // Direct navigation is refused by the route permission gate — the sandbox
  // page never renders; the 403 panel does.
  await page.goto('/settings/sandbox')
  await expect(page.getByTestId('sandbox-settings-page')).toHaveCount(0)
  await expect(page.getByText('Not authorized')).toBeVisible()

  // TEST-17 [negative-perm] (#54): the #54 cards are gated by the same page route, so
  // a restricted user sees NONE of them (per-class defaults + env-image), not only the
  // pre-existing limits card.
  await expect(page.getByTestId('sandbox-per-class-card')).toHaveCount(0)
  await expect(page.getByTestId('sandbox-env-image-card')).toHaveCount(0)
})
