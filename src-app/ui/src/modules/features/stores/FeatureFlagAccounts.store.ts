import { ApiClient } from '@/api-client'
import type { AdminAccountSummary } from '@/api-client/types'
import { Permissions } from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

/** The bounded first page fetched for the account PICKER — searched client-side. */
const PICKER_PAGE_SIZE = 100

/**
 * The account list backing the Feature-Flags page's per-account picker (#53). A
 * dedicated, bounded, searchable list over `Admin.listAccounts` — mirrors
 * `billing/stores/BillingAccounts.store.ts` (a picker store distinct from the paged
 * `AdminAccounts` admin table), guarded by `hasPermissionNow(Permissions.AdminAccounts)`
 * so a caller without `admin::accounts` never fetches. Options render the account's
 * human label (name + owner), NEVER the raw UUID (the usability hard-rule).
 */
const FeatureFlagAccountsDef = defineStore('FeatureFlagAccounts', {
  state: {
    accounts: [] as AdminAccountSummary[],
    isInitialized: false,
    loading: false,
    error: null as string | null,
  },
  actions: set => {
    const loadAccounts = async () => {
      // Read-guard: without `admin::accounts` the list call would 403 — skip it (the
      // picker renders empty). `features::manage` is admin-only-via-`*`, so a root
      // admin holds both; a narrowly-delegated user simply sees no accounts to pick.
      if (!hasPermissionNow(Permissions.AdminAccounts)) return
      try {
        set({ loading: true, error: null })
        const res = await ApiClient.Admin.listAccounts({ page: 1, per_page: PICKER_PAGE_SIZE })
        set({ accounts: res.accounts, isInitialized: true, loading: false })
      } catch (error) {
        // Mark initialized even on failure so the page's cold-load guard
        // (`!isInitialized && !loading`) can't re-fire forever (mirrors AdminAccounts).
        set({
          error: error instanceof Error ? error.message : 'Failed to load accounts',
          loading: false,
          isInitialized: true,
        })
        throw error
      }
    }

    return { loadAccounts }
  },
})

export const useFeatureFlagAccountsStore = FeatureFlagAccountsDef.store

/** The reactive store proxy consumers import. */
export const FeatureFlagAccounts = registerLazyStore(FeatureFlagAccountsDef)

/** The human label for an account option — name (+ owner), never the raw UUID. */
export function featureFlagAccountLabel(s: AdminAccountSummary): string {
  return s.owner_label ? `${s.account.name} — ${s.owner_label}` : s.account.name
}
