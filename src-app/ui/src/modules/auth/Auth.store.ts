import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'
import { setAuthView, type PermissionAuthView } from '@ziee/framework/permissions'
import { ApiClient } from '@/api-client'
import { setUnauthorizedHandler } from '@ziee/framework/api-client/core'
import type {
  CreateUserRequest,
  LinkAccountRequest,
  LoginRequest,
  User,
} from '@/api-client/types'
import { EventBus, type StoreProxy } from '@ziee/framework/stores'

/**
 * Map an API/login failure to safe, actionable user-facing copy.
 *
 * Branches on the backend's stable `error_code` (attached by api-client/core.ts)
 * so actionable cases (bad credentials, disabled account, OAuth-only account,
 * field validation) stay meaningful, while unknown 5xx failures show a generic
 * message instead of leaking the raw backend/DB error string verbatim.
 */
function friendlyAuthError(error: unknown): string {
  const code = (error as { error_code?: string } | null)?.error_code
  switch (code) {
    case 'INVALID_CREDENTIALS':
      return 'Invalid username or password. Please try again.'
    case 'ACCOUNT_DISABLED':
      return 'Your account has been disabled. Please contact your administrator.'
    case 'NO_PASSWORD':
      return 'This account signs in with a connected provider — use a provider button below.'
    case 'INVALID_USERNAME':
    case 'INVALID_EMAIL':
    case 'INVALID_PASSWORD':
      // Field-validation errors carry actionable, safe backend copy.
      return error instanceof Error ? error.message : 'Please check your input.'
  }
  // Network / aborted fetch.
  if (
    error instanceof TypeError &&
    /failed to fetch|network|aborted/i.test(error.message)
  ) {
    return 'Unable to reach the server. Check your connection and try again.'
  }
  // Unknown server-side failure — never surface the raw message (it may carry
  // internal/DB detail). Show a generic, safe message.
  const status = (error as { status?: number } | null)?.status
  if (status && status >= 500) {
    return 'Something went wrong on our end. Please try again in a moment.'
  }
  return error instanceof Error && error.message
    ? error.message
    : 'Login failed. Please try again.'
}

export interface AutoLoginResponse {
  // Nullable: the OAuth callback path passes `null` because the
  // server is the truth (initAuth() re-fetches /me right after).
  // The store handles the null case by holding isAuthenticated=false
  // + isLoading=true until /me resolves.
  user: User | null
  access_token: string
  refresh_token: string
  expires_in?: number // Seconds until token expires (optional for backward compatibility)
}

interface AuthState {
  user?: User | null
  token?: string | null
  // Epoch-ms deadline of the current access token + its lifetime in
  // seconds. Persisted (alongside `token`) so a reloaded tab can
  // re-arm the proactive silent refresh without waiting for a 401.
  expiresAt?: number | null
  expiresIn?: number | null
  permissions?: string[]
  // Whether the current account has a local password (drives the
  // self-service "change password" form on the profile page). False
  // for OAuth/LDAP-only accounts. Sourced from MeResponse.has_password.
  hasPassword: boolean
  isAuthenticated: boolean
  isLoading: boolean
  isInitializing: boolean
  error?: string | null

  __init__: {
    __store__: () => void
  }
  __destroy__: () => void

  // Actions
  authenticateUser: (credentials: LoginRequest) => Promise<void>
  logoutUser: () => Promise<void>
  registerNewUser: (userData: CreateUserRequest) => Promise<void>
  linkAccount: (request: LinkAccountRequest) => Promise<void>
  clearAuthenticationError: () => void
  initAuth: () => Promise<void>
  setAuthFromAutoLogin: (response: AutoLoginResponse) => void
  refreshFromSync: () => Promise<void>
  // Re-fetch /me and refresh the cached user/permissions/hasPassword.
  // Called after a self-service profile edit so the sidebar widget and
  // password-section visibility stay in sync without a page reload.
  refreshCurrentUser: () => Promise<void>
  // Silently rotate the access token via POST /api/auth/refresh (web:
  // httpOnly cookie; desktop/tunnel: in-memory body token). Returns
  // true when a fresh token landed. Registered as the api-client's
  // on-401 handler and driven proactively by the timer/watchdog below.
  refreshSession: () => Promise<boolean>
  // Desktop registers its auto_login re-mint here so a failed refresh
  // re-mints locally instead of bouncing the local user to a login
  // page (desktop sessions are permanent). Web leaves it unset.
  setRefreshFallback: (fn: (() => Promise<void>) | null) => void
}

