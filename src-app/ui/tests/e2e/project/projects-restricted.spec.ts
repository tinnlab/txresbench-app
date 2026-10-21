import { expect, test } from '@playwright/test'
import {
  createRestrictedUser,
  loginViaUi,
  MEMBER_PASSWORD,
  ownerToken,
} from './_helpers'

// TEST-34 [negative-perm] (A10): a user LACKING `projects::use` sees NO projects UI
// at ANY of the four gating layers — sidebar slot, route, <Can>, usePermission.
test('a user without projects::use sees no projects UI', async ({ page, request }) => {
  const admin = await ownerToken(request)
  await createRestrictedUser(request, admin, 'restricted')

  await loginViaUi(page, 'restricted', MEMBER_PASSWORD)
  // Land somewhere authenticated (the app shell renders).
  await page.waitForLoadState('networkidle')

  // (1) Slot: NO "Projects" nav entry in the sidebar.
  await expect(page.getByTestId('project')).toHaveCount(0)
  await expect(page.getByRole('link', { name: /^projects$/i })).toHaveCount(0)

  // (1b) TEST-12: the recent-projects sidebar widget is also permission-gated —
  // it never mounts (never fetches) for a user lacking projects::use.
  await expect(page.getByTestId('recent-projects-widget')).toHaveCount(0)

  // (2) Route: navigating directly to /projects does NOT render the projects page
  // (the route gate blocks it — no page container, no create button).
  await page.goto('/projects')
  await page.waitForLoadState('networkidle')
  await expect(page.getByTestId('projects-page')).toHaveCount(0)

  // (3)/(4) <Can>/usePermission: no create/list affordances anywhere.
  await expect(page.getByTestId('projects-new-button')).toHaveCount(0)
  await expect(page.getByTestId('projects-grid')).toHaveCount(0)
})
