import { test, expect } from '@playwright/test'
import {
  loginAsOwner,
  loginAs,
  ownerToken,
  createRestrictedUser,
  jobsSidebarButton,
} from './helpers'

// TEST-25 [negative-perm] (A10): a user LACKING jobs::use sees NO Jobs UI at any
// gating layer — no sidebar button (slot), no drawer, no /settings/jobs page
// (route), and no "Jobs" entry in the settings admin nav (<Can>/usePermission).
test('a user without jobs::use sees no Jobs UI anywhere', async ({ page, request }) => {
  // Owner sets up + creates a restricted user via the admin API.
  await loginAsOwner(page)
  const admin = await ownerToken(page)
  const creds = await createRestrictedUser(request, admin, 'restricted')

  // Log in AS the restricted user.
  await loginAs(page, creds.username, creds.password)
  await page.goto('/settings/general')
  // The app is usable (profile perms) — the settings heading renders.
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({
    timeout: 15_000,
  })

  // Layer 1 (slot): NO "Jobs" button in the sidebar tools.
  await expect(jobsSidebarButton(page)).toHaveCount(0)

  // Layer 4 (usePermission / <Can>): NO "Jobs" entry in the settings admin nav.
  await expect(
    page.getByTestId('settings-nav-menu').getByText('Jobs', { exact: true }),
  ).toHaveCount(0)

  // Layer 2 (route): navigating to /settings/jobs does NOT render the page.
  await page.goto('/settings/jobs')
  await expect(page.getByTestId('job-settings-max-concurrent')).toHaveCount(0)
  await expect(page.getByTestId('job-settings-card')).toHaveCount(0)
})
