import { expect, test } from '@playwright/test'
import { createRestrictedUser, loginAs, loginAsOwner, ownerToken } from './helpers'
import { logout } from '../_owner'

// TEST-16 [negative-perm][positive-control] (#54): a user WITHOUT jobs::settings::read must not
// see the Jobs settings nav entry AND cannot render /settings/jobs (route perm-gated → the 403
// "Not authorized" panel). The POSITIVE CONTROL is that the same user still LOADS the settings
// shell (/settings/general renders) — so "absent" means "gated", not "never rendered". This is
// the frontend half of the authz proof (A10); the backend deny is the integration TEST-9.

const RESTRICTED_USERNAME = 'e2e-jobs-restricted'

test('a user without jobs settings permission sees no Jobs settings and is denied the route', async ({
  page,
}) => {
  // Admin creates a restricted user (profile perms only — no jobs::use, no jobs::settings).
  await loginAsOwner(page)
  const token = await ownerToken(page)
  const { username, password } = await createRestrictedUser(page.request, token, RESTRICTED_USERNAME)

  // Become the restricted user.
  await logout(page)
  await loginAs(page, username, password)

  // POSITIVE CONTROL: the settings shell still loads for this user.
  await page.goto('/settings/general')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 15_000 })

  // The settings nav must NOT offer a "Jobs" entry (the slot is perm-gated).
  await expect(page.getByRole('link', { name: 'Jobs' })).toHaveCount(0)

  // Direct navigation is refused by the route permission gate — the Jobs settings
  // page never renders; the 403 panel does.
  await page.goto('/settings/jobs')
  await expect(page.getByTestId('job-settings-page')).toHaveCount(0)
  await expect(page.getByTestId('job-concurrency-card')).toHaveCount(0)
  // TEST-13 (#56): the new Scheduler & reaper card is absent for a restricted user (it
  // inherits the same route/slot gate as the sibling cards).
  await expect(page.getByTestId('job-scheduler-card')).toHaveCount(0)
  await expect(page.getByText('Not authorized')).toBeVisible()
})
