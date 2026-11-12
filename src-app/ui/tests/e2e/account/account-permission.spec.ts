import { type APIRequestContext, expect, test } from '@playwright/test'
import {
  BACKEND,
  loginViaUi,
  MEMBER_PASSWORD,
  ownerToken,
  waitUntilOffLoginScreen,
} from '../project/_helpers'

// TEST-13 [negative-perm][positive-control] (A10 — the epic-closing authz proof,
// deferred from A1 DEC-4 / A3 DEC-7 to the first account surface):
//
// A user in a CUSTOM group that holds profile + projects perms but NOT `account::read`
// sees NO account UI at any gating layer (slot → route → API), while — the positive
// control — the SAME user still LOADS the app dashboard and a permitted settings page.
// The positive control is what makes "account UI absent" mean GATED, not never-rendered:
// the spec would fail if the account surface were left ungated (it would appear) OR if
// the user's session simply failed to load (the control would fail).

const USERS_GROUP_ID = '79668b78-16ff-4d3f-80e6-afdbb3236dc9'

/** Create a user in a custom group WITHOUT `account::read` but WITH the perms the
 *  dashboard + profile page need (the positive control), then strip the Users group
 *  (which grants `account::read`). */
async function createUserWithoutAccountRead(
  request: APIRequestContext,
  admin: string,
  username: string,
): Promise<void> {
  const auth = { authorization: `Bearer ${admin}` }
  // 1) the user (auto-joined to Users).
  const u = await request.post(`${BACKEND}/api/users`, {
    headers: auth,
    data: { username, email: `${username}@txresbench.test`, password: MEMBER_PASSWORD },
  })
  expect(u.ok()).toBeTruthy()
  const userId = (await u.json()).id

  // 2) a custom group with EXACTLY the Users-group permissions MINUS `account::read`
  //    — so the user is a normal user in every respect except the account grant (the
  //    positive control needs the full dashboard + settings to load).
  const ug = await request.get(`${BACKEND}/api/groups/${USERS_GROUP_ID}`, { headers: auth })
  expect(ug.ok()).toBeTruthy()
  const usersPerms: string[] = (await ug.json()).permissions ?? []
  const perms = usersPerms.filter(p => p !== 'account::read')
  expect(perms.includes('account::read')).toBeFalsy()
  expect(perms.includes('projects::use')).toBeTruthy() // sanity: still a real user

  const g = await request.post(`${BACKEND}/api/groups`, {
    headers: auth,
    data: {
      name: `no-account-${username}`,
      description: 'Users-group perms minus account::read',
      permissions: perms,
      is_active: true,
    },
  })
  expect(g.ok()).toBeTruthy()
  const groupId = (await g.json()).id

  // 3) assign the user to the custom group.
  const a = await request.post(`${BACKEND}/api/groups/assign`, {
    headers: auth,
    data: { user_id: userId, group_id: groupId },
  })
  expect(a.ok()).toBeTruthy()

  // 4) remove the user from Users → they lose `account::read` (but keep the custom
  //    group's profile + projects perms).
  const r = await request.delete(`${BACKEND}/api/groups/${userId}/${USERS_GROUP_ID}/remove`, {
    headers: auth,
  })
  expect(r.ok()).toBeTruthy()
}

/** A bearer token for a username/password (to prove the API gate directly). */
async function tokenFor(request: APIRequestContext, username: string): Promise<string> {
  const r = await request.post(`${BACKEND}/api/auth/login`, {
    data: { username, password: MEMBER_PASSWORD },
  })
  expect(r.ok()).toBeTruthy()
  const body = await r.json()
  return body.access_token ?? body.token
}

test('a user without account::read sees no account UI, but their app still loads', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  await createUserWithoutAccountRead(request, admin, 'noacct')

  // API gate (A9-adjacent, from the UI's own request path): GET /api/accounts → 403.
  const token = await tokenFor(request, 'noacct')
  const apiResp = await request.get(`${BACKEND}/api/accounts`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(apiResp.status(), 'GET /api/accounts is forbidden without account::read').toBe(403)

  await loginViaUi(page, 'noacct', MEMBER_PASSWORD)
  // `loginViaUi` only fills + clicks — it does NOT wait for auth to complete. Wait for the
  // login screen to clear before navigating (else a goto races the redirect and bounces
  // back to /login). NEVER `waitForLoadState('networkidle')` here — this user holds
  // `profile::read`, so the app opens a long-lived SSE sync stream and the network is
  // never idle. Wait on concrete elements instead.
  await waitUntilOffLoginScreen(page)

  // ── POSITIVE CONTROL: the same user's app loads (not a blank/bounced session) ──
  await page.goto('/projects')
  await expect(page.getByTestId('projects-page')).toBeVisible({ timeout: 30_000 })
  await page.goto('/settings/profile')
  await expect(page.getByTestId('profile-account-card')).toBeVisible({ timeout: 30_000 })
  // …and the settings nav renders (so an absent "Accounts" entry means gated, not "no nav").
  await expect(page.getByTestId('settings-nav-menu')).toBeVisible()

  // ── NEGATIVE: every account surface is absent/gated ──
  // (1) Slot: no "Accounts" entry in the settings nav.
  await expect(
    page.getByTestId('settings-nav-menu').getByRole('link', { name: /^accounts$/i }),
  ).toHaveCount(0)
  // (1b) Slot: no account switcher in the app chrome.
  await page.goto('/projects')
  await expect(page.getByTestId('projects-page')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('account-switcher')).toHaveCount(0)

  // (2) Route: navigating directly to /settings/accounts is blocked — the settings
  //     layout renders its "Not authorized … to view Accounts" 403 panel, and the
  //     account settings list never mounts.
  await page.goto('/settings/accounts')
  await expect(page.getByTestId('settings-forbidden-result')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('account-settings-list')).toHaveCount(0)
})
