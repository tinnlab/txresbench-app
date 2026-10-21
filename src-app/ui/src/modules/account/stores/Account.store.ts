import { ApiClient } from '@/api-client'
import { type Account as AccountModel } from '@/api-client/types'
import { Permissions } from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'
import { EventBus } from '@ziee/framework/stores'
import { setAccountId } from '@/core/sync/accountId'

/** localStorage key for the persisted active-account preference (DEC-3). Re-validated
 *  against the live `list_user_accounts` on every load, so a stale id (an account the
 *  user was removed from, or another user's saved id — the account list is user-scoped)
 *  falls back to the personal account rather than stranding. A single key is safe
 *  BECAUSE of that re-validation: an id not belonging to the current user is not in
 *  their `accounts`, so it is discarded. The server 404s a stale header regardless
 *  (INV-3), so this is the friendliness layer, not the security layer. */
const STORAGE_KEY = 'cyto.activeAccountId'

const readPref = (): string | null => {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}
const writePref = (id: string | null): void => {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // storage unavailable (private mode / SSR) — the preference is best-effort.
  }
}

/** The personal account is the INV-1 default (its `kind === 'personal'`). */
const personalIdOf = (accounts: AccountModel[]): string | null =>
  accounts.find(a => a.kind === 'personal')?.id ?? accounts[0]?.id ?? null

/** Stamp (or clear) the `X-Account-Id` request header for the chosen active account.
 *  The personal account is the server default, so it rides header-FREE (INV-1/INV-4:
 *  a default/solo request sends no header); an org account stamps its id. */
const applyHeader = (id: string | null, accounts: AccountModel[]): void => {
  const acct = accounts.find(a => a.id === id)
  setAccountId(acct && acct.kind !== 'personal' ? id : null)
}

/**
 * The `Accounts` client store (A4 ITEM-4) — the account switcher list + the active
 * account the user is acting under. Self-gated on `account::read` (the perm
 * `GET /api/accounts` enforces — the no-403-on-reconnect rule); `sync:account` /
 * `sync:account_member` / `sync:reconnect` refresh it live. Mirrors `Datasets.store`.
 */
const AccountDef = defineStore('Account', {
  state: {
    /** Every account the user is a member of (personal + any orgs) — the switcher list. */
    accounts: [] as AccountModel[],
    /** The account the user is currently acting under (personal by default; INV-1). */
    activeAccountId: null as string | null,
    loading: false,
    error: null as string | null,
    isInitialized: false,
  },
  actions: (set, get) => {
    const load = async () => {
      // Self-gate: a user lacking `account::read` never fetches (no 403 storm on
      // reconnect; the switcher/settings are hidden by the slot/route gates anyway).
      if (!hasPermissionNow(Permissions.AccountRead)) return
      set({ loading: true, error: null })
      try {
        const res = await ApiClient.Account.list()
        const accounts = res.accounts
        // Default-active resolution (INV-1 / DEC-3): honor the persisted preference
        // IFF it is still a live membership, else fall back to the personal account.
        const pref = readPref()
        const active =
          pref && accounts.some(a => a.id === pref) ? pref : personalIdOf(accounts)
        applyHeader(active, accounts)
        set({ accounts, activeAccountId: active, loading: false, isInitialized: true })
      } catch (error) {
        set({
          loading: false,
          isInitialized: true,
          error: error instanceof Error ? error.message : 'Failed to load accounts',
        })
      }
    }

    /** Switch the active account (client-header op — DEC-2; no server mutation). Sets
     *  the header + persists the choice, then triggers every account-scoped list to
     *  refetch into the new scope (a sync-reconnect-style refresh). */
    const setActiveAccount = (id: string) => {
      const { accounts } = get()
      if (!accounts.some(a => a.id === id)) return
      applyHeader(id, accounts)
      writePref(id)
      set({ activeAccountId: id })
      void EventBus.emit({ type: 'sync:reconnect', data: {} } as never)
    }

    return { load, setActiveAccount }
  },
  init: ({ on, actions }) => {
    const reload = () => {
      // Self-gate the sync refetch (no 403 on reconnect for a user without the perm;
      // `sync:reconnect` fires for every store regardless of server audience).
      if (!hasPermissionNow(Permissions.AccountRead)) return
      void actions.load()
    }
    on('sync:account', reload)
    on('sync:account_member', reload)
    on('sync:reconnect', reload)
    if (hasPermissionNow(Permissions.AccountRead)) void actions.load()
  },
})

export const useAccountStore = AccountDef.store
export const Account = registerLazyStore(AccountDef)
