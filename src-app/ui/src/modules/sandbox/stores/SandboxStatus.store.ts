import { ApiClient } from '@/api-client'
import { type SandboxStatus as SandboxStatusDTO } from '@/api-client/types'
import { Permissions } from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { defineStore, registerLazyStore } from '@txresbench/framework/store-kit'

/**
 * Read-only sandbox availability + embedded-rootfs status for the admin
 * `/settings/sandbox` page. Loads on first use (and on a full reload, since the
 * store is recreated). Self-gates the fetch on `sandbox::settings::read` (the
 * exact perm the endpoint enforces) so an unpermitted user never triggers a 403.
 */
const SandboxStatusDef = defineStore('SandboxStatus', {
  state: {
    status: null as SandboxStatusDTO | null,
    loading: false,
    error: null as string | null,
  },
  actions: set => ({
    loadStatus: async () => {
      if (!hasPermissionNow(Permissions.SandboxSettingsRead)) return
      set({ loading: true, error: null })
      try {
        const status = await ApiClient.Sandbox.getStatus()
        set({ status, loading: false })
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e), loading: false })
      }
    },
  }),
  init: ({ actions }) => {
    void actions.loadStatus()
  },
})

export const useSandboxStatusStore = SandboxStatusDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'SandboxStatus'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const SandboxStatus = registerLazyStore(SandboxStatusDef)