// Augment the RegisteredStores interface for IntelliSense
declare module '@ziee/framework/stores' {
  interface RegisteredStores {
    Auth: StoreProxy<AuthState>
  }
}

const defaultState = {
  user: null,
  token: null,
  expiresAt: null,
  expiresIn: null,
  permissions: [],
  hasPassword: false,
  isAuthenticated: false,
  isLoading: false,
  isInitializing: true,
  error: null,
}

// Module-scope handle to the visibilitychange listener so __destroy__
// can remove it (permission-plan follow-up: re-fetch /api/auth/me when
// the tab regains focus, so stale permissions self-heal after an admin
// edits the current user's group in another tab).
let visibilityListener: (() => void) | null = null

// Guards `refreshCurrentUser` so overlapping callers (mount effect +
// post-save refresh + visibility refetch) collapse to a single in-flight
// /me request instead of racing.
let refreshInFlight: Promise<void> | null = null

// ────────────────── Silent-refresh machinery (module-scope) ──────────────────
//
// The refresh token itself deliberately lives OUTSIDE the store state:
//   - web: in the httpOnly `ziee_refresh` cookie — page JS never sees it;
//     the refresh call sends `{}` and the browser attaches the cookie.
//   - desktop/tunnel: in `bodyRefreshToken` below, seeded from the
//     auto_login / magic-link / password-login responses. In-memory only,
//     never persisted (localStorage would re-open the XSS window the
//     cookie closes on web).

let bodyRefreshToken: string | null = null
let proactiveTimer: ReturnType<typeof setTimeout> | null = null
let watchdogTimer: ReturnType<typeof setInterval> | null = null
let onlineListener: (() => void) | null = null
// Desktop's auto_login re-mint (see `setRefreshFallback`).
let refreshFallback: (() => Promise<void>) | null = null
// In-tab single-flight: concurrent 401s / timer+watchdog overlaps share
// one refresh round-trip.
let refreshSessionInFlight: Promise<boolean> | null = null
// Bumped every time the session is intentionally torn down (logout / a
// terminal 401 wipe). A refresh whose round-trip is already in flight
// captures the epoch at start and DISCARDS its result if the epoch moved
// — so a wake-triggered refresh that resolves 200 just after the user
// logged out cannot resurrect the cleared session.
let sessionEpoch = 0
function endSession(): void {
  sessionEpoch += 1
  stopRefreshMachinery()
}

// Refresh at 75% of the token's lifetime — early enough that a slow
// network can't strand the session, late enough to not spam rotations.
const REFRESH_AT_FRACTION = 0.75
// The watchdog + visibilitychange/online listeners are the OS-sleep fix:
// a long setTimeout doesn't tick while the machine is suspended, so on
// wake the timer can be hours late. The listeners compare wall-clock
// timestamps instead, which suspend can't fool.
const WATCHDOG_INTERVAL_MS = 60_000
// setTimeout clamps its delay to a signed 32-bit ms int (~24.8 days);
// past that the watchdog re-arms the timer on each tick.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

/** Epoch-ms moment at which the session should be refreshed. */
function refreshThreshold(state: Pick<AuthState, 'expiresAt' | 'expiresIn'>): number | null {
  if (!state.expiresAt) return null
  const lifetimeMs = (state.expiresIn ?? 0) * 1000
  if (lifetimeMs > 0) {
    return state.expiresAt - lifetimeMs * (1 - REFRESH_AT_FRACTION)
  }
  // Lifetime unknown (older persisted sessions): refresh 60s before exp.
  return state.expiresAt - 60_000
}

