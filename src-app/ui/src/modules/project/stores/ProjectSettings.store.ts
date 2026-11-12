import { ApiClient } from '@/api-client'
import { type ProjectSettings as ProjectSettingsRow } from '@/api-client/types'
import { Permissions } from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { defineStore, registerLazyStore } from '@txresbench/framework/store-kit'

/**
 * Admin view of the deployment-wide project settings (singleton): the
 * ownership-transfer enable toggle. Self-gated on `project::settings::read`;
 * `sync:project_settings` / `sync:reconnect` refresh another admin's edit live.
 */
const ProjectSettingsDef = defineStore('ProjectSettings', {
  state: {
    settings: null as ProjectSettingsRow | null,
    loading: false,
    saving: false,
    error: null as string | null,
  },
  actions: set => {
    const load = async () => {
      if (!hasPermissionNow(Permissions.ProjectsUse)) return
      set({ loading: true, error: null })
      try {
        const row = await ApiClient.ProjectSettings.get()
        set({ settings: row, loading: false })
      } catch (error) {
        set({
          loading: false,
          error: error instanceof Error ? error.message : 'Failed to load project settings',
        })
      }
    }
    return {
      load,
      update: async (transferEnabled: boolean): Promise<void> => {
        set({ saving: true, error: null })
        try {
          const row = await ApiClient.ProjectSettings.update({
            transfer_enabled: transferEnabled,
          })
          set({ settings: row, saving: false })
        } catch (error) {
          set({
            saving: false,
            error: error instanceof Error ? error.message : 'Update failed',
          })
          throw error
        }
      },
    }
  },
  init: ({ on, actions }) => {
    const reload = () => {
      if (!hasPermissionNow(Permissions.ProjectsUse)) return
      void actions.load()
    }
    on('sync:project_settings', reload)
    on('sync:reconnect', reload)
    if (hasPermissionNow(Permissions.ProjectsUse)) void actions.load()
  },
})

export const useProjectSettingsStore = ProjectSettingsDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'ProjectSettings'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const ProjectSettings = registerLazyStore(ProjectSettingsDef)
