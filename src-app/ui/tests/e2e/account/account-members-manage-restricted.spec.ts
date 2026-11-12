import { type APIRequestContext, expect, test } from '@playwright/test'
import {
  BACKEND,
  loginViaUi,
  MEMBER_PASSWORD,
  ownerToken,
  waitUntilOffLoginScreen,
} from '../project/_helpers'

// TEST-14 [negative-perm][positive-control] [covers: ITEM-10] (#139, A10)
//
// The FRONTEND half of the authz proof for the NEW permission `account::members::manage`
// (the backend half is `account_scope_test.rs`'s A9 deny suite).
//
// A user who holds `account::read` but NOT `account::members::manage`:
//   * POSITIVE CONTROL — still LOADS `/settings/accounts`, and the org's members list
//     renders WITH REAL MEMBERS. This is what makes the absences below mean "gated"
//     rather than "never rendered": a failed route, a login bounce, a render crash or a
//     blank shell would all satisfy "the affordance is not visible", and would all fail
//     this control.
//   * NEGATIVE — the capability-gated route 403s through their own session, and no
//     member-write affordance is present.
//
// SECOND CONTROL (the one that makes the 403 mean "the permission"): a sibling user who
// IS in the Users group — same org, same `owner` role, same route — gets 200. So the
// difference between the two arms is exactly one permission, and nothing else.

const USERS_GROUP_ID = '79668b78-16ff-4d3f-80e6-afdbb3236dc9'

// The member-write affordances. #139 ships NO member-management UI (that is #149), so
// these are a FORWARD-PIN, not this diff's negative proof — the real negative here is
// the API 403 asserted below, through this user's own session.
//
// They are PREFIX selectors on purpose. The reference implementation this surface will
// mirror (`modules/admin-accounts/components/MembersSection.tsx`) suffixes every
// per-row control with the member id (`account-member-role-select-${m.user_id}`,
// `account-member-remove-button-${m.user_id}`), so an EXACT `getByTestId` match would
// never fire even once #149 ships — the pin would silently stay vacuous forever, which
// is the failure mode this repo keeps paying for.
const WRITE_AFFORDANCE_PREFIXES = [
  // The reference names its add-member controls with the PLURAL stem
  // `account-members-add-*` (`-row`, `-user-select`, `-role-select`, `-button`), which
  // `account-member-` (singular, trailing dash) does NOT prefix-match. Getting this
  // wrong would leave the single most likely write affordance — add/invite a member —
  // permanently unpinned while the loop stayed green.
  //
  // The TRAILING HYPHEN is load-bearing. `account-members-add` (without it) also
  // prefix-matches the members-LIST container `account-members-${accountId}` whenever
  // the seeded org's v4 UUID happens to start with the hex digits `add` — about 1 run
  // in 4096, failing this pin for a reason that has nothing to do with an affordance.
  // The other prefixes are safe only by luck (`invite`/`remove`/`select`/`transfer`
  // all contain non-hex letters, so they can never collide with a UUID); this one is
  // all-hex, so it must be anchored on the boundary explicitly.
  'account-members-add-',
  'account-member-invite',
  'account-member-role-select',
  'account-member-remove',
  'account-transfer-ownership',
] as const

/** Any element whose data-testid STARTS WITH `prefix` (matches the id-suffixed
 *  per-row controls the sibling MembersSection uses). */
const affordance = (page: import('@playwright/test').Page, prefix: string) =>
  page.locator(`[data-testid^="${prefix}"]`)

async function createUser(
  request: APIRequestContext,
  admin: string,
  username: string,
): Promise<string> {
  const r = await request.post(`${BACKEND}/api/users`, {
    headers: { authorization: `Bearer ${admin}` },
    data: { username, email: `${username}@txresbench.test`, password: MEMBER_PASSWORD },
  })
  expect(r.ok(), `create user ${username}`).toBeTruthy()
  return (await r.json()).id
}