/** (Re-)arm the proactive refresh timer from the current expiresAt. */
function scheduleProactiveRefresh(): void {
  if (proactiveTimer) {
    clearTimeout(proactiveTimer)
    proactiveTimer = null
  }
  const state = useAuthStore.getState()
  if (!state.token) return
  const threshold = refreshThreshold(state)
  if (threshold == null) return
  const delay = Math.min(Math.max(threshold - Date.now(), 0), MAX_TIMER_DELAY_MS)
  proactiveTimer = setTimeout(() => void maybeRefresh(), delay)
}

/** Refresh if we're past the threshold; otherwise just re-arm the timer. */
async function maybeRefresh(): Promise<void> {
  const state = useAuthStore.getState()
  if (!state.token) return
  const threshold = refreshThreshold(state)
  if (threshold == null) return
  if (Date.now() >= threshold) {
    await state.refreshSession()
  } else {
    scheduleProactiveRefresh()
  }
}

/** Record freshly-minted tokens + re-arm the proactive refresh.
 *  A non-empty body refresh token (desktop/tunnel) is captured into the
 *  in-memory shadow; web responses carry a blank one (cookie mode). */
function seedSessionTokens(
  set: (partial: Partial<AuthState>) => void,
  accessToken: string,
  expiresIn?: number | null,
  refreshTokenFromBody?: string | null,
): void {
  if (refreshTokenFromBody) {
    bodyRefreshToken = refreshTokenFromBody
  }
  set({
    token: accessToken,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
    expiresIn: expiresIn ?? null,
  })
  scheduleProactiveRefresh()
}

/** Tear down timers + the in-memory refresh token (logout / auth wipe). */
function stopRefreshMachinery(): void {
  bodyRefreshToken = null
  if (proactiveTimer) {
    clearTimeout(proactiveTimer)
    proactiveTimer = null
  }
}

/** The actual refresh round-trip. Runs under the cross-tab lock. */
async function doRefresh(): Promise<boolean> {
  const state = useAuthStore.getState()
  if (!state.token) return false
  const epochAtStart = sessionEpoch
  try {
    // Web sends `{}` — the browser attaches the httpOnly cookie and the
    // server answers in cookie mode (rotated cookie + blank body token).
    // Desktop/tunnel sends the in-memory body token and gets a body
    // token back (body-in→body-out).
    const pair = await ApiClient.Auth.refresh(
      bodyRefreshToken ? { refresh_token: bodyRefreshToken } : {},
      undefined,
    )
    // A logout / terminal wipe raced this in-flight refresh — the session
    // is intentionally gone. Discard the fresh token rather than
    // resurrecting it (and don't reschedule).
    if (sessionEpoch !== epochAtStart) return false
    if (pair.refresh_token) {
      bodyRefreshToken = pair.refresh_token
    }
    useAuthStore.setState({
      token: pair.access_token,
      expiresAt: Date.now() + pair.expires_in * 1000,
      expiresIn: pair.expires_in,
    })
    scheduleProactiveRefresh()
    return true
  } catch (error) {
    if (sessionEpoch !== epochAtStart) return false
    const status = (error as { status?: number } | null)?.status
    if (status === 401) {
      // Session genuinely over (refresh token revoked/expired/absent).
      if (refreshFallback) {
        // Desktop: re-mint locally via auto_login — the local user is
        // never bounced to a login page. On fallback failure the
        // desktop Bootstrap surface owns the messaging; keep the store
        // state as-is rather than flashing an auth screen.
        try {
          await refreshFallback()
          return !!useAuthStore.getState().token
        } catch (fallbackError) {
          console.error('[Auth] refresh fallback failed:', fallbackError)
          return false
        }
      }
      // Web: clear the session → AuthGuard routes to the login page.
      endSession()
      useAuthStore.setState({
        user: null,
        token: null,
        expiresAt: null,
        expiresIn: null,
        isAuthenticated: false,
      })
      return false
    }
    // Network / transient server error: keep the session; the watchdog
    // (or the next on-401 interception) retries.
    console.warn('[Auth] token refresh failed (transient):', error)
    return false
  }
}

