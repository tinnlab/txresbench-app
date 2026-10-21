import { expect, test } from '@playwright/test'
import { createRestrictedUser, loginAs, loginAsOwner, logout } from './helpers'

// TEST-19 [negative-perm] [ITEM-14]: a user WITHOUT sandbox::settings::read (the
// reused gate, DEC-6) must not see the Processors settings surface — the nav entry
// is absent AND /settings/processors cannot render (route permission-gated → the
// 403 "Not authorized" panel). Frontend-hidden (A10) on top of backend-deny (the
// integration reload_api_test proves the 401/403). Mirrors
// sandbox/sandbox-settings-restricted.spec.ts.

const RESTRICTED = {
  username: 'e2e-proc-restricted',
  email: 'proc-restricted@cyto.test',
  password: 'restrictedP0!x',
}

test('a user without the sandbox settings permission sees no Processors surface', async ({
  page,
}) => {
  // Admin creates a restricted (no-permission) user.
  const token = await loginAsOwner(page)
  await createRestrictedUser(page, token, RESTRICTED)

  // Become the restricted user.
  await logout(page)
  await loginAs(page, RESTRICTED.username, RESTRICTED.password)

  // The settings nav must NOT offer a "Processors" entry (slot is perm-gated).
  await page.goto('/settings/general')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Processors' })).toHaveCount(0)

  // Direct navigation is refused by the route permission gate — the page never
  // renders; the 403 panel does.
  await page.goto('/settings/processors')
  await expect(page.getByTestId('processors-settings-page')).toHaveCount(0)
  await expect(page.getByText('Not authorized')).toBeVisible()
})
