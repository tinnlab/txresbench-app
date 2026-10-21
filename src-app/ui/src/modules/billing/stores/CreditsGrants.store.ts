import { SaasApiClient } from '@/api-client-saas/client'
import type { CreditBalanceResponse } from '@/api-client-saas/types'
import { hasPermissionNow } from '@/core/permissions'
import type { Permission } from '@/core/permissions/types'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

const BILLING_ADMIN = 'billing::admin' as Permission

/**
 * Credits & Grants page store (#47). Loads the account's credit balance + FULL
 * grant ledger (including revoked/expired rows — INV-4) via the `SaasApiClient`,
 * and holds the premium-override state. Mutation methods (`grant`/`revoke`/
 * `setPremium`) are the thin targets the `billing.*` credit defineActions delegate
 * to; each refetches so the ledger + balance reflect the authoritative response.
 */
const CreditsGrantsDef = defineStore('CreditsGrants', {
  state: {
    accountId: null as string | null,
    credits: null as CreditBalanceResponse | null,
    // `premium` is read from the billing GET on load (#39 read projection —
    // `AdminBillingStateResponse.premium`), so `premiumKnown` becomes true after a cold
    // load, not only after a `setPremium` this session. It stays false ONLY before the
    // first successful load (genuinely unknown), so a pre-load render never presents a
    // fabricated definite `false`.
    premium: false,
    premiumKnown: false,
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
          ...(switching ? { credits: null, premium: false, premiumKnown: false } : {}),
        })
        // Load the balance + ledger AND the billing state in parallel. The billing GET
        // (#39) carries the `premium` read projection that `getAccountCredits` does not —
        // reading it here makes the premium comp a DEFINITE state on cold load (INV-3),
        // not a write-only value known only after a mutation. Both reads are billing::admin
        // (the page's own gate), so no new authorization surface.
        const [credits, billing] = await Promise.all([
          SaasApiClient.Admin.getAccountCredits({ account_id: accountId }),
          SaasApiClient.Admin.getAccountBilling({ account_id: accountId }),
        ])
        if (get().accountId !== accountId) return // stale: operator switched accounts
        set({
          credits,
          premium: billing.premium,
          premiumKnown: true,
          isInitialized: true,
          loading: false,
        })
      } catch (error) {
        if (get().accountId !== accountId) return // stale error for a since-abandoned account
        set({
          error: error instanceof Error ? error.message : 'Failed to load credits',
          loading: false,
          isInitialized: true,
        })
        throw error
      }
    }
    return {
      load,
      grant: async (
        accountId: string,
        amount_cents: number,
        reason: string,
        expires_at?: string,
      ) => {
        const res = await SaasApiClient.Admin.grantAccountCredit({
          account_id: accountId,
          amount_cents,
          reason,
          ...(expires_at ? { expires_at } : {}),
        })
        // Only apply if the operator is still on this account (a slow mutation must
        // not clobber a since-selected account's ledger).
        if (get().accountId === accountId) set({ credits: res })
        return res
      },
      revoke: async (accountId: string, grant_id: string) => {
        const res = await SaasApiClient.Admin.revokeAccountCredit({
          account_id: accountId,
          grant_id,
        })
        if (get().accountId === accountId) set({ credits: res })
        return res
      },
      setPremium: async (accountId: string, premium: boolean, reason?: string) => {
        const res = await SaasApiClient.Admin.putAccountPremium({
          account_id: accountId,
          premium,
          ...(reason ? { reason } : {}),
        })
        // premium is now KNOWN (the authoritative response) — but only if the
        // operator is still on this account; the reload is guarded the same way so a
        // mutation resolving after a switch does NOT hijack the store back.
        if (get().accountId === accountId) {
          set({ premium: res.premium, premiumKnown: true })
          await load(accountId)
        }
        return res
      },
      clearError: () => set({ error: null }),
    }
  },
})

export const useCreditsGrantsStore = CreditsGrantsDef.store
export const CreditsGrants = registerLazyStore(CreditsGrantsDef)