/** Single-flight + cross-tab-serialized refresh. */
function refreshSessionImpl(): Promise<boolean> {
  refreshSessionInFlight ??= (async () => {
    try {
      // Cross-tab serialization: rotation is single-use, so two tabs
      // refreshing concurrently would burn each other's token (the
      // server's 30s rotation grace is the backstop; the lock avoids
      // leaning on it). Web Locks is available in all evergreen
      // browsers + the Tauri webviews; fall back to in-tab-only
      // single-flight elsewhere.
      if (typeof navigator !== 'undefined' && navigator.locks?.request) {
        return await navigator.locks.request('ziee-auth-refresh', () =>
          doRefresh(),
        )
      }
      return await doRefresh()
    } finally {
      refreshSessionInFlight = null
    }
  })()
  return refreshSessionInFlight
}

const AuthDef = defineStore('Auth', {
  persist: {
    name: 'auth-storage',
    // expiresAt/expiresIn ride along with the token so a reloaded tab re-arms
    // the proactive refresh; the refresh token itself is NEVER persisted
    // (web: httpOnly cookie; desktop: in-memory).
    partialize: state => ({
      token: state.token,
      expiresAt: state.expiresAt,
      expiresIn: state.expiresIn,
    }),
  },
  state: defaultState as Pick<
    AuthState,
    | 'user'
    | 'token'
    | 'expiresAt'
    | 'expiresIn'
    | 'permissions'
    | 'hasPassword'
    | 'isAuthenticated'
    | 'isLoading'
    | 'isInitializing'
    | 'error'
  >,
  actions: (set, getRaw) => {
    const get = getRaw as () => AuthState
    return {
        // Actions
        authenticateUser: async (credentials: LoginRequest) => {
          const state = get()
          if (state.isLoading) {
            return
          }
          set({ isLoading: true, error: null })
          let loginSucceeded = false
          try {
            const response = await ApiClient.Auth.login(credentials, undefined)
            loginSucceeded = true

            // Seed the token, then COMPLETE the bootstrap by fetching /me for
            // permissions. The login/register responses don't carry
            // permissions, and the app shell gates on `permissions` +
            // `isInitializing`. Finalizing both here (not relying on a
            // separate initAuth) avoids the post-setup hang: AuthGuard's
            // initAuth() races this call, early-returns on our `isLoading`,
            // and would otherwise leave `isInitializing` stuck true forever.
            seedSessionTokens(
              set,
              response.access_token,
              response.expires_in,
              response.refresh_token,
            )
            const me = await ApiClient.Auth.me(undefined, undefined)
            set({
              user: me.user,
              permissions: me.permissions,
              // Carry hasPassword from /me (initAuth + the visibility-refetch
              // both set it; a fresh login/register must too, else OAuth-only
              // accounts see a stale value and the "set a password" UI misfires).
              hasPassword: me.has_password,
              isAuthenticated: true,
              isLoading: false,
              isInitializing: false,
              error: null,
            })
          } catch (error) {
            // If LOGIN itself failed (bad credentials, network, etc.),
            // clear everything — there is no valid token.
            //
            // If login SUCCEEDED but the follow-up /me throws (test
            // navigation aborts the in-flight fetch, transient backend
            // hiccup, etc.), keep the token in place. The token is
            // still valid; AuthGuard's initAuth will retry /me on the
            // next mount and either succeed (→ authenticated) or get
            // a real 401 (→ redirect to /auth). Wiping the token here
            // turned every aborted /me into a logged-out session and
            // was the cause of ~200 E2E failures per parallel run.
            const isAbort =
              error instanceof TypeError &&
              /failed to fetch|network|aborted/i.test(error.message)
            const baseError = {
              error: friendlyAuthError(error),
              isLoading: false,
              isInitializing: false,
            }
            if (!loginSucceeded || !isAbort) {
              endSession()
              set({
                ...baseError,
                isAuthenticated: false,
                token: null,
                expiresAt: null,
                expiresIn: null,
                user: null,
              })
            } else {
              // Login OK, /me aborted — token is still valid, leave it.
              set(baseError)
            }
            throw error
          }
        },

        logoutUser: async () => {
          const state = get()
          if (state.isLoading) {
            return
          }
          set({ isLoading: true, error: null })
          try {
            const { token } = get()
            if (token) {
              // Call logout API to invalidate token on server (revokes
              // every refresh token + clears the httpOnly cookie).
              await ApiClient.Auth.logout(undefined, undefined)
            }
          } catch (err) {
            // If logout 401'd because the ACCESS token expired (e.g. the
            // machine slept past exp), the server-side revoke + cookie
            // clear never happened. Refresh once and retry so logout
            // genuinely tears down the session rather than only clearing
            // localStorage (which would leave the refresh token live for
            // its full TTL). `/auth/logout` is exempt from the api-client
            // 401 interceptor, so drive the refresh explicitly here.
            const status = (err as { status?: number } | null)?.status
            if (status === 401) {
              try {
                if (await refreshSessionImpl()) {
                  await ApiClient.Auth.logout(undefined, undefined)
                }
              } catch {
                // Best effort — fall through and clear local state.
              }
            }
            // Any other error: fall through and clear local state.
          }
          // End the session: bump the epoch (so any in-flight refresh
          // discards its result) and kill the timers BEFORE clearing the
          // token.
          endSession()
          set({
            user: null,
            token: null,
            expiresAt: null,
            expiresIn: null,
            isAuthenticated: false,
            isLoading: false,
            error: null,
          })
        },

        registerNewUser: async (userData: CreateUserRequest) => {
          const state = get()
          if (state.isLoading) {
            throw new Error('Request already in progress')
          }
          set({ isLoading: true, error: null })
          try {
            const response = await ApiClient.Auth.register(userData, undefined)

            // Complete the bootstrap here (token → /me for permissions →
            // isInitializing:false), same as authenticateUser — so the app
            // shell doesn't hang on the spinner after registration.
            seedSessionTokens(
              set,
              response.access_token,
              response.expires_in,
              response.refresh_token,
            )
            const me = await ApiClient.Auth.me(undefined, undefined)
            set({
              user: me.user,
              permissions: me.permissions,
              // Carry hasPassword from /me (initAuth + the visibility-refetch
              // both set it; a fresh login/register must too, else OAuth-only
              // accounts see a stale value and the "set a password" UI misfires).
              hasPassword: me.has_password,
              isAuthenticated: true,
              isLoading: false,
              isInitializing: false,
              error: null,
            })
          } catch (error) {
            set({
              error:
                error instanceof Error ? error.message : 'Registration failed',
              isLoading: false,
              isInitializing: false,
            })
            throw error
          }
        },

        clearAuthenticationError: () => {
          set({ error: null })
        },

        linkAccount: async (request: LinkAccountRequest) => {
          // Encapsulates the OAuth-link round-trip + re-bootstrap
          // sequence so LinkAccountPage stays presentation-only:
          //   1. POST /api/auth/link_account
          //   2. Seed the access token via setAuthFromAutoLogin
          //   3. Re-fetch /me to populate user + permissions
          const res = await ApiClient.Auth.linkAccount(request, undefined)
          get().setAuthFromAutoLogin({
            user: res.user,
            access_token: res.access_token,
            refresh_token: res.refresh_token,
            expires_in: res.expires_in,
          })
          await get().initAuth()
        },

        setAuthFromAutoLogin: (response: AutoLoginResponse) => {
          // The OAuth callback flow passes a null user (the server is
          // the source of truth; initAuth() re-fetches /me right
          // after). During the gap between this set() and the
          // initAuth resolve, code that reads `user.something`
          // would crash on null. Hold isAuthenticated=false until
          // we have a real user.
          //
          // CRITICAL: use `isInitializing`, NOT `isLoading`. initAuth
          // early-returns when isLoading is already true — setting it
          // here would silently skip the /me fetch and the user gets
          // bounced back to /auth by AuthGuard. AuthGuard already
          // gates its spinner on isInitializing during the bootstrap
          // path, so the UX (spinner instead of login flash) is
          // identical. (round-5 audit finding.)
          if (response.user == null) {
            seedSessionTokens(
              set,
              response.access_token,
              response.expires_in,
              response.refresh_token,
            )
            set({
              user: null,
              isAuthenticated: false,
              isInitializing: true,
              error: null,
            })
            return
          }
          seedSessionTokens(
            set,
            response.access_token,
            response.expires_in,
            response.refresh_token,
          )
          set({
            user: response.user,
            isAuthenticated: true,
            isLoading: false,
            error: null,
          })
        },

        // A permission/group-membership/profile change on another device. Quietly
        // re-fetch /auth/me and patch user + permissions so this tab's
        // permission-gated UI updates. Deliberately does NOT call `initAuth()` —
        // that sets `isInitializing` which blanks the whole app to a fullscreen
        // spinner. Mirrors the auth store's visibilitychange refetch.
        refreshFromSync: async () => {
          const { token, isLoading } = get()
          if (!token || isLoading) return
          await ApiClient.Auth.me(undefined, undefined)
            .then(response => {
              set({
                user: response.user,
                permissions: response.permissions,
                // Carried too: this is now the refresh path for the user's OWN profile
                // edit (which echoes `sync:profile` locally rather than calling
                // `refreshCurrentUser` across modules), and that call set it. Dropping it
                // here would narrow what a profile save refreshes.
                hasPassword: response.has_password,
              })
            })
            .catch(err => {
              // 401 → session revoked elsewhere; let the next API call's normal
              // error handling log the user out rather than yanking them here.
              console.warn('[sync] session refresh /me failed:', err)
            })
        },

        initAuth: async () => {
          const state = get()
          if (state.isLoading) {
            return
          }
          set({ isLoading: true, isInitializing: true, error: null })

          try {
            const token = get().token
            if (!token) {
              set({
                isAuthenticated: false,
                isLoading: false,
                isInitializing: false,
              })
              return
            }

            // Verify the session via /auth/me, retrying TRANSIENT failures.
            // A momentary network blip on startup (server briefly busy, or
            // many tabs/devices cold-loading at once) must NOT destroy a
            // valid session — only a genuine 401 (invalid/expired token)
            // logs the user out. Without this, a single refused /auth/me
            // silently logs the user back out at boot.
            let lastError: unknown
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const response = await ApiClient.Auth.me(undefined, undefined)
                set({
                  user: response.user,
                  permissions: response.permissions,
                  hasPassword: response.has_password,
                  isAuthenticated: true,
                  isLoading: false,
                  isInitializing: false,
                })
                return
              } catch (err) {
                lastError = err
                // A real auth rejection is terminal — stop retrying.
                if (
                  err instanceof Error &&
                  err.message.includes('status: 401')
                ) {
                  break
                }
                // Transient: back off (300ms, 600ms) and retry.
                if (attempt < 2) {
                  await new Promise(r => setTimeout(r, 300 * 2 ** attempt))
                }
              }
            }
            throw lastError
          } catch (error) {
            // Same logic as `authenticateUser`: a "Failed to fetch"
            // / aborted error doesn't prove the token is bad — it
            // usually means the page navigated mid-/me. Preserve
            // the token so the next mount can retry. Only wipe on
            // a real auth failure (401 surfaces here as a non-
            // TypeError with a status-bearing message).
            const isAbort =
              error instanceof TypeError &&
              /failed to fetch|network|aborted/i.test(error.message)
            const baseError = {
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to fetch user information',
              isLoading: false,
              isInitializing: false,
            }
            if (isAbort) {
              // Keep token; AuthGuard will retry initAuth on next mount.
              set(baseError)
              return
            }
            endSession()
            set({
              ...baseError,
              isAuthenticated: false,
              token: null,
              expiresAt: null,
              expiresIn: null,
              user: null,
            })
          }
        },

        refreshCurrentUser: async () => {
          // Collapse concurrent callers onto one in-flight /me request.
          if (refreshInFlight) return refreshInFlight
          refreshInFlight = (async () => {
            try {
              const response = await ApiClient.Auth.me(undefined, undefined)
              set({
                user: response.user,
                permissions: response.permissions,
                hasPassword: response.has_password,
              })
            } finally {
              refreshInFlight = null
            }
          })()
          return refreshInFlight
        },

        refreshSession: () => refreshSessionImpl(),

        setRefreshFallback: (fn: (() => Promise<void>) | null) => {
          refreshFallback = fn
        },
    }
  },
  init: ({ set, get: getRaw, onCleanup }) => {
    const get = getRaw as () => AuthState

            const eventBus = EventBus
            const GROUP = 'AuthStore'

            // Silent refresh: register as the api-client's on-401 handler
            // (module holder — same import-cycle dodge as the sync
            // connection id), arm the proactive timer from any persisted
            // session, and start the sleep/wake watchdog.
            setUnauthorizedHandler(() => get().refreshSession())
            scheduleProactiveRefresh()
            // Clear any prior instances first so a double-init (without an
            // interleaved __destroy__) can't leak an orphaned interval /
            // listener.
            if (watchdogTimer) clearInterval(watchdogTimer)
            watchdogTimer = setInterval(
              () => void maybeRefresh(),
              WATCHDOG_INTERVAL_MS,
            )
            if (onlineListener) window.removeEventListener('online', onlineListener)
            onlineListener = () => void maybeRefresh()
            window.addEventListener('online', onlineListener)

            // Sync events are ordinary EventBus events: a session/profile
            // change on another device (or a reconnect resync) quietly
            // re-fetches /me and patches user + permissions.
            eventBus.on(
              'sync:session',
              () => void get().refreshFromSync(),
              GROUP,
            )
            eventBus.on(
              'sync:profile',
              () => void get().refreshFromSync(),
              GROUP,
            )
            eventBus.on(
              'sync:reconnect',
              () => void get().refreshFromSync(),
              GROUP,
            )

            // Re-fetch /me when the tab regains focus, so a permissions
            // change made by an admin in another tab self-heals here on
            // the next interaction (permission-plan follow-up).
            visibilityListener = () => {
              if (document.visibilityState !== 'visible') return
              const state = get()
              if (!state.token || state.isLoading) return
              // Wake-from-suspend check: a long setTimeout doesn't tick
              // while the OS sleeps, so the tab may already be past the
              // refresh threshold (or past exp) the moment it becomes
              // visible again. maybeRefresh() compares wall-clock
              // timestamps and refreshes before the /me below can 401.
              void maybeRefresh()
              ApiClient.Auth.me(undefined, undefined)
                .then(response => {
                  set({
                    user: response.user,
                    permissions: response.permissions,
                    hasPassword: response.has_password,
                  })
                })
                .catch(err => {
                  // 401 → user's session was revoked elsewhere; let the
                  // next API call's normal error handling kick in rather
                  // than logging the user out here (which would lose
                  // any in-progress work).
                  console.warn('[Auth] visibility-refetch /me failed:', err)
                })
            }
            document.addEventListener('visibilitychange', visibilityListener)
          
    onCleanup(() => {

          // Tear down the silent-refresh machinery symmetrically with
          // __init__ (handler, timers, listeners, in-memory token).
          setUnauthorizedHandler(null)
          stopRefreshMachinery()
          if (watchdogTimer) {
            clearInterval(watchdogTimer)
            watchdogTimer = null
          }
          if (onlineListener) {
            window.removeEventListener('online', onlineListener)
            onlineListener = null
          }
          refreshFallback = null
          EventBus.removeGroupListeners('AuthStore')
          if (visibilityListener) {
            document.removeEventListener('visibilitychange', visibilityListener)
            visibilityListener = null
          }
        
    })
  },
})

export const useAuthStore = AuthDef.store

/**
 * The reactive store PROXY (what the removed global registry lookup resolved to).
 * `registerLazyStore` builds it ONCE and self-registers it under the name
 * `'Auth'`, so `auth/module.tsx`'s `stores: [...]` entry REUSES this instance
 * instead of building a second one with an independent ref count — which would
 * run `init` (and every `sync:*` listener it registers) twice.
 */
export const Auth = registerLazyStore(AuthDef)

// SEAM: register the Auth store with the framework permission system. The SDK's
// permission primitives (`usePermission` / `<Can>` / `hasPermissionNow`) and
// `usePrefetchModules` read `{ user, permissions }` through `authStoreProxy()`,
// staying app-agnostic with no global registry lookup. Runs at module
// scope, and this file is imported eagerly by `App.tsx` (and by
// `auth/module.tsx`, which `loadModules()` globs eagerly) — so the view is
// registered before any permission hook renders.
setAuthView(Auth as unknown as StoreProxy<PermissionAuthView>)
