import { ApiClient } from '@/api-client'
import { type FeatureFlagView } from '@/api-client/types'
import { Permissions } from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { defineStore, registerLazyStore } from '@txresbench/framework/store-kit'

/**
 * Admin feature-flags store (the runtime feature-flags subsystem, #40 listing, #48
 * global toggle, #53 per-account overrides + clear). It holds two slices: the GLOBAL
 * flag list (`flags` + `setGlobal`) and the PER-ACCOUNT section (`accountFlags` for
 * the `selectedAccountId`, + `setAccount`/`clearAccount`). Clearing a per-account
 * override reverts the account to inheriting the global/compiled default (#53). The
 * global load is self-gated, mirroring `JobSettings.store.ts`.
 */
const FeatureFlagsDef = defineStore('FeatureFlags', {
  immer: true,
  state: {
    flags: [] as FeatureFlagView[],
    loading: false,
    error: null as string | null,
    // flag_key -> true while its GLOBAL toggle is in flight (#48). The row's
    // Switch is disabled for a pending key so a double-click can't double-fire.
    pending: {} as Record<string, boolean>,

    // --- per-account overrides (#53) --------------------------------------
    // The account currently selected in the per-account section (null = none
    // picked). The per-account flag rows are resolved FOR this account.
    selectedAccountId: null as string | null,
    // Every known flag resolved for `selectedAccountId`: `account_enabled`
    // non-null ⇒ this account has an OVERRIDE; null ⇒ it INHERITS the
    // global/compiled default. `effective` is the account's resolved value.
    accountFlags: [] as FeatureFlagView[],
    accountLoading: false,
    accountError: null as string | null,
    // flag_key -> true while THIS account's per-account set/clear is in flight.
    accountPending: {} as Record<string, boolean>,
  },
  actions: set => {
    const load = async () => {
      set(s => {
        s.loading = true
        s.error = null
      })
      try {
        const res = await ApiClient.Features.list({})
        set(s => {
          s.flags = res.flags
          s.loading = false
        })
      } catch (e) {
        set(s => {
          s.error = e instanceof Error ? e.message : 'Failed to load feature flags'
          s.loading = false
        })
      }
    }

    // Set a flag's GLOBAL default (#48). No `account_id` → the global row
    // (`PUT /api/admin/features/{flag_key}` with `account_id = None`). Replaces
    // the row with the server-RESOLVED `FeatureFlagView` the PUT returns (DEC-2,
    // authoritative — no optimistic local flip), and surfaces failure by setting
    // `error` + rethrowing so the caller (the `features.setGlobalFlag` action)
    // can toast. Mirrors `AdminAccounts` act-then-use-response.
    const setGlobal = async (flag_key: string, enabled: boolean) => {
      set(s => {
        s.pending[flag_key] = true
        s.error = null
      })
      try {
        const updated = await ApiClient.Features.set({ flag_key, enabled })
        set(s => {
          const i = s.flags.findIndex(f => f.flag_key === flag_key)
          if (i !== -1) s.flags[i] = updated
          delete s.pending[flag_key]
        })
        return updated
      } catch (e) {
        set(s => {
          s.error = e instanceof Error ? e.message : 'Failed to update feature flag'
          delete s.pending[flag_key]
        })
        throw e
      }
    }

    // Load every flag RESOLVED for one account (`GET /api/admin/features?account_id=`)
    // so the per-account section can show each flag's inherited-vs-overridden state
    // (#53). Mirrors `load` but fills the per-account slice.
    const loadForAccount = async (account_id: string) => {
      set(s => {
        s.accountLoading = true
        s.accountError = null
      })
      try {
        const res = await ApiClient.Features.list({ account_id })
        set(s => {
          // Staleness guard: if the user switched accounts while this load was in
          // flight, drop the result — writing it would show this account's rows under
          // the newly-selected account (the audit's stale-snapshot finding).
          if (s.selectedAccountId !== account_id) return
          s.accountFlags = res.flags
          s.accountLoading = false
        })
      } catch (e) {
        set(s => {
          if (s.selectedAccountId !== account_id) return
          s.accountError =
            e instanceof Error ? e.message : 'Failed to load per-account overrides'
          s.accountLoading = false
        })
      }
    }

    // Select an account for the per-account section and load its resolved flags. Any
    // switch (to another account OR to null) CLEARS the prior account's rows first, so
    // the section shows its loading spinner — never the previous account's overrides
    // attributed to the newly-picked one.
    const selectAccount = async (account_id: string | null) => {
      set(s => {
        s.selectedAccountId = account_id
        s.accountError = null
        s.accountFlags = []
        s.accountLoading = account_id != null
      })
      if (account_id != null) await loadForAccount(account_id)
    }

    // Set (upsert) a PER-ACCOUNT override (#53) — `PUT` WITH `account_id`. Replaces the
    // row in `accountFlags` with the server-RESOLVED view (authoritative), so an
    // overridden row immediately shows `account_enabled` set + the resolved `effective`.
    // Does NOT touch the global `flags` list. Throw-after-set so the action can toast.
    const setAccount = async (
      flag_key: string,
      account_id: string,
      enabled: boolean,
    ) => {
      set(s => {
        s.accountPending[flag_key] = true
        s.accountError = null
      })
      try {
        const updated = await ApiClient.Features.set({ flag_key, account_id, enabled })
        set(s => {
          delete s.accountPending[flag_key]
          // Staleness guard: only write the row if this account is still selected —
          // a mutation that resolves after the user switched must not land in another
          // account's list.
          if (s.selectedAccountId !== account_id) return
          const i = s.accountFlags.findIndex(f => f.flag_key === flag_key)
          if (i !== -1) s.accountFlags[i] = updated
        })
        return updated
      } catch (e) {
        set(s => {
          s.accountError =
            e instanceof Error ? e.message : 'Failed to set per-account override'
          delete s.accountPending[flag_key]
        })
        throw e
      }
    }

    // Clear (DELETE) a PER-ACCOUNT override (#53) so the account reverts to inheriting
    // the global/compiled default. Replaces the row with the server-resolved
    // now-inherited view (`account_enabled` null, `effective` = global/compiled), so the
    // UI immediately reflects the revert. Throw-after-set so the action can toast.
    const clearAccount = async (flag_key: string, account_id: string) => {
      set(s => {
        s.accountPending[flag_key] = true
        s.accountError = null
      })
      try {
        const updated = await ApiClient.Features.clear({ flag_key, account_id })
        set(s => {
          delete s.accountPending[flag_key]
          // Staleness guard (see setAccount): only write if this account is still selected.
          if (s.selectedAccountId !== account_id) return
          const i = s.accountFlags.findIndex(f => f.flag_key === flag_key)
          if (i !== -1) s.accountFlags[i] = updated
        })
        return updated
      } catch (e) {
        set(s => {
          s.accountError =
            e instanceof Error ? e.message : 'Failed to clear per-account override'
          delete s.accountPending[flag_key]
        })
        throw e
      }
    }

    return { load, setGlobal, loadForAccount, selectAccount, setAccount, clearAccount }
  },
  init: ({ on, actions }) => {
    const reload = () => {
      if (!hasPermissionNow(Permissions.FeaturesManage)) return
      void actions.load()
    }
    on('sync:reconnect', reload)
    if (hasPermissionNow(Permissions.FeaturesManage)) void actions.load()
  },
})

export const useFeatureFlagsStore = FeatureFlagsDef.store

/** The reactive store proxy — the direct handle consumers import. */
export const FeatureFlags = registerLazyStore(FeatureFlagsDef)
