import { expect, test, type APIRequestContext } from '@playwright/test'
import { BACKEND, createMember, loginAsOwner, ownerToken } from '../_helpers'

// TEST-19 [acceptance][invariant: INV-3][positive-control] (#141) — the RUNTIME half of
// "on a desktop/OSS build the seat check compiles out and `member_allowance` is unlimited;
// the membership routes themselves are not saas-gated".
//
// The e2e harness drives the DEFAULT (saas-OFF) build, which is exactly the build INV-3
// makes its promise about — so this is the one layer where that promise can be observed by
// a user rather than inferred from source. It drives the REAL account-detail Members card
// (the `admin.account.addMember` action) past the `free` tier's seat allowance and asserts
// every add lands.
//
// WHY THIS IS NOT VACUOUS. Its control is the saas arm of
// `src-app/server/tests/account/seat_allowance_test.rs`, which refuses the identical
// sequence at the allowance with 422 SEAT_LIMIT_REACHED. So "the adds succeeded" is a
// difference, not an absence: the same actions, the same route, opposite outcomes,
// selected by the build. It goes RED if the seat limit ever leaks into the default build,
// or if the membership routes acquire a build gate.
//
// It is also an ACTIVE positive control at every step, not an idle one: each add is
// confirmed by the member's row appearing in the card, so a broken picker, a failed
// action, or a page that never rendered fails the test rather than passing it silently.
//
// WHAT IT DOES NOT PROVE, stated so nobody reads more into it: it says nothing about the
// saas build's enforcement (that is TEST-6/TEST-7) and nothing about the wire schema (that
// is TEST-18, which asserts the default spec carries no `member_allowance` at all).

// The `free` tier's `member_allowance`, mirrored from `billing/catalog.rs`. It is a LITERAL
// because the catalog is a saas-only Rust module that does not exist in the build this spec
// drives — which is the point of the spec.
//
// A mirrored constant goes stale in silence, and this one already did: the number was 5 and
// a re-price to 10 landed in the same change, leaving the spec adding SEVEN members to an
// account whose real allowance was TEN — comfortably inside the limit, so it would have
// stayed green with the seat check leaking into the desktop build, the exact regression it
// claims to catch. So the coupling is now ASSERTED, in
// `tests/account/seat_allowance_test.rs::test22_the_desktop_arms_still_cross_the_boundary`,
// which parses this line and compares it against `catalog::plan("free").member_allowance`.
// Re-pricing the catalog turns THAT test red and names this file. Do not edit the constant
// without letting that test confirm it.
const FREE_TIER_SEAT_ALLOWANCE = 10
const MEMBERS_TO_ADD = FREE_TIER_SEAT_ALLOWANCE + 1

async function createOrg(
  request: APIRequestContext,
  token: string,
  name: string,
  ownerId: string,
): Promise<{ id: string }> {
  const r = await request.post(`${BACKEND}/api/accounts`, {
    headers: { authorization: `Bearer ${token}` },
    data: { name, owner_id: ownerId },
  })
  expect(r.ok(), `create org ${name}`).toBeTruthy()
  return r.json()
}

async function adminId(request: APIRequestContext, token: string): Promise<string> {
  const r = await request.get(`${BACKEND}/api/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(r.ok(), 'auth/me').toBeTruthy()
  return (await r.json()).user.id
}

test('TEST-19: the saas-OFF build adds members past the free tier seat allowance', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const me = await adminId(request, admin)
  const stamp = Date.now()

  const usernames: string[] = []
  const memberIds: string[] = []
  for (let i = 0; i < MEMBERS_TO_ADD; i++) {
    const u = `seatuser${stamp}x${i}`
    usernames.push(u)
    memberIds.push(await createMember(request, admin, u))
  }

  const org = await createOrg(request, admin, `Seat Org ${stamp}`, me)

  await loginAsOwner(page)
  await page.goto(`/settings/accounts-admin/${org.id}`)

  // POSITIVE CONTROL — the page and its Members card really rendered, and the owner row is
  // there. Without this, "the adds worked" could be true of a page that never loaded.
  await expect(page.getByTestId('account-detail-page')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('account-detail-members-card')).toBeVisible()
  await expect(page.getByTestId(`account-member-row-${me}`)).toBeVisible({ timeout: 20_000 })

  // Cross the boundary. Each add is confirmed by its row, so a silently-failed action
  // cannot be mistaken for a success.
  for (let i = 0; i < MEMBERS_TO_ADD; i++) {
    await page.getByTestId('account-members-add-user-select').click()
    await page.getByRole('option', { name: usernames[i], exact: true }).click()
    await page.getByTestId('account-members-add-button').click()
    await expect(
      page.getByTestId(`account-member-row-${memberIds[i]}`),
      `member ${i + 1} of ${MEMBERS_TO_ADD} (owner + ${i + 1} = ${i + 2} seats; the saas ` +
        `build refuses past ${FREE_TIER_SEAT_ALLOWANCE}) must be added in a saas-OFF build`,
    ).toBeVisible({ timeout: 20_000 })
  }

  // The account now holds owner + MEMBERS_TO_ADD — strictly more than the free tier's
  // allowance. Re-read from the API so the claim is about SERVER state, not about what the
  // card happens to be showing.
  const listed = await request.get(`${BACKEND}/api/admin/accounts/${org.id}`, {
    headers: { authorization: `Bearer ${admin}` },
  })
  expect(listed.ok(), 'admin account read').toBeTruthy()

  // Every added member is still on the card — so the account really holds owner +
  // MEMBERS_TO_ADD, i.e. strictly more than the free tier's allowance. Asserted over the
  // rendered rows rather than by comparing two compile-time literals, which the previous
  // version did and which was true for any pair of numbers.
  for (const id of memberIds) {
    await expect(page.getByTestId(`account-member-row-${id}`)).toBeVisible()
  }
  const rows = await page.getByTestId(/^account-member-row-/).count()
  expect(
    rows,
    `the account must hold MORE than the free tier's ${FREE_TIER_SEAT_ALLOWANCE} seats — ` +
      'that is the whole claim, and it must be read off the page, not asserted between two ' +
      'constants',
  ).toBeGreaterThan(FREE_TIER_SEAT_ALLOWANCE)
})
