import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

/**
 * Portable "what kind of build is this" flag for core UI code that branches on
 * multi-user (web) vs single-admin (desktop) semantics without importing the
 * desktop-only platform helpers. Default true (web); the desktop bootstrap flips
 * it to false at startup.
 */
interface AppModeState {
  multiUserMode: boolean
  setMultiUserMode: (value: boolean) => void
}


const AppModeDef = defineStore('AppMode', {
  state: { multiUserMode: true },
  actions: set => ({
    setMultiUserMode: (value: boolean) => set({ multiUserMode: value }),
  }),
})

export const useAppModeStore = AppModeDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'AppMode'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const AppMode = registerLazyStore(AppModeDef)

