import { ApiClient } from '@/api-client'
import {
  type SessionSettings as SessionSettingsRow,
  type UpdateSessionSettingsRequest,
} from '@/api-client/types'
import {
  Permissions,
} from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

/**
 * Admin view of the deployment-wide JWT session settings (singleton):
 * access-token TTL + max session length. Self-gated loaders +
 * `sync:session_settings` / `sync:reconnect` subscriptions so another admin's
 * edit refreshes this tab live.
 */
const SessionSettingsDef = defineStore('SessionSettings', {
  immer: true,
  state: {
    settings: null as SessionSettingsRow | null,
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
        const row = await ApiClient.Auth.getSessionSettings()
        set(s => {
          s.settings = row
          s.loading = false
        })
      } catch (error) {
        set(s => {
          s.error =
            error instanceof Error ? error.message : 'Failed to load session settings'
          s.loading = false
        })
      }
    }
    return {
      load,
      update: async (patch: UpdateSessionSettingsRequest): Promise<SessionSettingsRow> => {
        set(s => {
          s.saving = true
          s.error = null
        })
        try {
          const row = await ApiClient.Auth.updateSessionSettings(patch)
          set(s => {
            s.settings = row
            s.saving = false
          })
          return row
        } catch (error) {
          set(s => {
            s.error = error instanceof Error ? error.message : 'Update failed'
            s.saving = false
          })
          throw error
        }
      },
    }
  },
  // Loader hits the `auth::session_settings::read`-gated endpoint. Self-gate so
  // non-admins never generate 403s (incl. on the audience-agnostic reconnect).
  init: ({ on, actions }) => {
    const reload = () => {
      if (!hasPermissionNow(Permissions.SessionSettingsRead)) return
      void actions.load()
    }
    on('sync:session_settings', reload)
    on('sync:reconnect', reload)
    if (hasPermissionNow(Permissions.SessionSettingsRead)) void actions.load()
  },
})

export const useSessionSettingsStore = SessionSettingsDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'SessionSettings'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const SessionSettings = registerLazyStore(SessionSettingsDef)
