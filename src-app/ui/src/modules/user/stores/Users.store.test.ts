// TEST-1 [covers ITEM-1] — loadUsers keeps the admin row shape (personal_account_id +
//   the saas billing sub-object) off the DEFAULT ApiClient.User.list.
// TEST-3 [covers ITEM-3] — the tier-comp methods delegate to SaasApiClient.Admin.* and
//   refetch the users list; both no-op without billing::admin.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ permOk: true }))
const saas = vi.hoisted(() => ({
  putAccountPremium: vi.fn(),
  grantAccountCredit: vi.fn(),
}))
const userApi = vi.hoisted(() => ({ list: vi.fn() }))

// hasPermissionNow gates both loadUsers (UsersRead) and the comp methods (billing::admin);
// the tests toggle a single boolean — good enough since both paths use the same guard fn.
vi.mock('@/core/permissions', () => ({ hasPermissionNow: () => h.permOk }))
vi.mock('@/core/permissions/types', () => ({}))
vi.mock('@/api-client-saas/client', () => ({ SaasApiClient: { Admin: saas } }))
vi.mock('@/api-client', () => ({ ApiClient: { User: userApi } }))
vi.mock('@/api-client/permissions', () => ({ Permissions: { UsersRead: 'users::read' } }))
vi.mock('@/core/sync/localEcho', () => ({ echoLocalSync: vi.fn() }))

const { Users, useUsersStore } = await import('./Users.store')

const page = (users: unknown[]) => ({ users, total: users.length, page: 1, per_page: 10 })
const seededRow = {
  id: 'u1',
  username: 'alovelace',
  display_name: 'Ada Lovelace',
  email: 'ada@acme.bio',
  is_active: true,
  is_admin: true,
  email_verified: true,
  permissions: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  personal_account_id: 'acct-1',
  billing: { premium: true, plan_id: 'enterprise', credit_balance_cents: 500000 },
}

beforeEach(() => {
  h.permOk = true
  Object.values(saas).forEach(f => f.mockReset())
  userApi.list.mockReset()
  useUsersStore.setState({
    users: [],
    total: 0,
    currentPage: 1,
    pageSize: 10,
    isInitialized: false,
    loading: false,
    error: null,
  } as never)
})

describe('TEST-1 — loadUsers keeps the admin row shape', () => {
  it('stores personal_account_id + the saas billing sub-object off the default list', async () => {
    userApi.list.mockResolvedValue(page([seededRow]))
    await Users.loadUsers(1, 10)
    const row = useUsersStore.getState().users[0] as typeof seededRow
    expect(row.personal_account_id).toBe('acct-1')
    expect(row.billing).toEqual({ premium: true, plan_id: 'enterprise', credit_balance_cents: 500000 })
  })
})

describe('TEST-3 — tier-comp methods delegate to SaasApiClient + refetch', () => {
  it('setPersonalAccountPremium calls putAccountPremium then reloads the list', async () => {
    saas.putAccountPremium.mockResolvedValue({ account_id: 'acct-1', premium: true })
    userApi.list.mockResolvedValue(page([seededRow]))
    await Users.setPersonalAccountPremium('acct-1', true, 'Partner')
    expect(saas.putAccountPremium).toHaveBeenCalledWith({
      account_id: 'acct-1',
      premium: true,
      reason: 'Partner',
    })
    expect(userApi.list).toHaveBeenCalled() // column refetch
  })

  it('grantPersonalAccountCredit calls grantAccountCredit then reloads the list', async () => {
    saas.grantAccountCredit.mockResolvedValue({ account_id: 'acct-1', balance_cents: 6250, grants: [] })
    userApi.list.mockResolvedValue(page([seededRow]))
    await Users.grantPersonalAccountCredit('acct-1', 1250, 'Comp', '2026-12-31T23:59:59Z')
    expect(saas.grantAccountCredit).toHaveBeenCalledWith({
      account_id: 'acct-1',
      amount_cents: 1250,
      reason: 'Comp',
      expires_at: '2026-12-31T23:59:59Z',
    })
    expect(userApi.list).toHaveBeenCalled()
  })

  it('both no-op when billing::admin is not held (no SaasApiClient call)', async () => {
    h.permOk = false
    await Users.setPersonalAccountPremium('acct-1', true)
    await Users.grantPersonalAccountCredit('acct-1', 1250, 'Comp')
    expect(saas.putAccountPremium).not.toHaveBeenCalled()
    expect(saas.grantAccountCredit).not.toHaveBeenCalled()
  })
})
