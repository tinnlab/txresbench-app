import { expect, test } from '@playwright/test'
import {
  BACKEND,
  createDatasetApi,
  createMember,
  createRestrictedUser,
  gotoDatasets,
  loginMemberToDatasets,
  loginViaUi,
  MEMBER_PASSWORD,
  ownerToken,
  shareDatasetApi,
  waitUntilOffLoginScreen,
} from './_helpers'

// TEST-42 [ITEM-1, ITEM-2] [negative-perm — A10, CRITICAL]. Two boundaries:
//   1. A user LACKING `projects::use` (created then stripped from the Users group)
//      is REFUSED — every dataset route 403s and the `/datasets` UI does not
//      render for them (the A10 restricted-user e2e the lifecycle requires).
//   2. A user WITH `projects::use` who is neither owner nor sharee cannot see
//      another user's dataset (absent from the library, detail route 404s); a
//      sharee (positive control) DOES see it. Real backend — no API mocking.
test('a non-owner/non-sharee cannot see a dataset; a stripped user is refused entirely — TEST-42', async ({
  browser,
  request,
}) => {
  const admin = await ownerToken(request)
  const ts = Date.now()

  // The owner's private dataset, a stripped user R, and a Users-group member M.
  const ds = await createDatasetApi(request, admin, `vis-${ts}`)
  const rname = `visrestrict${ts}`
  await createRestrictedUser(request, admin, rname)
  const mname = `vismember${ts}`
  const mId = await createMember(request, admin, mname)

  const tokenOf = (b: Record<string, unknown>) => (b.access_token ?? b.token) as string

  // --- (1) Backend deny for the stripped user: dataset routes 403. ---
  const rBody = await (
    await request.post(`${BACKEND}/api/auth/login`, {
      data: { username: rname, password: MEMBER_PASSWORD },
    })
  ).json()
  const rAuth = { authorization: `Bearer ${tokenOf(rBody)}` }
  expect((await request.get(`${BACKEND}/api/datasets`, { headers: rAuth })).status()).toBe(403)
  expect((await request.get(`${BACKEND}/api/datasets/shared`, { headers: rAuth })).status()).toBe(403)
  expect(
    (await request.get(`${BACKEND}/api/datasets/${ds.id}`, { headers: rAuth })).status(),
  ).toBe(403)

  // --- (1b) Restricted UI: `/datasets` does not render for the stripped user. ---
  const rctx = await browser.newContext()
  const rp = await rctx.newPage()
  await loginViaUi(rp, rname, MEMBER_PASSWORD)
  await waitUntilOffLoginScreen(rp)
  await rp.goto('/datasets')
  await expect(rp.getByTestId('datasets-page')).toHaveCount(0)
  await rctx.close()

  // --- (2) Non-owner/non-sharee member: the dataset is ABSENT + detail 404s. ---
  const mctx = await browser.newContext()
  const mp = await mctx.newPage()
  await loginMemberToDatasets(mp, mname, MEMBER_PASSWORD)
  await expect(mp.getByTestId('datasets-page')).toBeVisible()
  await expect(mp.getByTestId(`dataset-row-${ds.id}`)).toHaveCount(0) // not in Mine
  await mp.getByRole('tab', { name: /Shared with me/ }).click()
  await expect(mp.getByTestId(`dataset-row-${ds.id}`)).toHaveCount(0) // not in Shared
  // The detail route is permitted (member holds projects::use), but the dataset is
  // not visible → the get 404s → the detail page shows the error state (no leak).
  await mp.goto(`/datasets/${ds.id}`)
  await expect(mp.getByTestId('dataset-detail-error')).toBeVisible()

  // --- (2b) Positive control: once SHARED (view), the sharee sees it. ---
  await shareDatasetApi(request, admin, ds.id, mId, 'view')
  await gotoDatasets(mp)
  await mp.getByRole('tab', { name: /Shared with me/ }).click()
  await expect(mp.getByTestId(`dataset-row-${ds.id}`)).toBeVisible()
  await mctx.close()
})
