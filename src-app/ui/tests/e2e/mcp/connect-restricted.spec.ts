import { expect, test } from '@playwright/test'
import { createRestrictedUser, loginAs, loginAsOwner, logout } from './helpers'

// TEST-17 [negative-perm, A10 — MUST pass]: a user LACKING `mcp::use` (which
// is granted only via the default "Users" group — see the mcp_grants
// migration) sees NO "AI Assistant Access" settings nav entry, and direct
// navigation to /settings/ai-access renders the inline 403 panel, never the
// page (the frontend-hidden half of the backend-deny TEST-11 proves).

const RESTRICTED = {
  username: `mcp-restricted-${Date.now()}`,
  password: 'restrictedP0!x',
}

test('a user without mcp::use sees no AI Assistant Access entry and is denied the route', async ({
  page,
  request,
}) => {
  const adminToken = await loginAsOwner(page)
  await createRestrictedUser(request, adminToken, RESTRICTED.username, RESTRICTED.password)

  await logout(page)
  await loginAs(page, RESTRICTED.username, RESTRICTED.password)

  // A settings page this user CAN reach (no permission gate) — the nav must
  // not offer an "AI Assistant Access" entry (the slot is perm-gated). (The
  // kit `Menu` renders each settings-section item as a `<button>`, not an
  // `<a>` — confirmed against the real DOM, not assumed.)
  await page.goto('/settings/general')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(page.getByTestId('settings-nav-menu')).toBeVisible()
  await expect(
    page
      .getByTestId('settings-nav-menu')
      .getByRole('button', { name: 'AI Assistant Access', exact: true }),
  ).toHaveCount(0)

  // Direct navigation is refused by the route permission gate — the AI-access
  // page never renders; the inline 403 panel does.
  await page.goto('/settings/ai-access')
  await expect(page.getByTestId('ai-access-page')).toHaveCount(0)
  await expect(page.getByTestId('settings-forbidden-result')).toBeVisible()
  await expect(page.getByText('Not authorized')).toBeVisible()
})
