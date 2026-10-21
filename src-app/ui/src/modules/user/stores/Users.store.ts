import { ApiClient } from '@/api-client'
import {
  type AdminUserListItem,
  type CreateUserRequest,
  type UpdateUserRequest,
  type User,
} from '@/api-client/types'
import {
  Permissions,
} from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import type { Permission } from '@/core/permissions/types'
import { SaasApiClient } from '@/api-client-saas/client'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'
import { echoLocalSync } from '@/core/sync/localEcho'

// The saas-only comp/premium permission (NOT a `Permissions.X` member — absent from
// the default/OSS enum; referenced by string per the #50 seam). The tier column and
// its grant actions are gated on its PRESENCE; these store methods additionally
// re-guard at call time so an AI/palette dispatch on a build without it is a no-op.
const BILLING_ADMIN = 'billing::admin' as Permission

const UsersDef = defineStore('Users', {
  state: {
    // Widened from SDK `User[]` to the admin list item so `personal_account_id`
    // (unconditional) is typed on the row; the saas-only `billing` sub-object is
    // read by narrow cast at the consuming site (the default type omits it —
    // a field-level saas-only cfg-gate). The runtime is unchanged: `User.list`
    // already returns `AdminUserListItem[]`.
    users: [] as AdminUserListItem[],
    total: 0,
    currentPage: 1,
    pageSize: 10,
    isInitialized: false,
    // User registration settings
    userRegistrationEnabled: true,
    registrationSettingsInitialized: false,
    loadingRegistrationSettings: false,
    loading: false,
    creating: false,
    updating: false,
    deleting: false,
    error: null as string | null,
  },
  actions: (set, get) => {
    const loadUsers = async (page?: number, pageSize?: number) => {
      if (!hasPermissionNow(Permissions.UsersRead)) return
      try {
        const currentState = get()
        const requestPage = page || currentState.currentPage
        const requestPageSize = pageSize || currentState.pageSize
        // Skip if already initialized and loading first page without explicit page.
        if (currentState.isInitialized && currentState.loading && !page) return
        set({ loading: true, error: null })
        const response = await ApiClient.User.list({
          page: requestPage,
          per_page: requestPageSize,
        })
        set({
          users: response.users,
          total: response.total,
          currentPage: response.page,
          pageSize: response.per_page,
          isInitialized: true,
          loading: false,
        })
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : 'Failed to load users',
          loading: false,
        })
        throw error
      }
    }
    return {
      loadUsers,
      createUser: async (data: CreateUserRequest): Promise<User | undefined> => {
        if (get().creating) return
        try {
          set({ creating: true, error: null })
          const user = await ApiClient.User.create(data)
          set({ creating: false })
          // `create_user` publishes User/Create to `users::read` WITH `origin`, so this
          // tab is the one connection the fan-out skips. Echoing it is this store's own
          // refresh path too — see `core/sync/localEcho.ts` for why there is no inline
          // list patch alongside it.
          await echoLocalSync('user', 'create', user.id)
          return user
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Failed to create user',
            creating: false,
          })
          throw error
        }
      },
      updateUser: async (id: string, data: UpdateUserRequest): Promise<User | undefined> => {
        if (get().updating) return
        try {
          set({ updating: true, error: null })
          const user = await ApiClient.User.update({ user_id: id, ...data })
          set({ updating: false })
          await echoLocalSync('user', 'update', id)
          return user
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Failed to update user',
            updating: false,
          })
          throw error
        }
      },
      resetUserPassword: async (id: string, newPassword: string) => {
        if (get().updating) return
        try {
          set({ updating: true, error: null })
          await ApiClient.User.resetPassword({ user_id: id, new_password: newPassword })
          // NO echo, deliberately: `reset_user_password` publishes NOTHING. Re-derived
          // rather than inherited, and the earlier reason ("it changes only the password
          // hash") was WRONG: `update_password` also writes `password_changed_at` and
          // `updated_at`, so the users ROW does change. Publishing nothing is still
          // correct, for the narrower reason that NO SURFACE RENDERS either column —
          // `password_changed_at` exists in `types.ts` but appears in no component, and
          // the user module renders no `updated_at`. Nor is a `Session` frame owed: the
          // ADMIN reset path does not revoke refresh tokens (only ziee-auth's
          // self-service change-password does), so no session state changes either.
          //
          // EXIT CONDITION: add a "last password change" or "updated" column to the
          // admin users list and this becomes a real hole — the handler must then
          // publish `User` to `UsersRead` and this echo must come back.
          //
          // The old code emitted `user.updated` carrying the UNCHANGED row it happened
          // to have in the list — an event announcing a change that had not happened,
          // which is exactly the kind of drift a payload-carrying parallel channel
          // invites. Echo only what the handler publishes.
          set({ updating: false })
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Failed to reset password',
            updating: false,
          })
          throw error
        }
      },
      toggleUserActiveStatus: async (id: string) => {
        if (get().updating) return
        try {
          set({ updating: true, error: null })
          await ApiClient.User.toggleActive({ user_id: id })
          set({ updating: false })
          // Was a CLIENT-SIDE GUESS: it flipped `is_active` on the row it already held
          // and broadcast that as fact. The refetch reads what the server actually did.
          await echoLocalSync('user', 'update', id)
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Failed to toggle user status',
            updating: false,
          })
          throw error
        }
      },
      deleteUser: async (id: string) => {
        if (get().deleting) return
        try {
          set({ deleting: true, error: null })
          await ApiClient.User.delete({ user_id: id })
          set({ deleting: false })
          await echoLocalSync('user', 'delete', id)
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Failed to delete user',
            deleting: false,
          })
          throw error
        }
      },
      clearError: () => {
        set({ error: null })
      },
      // ── #43 tier/premium comp (saas-only) ─────────────────────────────────────
      // Thin targets the `user.grantPremiumComp` / `user.grantUserCredit`
      // defineActions delegate to. Each calls the saas invocation seam
      // (`SaasApiClient.Admin.*`, #50) against the user's PERSONAL account, then
      // reloads the list so the tier column reflects the authoritative write. The
      // billing-console stores (`CreditsGrants`) refetch the credit LEDGER instead —
      // a different target — which is why these live here.
      setPersonalAccountPremium: async (
        accountId: string,
        premium: boolean,
        reason?: string,
      ) => {
        if (!hasPermissionNow(BILLING_ADMIN)) return
        const res = await SaasApiClient.Admin.putAccountPremium({
          account_id: accountId,
          premium,
          ...(reason ? { reason } : {}),
        })
        await loadUsers(get().currentPage, get().pageSize)
        return res
      },
      grantPersonalAccountCredit: async (
        accountId: string,
        amount_cents: number,
        reason: string,
        expires_at?: string,
      ) => {
        if (!hasPermissionNow(BILLING_ADMIN)) return
        const res = await SaasApiClient.Admin.grantAccountCredit({
          account_id: accountId,
          amount_cents,
          reason,
          ...(expires_at ? { expires_at } : {}),
        })
        await loadUsers(get().currentPage, get().pageSize)
        return res
      },
      loadUserRegistrationSettings: async () => {
        const state = get()
        if (state.registrationSettingsInitialized || state.loadingRegistrationSettings) return
        try {
          set({ loadingRegistrationSettings: true, error: null })
          // TODO: Replace with actual API call when backend endpoint exists.
          set({
            userRegistrationEnabled: true, // Default for now
            registrationSettingsInitialized: true,
            loadingRegistrationSettings: false,
          })
        } catch (error) {
          set({
            error:
              error instanceof Error ? error.message : 'Failed to load registration settings',
            loadingRegistrationSettings: false,
          })
          throw error
        }
      },
      updateUserRegistrationSettings: async (enabled: boolean) => {
        if (get().updating) return
        try {
          set({ updating: true, error: null })
          // TODO: Replace with actual API call when backend endpoint exists.
          set({ userRegistrationEnabled: enabled, updating: false })
        } catch (error) {
          set({
            error:
              error instanceof Error ? error.message : 'Failed to update registration settings',
            updating: false,
          })
          throw error
        }
      },
    }
  },
  init: ({ on, actions }) => {
    // ONE channel. The `user.*` EventBus space this store used to maintain in
    // parallel is gone: it existed only because `sync:user` had no publisher, and
    // once both were live the same fact arrived twice by two different mechanisms —
    // a payload patch on the acting tab, a refetch everywhere else. Two mechanisms
    // for one fact is a drift generator, and it had already drifted (a `user.created`
    // emit nobody subscribed to; a client-GUESSED `is_active`; a `user.updated`
    // carrying an unchanged row after a password reset).
    //
    // Remote sync: loadUsers self-gates on UsersRead.
    const reload = () => void actions.loadUsers()
    on('sync:user', reload)
    // A user editing their OWN username/display_name publishes `Profile`/`Update`, never
    // `User` — the two are different entities in `sync/event.rs` and only the profile one
    // is emitted on that path. Without this key an admin renaming THEMSELVES left their
    // own row in this table showing the old name until a reload.
    on('sync:profile', reload)
    on('sync:reconnect', reload)
    void actions.loadUsers()
  },
})

export const useUsersStore = UsersDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'Users'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const Users = registerLazyStore(UsersDef)

