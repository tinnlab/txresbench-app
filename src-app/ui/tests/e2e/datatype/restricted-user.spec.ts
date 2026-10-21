import { expect, test } from '@playwright/test'
import {
  createRestrictedUser,
  loginViaUi,
  MEMBER_PASSWORD,
  ownerToken,
  waitUntilOffLoginScreen,
} from '../project/_helpers'

// The backend base for API-request helpers. Imported from `_owner`, which derives it from
// `E2E_BACKEND` — the value `playwright.config.ts` assigns from the port it RESOLVED for this
// run. There is deliberately no `?? 'http://127.0.0.1:3155'` fallback any more: a committed
// default is only correct while every run uses the same port, and the moment ports became
// per-worktree it would have aimed these helpers at whatever else happened to be on :3155.
import { BACKEND } from '../_owner'

test('a user without projects::use is refused by every datatype route + UI — TEST-32', async ({
  browser,
  request,
}) => {
  const admin = await ownerToken(request)
  const uname = `dtrestrict${Date.now()}`
  await createRestrictedUser(request, admin, uname)

  const project = await (
    await request.post(`${BACKEND}/api/projects`, {
      headers: { authorization: `Bearer ${admin}` },
      data: { name: `DT restrict ${Date.now()}`, description: '' },
    })
  ).json()

  // The restricted user's token.
  const login = await request.post(`${BACKEND}/api/auth/login`, {
    data: { username: uname, password: MEMBER_PASSWORD },
  })
  const body = await login.json()
  const token: string = body.access_token ?? body.token
  const auth = { authorization: `Bearer ${token}` }

  // Backend deny (A9 at the FE boundary): every new route 403s.
  expect((await request.get(`${BACKEND}/api/datatypes`, { headers: auth })).status()).toBe(403)
  expect(
    (await request.get(`${BACKEND}/api/projects/${project.id}/artifacts`, { headers: auth })).status(),
  ).toBe(403)
  expect(
    (
      await request.get(`${BACKEND}/api/artifacts/${project.id}/catalog`, { headers: auth })
    ).status(),
  ).toBe(403)
  const sniff = await request.post(`${BACKEND}/api/datatypes/sniff`, {
    headers: auth,
    multipart: { file: { name: 'x.csv', mimeType: 'text/csv', buffer: Buffer.from('a\n1') } },
  })
  expect(sniff.status()).toBe(403)

  // UI: the datatype-consuming project surfaces do not render for this user, and the
  // FE registry never gets the authoritative (viewers-bearing) populate — only the
  // non-sensitive bootstrap skeleton (viewers empty).
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await loginViaUi(page, uname, MEMBER_PASSWORD)
  await waitUntilOffLoginScreen(page)

  await page.goto('/projects')
  await expect(page.getByTestId('projects-page')).toHaveCount(0)

  // The registry populate 403'd → the bootstrap has no viewers (no API data leaked).
  const viewers = await page.evaluate(() => {
    const r = (window as unknown as {
      __datatypeRegistry?: { viewersFor: (d: string) => unknown[] }
    }).__datatypeRegistry
    return r ? r.viewersFor('single-cell/expression').length : -1
  })
  expect(viewers).toBe(0)

  await ctx.close()
})
