import { ApiClient } from '@/api-client'
import type { AdminAccountSummary } from '@/api-client/types'
import { Permissions } from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

/**
 * A bounded account list over `Admin.listAccounts` (present in BOTH clients) —
 * a first page searched client-side (mirrors the CreateOrgDrawer owner Select over
 * the users list). Admin-scale; not a fetch-all of an unbounded set.
 *
 * Originally backed the Billing Console's account picker (retired in the #57 IA
 * refactor). Still consumed by the flags module's own account chooser store.
 * Gated `admin::accounts`.
 */
const PICKER_PAGE_SIZE = 100

const BillingAccountsDef = defineStore('BillingAccounts', {
  state: {
    accounts: [] as AdminAccountSummary[],
    total: 0,
    isInitialized: false,
    loading: false,
    error: null as string | null,
  },
  actions: set => ({
    loadAccounts: async () => {
      // The account list is admin::accounts-gated, but the console pages are gated on
      // billing::admin. A billing::admin holder who lacks admin::accounts must NOT be
      // left with a silently-inert picker — surface a clear, actionable state.
      if (!hasPermissionNow(Permissions.AdminAccounts)) {
        set({
          isInitialized: true,
          loading: false,
          error: 'Listing accounts requires the “admin::accounts” permission.',
        })
        return
      }
      try {
        set({ loading: true, error: null })
        const res = await ApiClient.Admin.listAccounts({
          page: 1,
          per_page: PICKER_PAGE_SIZE,
        })
        set({
          accounts: res.accounts,
          total: res.total,
          isInitialized: true,
          loading: false,
        })
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : 'Failed to load accounts',
          loading: false,
          isInitialized: true,
        })
        throw error
      }
    },
  }),
})

export const useBillingAccountsStore = BillingAccountsDef.store
export const BillingAccounts = registerLazyStore(BillingAccountsDef)
