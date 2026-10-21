import { ApiClient } from '@/api-client'
import type {
  Account,
  AccountMember,
  AccountRole,
} from '@/api-client/types'
import { Permissions } from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

/**
 * Members store (#44; inlined on the account-detail page #57) — one account's
 * members, paged
 * (`Account.listMembers`, `GET /api/accounts/{id}/members`), plus the three
 * admin member mutations (`Admin.addMember` / `removeMember` / `setMemberRole`,
 * gated `account::manage`). Each mutation refetches the current members page so
 * the drawer reflects the server truth (never a client-side guess).
 *
 * The last-owner guard is the BACKEND's (422 `error_code: 'LAST_OWNER'`); this
 * store propagates the error (throw-after-set) so the caller surfaces it and the
 * page never crashes (INV-3 / DEC-4).
 */
const AccountMembersDef = defineStore('AccountMembers', {
  state: {
    account: null as Account | null,
    members: [] as AccountMember[],
    total: 0,
    currentPage: 1,
    pageSize: 20,
    isInitialized: false,
    loading: false,
    mutating: false,
    error: null as string | null,
  },
  actions: (set, get) => {
    const loadMembers = async (page?: number, pageSize?: number) => {
      const account = get().account
      // Guard on a real id, not just a truthy account: the members endpoint requires
      // `id` as a path param, so a partially-resolved account (no id) must never reach
      // it (it throws "Missing required parameter: id" client-side).
      if (!account?.id) return
      if (!hasPermissionNow(Permissions.AccountManage)) return
      try {
        const cur = get()
        const requestPage = page ?? cur.currentPage
        const requestPageSize = pageSize ?? cur.pageSize
        set({ loading: true, error: null })
        const res = await ApiClient.Account.listMembers({
          id: account.id,
          page: requestPage,
          per_page: requestPageSize,
        })
        set({
          members: res.members,
          total: res.total,
          currentPage: res.page,
          pageSize: res.per_page,
          isInitialized: true,
          loading: false,
        })
      } catch (error) {
        // The backend `GET /api/accounts/{id}/members` is membership-gated: a
        // non-member (an admin who doesn't belong to this org) gets 404. Surface
        // that as a clear, actionable message rather than a bare "Account not
        // found" (DEC-10 — member LISTING is scoped to accounts the admin belongs
        // to; add/remove/set-role are membership-free).
        const status = (error as { status?: number })?.status
        const message =
          status === 404
            ? "You're not a member of this account, so its members can't be listed here. Add a member (including yourself) to manage it."
            : error instanceof Error
              ? error.message
              : 'Failed to load members'
        // Mark initialized even on failure — otherwise the drawer's load effect
        // guard (`!isInitialized && !loading`) re-fires forever on a failing
        // load. The ErrorState's Retry calls loadMembers directly.
        set({ error: message, loading: false, isInitialized: true })
        throw error
      }
    }

    // Returns true when the mutation actually ran, false when it was dropped as a
    // concurrent no-op — so a caller never reports a guarded no-op as success.
    const runMutation = async (op: () => Promise<unknown>): Promise<boolean> => {
      if (get().mutating) return false
      try {
        set({ mutating: true, error: null })
        await op()
        set({ mutating: false })
        // Re-read the current page so the drawer reflects the server truth.
        await loadMembers()
        return true
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : 'Mutation failed',
          mutating: false,
        })
        throw error
      }
    }

    return {
      /**
       * Inline analog of the retired drawer's `openFor` (#57): set the focused
       * account + reset the member list WITHOUT toggling `isOpen`. The
       * account-detail page's Members section calls this on mount / route-param
       * change, then drives the load off account presence (not a drawer flag).
       * A re-set for the SAME account is a no-op so a re-render doesn't wipe a
       * loaded list.
       */
      setAccount: (account: Account) => {
        if (get().account?.id === account.id) return
        set({
          account,
          members: [],
          total: 0,
          currentPage: 1,
          isInitialized: false,
          error: null,
        })
      },
      loadMembers,
      addMember: async (userId: string, role: AccountRole): Promise<boolean> => {
        const account = get().account
        if (!account) return false
        return runMutation(() =>
          ApiClient.Admin.addMember({
            account_id: account.id,
            user_id: userId,
            role,
          }),
        )
      },
      removeMember: async (userId: string): Promise<boolean> => {
        const account = get().account
        if (!account) return false
        return runMutation(() =>
          ApiClient.Admin.removeMember({
            account_id: account.id,
            user_id: userId,
          }),
        )
      },
      setRole: async (userId: string, role: AccountRole): Promise<boolean> => {
        const account = get().account
        if (!account) return false
        return runMutation(() =>
          ApiClient.Admin.setMemberRole({
            account_id: account.id,
            user_id: userId,
            role,
          }),
        )
      },
      clearError: () => set({ error: null }),
    }
  },
})

export const useAccountMembersStore = AccountMembersDef.store

/** The reactive store PROXY consumers import. */
export const AccountMembers = registerLazyStore(AccountMembersDef)