/** Move `userId` into a custom group holding the Users permissions MINUS
 *  `account::members::manage` — so they keep `account::read` (the control needs the
 *  page to load) and lose exactly one thing. Mirrors `account-permission.spec.ts`. */
async function stripMembersManage(
  request: APIRequestContext,
  admin: string,
  userId: string,
  username: string,
): Promise<void> {
  const auth = { authorization: `Bearer ${admin}` }
  const ug = await request.get(`${BACKEND}/api/groups/${USERS_GROUP_ID}`, { headers: auth })
  expect(ug.ok()).toBeTruthy()
  const usersPerms: string[] = (await ug.json()).permissions ?? []
  expect(
    usersPerms.includes('account::members::manage'),
    'precondition: the migration granted the key to the Users group, so removing it is a real subtraction',
  ).toBeTruthy()

  const perms = usersPerms.filter(p => p !== 'account::members::manage')
  expect(perms.includes('account::read'), 'the restricted user KEEPS account::read').toBeTruthy()

  const g = await request.post(`${BACKEND}/api/groups`, {
    headers: auth,
    data: {
      name: `no-members-manage-${username}`,
      description: 'Users-group perms minus account::members::manage',
      permissions: perms,
      is_active: true,
    },
  })
  expect(g.ok()).toBeTruthy()
  const groupId = (await g.json()).id

  const a = await request.post(`${BACKEND}/api/groups/assign`, {
    headers: auth,
    data: { user_id: userId, group_id: groupId },
  })
  expect(a.ok()).toBeTruthy()
  const rm = await request.delete(
    `${BACKEND}/api/groups/${userId}/${USERS_GROUP_ID}/remove`,
    { headers: auth },
  )
  expect(rm.ok()).toBeTruthy()
}

async function tokenFor(request: APIRequestContext, username: string): Promise<string> {
  const r = await request.post(`${BACKEND}/api/auth/login`, {
    data: { username, password: MEMBER_PASSWORD },
  })
  expect(r.ok()).toBeTruthy()
  const body = await r.json()
  return body.access_token ?? body.token
}

