import { type APIRequestContext, expect, type Page } from '@playwright/test'
import {
  BACKEND,
  loginAsOwner as ensureOwnerSession,
  loginViaUi,
  ownerApiToken,
  waitUntilOffLoginScreen,
} from '../_owner'

// Shared project-ADMIN e2e helpers (the `/settings/projects` cross-user page).
//
// The webServer reuses ONE backend + persistent DB across specs (workers:1,
// sequential); the owner admin is created once and subsequently logged into — by
// `tests/e2e/_owner.ts`, the ONE owner for the whole directory (see that file for
// why a per-suite owner was a bug). Sub-users are created via the admin REST API;
// a project owned by user X is seeded by logging X in over REST and POSTing
// /api/projects with X's token.
//
// That shared owner admin is is_admin (holds `project::admin::*` via the `*`
// wildcard) so it reaches `/settings/projects`. A plain `createMember` user holds
// `projects::use` but NOT `project::admin::*`, so it must NOT (A10, admin-restricted).
//
// TEST-10 (ProjectAdmin store) + TEST-11 (UserPicker) have no vitest in this app;
// they are exercised end-to-end here — the store drives every list/mutation
// action in these specs, and the UserPicker is the search-select used by
// change-owner / share-on-behalf / reassign.

export { OWNER, BACKEND, loginViaUi } from '../_owner'

export const MEMBER_PASSWORD = 'memberPassw0rd!'

/** Ensure the owner admin exists and land authenticated (auth settled). */
export async function loginAsOwner(page: Page): Promise<void> {
  await ensureOwnerSession(page)
}

/** Log in a Users-group member and land on /projects (mounts the sidebar + the
 *  notification bell — the blank post-login `/` has no app chrome). */
export async function loginMemberToProjects(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  await loginViaUi(page, username, password)
  await waitUntilOffLoginScreen(page)
  await page.goto('/projects')
  await page.getByTestId('projects-page').waitFor({ state: 'visible', timeout: 20_000 })
}

/** Log the owner admin in, then open the cross-user admin page + wait for it. */
export async function gotoProjectAdmin(page: Page): Promise<void> {
  await page.goto('/settings/projects')
  await page.getByTestId('project-admin-page').waitFor({ state: 'visible', timeout: 20_000 })
}

/** An admin API token (setup or login), for REST-driving sub-user + project seeding. */
export async function ownerToken(request: APIRequestContext): Promise<string> {
  return ownerApiToken(request)
}

function tokenOf(body: Record<string, unknown>): string {
  return (body.access_token ?? body.token) as string
}

/** Create a Users-group member (holds projects::use, NOT project::admin::*). Returns id. */
export async function createMember(
  request: APIRequestContext,
  admin: string,
  username: string,
): Promise<string> {
  const r = await request.post(`${BACKEND}/api/users`, {
    headers: { authorization: `Bearer ${admin}` },
    data: { username, email: `${username}@txresbench.test`, password: MEMBER_PASSWORD },
  })
  expect(r.ok()).toBeTruthy()
  return (await r.json()).id
}

/** REST-login a member, returning their access token (for owning-a-project seeding). */
export async function memberToken(
  request: APIRequestContext,
  username: string,
  password: string = MEMBER_PASSWORD,
): Promise<string> {
  const r = await request.post(`${BACKEND}/api/auth/login`, {
    data: { username, password },
  })
  expect(r.ok()).toBeTruthy()
  return tokenOf(await r.json())
}

/** POST /api/projects with `token` → the caller becomes the owner. Returns project id. */
export async function createProjectAs(
  request: APIRequestContext,
  token: string,
  name: string,
  description = '',
): Promise<string> {
  const r = await request.post(`${BACKEND}/api/projects`, {
    headers: { authorization: `Bearer ${token}` },
    data: { name, description },
  })
  expect(r.ok()).toBeTruthy()
  return (await r.json()).id
}

export interface SeededOwner {
  ownerId: string
  username: string
  token: string
}

/** Create a fresh member and return their id + username + a REST token. */
export async function seedMember(
  request: APIRequestContext,
  admin: string,
  username: string,
): Promise<SeededOwner> {
  const ownerId = await createMember(request, admin, username)
  const token = await memberToken(request, username)
  return { ownerId, username, token }
}

export interface SeededProject {
  projectId: string
  projectName: string
  owner: SeededOwner
}

/** Create a member and a project they own. */
export async function seedProjectOwnedBy(
  request: APIRequestContext,
  admin: string,
  username: string,
  projectName: string,
): Promise<SeededProject> {
  const owner = await seedMember(request, admin, username)
  const projectId = await createProjectAs(request, owner.token, projectName)
  return { projectId, projectName, owner }
}

/** Open a row's ⋯ action menu (kit Dropdown, trigger aria-label "Actions for …"). */
export async function openRowMenu(page: Page, projectName: string): Promise<void> {
  await page.getByRole('button', { name: `Actions for ${projectName}` }).click()
}
