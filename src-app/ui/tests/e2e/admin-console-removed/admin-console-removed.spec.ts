import { expect, test } from '@playwright/test'
import { loginAsOwner, ownerToken } from '../project/_helpers'

// Acceptance specs for the removal of the redundant `/settings/admin-console`
// landing hub (#42 shell). The hub was deleted because it only re-listed the
// Settings/Admin sidebar, which renders directly from the `settingsAdminPages`
// slot's OTHER entries.
//
// TEST-1 [acceptance][invariant: INV-1] — the Admin nav group STILL RENDERS from
//   a non-admin-console entry (Accounts), and the "Admin console" entry is gone.
// TEST-2 [acceptance][invariant: INV-2] — a bookmarked /settings/admin-console
//   no longer mounts the hub and does not crash: the SDK router's catch-all
//   redirects the authenticated user home (normal not-found/redirect behavior).

test('TEST-1: an admin still sees the Admin group (Accounts) and NO "Admin console" entry', async ({
  page,
  request,
}) => {
  await ownerToken(request) // ensure the owner (admin) exists
  await loginAsOwner(page)

  await page.goto('/settings')
  await expect(page.getByTestId('settings-nav-menu')).toBeVisible({ timeout: 30_000 })

  // The Admin group renders from its OTHER entries: the Accounts admin entry
  // (path `accounts-admin`, order 6) is present and clickable.
  await expect(
    page.getByTestId('settings-nav-menu-item-accounts-admin'),
  ).toBeVisible({ timeout: 20_000 })

  // The removed hub's nav entry is absent. Kit `Menu` items are <button>s.
  await expect(
    page
      .getByTestId('settings-nav-menu')
      .getByRole('button', { name: /^admin console$/i }),
  ).toHaveCount(0)
})

test('TEST-2: a bookmarked /settings/admin-console redirects home and does not crash', async ({
  page,
  request,
}) => {
  await ownerToken(request)
  await loginAsOwner(page)

  // The owner WOULD have had `admin::accounts` (the hub's old permission), so a
  // 403 is not what removes the page here — the route simply no longer exists.
  await page.goto('/settings/admin-console')

  // The SDK router catch-all (`path="*" → <Navigate to="/">`) redirects the
  // authenticated user off the removed route (normal not-found behavior)…
  await expect(page).not.toHaveURL(/\/settings\/admin-console$/, { timeout: 30_000 })
  // …and the removed hub page body never mounts.
  await expect(page.getByTestId('admin-console-page')).toHaveCount(0)

  // POSITIVE CONTROL — the app is alive, not crashed to the root ErrorBoundary:
  // navigating to a real page still renders it end-to-end. A crashed root could
  // not produce `projects-page`.
  await page.goto('/projects')
  await expect(page.getByTestId('projects-page')).toBeVisible({ timeout: 30_000 })
})
