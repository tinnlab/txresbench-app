import { type Page, type APIRequestContext, expect } from '@playwright/test'
import { loginViaUi, logout, waitForToken as waitForOwnerToken } from '../_owner'

// The owner identity + first-run setup come from `tests/e2e/_owner.ts` — the ONE
// owner for the whole directory (see that file for why a per-suite owner was a bug).

export { OWNER, loginAsOwner } from '../_owner'

/** Log in as an already-created non-owner user (fresh session). */
export async function loginAs(page: Page, username: string, password: string) {
  await logout(page)
  await loginViaUi(page, username, password)
  await waitForToken(page)
}

export async function waitForToken(page: Page) {
  await waitForOwnerToken(page)
}

export async function ownerToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    return JSON.parse(localStorage.getItem('auth-storage') || '{}')?.state?.token as string
  })
}

/** The sidebar "Jobs" tools button (kit Menu renders items as <button>). */
export function jobsSidebarButton(page: Page) {
  return page
    .getByTestId('layout-sidebar-tools-menu')
    .getByRole('button', { name: 'Jobs' })
}

/** Open the Jobs drawer from the sidebar tools button. */
export async function openJobsDrawer(page: Page) {
  await jobsSidebarButton(page).click()
  await expect(page.getByTestId('jobs-drawer')).toBeVisible()
}

/**
 * Create a user that LACKS `jobs::use` but keeps profile perms (so the app is
 * still usable) via the admin API: register, put them in a custom no-jobs group
 * (`profile::read`/`edit` only), then remove them from the Users group (which
 * grants jobs::use). Returns the creds.
 */
export async function createRestrictedUser(
  request: APIRequestContext,
  adminToken: string,
  username: string,
) {
  const password = 'restrictedPassw0rd!'
  const hdr = { Authorization: `Bearer ${adminToken}` }

  const reg = await request.post('/api/auth/register', {
    data: { username, email: `${username}@txresbench.test`, password, display_name: username },
  })
  expect(reg.ok(), `register ${username}`).toBeTruthy()
  const userToken = (await reg.json()).access_token
  const me = await (
    await request.get('/api/auth/me', { headers: { Authorization: `Bearer ${userToken}` } })
  ).json()
  const userId = me.user.id

  // A group with profile perms but NO jobs::use.
  const grp = await request.post('/api/groups', {
    headers: hdr,
    data: {
      name: `no-jobs-${username}`,
      description: 'e2e: profile perms without jobs::use',
      permissions: ['profile::read', 'profile::edit'],
    },
  })
  expect(grp.ok(), 'create no-jobs group').toBeTruthy()
  const groupId = (await grp.json()).id
  await request.post('/api/groups/assign', {
    headers: hdr,
    data: { user_id: userId, group_id: groupId },
  })

  const groups = await (await request.get('/api/groups', { headers: hdr })).json()
  const usersGroup = groups.groups.find((g: { name: string }) => g.name === 'Users')
  const removed = await request.delete(`/api/groups/${userId}/${usersGroup.id}/remove`, {
    headers: hdr,
  })
  expect(removed.ok(), 'remove from Users group').toBeTruthy()
  return { username, password }
}
