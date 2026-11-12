import { ApiClient } from '@/api-client'
import {
  type SandboxResourceLimits,
  type UpdateSandboxResourceLimits,
} from '@/api-client/types'
import {
  Permissions,
} from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { defineStore, registerLazyStore } from '@txresbench/framework/store-kit'

/**
 * Sandbox resource-limits singleton for the admin page. Loads on first use /
 * reload; `save` persists a partial update and re-stores the returned row (so
 * the form reflects server-side clamping/validation). Refetch-on-mount +
 * after-save — no realtime sync dependency this round (DEC-4).
 */
const SandboxSettingsDef = defineStore('SandboxSettings', {
  state: {
    limits: null as SandboxResourceLimits | null,
    loading: false,
    saving: false,
    error: null as string | null,
  },
  actions: set => ({
    loadSettings: async () => {
      if (!hasPermissionNow(Permissions.SandboxSettingsRead)) return
      set({ loading: true, error: null })
      try {
        const limits = await ApiClient.Sandbox.getSettings()
        set({ limits, loading: false })
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e), loading: false })
      }
    },
    saveSettings: async (update: UpdateSandboxResourceLimits): Promise<boolean> => {
      if (!hasPermissionNow(Permissions.SandboxSettingsManage)) return false
      set({ saving: true, error: null })
      try {
        const limits = await ApiClient.Sandbox.updateSettings(update)
        set({ limits, saving: false })
        return true
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e), saving: false })
        return false
      }
    },
  }),
  init: ({ actions }) => {
    void actions.loadSettings()
  },
})

export const useSandboxSettingsStore = SandboxSettingsDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'SandboxSettings'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const SandboxSettings = registerLazyStore(SandboxSettingsDef)
