import { ApiClient } from '@/api-client'
import type { PublicProvider } from '@/api-client/types'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

interface AuthProvidersState {
  providers: PublicProvider[]
  isLoading: boolean
  error?: string | null
  hasLoaded: boolean
  loadProviders: () => Promise<void>
}


const AuthProvidersDef = defineStore('AuthProviders', {
  state: {
    providers: [] as PublicProvider[],
    isLoading: false,
    error: null as string | null | undefined,
    hasLoaded: false,
  },
  actions: (set, get) => ({
    loadProviders: async () => {
      if (get().isLoading) return
      set({ isLoading: true, error: null })
      try {
        const res = await ApiClient.Auth.listProviders(undefined, undefined)
        set({ providers: res.providers, isLoading: false, hasLoaded: true })
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : 'Failed to load providers',
          isLoading: false,
          hasLoaded: true,
        })
      }
    },
  }),
  // Auto-load on first access (was `__init__.providers`) so the login page's
  // <ProviderButtons> doesn't fetch in a useEffect.
  init: ({ actions }) => {
    void actions.loadProviders()
  },
})

export const useAuthProvidersStore = AuthProvidersDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'AuthProviders'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const AuthProviders = registerLazyStore(AuthProvidersDef)

