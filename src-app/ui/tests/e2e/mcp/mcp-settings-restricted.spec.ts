import { expect, test } from '@playwright/test'
import { createRestrictedUser, loginAs, loginAsOwner, logout } from './helpers'

// TEST-15 [negative-perm][positive-control][acceptance INV-3]: a user WITHOUT
// `mcp::settings::read` must not see the "MCP" admin-settings nav entry AND cannot
// render /settings/mcp (route permission-gated → the inline 403 panel). This is the
// frontend-hidden half (A10) on top of the backend deny (integration TEST-11).
// The POSITIVE CONTROL — the same restricted user CAN load /settings/general — is
// what makes "absent" mean "gated", not "never rendered".

const RESTRICTED = {
  username: `mcp-set-restricted-${Date.now()}`,
  password: 'restrictedP0!x',
}

test('a user without mcp::settings::read sees no MCP settings and is denied the route', async ({
  page,
  request,
}) => {
  const adminToken = await loginAsOwner(page)
  await createRestrictedUser(request, adminToken, RESTRICTED.username, RESTRICTED.password)

  await logout(page)
  await loginAs(page, RESTRICTED.username, RESTRICTED.password)

  // POSITIVE CONTROL: the restricted user CAN load the settings area — so a hidden
  // MCP surface below means "gated", not "the page never rendered". (The kit `Menu`
  // renders each settings-section item as a `<button>`, not an `<a>`.)
  await page.goto('/settings/general')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(page.getByTestId('settings-nav-menu')).toBeVisible()

  // The settings nav must NOT offer an "MCP" admin entry (the slot is perm-gated).
  await expect(
    page.getByTestId('settings-nav-menu').getByRole('button', { name: 'MCP', exact: true }),
  ).toHaveCount(0)

  // Direct navigation is refused by the route permission gate — the MCP settings
  // page never renders; the inline 403 panel does.
  await page.goto('/settings/mcp')
  await expect(page.getByTestId('mcp-settings-page')).toHaveCount(0)
  await expect(page.getByTestId('settings-forbidden-result')).toBeVisible()
  await expect(page.getByText('Not authorized')).toBeVisible()
})
