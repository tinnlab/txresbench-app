import { defineStore, registerLazyStore } from '@txresbench/framework/store-kit'
import { setAuthView } from '@txresbench/framework/permissions'
import { setAuthToken } from '@txresbench/framework/api-client/core'
import { ApiClient } from '@/api-client'
import type { User } from '@/api-client/types'

/**
 * Session — TxResBench's single-user session store.
 *
 * The app has no login screen: the local server (or the desktop shell's
 * auto_login command) mints a permanent session for the one owner. This store
 * replaces the framework's multi-user Auth store with that single mint:
 *
 *   1. `POST /api/session/local` → access + refresh token (and the owner record).
 *   2. The access token is handed to the shared api-client transport
 *      (`setAuthToken`), so every request carries the bearer.
 *   3. `GET /api/auth/me` → permissions (the owner holds `"*"`, so every gate
 *      passes; `/me` is still the server's word on the live user).
 *
 * The store registers itself as the permission system's auth view
 * (`setAuthView`) at module scope, exactly like the old Auth store did.
 */

interface SessionState {
  user: User | null
  permissions: string[]
  ready: boolean
  minting: boolean
  error: string | null
  /** Mint + verify the local session (idempotent; re-runs are no-ops). */
  initSession: () => Promise<void>
  clearError: () => void
}

const defaultState = {
  user: null as User | null,
  permissions: [] as string[],
  ready: false,
  minting: false,
  error: null as string | null,
}

const SessionDef = defineStore('Session', {
  state: defaultState,
  actions: (set, get) => ({
    initSession: async () => {
      if (get().ready || get().minting) return
      set({ minting: true, error: null })
      try {
        const session = await ApiClient.LocalSession.create(undefined, undefined)
        setAuthToken(session.access_token)
        const me = await ApiClient.Auth.me(undefined, undefined)
        set({
          user: me.user,
          permissions: me.permissions,
          ready: true,
          minting: false,
        })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unable to start the local session.'
        set({ minting: false, ready: false, error: message })
      }
    },
    clearError: () => set({ error: null }),
  }),
})

export const useSessionStore = SessionDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers under `'Session'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance.
 */
export const Session = registerLazyStore(SessionDef)

// Register the permission seam the SDK reads (user + permissions). Module scope,
// once — the proxy exists right after `registerLazyStore` above.
setAuthView(Session as never)
