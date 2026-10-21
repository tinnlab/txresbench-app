import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import {
  BACKEND,
  createMember,
  loginAsOwner,
  ownerToken,
} from '../project/_helpers'

// #44 + #57 — Accounts admin LIST + per-account DETAIL page. An admin lists ALL
// accounts (incl. an org they are NOT a member of), creates an organization (it
// appears), then opens an account's DETAIL page (`/settings/accounts-admin/:id`) to
// manage its members (add / change-role / remove). The last-owner guard is proven to
// surface gracefully (the sole owner's Remove is disabled; nothing crashes).
//
// Since the #57 IA refactor the members surface is an INLINE section on the detail
// page (not a drawer). Member LISTING is still membership-gated by the backend
// (`GET /accounts/{id}/members` 404s for a non-member), so the member-management
// flow operates on orgs the admin BELONGS to. The all-accounts list itself
// (`Admin.listAccounts`) is membership-free, so a non-member org still appears (INV-1).

/** Create an organization via the API (POST /api/accounts), optionally seeding
 *  its owner. */
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

/** The acting admin's own user id (GET /api/auth/me). */
async function adminId(request: APIRequestContext, token: string): Promise<string> {
  const r = await request.get(`${BACKEND}/api/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(r.ok(), 'auth/me').toBeTruthy()
  return (await r.json()).user.id
}

/** Open Settings ▸ Admin ▸ Accounts (the list). */
async function gotoAccountsAdmin(page: Page) {
  await page.goto('/settings')
  await expect(page.getByTestId('settings-nav-menu')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('settings-nav-menu-item-accounts-admin').click()
  await expect(page).toHaveURL(/\/settings\/accounts-admin$/)
  await expect(page.getByTestId('accounts-admin-page')).toBeVisible({ timeout: 30_000 })
}

/** From the list, open an account's DETAIL page via its "Manage" button, and wait
 *  for the detail page + its inline Members section. */
async function openDetail(page: Page, orgId: string) {
  await page.getByTestId(`account-manage-button-${orgId}`).click()
  await expect(page).toHaveURL(new RegExp(`/settings/accounts-admin/${orgId}$`))
  await expect(page.getByTestId('account-detail-page')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('account-detail-members-card')).toBeVisible({ timeout: 30_000 })
}

// [acceptance][invariant: INV-1] — the admin sees the Accounts page under Admin,
// lists ALL accounts including a non-member org, and creates an organization.
test('an admin lists all accounts (incl. a non-member org) and creates one', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const memberId = await createMember(request, admin, 'acctowner1')
  const stamp = Date.now()
  const nonMemberOrg = `NonMember Org ${stamp}`
  await createOrg(request, admin, nonMemberOrg, memberId)

  await loginAsOwner(page)
  await gotoAccountsAdmin(page)
  await expect(page.getByTestId('accounts-admin-card')).toBeVisible()

  await expect(
    page.getByTestId('accounts-admin-card').getByText(nonMemberOrg),
  ).toBeVisible({ timeout: 20_000 })

  const created = `Created Org ${stamp}`
  await page.getByTestId('account-create-open-button').click()
  await expect(page.getByTestId('account-create-form')).toBeVisible()
  await page.getByTestId('account-create-name-input').fill(created)
  await page.getByTestId('account-create-submit-button').click()
  await expect(
    page.getByTestId('accounts-admin-card').getByText(created),
  ).toBeVisible({ timeout: 20_000 })
})

// TEST-15 [covers ITEM-11, ITEM-16] — a list row's "Manage" button navigates to the
// account DETAIL page; the retired members-drawer flow is gone.
test('TEST-15: a row Manage button navigates to the account detail page', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const me = await adminId(request, admin)
  const stamp = Date.now()
  const org = await createOrg(request, admin, `Manage Org ${stamp}`, me)

  await loginAsOwner(page)
  await gotoAccountsAdmin(page)
  // The retired drawer trigger no longer exists.
  await expect(page.getByTestId(`account-members-button-${org.id}`)).toHaveCount(0)
  await openDetail(page, org.id)
  // The Overview section identifies the account.
  await expect(page.getByTestId('account-detail-overview-card')).toBeVisible()
})

// [acceptance][invariant: INV-3] — the admin manages an org's members (add → change
// role → remove) on the DETAIL page; every mutation drives a permissioned
// defineAction (`admin.account.*`), so the surface stays AI-drivable, not a bare
// human-only onClick.
test('an admin adds, re-roles, and removes an account member on the detail page', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const me = await adminId(request, admin)
  const member2Id = await createMember(request, admin, 'acctmember2')
  const stamp = Date.now()
  const org = await createOrg(request, admin, `Members Org ${stamp}`, me)

  await loginAsOwner(page)
  await gotoAccountsAdmin(page)
  await openDetail(page, org.id)

  await expect(page.getByTestId(`account-member-row-${me}`)).toBeVisible({ timeout: 20_000 })

  await page.getByTestId('account-members-add-user-select').click()
  await page.getByRole('option', { name: 'acctmember2', exact: true }).click()
  await page.getByTestId('account-members-add-button').click()
  await expect(page.getByTestId(`account-member-row-${member2Id}`)).toBeVisible({ timeout: 20_000 })

  await page.getByTestId(`account-member-role-select-${member2Id}`).click()
  await page.getByRole('option', { name: 'Admin', exact: true }).click()
  await expect(page.getByTestId(`account-member-role-select-${member2Id}`)).toContainText('Admin', {
    timeout: 20_000,
  })

  await page.getByTestId(`account-member-remove-button-${member2Id}`).click()
  await page.getByTestId(`account-member-remove-confirm-${member2Id}-confirm`).click()
  await expect(page.getByTestId(`account-member-row-${member2Id}`)).toHaveCount(0, { timeout: 20_000 })
})

// [acceptance][invariant: INV-3] — the last-owner guard surfaces gracefully: the
// sole owner's Remove control is disabled, the page stays mounted, and the owner
// remains — no crash / ErrorBoundary.
test('the sole owner cannot be removed and the detail page does not crash', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const me = await adminId(request, admin)
  const stamp = Date.now()
  const org = await createOrg(request, admin, `SoleOwner Org ${stamp}`, me)

  await loginAsOwner(page)
  await gotoAccountsAdmin(page)
  await openDetail(page, org.id)

  const ownerRemove = page.getByTestId(`account-member-remove-button-${me}`)
  await expect(ownerRemove).toBeVisible({ timeout: 20_000 })
  await expect(ownerRemove).toHaveAttribute('aria-disabled', 'true')

  await expect(page.getByTestId('account-detail-members-card')).toBeVisible()
  await expect(page.getByTestId(`account-member-row-${me}`)).toBeVisible()
  await expect(page.getByTestId('account-detail-page')).toBeVisible()
})

// [acceptance][invariant: INV-1] (#51) — a human name, never a UUID: the members
// section shows each member by username/display-name, and the owner field on the
// accounts list shows a name.
test('member rows and the owner field show human names, not UUIDs', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const me = await adminId(request, admin)
  const memberId = await createMember(request, admin, 'humanname1')
  const stamp = Date.now()
  const org = await createOrg(request, admin, `HumanName Org ${stamp}`, me)

  await loginAsOwner(page)
  await gotoAccountsAdmin(page)

  const ownerField = page.getByTestId(`account-owner-${org.id}`)
  await expect(ownerField).toBeVisible({ timeout: 20_000 })
  const ownerText = (await ownerField.innerText()).trim()
  expect(ownerText.length).toBeGreaterThan(0)
  expect(ownerText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)

  await openDetail(page, org.id)
  await page.getByTestId('account-members-add-user-select').click()
  await page.getByRole('option', { name: 'humanname1', exact: true }).click()
  await page.getByTestId('account-members-add-button').click()

  const nameField = page.getByTestId(`account-member-name-${memberId}`)
  await expect(nameField).toBeVisible({ timeout: 20_000 })
  await expect(nameField).toHaveText('humanname1')
  const cardText = await page.getByTestId('account-detail-members-card').innerText()
  expect(cardText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
})

// (#51) — the account nav reads "Accounts" (admin) and "My accounts" (personal):
// both present, distinct, non-ambiguous.
test('the account nav labels are "Accounts" (admin) and "My accounts" (personal), distinct', async ({
  page,
}) => {
  await loginAsOwner(page)
  await page.goto('/settings')
  await expect(page.getByTestId('settings-nav-menu')).toBeVisible({ timeout: 30_000 })

  const adminEntry = page.getByTestId('settings-nav-menu-item-accounts-admin')
  const personalEntry = page.getByTestId('settings-nav-menu-item-accounts')
  await expect(adminEntry).toBeVisible()
  await expect(personalEntry).toBeVisible()

  const adminLabel = (await adminEntry.innerText()).trim()
  const personalLabel = (await personalEntry.innerText()).trim()
  expect(adminLabel).toContain('Accounts')
  expect(adminLabel).not.toContain('All accounts')
  expect(personalLabel).toContain('My accounts')
  expect(adminLabel).not.toBe(personalLabel)
})

// [covers ITEM-13] (#51) — the populated members section is usable at 390px: no
// horizontal page overflow, and the role Select + Remove controls stay reachable.
test('the populated members section has no overflow and reachable controls at 390px', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const me = await adminId(request, admin)
  const memberId = await createMember(request, admin, 'responsive1')
  const stamp = Date.now()
  const org = await createOrg(request, admin, `Responsive Org ${stamp}`, me)

  await loginAsOwner(page)
  await gotoAccountsAdmin(page)
  await openDetail(page, org.id)
  await page.getByTestId('account-members-add-user-select').click()
  await page.getByRole('option', { name: 'responsive1', exact: true }).click()
  await page.getByTestId('account-members-add-button').click()
  await expect(page.getByTestId(`account-member-name-${memberId}`)).toBeVisible({ timeout: 20_000 })

  await page.setViewportSize({ width: 390, height: 780 })
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow, 'no horizontal page scroll at 390px').toBeLessThanOrEqual(1)
  await expect(page.getByTestId(`account-member-role-select-${memberId}`)).toBeVisible()
  await expect(page.getByTestId(`account-member-remove-button-${memberId}`)).toBeVisible()
})
