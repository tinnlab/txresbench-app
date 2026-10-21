import { ApiClient } from '@/api-client'
import type {
  AdminAccountSummary,
  AccountKind,
  CreateOrganizationRequest,
  Account,
} from '@/api-client/types'
import { Permissions } from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

/**
 * Cross-account ADMIN list store (#44, ITEM-2) — the deployment-wide accounts
 * list the Accounts admin page renders. Reads `Admin.listAccounts`
 * (`GET /api/admin/accounts`), which returns ALL accounts membership-free
 * (`AdminAccountSummary`: account + member_count + owner_user_id) with `total`
 * for the "Showing N of M" affordance — NOT `Account.list` (the caller's own
 * memberships), so a non-member org still appears (INV-1 / DEC-2).
 *
 * Mirrors `modules/user/stores/Users.store.ts`: loading/error/paging fields, a
 * `hasPermissionNow` read guard, and throw-after-set so a caller can toast.
 */
const AdminAccountsDef = defineStore('AdminAccounts', {
  state: {
    accounts: [] as AdminAccountSummary[],
    total: 0,
    currentPage: 1,
    pageSize: 20,
    kind: undefined as AccountKind | undefined,
    isInitialized: false,
    loading: false,
    creating: false,
    error: null as string | null,
  },
  actions: (set, get) => {
    const loadAccounts = async (page?: number, pageSize?: number) => {
      if (!hasPermissionNow(Permissions.AdminAccounts)) return
      try {
        const cur = get()
        const requestPage = page ?? cur.currentPage
        const requestPageSize = pageSize ?? cur.pageSize
        const requestKind = cur.kind
        set({ loading: true, error: null })
        const res = await ApiClient.Admin.listAccounts({
          page: requestPage,
          per_page: requestPageSize,
          ...(requestKind ? { kind: requestKind } : {}),
        })
        set({
          accounts: res.accounts,
          total: res.total,
          currentPage: res.page,
          pageSize: res.per_page,
          isInitialized: true,
          loading: false,
        })
      } catch (error) {
        // Mark initialized even on failure — otherwise the page's cold-load
        // effect guard (`!isInitialized && !loading`) re-fires the moment
        // `loading` flips false and re-calls this forever (flicker + backend
        // hammer). A failed cold load renders the ErrorState, whose Retry button
        // calls loadAccounts directly (bypassing the guard).
        set({
          error:
            error instanceof Error ? error.message : 'Failed to load accounts',
          loading: false,
          isInitialized: true,
        })
        throw error
      }
    }

    return {
      loadAccounts,
      /**
       * Create an organization (`Account.create`, `POST /api/accounts`) and
       * refetch the current page so the new org appears (INV-1). Throws on
       * failure after recording `error`.
       */
      createOrg: async (
        req: CreateOrganizationRequest,
      ): Promise<Account | undefined> => {
        if (get().creating) return
        try {
          set({ creating: true, error: null })
          const account = await ApiClient.Account.create(req)
          set({ creating: false })
          // Refetch page 1 so the freshly created org is visible at the top of
          // the list (the server orders newest-first).
          await loadAccounts(1)
          return account
        } catch (error) {
          set({
            error:
              error instanceof Error
                ? error.message
                : 'Failed to create organization',
            creating: false,
          })
          throw error
        }
      },
      clearError: () => set({ error: null }),
    }
  },
})

export const useAdminAccountsStore = AdminAccountsDef.store

/**
 * The reactive store PROXY consumers import. `registerLazyStore` builds it once
 * and self-registers it under `'AdminAccounts'`.
 */
export const AdminAccounts = registerLazyStore(AdminAccountsDef)
