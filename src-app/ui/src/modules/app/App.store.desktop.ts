/**
 * DELIBERATE DIVERGENCE from core's App.store.
 *
 * Core's `checkSetupStatus()` hits `/api/app/setup/status` and, if `needs_setup`,
 * `app/module.tsx::initialize` bounces the SPA to `/setup`. On desktop the admin
 * is bootstrapped by the Tauri host BEFORE the webview opens, so `needs_setup` is
 * always false in production; the e2e specs also mock it true and assert desktop
 * does NOT redirect. This override pins `needsSetup: false` and neuters
 * `checkSetupStatus()`; `setupAdmin` stays functional.
 */
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
    // Pin to `false` — desktop's Tauri host always bootstraps the admin before
    // the webview opens (skipping `null` avoids brief setup-spinner branches).
    needsSetup: false as boolean | null,
    isCheckingSetup: false,
    isSettingUpAdmin: false,
    setupError: null as string | null,
  },
  actions: (set, get) => ({
    // No-op on desktop; `needsSetup` stays `false` (core redirects to /setup on true).
    checkSetupStatus: async () => {},
    setupAdmin: async (request: SetupAdminRequest) => {
      if (get().isSettingUpAdmin) return
      set({ isSettingUpAdmin: true, setupError: null })
      try {
        await ApiClient.App.setupAdmin(request, undefined)
        set({ isSettingUpAdmin: false, needsSetup: false, setupError: null })
      } catch (error: unknown) {
        const err = error as { response?: { data?: { message?: string } }; message?: string }
        const message =
          err?.response?.data?.message || err?.message || 'Setup failed. Please try again.'
        set({ isSettingUpAdmin: false, setupError: message })
        throw error
      }
    },
    clearSetupError: () => {
      set({ setupError: null })
    },
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


