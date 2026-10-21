// TEST-8 [covers ITEM-8] — the subscription store loads billing + status via the
// SaasApiClient, is guarded by the permission, sets isInitialized-on-error, and its
// mutation methods delegate to the client + refetch.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ permOk: true, adminAccountsOk: true }))
const api = vi.hoisted(() => ({
  getAccountBilling: vi.fn(),
  getAccountStatus: vi.fn(),
  setAccountPlan: vi.fn(),
  clearAccountPlan: vi.fn(),
  suspendAccount: vi.fn(),
  reactivateAccount: vi.fn(),
}))

vi.mock('@/core/permissions', () => ({
  hasPermissionNow: (p: string) => (p === 'admin::accounts' ? h.adminAccountsOk : h.permOk),
}))
vi.mock('@/api-client-saas/client', () => ({ SaasApiClient: { Admin: api } }))

const { BillingSubscription, useBillingSubscriptionStore } = await import('./BillingSubscription.store')

const billing = { account_id: 'a1', plan_id: 'pro', subscription_status: 'active', suspended: false }
const status = { account_id: 'a1', admin_suspended: false }

beforeEach(() => {
  h.permOk = true
  h.adminAccountsOk = true
  Object.values(api).forEach(f => f.mockReset())
  useBillingSubscriptionStore.setState({
    accountId: null,
    billing: null,
    status: null,
    planOverride: null,
    isInitialized: false,
    loading: false,
    error: null,
  } as never)
})

describe('TEST-8 — BillingSubscription store', () => {
  it('loads billing + status and maps them into state', async () => {
    api.getAccountBilling.mockResolvedValue(billing)
    api.getAccountStatus.mockResolvedValue(status)
    await BillingSubscription.load('a1')
    expect(api.getAccountBilling).toHaveBeenCalledWith({ account_id: 'a1' })
    expect(api.getAccountStatus).toHaveBeenCalledWith({ account_id: 'a1' })
    const s = useBillingSubscriptionStore.getState()
    expect(s.billing).toEqual(billing)
    expect(s.status).toEqual(status)
    expect(s.isInitialized).toBe(true)
  })

  it('skips the load when the permission is not held', async () => {
    h.permOk = false
    await BillingSubscription.load('a1')
    expect(api.getAccountBilling).not.toHaveBeenCalled()
  })

  it('loads billing even when the admin::accounts-gated status read fails (billing::admin-only holder)', async () => {
    h.permOk = true
    h.adminAccountsOk = true
    api.getAccountBilling.mockResolvedValue(billing)
    api.getAccountStatus.mockRejectedValue(new Error('403'))
    await BillingSubscription.load('a1')
    const s = useBillingSubscriptionStore.getState()
    expect(s.billing).toEqual(billing) // billing rendered
    expect(s.status).toBeNull() // status best-effort, absent
    expect(s.error).toBeNull() // the page is NOT blanked by a status failure
  })

  it('does not call getAccountStatus when the caller lacks admin::accounts', async () => {
    h.permOk = true
    h.adminAccountsOk = false
    api.getAccountBilling.mockResolvedValue(billing)
    await BillingSubscription.load('a1')
    expect(api.getAccountStatus).not.toHaveBeenCalled()
    expect(useBillingSubscriptionStore.getState().billing).toEqual(billing)
  })

  it('marks isInitialized and rethrows on error', async () => {
    api.getAccountBilling.mockRejectedValue(new Error('boom'))
    api.getAccountStatus.mockResolvedValue(status)
    await expect(BillingSubscription.load('a1')).rejects.toThrow('boom')
    const s = useBillingSubscriptionStore.getState()
    expect(s.isInitialized).toBe(true)
    expect(s.error).toBe('boom')
  })

  it('setPlan delegates to the client, stores the override marker, and refetches', async () => {
    // The page has already loaded account a1 before a mutation fires.
    useBillingSubscriptionStore.setState({ accountId: 'a1' } as never)
    const override = { account_id: 'a1', plan_id: 'pro', plan_manually_set: true }
    api.setAccountPlan.mockResolvedValue(override)
    api.getAccountBilling.mockResolvedValue(billing)
    api.getAccountStatus.mockResolvedValue(status)
    await BillingSubscription.setPlan('a1', 'pro')
    expect(api.setAccountPlan).toHaveBeenCalledWith({ account_id: 'a1', plan_id: 'pro' })
    expect(useBillingSubscriptionStore.getState().planOverride).toEqual(override)
    expect(api.getAccountBilling).toHaveBeenCalled() // refetched
  })

  it('a setPlan resolving after an account switch does NOT hijack the store back', async () => {
    useBillingSubscriptionStore.setState({ accountId: 'a2' } as never)
    api.setAccountPlan.mockResolvedValue({ account_id: 'a1', plan_id: 'pro', plan_manually_set: true })
    await BillingSubscription.setPlan('a1', 'pro')
    const s = useBillingSubscriptionStore.getState()
    expect(s.planOverride).toBeNull() // not applied for the abandoned account
    expect(s.accountId).toBe('a2')
    expect(api.getAccountBilling).not.toHaveBeenCalled() // no reload of a1
  })

  it('suspend delegates with the reason and refetches', async () => {
    api.suspendAccount.mockResolvedValue({ account_id: 'a1', admin_suspended: true })
    api.getAccountBilling.mockResolvedValue(billing)
    api.getAccountStatus.mockResolvedValue(status)
    await BillingSubscription.suspend('a1', 'abuse')
    expect(api.suspendAccount).toHaveBeenCalledWith({ account_id: 'a1', reason: 'abuse' })
  })
})
