import { SaasApiClient } from '@/api-client-saas/client'
import type {
  AdminBillingStateResponse,
  AdminAccountStatusResponse,
  AdminPlanOverrideResponse,
} from '@/api-client-saas/types'
import { hasPermissionNow } from '@/core/permissions'
import type { Permission } from '@/core/permissions/types'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

const BILLING_ADMIN = 'billing::admin' as Permission
const ADMIN_ACCOUNTS = 'admin::accounts' as Permission

/**
 * Subscription & Billing page store (#45). Loads the account's billing state
 * (`getAccountBilling`) + admin/suspend status (`getAccountStatus`) via the
 * `SaasApiClient` (the #50 invocation seam). Holds the plan-override marker
 * (`plan_manually_set`) ONLY when a set/clear mutation returned it — no GET exposes
 * it (DRIFT-1.1), so `planOverride` starts null and is not asserted on cold load.
 *
 * Mirrors `AdminAccounts.store.ts`: loading/error, isInitialized-on-error,
 * throw-after-set. Mutation methods are the thin targets the `billing.*`
 * defineActions delegate to.
 */
const BillingSubscriptionDef = defineStore('BillingSubscription', {
  state: {
    accountId: null as string | null,
    billing: null as AdminBillingStateResponse | null,
    status: null as AdminAccountStatusResponse | null,
    planOverride: null as AdminPlanOverrideResponse | null,
    isInitialized: false,
    loading: false,
    error: null as string | null,
  },
  actions: (set, get) => {
    const load = async (accountId: string) => {
      if (!hasPermissionNow(BILLING_ADMIN)) return
      const switching = get().accountId !== accountId
      try {
        // Clear the previous account's data on a switch so it never renders under
        // the newly-selected account while the new fetch is in flight.
        set({
          loading: true,
          error: null,
          accountId,
          ...(switching ? { billing: null, status: null, planOverride: null } : {}),
        })
        // Billing is billing::admin-gated (the page's own gate). Status is a SEPARATE
        // admin::accounts-gated read (AdminAccountScope): a billing::admin holder who
        // lacks admin::accounts still gets billing, so status is loaded best-effort —
        // its failure must NOT blank the whole page (the suspend/reactivate UI is
        // itself admin::accounts-gated, so an absent status is consistent).
        const billing = await SaasApiClient.Admin.getAccountBilling({ account_id: accountId })
        let status = null
        if (hasPermissionNow(ADMIN_ACCOUNTS)) {
          status = await SaasApiClient.Admin.getAccountStatus({ account_id: accountId }).catch(
            () => null,
          )
        }
        if (get().accountId !== accountId) return // stale: operator switched accounts
        set({ billing, status, isInitialized: true, loading: false })
      } catch (error) {
        if (get().accountId !== accountId) return // stale error for a since-abandoned account
        set({
          error: error instanceof Error ? error.message : 'Failed to load billing state',
          loading: false,
          isInitialized: true,
        })
        throw error
      }
    }
    return {
      load,
      setPlan: async (accountId: string, plan_id: string) => {
        const res = await SaasApiClient.Admin.setAccountPlan({ account_id: accountId, plan_id })
        // Only apply + reload if the operator is still on this account (a mutation
        // resolving after a switch must not hijack the store back).
        if (get().accountId === accountId) {
          set({ planOverride: res })
          await load(accountId)
        }
        return res
      },
      clearPlan: async (accountId: string) => {
        const res = await SaasApiClient.Admin.clearAccountPlan({ account_id: accountId })
        if (get().accountId === accountId) {
          set({ planOverride: res })
          await load(accountId)
        }
        return res
      },
      suspend: async (accountId: string, reason?: string) => {
        if (!hasPermissionNow(ADMIN_ACCOUNTS)) return undefined
        const res = await SaasApiClient.Admin.suspendAccount({
          account_id: accountId,
          ...(reason ? { reason } : {}),
        })
        if (get().accountId === accountId) await load(accountId)
        return res
      },
      reactivate: async (accountId: string) => {
        if (!hasPermissionNow(ADMIN_ACCOUNTS)) return undefined
        const res = await SaasApiClient.Admin.reactivateAccount({ account_id: accountId })
        if (get().accountId === accountId) await load(accountId)
        return res
      },
      clearError: () => set({ error: null }),
    }
  },
})

export const useBillingSubscriptionStore = BillingSubscriptionDef.store
export const BillingSubscription = registerLazyStore(BillingSubscriptionDef)
