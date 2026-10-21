import { ApiClient } from '@/api-client'
import { type McpSettings as McpSettingsRow, type UpdateMcpSettings } from '@/api-client/types'
import { Permissions } from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

/**
 * MCP admin settings singleton (issue #54: agent/tool caps + pairing-TTL) for the
 * admin page. Loads on first use / reload; `save` persists a partial update and
 * re-stores the returned row (so the form reflects server-side clamping/validation).
 * Non-saas — the normal `@/api-client`. Mirrors `WorkstoreSettings.store`.
 */
const McpSettingsDef = defineStore('McpSettings', {
  state: {
    settings: null as McpSettingsRow | null,
    loading: false,
    saving: false,
    error: null as string | null,
  },
  actions: set => ({
    loadSettings: async () => {
      if (!hasPermissionNow(Permissions.McpSettingsRead)) return
      set({ loading: true, error: null })
      try {
        const settings = await ApiClient.Mcp.getSettings()
        set({ settings, loading: false })
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e), loading: false })
      }
    },
    saveSettings: async (update: UpdateMcpSettings): Promise<boolean> => {
      if (!hasPermissionNow(Permissions.McpSettingsManage)) return false
      set({ saving: true, error: null })
      try {
        const settings = await ApiClient.Mcp.updateSettings(update)
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

export const useMcpSettingsStore = McpSettingsDef.store

/**
 * The reactive store PROXY — the direct handle consumers import. `registerLazyStore`
 * builds it ONCE and self-registers it under `'McpSettings'`.
 */
export const McpSettings = registerLazyStore(McpSettingsDef)
