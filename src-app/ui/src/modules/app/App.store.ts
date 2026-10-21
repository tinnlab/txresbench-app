import { ApiClient } from '@/api-client'
import type { SetupAdminRequest } from '@/api-client/types'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

interface AppState {
  needsSetup: boolean | null
  isCheckingSetup: boolean
  isSettingUpAdmin: boolean
  setupError: string | null
  checkSetupStatus: () => Promise<void>
  setupAdmin: (request: SetupAdminRequest) => Promise<void>
  clearSetupError: () => void
}


const AppDef = defineStore('App', {
  state: {
    needsSetup: null as boolean | null,
    isCheckingSetup: false,
    isSettingUpAdmin: false,
    setupError: null as string | null,
  },
  actions: (set, get) => ({
    checkSetupStatus: async () => {
      if (get().isCheckingSetup) return
      set({ isCheckingSetup: true })
      try {
        const response = await ApiClient.App.getSetupStatus(undefined, undefined)
        set({ needsSetup: response.needs_setup, isCheckingSetup: false })
      } catch (error) {
        console.error('Failed to check setup status:', error)
        // If we can't check, assume setup is needed (safe default).
        set({ needsSetup: true, isCheckingSetup: false })
      }
    },
    setupAdmin: async (request: SetupAdminRequest) => {
      if (get().isSettingUpAdmin) return
      set({ isSettingUpAdmin: true, setupError: null })
      try {
        await ApiClient.App.setupAdmin(request, undefined)
        set({ isSettingUpAdmin: false, needsSetup: false, setupError: null })
      } catch (error: any) {
        const message =
          error?.response?.data?.message || error?.message || 'Setup failed. Please try again.'
        set({ isSettingUpAdmin: false, setupError: message })
        throw error
      }
    },
    clearSetupError: () => set({ setupError: null }),
  }),
})

export const useAppStore = AppDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'App'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const App = registerLazyStore(AppDef)

