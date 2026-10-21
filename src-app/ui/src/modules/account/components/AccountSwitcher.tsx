import { Select, Skeleton } from '@ziee/kit'
import { isDesktop } from '@/core/platform'
import type { Account as AccountModel } from '@/api-client/types'
import { Account } from '@/modules/account/stores/Account.store'

/** GitHub-style label split (DEC-6): the personal account reads "Personal"; an org
 *  reads by its name. The switcher control carries no fixed noun — it shows the
 *  ACTIVE account's label. */
function labelFor(account: AccountModel): string {
  return account.kind === 'personal' ? 'Personal' : account.name
}

/**
 * The account switcher (A4 ITEM-3) — the app-chrome control (left-sidebar header
 * region) showing the active account + a dropdown of the user's accounts. Renders
 * **nothing** at ≤1 account (every solo user) and on desktop (`__TAURI__`, DEC-7 —
 * belt-and-suspenders), so the concept never surfaces for the modal invisible-tenancy
 * user. Selecting an account switches the active-account context (the `X-Account-Id`
 * holder) and every subsequent request scopes to it.
 */
export function AccountSwitcher() {
  // Reactive reads (proxy getters subscribe).
  const { accounts, activeAccountId, loading, error } = Account

  // Desktop is a single-valued no-op — never mount the switcher (INV-4 / AC-INV-7).
  if (isDesktop()) return null

  // Loading the very first list: a quiet skeleton row (never a blank chrome).
  if (loading && accounts.length === 0) {
    return (
      <div data-testid="account-switcher-loading" className="py-1">
        <Skeleton className="h-8 w-full" />
      </div>
    )
  }

  // An error is surfaced inline, small, never as a blank chrome. (A transient list
  // error still lets the rest of the sidebar render.)
  if (error && accounts.length === 0) {
    return (
      <div
        data-testid="account-switcher-error"
        role="alert"
        className="py-1 text-xs text-destructive"
      >
        Couldn’t load accounts
      </div>
    )
  }

  // Hidden at ≤1 account — the solo/desktop no-op (§7 hidden-at-one). This is the
  // primary gate; the desktop predicate above is the belt-and-suspenders (DEC-7).
  if (accounts.length <= 1) return null

  const options = accounts.map(a => ({ label: labelFor(a), value: a.id }))

  return (
    <div data-testid="account-switcher">
      <Select
        data-testid="account-switcher-select"
        aria-label="Active account"
        options={options}
        value={activeAccountId ?? undefined}
        onChange={(id: string) => Account.setActiveAccount(id)}
      />
    </div>
  )
}
