// TEST-1 [covers ITEM-1] — the SaasApiClient exposes the saas-only endpoints that
// the default ApiClient does NOT, locking the #50 invocation seam (which wired
// presence gating but left the runtime client built from the default endpoint map).

import { describe, expect, it } from 'vitest'
import { SaasApiClient } from './client'
import { ApiClient } from '@/api-client'

describe('TEST-1 — SaasApiClient invocation seam', () => {
  it('exposes the saas-only billing/credit/quota admin methods', () => {
    expect(typeof SaasApiClient.Admin.getAccountBilling).toBe('function')
    expect(typeof SaasApiClient.Admin.getAccountQuota).toBe('function')
    expect(typeof SaasApiClient.Admin.getAccountCredits).toBe('function')
    expect(typeof SaasApiClient.Admin.grantAccountCredit).toBe('function')
    expect(typeof SaasApiClient.Admin.setAccountPlan).toBe('function')
    expect(typeof SaasApiClient.Admin.putAccountPremium).toBe('function')
    expect(typeof SaasApiClient.Billing.getCatalog).toBe('function')
  })

  it('the default ApiClient does NOT carry the saas-only endpoints (why the seam is needed)', () => {
    const admin = ApiClient.Admin as unknown as Record<string, unknown>
    expect(admin.grantAccountCredit).toBeUndefined()
    expect(admin.getAccountBilling).toBeUndefined()
    expect(admin.putAccountPremium).toBeUndefined()
  })

  it('still shares the endpoints present in BOTH clients (listAccounts)', () => {
    expect(typeof SaasApiClient.Admin.listAccounts).toBe('function')
    expect(typeof ApiClient.Admin.listAccounts).toBe('function')
  })
})
