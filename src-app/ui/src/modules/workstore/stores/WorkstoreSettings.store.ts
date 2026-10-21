import { ApiClient } from '@/api-client'
import { type WorkstoreSettings as WorkstoreSettingsRow, type UpdateWorkstoreSettings } from '@/api-client/types'
import { Permissions } from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

/**
 * Workstore admin settings singleton (issue #54: GC policy + ingest size caps) for
 * the admin page. Loads on first use / reload; `save` persists a partial update and
 * re-stores the returned row (so the form reflects server-side clamping/validation).
 * Non-saas — the normal `@/api-client`. Mirrors `SandboxSettings.store`.
 */
const WorkstoreSettingsDef = defineStore('WorkstoreSettings', {
  state: {
    settings: null as WorkstoreSettingsRow | null,
    loading: false,
    saving: false,
    error: null as string | null,
  },
  actions: set => ({
    loadSettings: async () => {
      if (!hasPermissionNow(Permissions.WorkstoreSettingsRead)) return
      set({ loading: true, error: null })
      try {
        const settings = await ApiClient.Workstore.getSettings()
        set({ settings, loading: false })
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e), loading: false })
      }
    },
    saveSettings: async (update: UpdateWorkstoreSettings): Promise<boolean> => {
      if (!hasPermissionNow(Permissions.WorkstoreSettingsManage)) return false
      set({ saving: true, error: null })
      try {
        const settings = await ApiClient.Workstore.updateSettings(update)
        set({ settings, saving: false })
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

export const useWorkstoreSettingsStore = WorkstoreSettingsDef.store

/**
 * The reactive store PROXY — the direct handle consumers import. `registerLazyStore`
 * builds it ONCE and self-registers it under `'WorkstoreSettings'`.
 */
export const WorkstoreSettings = registerLazyStore(WorkstoreSettingsDef)
