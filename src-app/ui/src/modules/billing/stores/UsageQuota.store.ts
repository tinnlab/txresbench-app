import { SaasApiClient } from '@/api-client-saas/client'
import type {
  AccountUsageResponse,
  QuotaStateResponse,
  UsageRollupRow,
} from '@/api-client-saas/types'
import { hasPermissionNow } from '@/core/permissions'
import type { Permission } from '@/core/permissions/types'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

const BILLING_ADMIN = 'billing::admin' as Permission

/**
 * Usage & Quota page store (#46). Loads the metered usage rollup (paginated) +
 * the quota state via the `SaasApiClient`. READ-ONLY — there is no mutation
 * endpoint for usage/quota, so this store has no mutation methods. Mirrors the
 * paging idiom of `AdminAccounts.store.ts`.
 */
const UsageQuotaDef = defineStore('UsageQuota', {
  state: {
    accountId: null as string | null,
    rows: [] as UsageRollupRow[],
    total: 0,
    currentPage: 1,
    pageSize: 20,
    quota: null as QuotaStateResponse | null,
    isInitialized: false,
    loading: false,
    error: null as string | null,
  },
  actions: (set, get) => {
    const load = async (accountId: string, page?: number, pageSize?: number) => {
      if (!hasPermissionNow(BILLING_ADMIN)) return
      const cur = get()
      const switching = accountId !== cur.accountId
      const requestPage = page ?? (switching ? 1 : cur.currentPage)
      const requestPageSize = pageSize ?? cur.pageSize
      try {
        set({
          loading: true,
          error: null,
          accountId,
          // Clear the previous account's usage/quota on a switch.
          ...(switching ? { rows: [], total: 0, quota: null } : {}),
        })
        const [usage, quota]: [AccountUsageResponse, QuotaStateResponse] = await Promise.all([
          SaasApiClient.Admin.getAccountUsage({
            account_id: accountId,
            page: requestPage,
            per_page: requestPageSize,
          }),
          SaasApiClient.Admin.getAccountQuota({ account_id: accountId }),
        ])
        if (get().accountId !== accountId) return
        set({
          rows: usage.rows,
          total: usage.total,
          currentPage: usage.page,
          pageSize: usage.per_page,
          quota,
          isInitialized: true,
          loading: false,
        })
      } catch (error) {
        if (get().accountId !== accountId) return // stale error for a since-abandoned account
        set({
          error: error instanceof Error ? error.message : 'Failed to load usage & quota',
          loading: false,
          isInitialized: true,
        })
        throw error
      }
    }
    return { load, clearError: () => set({ error: null }) }
  },
})

export const useUsageQuotaStore = UsageQuotaDef.store
export const UsageQuota = registerLazyStore(UsageQuotaDef)
