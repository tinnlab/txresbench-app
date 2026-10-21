import { expect, test } from '@playwright/test'
import {
  createRestrictedUser,
  loginViaUi,
  MEMBER_PASSWORD,
  ownerToken,
  waitUntilOffLoginScreen,
} from '../project/_helpers'
import { BACKEND } from '../_owner'

// draftable-entity — the A10 RESTRICTED-USER e2e (TEST-7, [negative-perm]
// [positive-control]). A user LACKING `drafts::use` is refused by EVERY /api/drafts
// route (the frontend-boundary deny), while a NON-drafts endpoint still answers 200
// for that same user (the positive control — the denial is the permission, not a
// broken account/app), and no draftable affordance renders in the shell.
//
// v1 ships NO draftable UI (ITEM-10/11 activation is descoped to the first consumer
// increment, DEC-9), so there is no domain draftable view to hide; this spec is the
// leaner RUNNABLE replacement for the removed fixture-view-dependent variant, and it
// pins the invariant that matters — the drafts primitive never leaks a UI surface or
// a route to an unpermitted user, and its permission gate genuinely refuses them.

test('a user without drafts::use is refused by every /api/drafts route; a non-drafts endpoint still loads 200 for them (positive control) — TEST-7', async ({
  browser,
  request,
}) => {
  const admin = await ownerToken(request)
  const uname = `draftrestrict${Date.now()}`
  await createRestrictedUser(request, admin, uname)

  // A project (as admin) to address the drafts routes against.
  const project = await (
    await request.post(`${BACKEND}/api/projects`, {
      headers: { authorization: `Bearer ${admin}` },
      data: { name: `Drafts restrict ${Date.now()}`, description: '' },
    })
  ).json()

  // The restricted user's token.
  const login = await request.post(`${BACKEND}/api/auth/login`, {
    data: { username: uname, password: MEMBER_PASSWORD },
  })
  const body = await login.json()
  const token: string = body.access_token ?? body.token
  const auth = { authorization: `Bearer ${token}` }

  // POSITIVE CONTROL — the account is valid and the API is reachable for THIS user:
  // an endpoint NOT gated by `drafts::use` answers 200. Without this control, the
  // "denied" assertions below would pass identically for a broken/never-created user.
  expect((await request.get(`${BACKEND}/api/auth/me`, { headers: auth })).status()).toBe(200)

  // Backend deny at the FE boundary (A9): every /api/drafts route 403s for the
  // unpermitted user — never the row, never a silent 200.
  expect(
    (await request.get(`${BACKEND}/api/drafts?project_id=${project.id}`, { headers: auth })).status(),
  ).toBe(403)
  expect(
    (
      await request.post(`${BACKEND}/api/drafts`, {
        headers: auth,
        data: { kind: 'test/widget', project_id: project.id, data: { n: 1 } },
      })
    ).status(),
  ).toBe(403)
  expect(
    (await request.post(`${BACKEND}/api/drafts/${crypto.randomUUID()}/freeze`, { headers: auth })).status(),
  ).toBe(403)

  // POSITIVE CONTROL (UI) + negative surface: the app LOADS for this restricted user
  // (off the login screen), and no draftable affordance is present anywhere in the
  // shell — an unpermitted user can never see a draftable UI (there is none in v1).
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await loginViaUi(page, uname, MEMBER_PASSWORD)
  await waitUntilOffLoginScreen(page)
  await page.goto('/projects')
  await expect(
    page.locator('[data-testid*="draftable"], [data-testid*="draft-editor"], [data-testid*="draft-view"]'),
  ).toHaveCount(0)
  await ctx.close()
})
