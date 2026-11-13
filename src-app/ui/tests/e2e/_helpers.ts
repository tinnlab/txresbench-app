import { type APIRequestContext, expect, type Page } from '@playwright/test'
import {
  BACKEND,
  loginViaUi,
  logout,
  ownerApiToken,
  waitForToken,
  waitUntilOffLoginScreen,
} from './_owner'

// The GENERIC e2e identity helpers for every suite under `tests/e2e`.
//
// These lived in `tests/e2e/project/_helpers.ts` and `tests/e2e/jobs/helpers.ts`
// and moved here when the single-cell project/jobs suites left (strip node):
// the owner bootstrap, the member-creation and member-restriction helpers and
// the plain-login helpers are the app's OWN surface (the kept account/user/
// feature-flag suites all use them), while the project-specific navigation
// helpers (`gotoProjects`, `openDatasetsPane`, …) died with the screens they
// served.
//
// The ONE owner identity + first-run setup live in `tests/e2e/_owner.ts` — see
// that file for why a per-suite owner was a bug. A suite helper that wants the
// owner delegates here; it does not re-implement the flow.

export { OWNER, BACKEND, loginAsOwner, loginViaUi, waitUntilOffLoginScreen, logout } from './_owner'

/** Log in as an already-created non-owner user (fresh session). */
export async function loginAs(page: Page, username: string, password: string) {
  await logout(page)
  await loginViaUi(page, username, password)
  await waitForToken(page)
}

/** An admin API token (setup or login), for REST-driving sub-user creation.
 *  Accepts either the API request context (the `_owner` path) or a page whose
 *  localStorage holds the session token (the feature-flag suite's path). */
export async function ownerToken(ctx: APIRequestContext | Page): Promise<string> {
  if ('evaluate' in ctx) {
    return ctx.evaluate(() => {
      return JSON.parse(localStorage.getItem('auth-storage') || '{}')?.state?.token as string
    })
  }
  return ownerApiToken(ctx)
}

const USERS_GROUP_ID = '79668b78-16ff-4d3f-80e6-afdbb3236dc9'

/** Create a Users-group member (holds the default member grants). Returns their id. */
export async function createMember(
  request: APIRequestContext,
  admin: string,
  username: string,
): Promise<string> {
  const r = await request.post('/api/users', {
    headers: { authorization: `Bearer ${admin}` },
    data: { username, email: `${username}@txresbench.test`, password: 'memberPassw0rd!' },
  })
  expect(r.ok()).toBeTruthy()
  return (await r.json()).id
}

/** Create a user whose group grants are profile-only — no platform member grants
 *  (the `jobs/helpers.ts` variant, which the kept feature-flag suite consumes). */
export async function createRestrictedUser(
  request: APIRequestContext,
  admin: string,
  username: string,
): Promise<{ username: string; password: string }> {
  const password = 'restrictedPassw0rd!'
  const hdr = { Authorization: `Bearer ${admin}` }
  const reg = await request.post('/api/auth/register', {
    data: { username, email: `${username}@txresbench.test`, password, display_name: username },
  })
  expect(reg.ok(), `register ${username}`).toBeTruthy()
  const userToken = (await reg.json()).access_token
  const me = await (
    await request.get('/api/auth/me', { headers: { Authorization: `Bearer ${userToken}` } })
  ).json()
  const userId = me.user.id

  const grp = await request.post('/api/groups', {
    headers: hdr,
    data: {
      name: `restricted-${username}`,
      description: 'e2e: profile perms without the member grants',
      permissions: ['profile::read', 'profile::edit'],
    },
  })
  expect(grp.ok(), 'create restricted group').toBeTruthy()
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

export const MEMBER_PASSWORD = 'memberPassw0rd!'