test('a user without account::members::manage loads the accounts page and its members list, but gets no management affordance', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const auth = { authorization: `Bearer ${admin}` }

  // ── seed: an ORG owned by the restricted user, plus a permitted sibling member ──
  const restrictedId = await createUser(request, admin, 'nomanage')
  const permittedId = await createUser(request, admin, 'canmanage')

  // Only an admin holds `account::manage`, so the admin creates the org on their behalf.
  const orgResp = await request.post(`${BACKEND}/api/accounts`, {
    headers: auth,
    data: { name: 'Restricted Org', owner_id: restrictedId },
  })
  expect(orgResp.ok(), 'admin creates the org').toBeTruthy()
  const orgId = (await orgResp.json()).id

  // The permitted sibling is an OWNER of the same org — identical role, so the only
  // difference between the two arms below is the permission.
  const addResp = await request.post(`${BACKEND}/api/admin/accounts/${orgId}/members`, {
    headers: auth,
    data: { user_id: permittedId, role: 'owner' },
  })
  expect(addResp.ok(), 'admin adds the permitted sibling as an owner').toBeTruthy()

  // Strip the key from the restricted user ONLY.
  await stripMembersManage(request, admin, restrictedId, 'nomanage')

  const route = `${BACKEND}/api/accounts/${orgId}/members/manage-context`

  // ── NEGATIVE (API): the restricted user is refused, by NAME ──
  const restrictedToken = await tokenFor(request, 'nomanage')
  const denied = await request.get(route, {
    headers: { authorization: `Bearer ${restrictedToken}` },
  })
  expect(denied.status(), 'no account::members::manage ⇒ 403').toBe(403)
  const deniedBody = await denied.json()
  expect(
    deniedBody.error_code ?? deniedBody.code,
    'the refusal names the CAPABILITY, not the role floor',
  ).toBe('ACCOUNT_MEMBERS_MANAGE_REQUIRED')

  // ── POSITIVE CONTROL (API): same org, same `owner` role, WITH the key ⇒ 200 ──
  // Without this arm, the 403 above could equally mean "the route is broken".
  const permittedToken = await tokenFor(request, 'canmanage')
  const allowed = await request.get(route, {
    headers: { authorization: `Bearer ${permittedToken}` },
  })
  expect(allowed.status(), 'the ONLY difference is the permission').toBe(200)
  const allowedBody = await allowed.json()
  expect(allowedBody.actor_role).toBe('owner')
  expect(allowedBody.member_count).toBe(2)

  // ── POSITIVE CONTROL (UI): the restricted user's app and page actually LOAD ──
  await loginViaUi(page, 'nomanage', MEMBER_PASSWORD)
  // `loginViaUi` only fills + clicks. Wait for the login screen to clear before
  // navigating, or a goto races the redirect. NEVER `waitForLoadState('networkidle')` —
  // this user holds `profile::read`, so the SSE sync stream keeps the network busy.
  await waitUntilOffLoginScreen(page)

  await page.goto('/settings/accounts')
  await expect(
    page.getByTestId('account-settings-list'),
    'the accounts page LOADS for the restricted user (this is the control)',
  ).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('settings-nav-menu')).toBeVisible()

  // …and the members list for the org renders WITH REAL MEMBERS. If the list were
  // empty or absent, every absence assertion below would be vacuous.
  const membersList = page.getByTestId(`account-members-${orgId}`)
  await expect(membersList, 'the org members list renders').toBeVisible({ timeout: 30_000 })
  // Count the per-member ROWS. Two traps here, both real:
  //   * `toContainText('2')` on the "Showing N of M" sentence also passes on
  //     "Showing 1 of 2" and "Showing 12 of 30" — a substring, not a count.
  //   * a bare `[data-testid^="account-member-"]` matches FOUR nodes per member (the
  //     <li> row plus its name/email/role descendants), so it would read 8 here.
  // Scoping to `li` is what makes the number mean "members".
  await expect(
    membersList.locator('li[data-testid^="account-member-"]'),
    'the list is POPULATED with exactly the 2 seeded members, not an empty shell',
  ).toHaveCount(2)
  await expect(
    page.getByTestId(`account-member-${restrictedId}`),
    'the restricted user themselves is listed (real, identified data)',
  ).toBeVisible()
  await expect(
    page.getByTestId(`account-member-${permittedId}`),
    'and so is the permitted sibling — 2 real members',
  ).toBeVisible()

  // ── FORWARD-PIN (UI): no member-write affordance on the loaded page ──
  // NOTE this is a pin for #149, not this diff's gate: #139 ships no member-management
  // UI, so these currently cannot fail. The load-bearing negative in this spec is the
  // API 403 asserted above. Kept (with PREFIX matching) so that when #149 adds the
  // affordances, an ungated one turns this red instead of shipping.
  for (const prefix of WRITE_AFFORDANCE_PREFIXES) {
    await expect(
      affordance(page, prefix),
      `${prefix}* must be absent for a user lacking account::members::manage`,
    ).toHaveCount(0)
  }

  // Narrow viewport: the page must still render, and the pin must hold at 390px too
  // (an affordance that appears only in a mobile layout is still an ungated affordance).
  await page.setViewportSize({ width: 390, height: 780 })
  await expect(page.getByTestId('account-settings-list')).toBeVisible()
  await expect(
    page.getByTestId(`account-member-${restrictedId}`),
    'the members list still renders at 390px — so the pin below is not vacuous here either',
  ).toBeVisible()
  for (const prefix of WRITE_AFFORDANCE_PREFIXES) {
    await expect(affordance(page, prefix)).toHaveCount(0)
  }
})
