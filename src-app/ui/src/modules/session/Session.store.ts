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
 *   1. `POST /api/session/local` → access + refresh token (and the owner record);
 *   2. The access token is handed to the shared api-client transport
 *      (`setAuthToken`), so every request carries the bearer.
 *   3. `GET /api/auth/me` → permissions (the owner holds `"*"`, so every gate
 *      passes; `/me` is still the server's word on the live user).
 *
 * The mint retries automatically (R3-intake-8): a transient failure under
 * load — "POST /api/session/local Failed to fetch" — retries up to 3 times
 * with backoff, and a slow endpoint is reported as "still trying" rather
 * than an endless bare "Loading…" (the guard's `slow` line). After the last
 * try the guard shows the honest error state with a manual Retry.
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
  /** The attempt currently running (1-based; 0 before the first try).
   *  R3-intake-8: the guard reads it so the user sees the retry, not a
   *  bare endless "Loading…" while the mint retries. */
  attempts: number
  /**
   * The mint has taken longer than the slow threshold (R3-intake-8 — a
   * "slow" session endpoint must not look like a hang; the guard says it
   * is still trying).
   */
  slow: boolean
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
  attempts: 0,
  slow: false,
}

/**
 * How many tries the automatic boot makes before giving up (R3-intake-8:
 * "retry automatically with backoff (3 tries)"). A transient failure under
 * load (the round-3 report's "Failed to fetch" five times in one run) is
 * absorbed; a real outage ends in the guard's error state.
 */
const SESSION_ATTEMPTS = 3

/** The backoff between tries, in ms (500 ms then 1 s — seconds-scale). */
const SESSION_BACKOFF_MS = [500, 1000] as const

/** A try in flight longer than this marks the mint "slow" (the guard says
 *  it is still trying — never a bare Loading with no progress facts). */
const SESSION_SLOW_MS = 4000

const SessionDef = defineStore('Session', {
  state: defaultState,
  actions: (set, get) => ({
    initSession: async () => {
      if (get().ready || get().minting) return
      set({ minting: true, error: null, attempts: 0, slow: false })
      const slowTimer = setTimeout(() => set({ slow: true }), SESSION_SLOW_MS)
      let lastError: unknown = null
      try {
        for (let attempt = 1; attempt <= SESSION_ATTEMPTS; attempt += 1) {
          set({ attempts: attempt })
          try {
            const session = await ApiClient.LocalSession.create(undefined, undefined)
            setAuthToken(session.access_token)
            const me = await ApiClient.Auth.me(undefined, undefined)
            clearTimeout(slowTimer)
            set({
              user: me.user,
              permissions: me.permissions,
              ready: true,
              minting: false,
              slow: false,
            })
            return
          } catch (error) {
            // The next try waits out the backoff; the last failure is the
            // one reported (its message is the guard's plain reason).
            lastError = error
            if (attempt < SESSION_ATTEMPTS) {
              await new Promise(resolve => setTimeout(resolve, SESSION_BACKOFF_MS[attempt - 1]))
            }
          }
        }
        clearTimeout(slowTimer)
        const message =
          lastError instanceof Error ? lastError.message : 'Unable to start the local session.'
        set({ minting: false, ready: false, error: message, slow: false })
      } catch (unexpected) {
        // The retry ladder itself failing (an AbortError out of the
        // backoff sleep) still ends in the error state, never a hang.
        clearTimeout(slowTimer)
        const message =
          unexpected instanceof Error ? unexpected.message : 'Unable to start the local session.'
        set({ minting: false, ready: false, error: message, slow: false })
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
