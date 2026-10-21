// TEST-14 [covers ITEM-14] — the credits store loads the balance + ledger via the
// SaasApiClient, and its mutations (grant/revoke/setPremium) delegate + refetch.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ permOk: true }))
const api = vi.hoisted(() => ({
  getAccountCredits: vi.fn(),
  getAccountBilling: vi.fn(),
  grantAccountCredit: vi.fn(),
  revokeAccountCredit: vi.fn(),
  putAccountPremium: vi.fn(),
}))

vi.mock('@/core/permissions', () => ({ hasPermissionNow: () => h.permOk }))
vi.mock('@/api-client-saas/client', () => ({ SaasApiClient: { Admin: api } }))

const { CreditsGrants, useCreditsGrantsStore } = await import('./CreditsGrants.store')

const credits = { account_id: 'a1', balance_cents: 5000, grants: [] }

const billingState = {
  account_id: 'a1',
  plan_id: 'pro',
  subscription_status: 'active',
  suspended: false,
  premium: false,
  plan_manually_set: false,
  credit_balance_cents: 5000,
}

beforeEach(() => {
  h.permOk = true
  Object.values(api).forEach(f => f.mockReset())
  // load() now reads the billing state too (#39 premium read projection).
  api.getAccountBilling.mockResolvedValue(billingState)
  useCreditsGrantsStore.setState({
    accountId: null,
    credits: null,
    premium: false,
    premiumKnown: false,
    isInitialized: false,
    loading: false,
    error: null,
  } as never)
})

describe('TEST-14 — CreditsGrants store', () => {
  it('loads the credit balance + ledger', async () => {
    api.getAccountCredits.mockResolvedValue(credits)
    await CreditsGrants.load('a1')
    expect(api.getAccountCredits).toHaveBeenCalledWith({ account_id: 'a1' })
    expect(useCreditsGrantsStore.getState().credits).toEqual(credits)
    expect(useCreditsGrantsStore.getState().isInitialized).toBe(true)
  })

  // TEST-13 [acceptance][invariant: INV-3] — the premium comp is a READ projection: load()
  // reads it from getAccountBilling and marks it KNOWN, with NO setPremium mutation.
  it('reads premium from the billing GET on cold load (INV-3: read projection, not write-only)', async () => {
    api.getAccountCredits.mockResolvedValue(credits)
    api.getAccountBilling.mockResolvedValue({ ...billingState, premium: true })
    await CreditsGrants.load('a1')
    expect(api.getAccountBilling).toHaveBeenCalledWith({ account_id: 'a1' })
    expect(api.putAccountPremium).not.toHaveBeenCalled() // no mutation — purely a read
    expect(useCreditsGrantsStore.getState().premium).toBe(true)
    expect(useCreditsGrantsStore.getState().premiumKnown).toBe(true)
  })

  it('a premium:false read is a DEFINITE off (known), not "unknown"', async () => {
    api.getAccountCredits.mockResolvedValue(credits)
    api.getAccountBilling.mockResolvedValue({ ...billingState, premium: false })
    await CreditsGrants.load('a1')
    expect(useCreditsGrantsStore.getState().premium).toBe(false)
    expect(useCreditsGrantsStore.getState().premiumKnown).toBe(true)
  })

  it('clears the previous account credits + premium-known on an account switch', async () => {
    api.getAccountCredits.mockResolvedValue(credits)
    api.putAccountPremium.mockResolvedValue({ account_id: 'a1', premium: true })
    await CreditsGrants.load('a1')
    await CreditsGrants.setPremium('a1', true)
    expect(useCreditsGrantsStore.getState().premiumKnown).toBe(true)
    // Switch to a new account: a never-resolving load leaves the fields cleared,
    // not stuck on account a1's premium=true.
    api.getAccountCredits.mockReturnValue(new Promise(() => {}))
    void CreditsGrants.load('a2')
    const s = useCreditsGrantsStore.getState()
    expect(s.credits).toBeNull()
    expect(s.premiumKnown).toBe(false)
    expect(s.premium).toBe(false)
  })

  it('grant delegates with cents/reason/expiry and stores the refreshed ledger', async () => {
    useCreditsGrantsStore.setState({ accountId: 'a1' } as never)
    const updated = { account_id: 'a1', balance_cents: 6250, grants: [{ id: 'g1' }] }
    api.grantAccountCredit.mockResolvedValue(updated)
    await CreditsGrants.grant('a1', 1250, 'Comp', '2026-12-31T23:59:59Z')
    expect(api.grantAccountCredit).toHaveBeenCalledWith({
      account_id: 'a1',
      amount_cents: 1250,
      reason: 'Comp',
      expires_at: '2026-12-31T23:59:59Z',
    })
    expect(useCreditsGrantsStore.getState().credits).toEqual(updated)
  })

  it('revoke delegates and stores the refreshed ledger', async () => {
    api.revokeAccountCredit.mockResolvedValue(credits)
    await CreditsGrants.revoke('a1', 'g2')
    expect(api.revokeAccountCredit).toHaveBeenCalledWith({ account_id: 'a1', grant_id: 'g2' })
  })

  it('setPremium delegates and refetches the ledger', async () => {
    useCreditsGrantsStore.setState({ accountId: 'a1' } as never)
    api.putAccountPremium.mockResolvedValue({ account_id: 'a1', premium: true })
    api.getAccountCredits.mockResolvedValue(credits)
    // The post-mutation reload reads the now-applied comp from the billing GET.
    api.getAccountBilling.mockResolvedValue({ ...billingState, premium: true })
    await CreditsGrants.setPremium('a1', true, 'Partner')
    expect(api.putAccountPremium).toHaveBeenCalledWith({
      account_id: 'a1',
      premium: true,
      reason: 'Partner',
    })
    expect(useCreditsGrantsStore.getState().premium).toBe(true)
    expect(useCreditsGrantsStore.getState().premiumKnown).toBe(true)
    expect(api.getAccountCredits).toHaveBeenCalled() // refetched
  })

  it('skips the load when the permission is not held', async () => {
    h.permOk = false
    await CreditsGrants.load('a1')
    expect(api.getAccountCredits).not.toHaveBeenCalled()
  })

  it('a setPremium resolving after an account switch does NOT hijack the store back', async () => {
    // Operator has since switched to a2; the a1 mutation resolves late.
    useCreditsGrantsStore.setState({ accountId: 'a2' } as never)
    api.putAccountPremium.mockResolvedValue({ account_id: 'a1', premium: true })
    await CreditsGrants.setPremium('a1', true)
    // Neither the premium flag nor a reload for the abandoned a1 is applied.
    expect(useCreditsGrantsStore.getState().premiumKnown).toBe(false)
    expect(useCreditsGrantsStore.getState().accountId).toBe('a2')
    expect(api.getAccountCredits).not.toHaveBeenCalled()
  })
})
