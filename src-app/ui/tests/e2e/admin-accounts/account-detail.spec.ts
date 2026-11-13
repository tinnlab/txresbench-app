import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { BACKEND, createMember, loginAsOwner, ownerToken } from '../_helpers'

// #57 — the account-detail page. These specs run under the DEFAULT (saas-OFF) build,
// so `billing::admin` is absent from the generated enum for EVERY user — the billing
// widget sections self-hide even for the root admin (INV-2's "even for a root admin"
// clause). Overview + Members (admin::accounts) always render.

async function createOrg(
  request: APIRequestContext,
  token: string,
  name: string,
  ownerId?: string,
): Promise<{ id: string }> {
  const r = await request.post(`${BACKEND}/api/accounts`, {
    headers: { authorization: `Bearer ${token}` },
    data: { name, ...(ownerId ? { owner_id: ownerId } : {}) },
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

async function gotoDetail(page: Page, orgId: string) {
  await page.goto(`/settings/accounts-admin/${orgId}`)
  await expect(page.getByTestId('account-detail-page')).toBeVisible({ timeout: 30_000 })
}

// TEST-11 [acceptance][invariant: INV-3] — every admin control on the detail page is
// a permissioned defineAction (AI-drivable), not a bare human-only onClick: adding a
// member drives `runAction('admin.account.addMember')` and the member appears. The
// billing widget sections are absent in this saas-OFF build (INV-2 self-hide).
test('TEST-11: detail-page member controls drive a permissioned action; billing widgets self-hide', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const me = await adminId(request, admin)
  const memberId = await createMember(request, admin, 'detailmember1')
  const stamp = Date.now()
  const org = await createOrg(request, admin, `Detail Org ${stamp}`, me)

  await loginAsOwner(page)
  await gotoDetail(page, org.id)

  // Overview + Members render (admin::accounts, always present).
  await expect(page.getByTestId('account-detail-overview-card')).toBeVisible()
  await expect(page.getByTestId('account-detail-members-card')).toBeVisible()
  await expect(page.getByTestId(`account-member-row-${me}`)).toBeVisible({ timeout: 20_000 })

  // The add-member control drives the registered `admin.account.addMember` action.
  await page.getByTestId('account-members-add-user-select').click()
  await page.getByRole('option', { name: 'detailmember1', exact: true }).click()
  await page.getByTestId('account-members-add-button').click()
  await expect(page.getByTestId(`account-member-row-${memberId}`)).toBeVisible({ timeout: 20_000 })

  // INV-2 (this saas-OFF build): the billing widget sections are ABSENT even for the
  // root admin (billing::admin is not in the generated enum).
  await expect(page.getByTestId('billing-subscription-card')).toHaveCount(0)
  await expect(page.getByTestId('billing-quota-card')).toHaveCount(0)
  await expect(page.getByTestId('billing-credits-card')).toHaveCount(0)
})

// TEST-16 [covers ITEM-12, ITEM-16] — the retired standalone billing routes no longer
// resolve to their pages, and no standalone billing nav entries appear in the Admin
// group; the settings shell still renders (the user is not thrown out).
test('TEST-16: the retired standalone billing routes + nav entries are gone', async ({
  page,
}) => {
  await loginAsOwner(page)

  await page.goto('/settings')
  await expect(page.getByTestId('settings-nav-menu')).toBeVisible({ timeout: 30_000 })
  // No standalone billing nav entries.
  await expect(page.getByTestId('settings-nav-menu-item-billing-subscription')).toHaveCount(0)
  await expect(page.getByTestId('settings-nav-menu-item-billing-usage')).toHaveCount(0)
  await expect(page.getByTestId('settings-nav-menu-item-billing-credits')).toHaveCount(0)

  // The retired page routes no longer resolve to a billing surface. Assert on the
  // View CARD testids (which STILL EXIST in the reused *View components) — so if the
  // old route somehow still mounted a billing surface, the card WOULD appear and this
  // would fail (a meaningful, non-tautological check; the *-page wrapper testids were
  // deleted with the pages and would pass vacuously).
  for (const path of ['/settings/billing-subscription', '/settings/billing-usage', '/settings/billing-credits']) {
    await page.goto(path)
    // The settings shell still renders (the user is not thrown out).
    await expect(page.getByTestId('settings-nav-menu')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('billing-subscription-card')).toHaveCount(0)
    await expect(page.getByTestId('billing-quota-card')).toHaveCount(0)
    await expect(page.getByTestId('billing-credits-card')).toHaveCount(0)
  }
})
