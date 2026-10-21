import { expect, test, type APIRequestContext } from '@playwright/test'
import {
  BACKEND,
  createMember,
  loginAsOwner,
  loginViaUi,
  MEMBER_PASSWORD,
  ownerToken,
  waitUntilOffLoginScreen,
} from '../project/_helpers'

// #57 — the account-detail page authz gate, proven end-to-end with a real restricted
// user + a positive control. The harness drives the DEFAULT (saas-OFF) build, so
// `billing::admin` is absent for EVERY user.

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

// TEST-12 [acceptance][invariant: INV-1][negative-perm][positive-control] — a user
// LACKING `admin::accounts` sees NO "Accounts" admin nav entry and a deep-link to the
// detail route never mounts the page — while their OWN settings still load (the
// positive control that makes "absent" mean GATED, not never-rendered).
test('TEST-12: a user without admin::accounts sees no Accounts nav and gets no detail page, but their own settings load', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  // An org exists (created by the admin) to deep-link at.
  const org = await createOrg(request, admin, `Restricted Target ${Date.now()}`)
  // A normal member: their app + settings load, but they hold no admin::accounts.
  await createMember(request, admin, 'noaccounts')

  await loginViaUi(page, 'noaccounts', MEMBER_PASSWORD)
  await waitUntilOffLoginScreen(page)

  // ── POSITIVE CONTROL: the user's own settings load (not blank/bounced) ──
  await page.goto('/settings/profile')
  await expect(page.getByTestId('profile-account-card')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('settings-nav-menu')).toBeVisible()

  // ── NEGATIVE: no Accounts (admin) nav entry at the slot layer ──
  await expect(page.getByTestId('settings-nav-menu-item-accounts-admin')).toHaveCount(0)

  // ── NEGATIVE: a direct deep-link to the detail route renders the in-place 403
  //    panel, and the detail page body never mounts ──
  await page.goto(`/settings/accounts-admin/${org.id}`)
  await expect(page.getByTestId('settings-forbidden-result')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('account-detail-page')).toHaveCount(0)
})

// TEST-13 [acceptance][invariant: INV-2][negative-perm][positive-control] — a user
// WITH `admin::accounts` but WITHOUT `billing::admin` (the root admin in this saas-OFF
// build) opens the detail page: Overview + Members render (positive control — the page
// LOADS populated) and the Subscription / Usage & Quota / Credits sections are ABSENT.
// This is INV-2's "even for a root admin" presence self-hide, proven end-to-end.
test('TEST-13: an admin without billing::admin loads the detail page with Overview + Members but NO billing widgets', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const me = await adminId(request, admin)
  const org = await createOrg(request, admin, `NoBilling Detail ${Date.now()}`, me)

  await loginAsOwner(page)
  await page.goto(`/settings/accounts-admin/${org.id}`)

  // ── POSITIVE CONTROL: the page LOADS populated ──
  await expect(page.getByTestId('account-detail-page')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('account-detail-overview-card')).toBeVisible()
  await expect(page.getByTestId('account-detail-members-card')).toBeVisible()
  await expect(page.getByTestId(`account-member-row-${me}`)).toBeVisible({ timeout: 20_000 })

  // ── NEGATIVE: the three billing widget sections are ABSENT (billing::admin not in
  // the build → presence self-hide, even for the root admin) ──
  await expect(page.getByTestId('billing-subscription-card')).toHaveCount(0)
  await expect(page.getByTestId('billing-quota-card')).toHaveCount(0)
  await expect(page.getByTestId('billing-credits-card')).toHaveCount(0)
})
