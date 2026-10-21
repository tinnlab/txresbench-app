import { ApiClient } from '@/api-client'
import { type PackageLoadStatus } from '@/api-client/types'
import { Permissions } from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

/**
 * Discovered processor packages for the admin `/settings/processors` page — the
 * runtime folder-scan control plane (D2). Loads the discovered set from
 * `GET /api/processors` on first use / reload (the store is recreated on a full
 * reload), and `reload()` triggers `POST /api/processors/reload` (re-scan +
 * republish) then refreshes the list.
 *
 * Self-gates the LIST on `sandbox::settings::read` — the EXACT perm the page +
 * `GET /api/processors` enforce (M6, reconciled). The Reload action self-gates on
 * `sandbox::settings::manage` — the EXACT perm `POST /api/processors/reload` now
 * enforces (reconciled from the old root-only `RequireAdmin`, so an Administrators-group
 * member holding the perm via `*` can Reload without a live 403). So each client self-gate
 * equals the perm the endpoint it calls enforces. No realtime sync this round — reload is
 * user-triggered.
 */
const ProcessorsAdminDef = defineStore('ProcessorsAdmin', {
  state: {
    packages: [] as PackageLoadStatus[],
    /** Count of registered (valid, folded) extensions after the last reflect. */
    registered: null as number | null,
    loading: false,
    reloading: false,
    /** True once an INITIAL list has succeeded — lets the page distinguish an
     * initial-load failure (show the page ErrorState) from a later reload failure
     * (keep the card + its inline error + the Reload affordance). */
    loaded: false,
    error: null as string | null,
  },
  actions: set => ({
    loadProcessors: async () => {
      if (!hasPermissionNow(Permissions.SandboxSettingsRead)) return
      set({ loading: true, error: null })
      try {
        const packages = await ApiClient.Processor.list()
        set({ packages, loading: false, loaded: true })
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e), loading: false })
      }
    },
    reload: async (): Promise<boolean> => {
      // Reload requires MANAGE (the perm POST /api/processors/reload enforces) — not READ.
      if (!hasPermissionNow(Permissions.SandboxSettingsManage)) return false
      set({ reloading: true, error: null })
      try {
        const res = await ApiClient.Processor.reload()
        set({
          packages: res.packages,
          registered: res.registered,
          reloading: false,
        })
        return true
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e), reloading: false })
        return false
      }
    },
  }),
  init: ({ actions }) => {
    void actions.loadProcessors()
  },
})

export const useProcessorsAdminStore = ProcessorsAdminDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'ProcessorsAdmin'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const ProcessorsAdmin = registerLazyStore(ProcessorsAdminDef)
