import { ApiClient } from '@/api-client'
import {
  type ProvenanceSettings as ProvenanceSettingsDto,
  type UpdateProvenanceSettings,
} from '@/api-client/types'
import {
  Permissions,
} from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

/**
 * Deployment-wide provenance settings singleton for the admin page. Loads on
 * first use / reload; `save` persists a partial update and re-stores the
 * returned row (so the form reflects server-side clamping/validation). Mirrors
 * `SandboxSettings.store` — refetch-on-mount + after-save; reloads on
 * `sync:provenance_settings` (self-gated on `provenance::settings::read`).
 */
const ProvenanceSettingsDef = defineStore('ProvenanceSettings', {
  state: {
    settings: null as ProvenanceSettingsDto | null,
    loading: false,
    saving: false,
    error: null as string | null,
  },
  actions: set => ({
    loadSettings: async () => {
      if (!hasPermissionNow(Permissions.ProvenanceSettingsRead)) return
      set({ loading: true, error: null })
      try {
        const settings = await ApiClient.Provenance.getSettings()
        set({ settings, loading: false })
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e), loading: false })
      }
    },
    saveSettings: async (update: UpdateProvenanceSettings): Promise<boolean> => {
      if (!hasPermissionNow(Permissions.ProvenanceSettingsManage)) return false
      set({ saving: true, error: null })
      try {
        const settings = await ApiClient.Provenance.updateSettings(update)
        set({ settings, saving: false })
        return true
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e), saving: false })
        return false
      }
    },
  }),
  init: ({ on, actions }) => {
    void actions.loadSettings()
    const reload = () => {
      if (!hasPermissionNow(Permissions.ProvenanceSettingsRead)) return
      void actions.loadSettings()
    }
    on('sync:provenance_settings', reload)
    on('sync:reconnect', reload)
  },
})

export const useProvenanceSettingsStore = ProvenanceSettingsDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'ProvenanceSettings'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const ProvenanceSettings = registerLazyStore(ProvenanceSettingsDef)
