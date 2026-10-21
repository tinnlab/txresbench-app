// TEST-12 [covers ITEM-12] — the usage/quota store loads the paginated rollup +
// quota via the SaasApiClient with the paging params, and is permission-guarded.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ permOk: true }))
const api = vi.hoisted(() => ({ getAccountUsage: vi.fn(), getAccountQuota: vi.fn() }))

vi.mock('@/core/permissions', () => ({ hasPermissionNow: () => h.permOk }))
vi.mock('@/api-client-saas/client', () => ({ SaasApiClient: { Admin: api } }))

const { UsageQuota, useUsageQuotaStore } = await import('./UsageQuota.store')

const usage = {
  page: 2,
  per_page: 10,
  total: 25,
  total_pages: 3,
  rows: [{ id: 'u1', account_id: 'a1' }],
}
const quota = { plan_id: 'pro', compute_allowance: 1000, compute_used: 100 }

beforeEach(() => {
  h.permOk = true
  Object.values(api).forEach(f => f.mockReset())
  useUsageQuotaStore.setState({
    accountId: null,
    rows: [],
    total: 0,
    currentPage: 1,
    pageSize: 20,
    quota: null,
    isInitialized: false,
    loading: false,
    error: null,
  } as never)
})

describe('TEST-12 — UsageQuota store', () => {
  it('loads usage (paged) + quota and maps them', async () => {
    api.getAccountUsage.mockResolvedValue(usage)
    api.getAccountQuota.mockResolvedValue(quota)
    await UsageQuota.load('a1', 2, 10)
    expect(api.getAccountUsage).toHaveBeenCalledWith({ account_id: 'a1', page: 2, per_page: 10 })
    expect(api.getAccountQuota).toHaveBeenCalledWith({ account_id: 'a1' })
    const s = useUsageQuotaStore.getState()
    expect(s.rows.length).toBe(1)
    expect(s.total).toBe(25)
    expect(s.currentPage).toBe(2)
    expect(s.quota).toEqual(quota)
  })

  it('skips when the permission is not held', async () => {
    h.permOk = false
    await UsageQuota.load('a1', 1)
    expect(api.getAccountUsage).not.toHaveBeenCalled()
  })

  it('marks isInitialized and rethrows on error', async () => {
    api.getAccountUsage.mockRejectedValue(new Error('down'))
    api.getAccountQuota.mockResolvedValue(quota)
    await expect(UsageQuota.load('a1', 1)).rejects.toThrow('down')
    expect(useUsageQuotaStore.getState().isInitialized).toBe(true)
  })
})
