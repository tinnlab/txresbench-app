import { ApiClient } from '@/api-client'
import type { Account } from '@/api-client/types'
import { Permissions } from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

/**
 * Account-context store for the account-detail page (#57) — the route param `:id`
 * is the single source of the focused account (it replaces the retired cross-page
 * `BillingSelection` picker). `load(accountId)` resolves the canonical `Account`
 * via `Admin.getAccount` (`GET /api/admin/accounts/{id}`) so a deep-link / refresh
 * to `/settings/accounts-admin/:id` works with NO list state.
 *
 * Mirrors `AdminAccounts.store.ts`: a `hasPermissionNow(admin::accounts)` read
 * guard, throw-after-set so a caller can toast, and `isInitialized:true` on error
 * so a cold-load effect guard doesn't re-fire forever.
 */
const AccountDetailDef = defineStore('AccountDetail', {
  state: {
    accountId: null as string | null,
    account: null as Account | null,
    isInitialized: false,
    loading: false,
    error: null as string | null,
  },
  actions: (set, get) => {
    const load = async (accountId: string) => {
      if (!hasPermissionNow(Permissions.AdminAccounts)) return
      // Switching accounts: clear the prior account so a stale name never flashes
      // under the new id while the fetch is in flight.
      const switching = get().accountId !== accountId
      try {
        set({
          accountId,
          loading: true,
          error: null,
          ...(switching ? { account: null, isInitialized: false } : {}),
        })
        const account = await ApiClient.Admin.getAccount({ account_id: accountId })
        // Stale guard: a slower load for a previous account must not clobber a
        // newer one.
        if (get().accountId !== accountId) return
        set({ account, isInitialized: true, loading: false })
      } catch (error) {
        if (get().accountId !== accountId) return
        set({
          error: error instanceof Error ? error.message : 'Failed to load the account',
          loading: false,
          isInitialized: true,
        })
        throw error
      }
    }

    return {
      load,
      clearError: () => set({ error: null }),
    }
  },
})

export const useAccountDetailStore = AccountDetailDef.store

/** The reactive store PROXY consumers import. */
export const AccountDetail = registerLazyStore(AccountDetailDef)
