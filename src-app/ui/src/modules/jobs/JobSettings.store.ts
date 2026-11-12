import { ApiClient } from '@/api-client'
import {
  type JobSettings as JobSettingsRow,
  type UpdateJobSettingsRequest,
} from '@/api-client/types'
import {
  Permissions,
} from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { defineStore, registerLazyStore } from '@txresbench/framework/store-kit'

/**
 * Admin jobs settings (the concurrency cap). Singleton config store mirroring
 * `SessionSettings.store.ts`: self-gated load + `sync:job_settings` refetch.
 */
const JobSettingsDef = defineStore('JobSettings', {
  immer: true,
  state: {
    settings: null as JobSettingsRow | null,
    loading: false,
    saving: false,
    error: null as string | null,
  },
  actions: set => {
    const load = async () => {
      set(s => {
        s.loading = true
        s.error = null
      })
      try {
        const row = await ApiClient.Jobs.getSettings()
        set(s => {
          s.settings = row
          s.loading = false
        })
      } catch (e) {
        set(s => {
          s.error = e instanceof Error ? e.message : 'Failed to load job settings'
          s.loading = false
        })
      }
    }
    return {
      load,
      update: async (patch: UpdateJobSettingsRequest) => {
        set(s => {
          s.saving = true
          s.error = null
        })
        try {
          const row = await ApiClient.Jobs.updateSettings(patch)
          set(s => {
            s.settings = row
            s.saving = false
          })
          return row
        } catch (e) {
          set(s => {
            s.error = e instanceof Error ? e.message : 'Failed to save job settings'
            s.saving = false
          })
          throw e
        }
      },
    }
  },
  init: ({ on, actions }) => {
    const reload = () => {
      if (!hasPermissionNow(Permissions.JobsSettingsRead)) return
      void actions.load()
    }
    on('sync:job_settings', reload)
    on('sync:reconnect', reload)
    if (hasPermissionNow(Permissions.JobsSettingsRead)) void actions.load()
  },
})

export const useJobSettingsStore = JobSettingsDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'JobSettings'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const JobSettings = registerLazyStore(JobSettingsDef)
