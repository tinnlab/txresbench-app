import { ApiClient } from '@/api-client'
import { Permissions } from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { useAuthStore } from '@/modules/auth/Auth.store'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

/**
 * Pairing state for the "AI Assistant Access" settings page
 * (PLAN.md ITEM-17/18). `startPairing` mints a one-time code + the MCP
 * server URL (`POST /api/mcp/pair/start` — CONTRACT.md) that the user
 * copies (or deep-links) into ziee; `pair/exchange` is called by ziee
 * itself, never the FE (CONTRACT.md), so this store only tracks the
 * mint side. No auto-load on init — pairing is user-initiated.
 */

// Module-scope (NOT store-instance-scope) last-observed auth identity.
// `McpConnect`'s store proxy is ref-counted: it destroys its `init`
// listeners ~5s after the settings page unmounts and lazily re-inits on the
// next access (`sdk/packages/framework/src/stores.ts`). A per-instance
// "watch and reset on change" would miss a logout/login pair that happens
// entirely while the store is torn down (idle) — e.g. user A pairs, leaves
// the page, and only much later user B logs in and revisits it: no live
// subscription was ever there to observe A's logout. Keeping the last-seen
// identity at MODULE scope (this variable lives for the whole page-load
// life of the tab, independent of the store instance's lifecycle) lets the
// `fireImmediately` check at every (re-)init catch up on any transition
// that happened while unobserved.
let lastAuthIdentity: string | null | undefined = undefined

// Guards `startPairing`'s async continuation against a logout/reset that
// lands WHILE the `pair/start` request is in flight. Without it, the identity
// watch below clears the state on logout but the stale in-flight response
// then re-populates the just-cleared one-time code — leaking user A's pairing
// secret to user B in the same tab. `reset()` bumps the epoch to invalidate
// any outstanding attempt; the continuation discards its result if superseded.
// (Same pattern as `Auth.store.ts`'s `sessionEpoch`, per CLAUDE.md.)
let pairingEpoch = 0

const McpConnectDef = defineStore('McpConnect', {
  state: {
    code: null as string | null,
    mcpUrl: null as string | null,
    starting: false,
    error: null as string | null,
  },
  actions: set => ({
    startPairing: async () => {
      if (!hasPermissionNow(Permissions.McpUse)) return
      const epoch = ++pairingEpoch // claim this attempt (latest wins; a reset invalidates it)
      set({ starting: true, error: null })
      try {
        const { code, mcp_url } = await ApiClient.Mcp.pairStart()
        if (epoch !== pairingEpoch) return // superseded by a reset/logout mid-flight — discard the secret
        set({ code, mcpUrl: mcp_url, starting: false })
      } catch (e) {
        if (epoch !== pairingEpoch) return
        set({ error: e instanceof Error ? e.message : String(e), starting: false })
      }
    },
    reset: () => {
      pairingEpoch++ // invalidate any in-flight startPairing continuation
      set({ code: null, mcpUrl: null, starting: false, error: null })
    },
  }),
  init: ({ watch, actions }) => {
    // The minted pairing code is a one-time SECRET (whoever holds it can
    // exchange it for MCP access). This is an SPA — logging out doesn't hard
    // reload the page — so without this, user A's leftover code/URL stays in
    // module-scope Zustand state and is visible to user B if B logs into the
    // SAME tab right after. Watch identity (authenticated ? user.id : null)
    // rather than only `isAuthenticated`, so an in-place account switch that
    // never bounces through `isAuthenticated:false` (e.g. a future
    // impersonation/account-link flow) still clears the leftover state too.
    //
    // `fireImmediately: true` + comparing against the module-scope
    // `lastAuthIdentity` (see above) — not just the previous value the
    // watcher itself observed — is what catches a transition that happened
    // while this store instance was torn down (ref-count decay).
    watch(
      useAuthStore,
      authState => (authState.isAuthenticated ? (authState.user?.id ?? null) : null),
      identity => {
        if (lastAuthIdentity !== undefined && identity !== lastAuthIdentity) {
          actions.reset()
        }
        lastAuthIdentity = identity
      },
      { fireImmediately: true },
    )
  },
})

export const useMcpConnectStore = McpConnectDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'McpConnect'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const McpConnect = registerLazyStore(McpConnectDef)
