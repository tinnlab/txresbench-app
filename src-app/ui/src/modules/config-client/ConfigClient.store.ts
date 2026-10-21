import { createJSONStorage } from 'zustand/middleware'
import {
  type AccentPreset,
  ACCENT_PRESETS,
  configClientSeam,
  DEFAULT_ACCENT,
} from '@ziee/shell'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'
import type { StoreProxy } from '@ziee/framework/stores'

// Guarded persistence storage. Accessing `localStorage` throws in locked-down
// contexts (private-mode quota, disabled storage, sandboxed iframe). Probe once
// and fall back to in-memory so store creation never takes the app down; the
// preference simply won't survive a reload there.
const safeStorage = createJSONStorage(() => {
  try {
    const probe = '__ziee_ls_probe__'
    window.localStorage.setItem(probe, probe)
    window.localStorage.removeItem(probe)
    return window.localStorage
  } catch {
    const mem = new Map<string, string>()
    return {
      getItem: (name: string) => mem.get(name) ?? null,
      setItem: (name: string, value: string) => {
        mem.set(name, value)
      },
      removeItem: (name: string) => {
        mem.delete(name)
      },
    }
  }
})

export type ThemePreference = 'light' | 'dark' | 'system'

// Guard against a stale persisted accent id that no longer exists in code.
const normalizeAccent = (a: AccentPreset): AccentPreset =>
  a in ACCENT_PRESETS ? a : DEFAULT_ACCENT

const ConfigClientDef = defineStore('ConfigClient', {
  persist: {
    name: 'config-client-storage',
    storage: safeStorage,
    partialize: state => ({
      themePreference: state.themePreference,
      accentPreset: state.accentPreset,
    }),
    merge: (persisted, current) => {
      const p = (persisted ?? {}) as {
        themePreference?: ThemePreference
        accentPreset?: AccentPreset
      }
      return {
        ...current,
        ...p,
        accentPreset: normalizeAccent(p.accentPreset ?? current.accentPreset),
      }
    },
  },
  state: {
    themePreference: 'system' as ThemePreference,
    /** User-selected brand accent (Settings → Appearance). Drives --primary/--ring. */
    accentPreset: DEFAULT_ACCENT as AccentPreset,
  },
  actions: (set, get) => ({
    setThemePreference: (preference: ThemePreference) => {
      set({ themePreference: preference })
    },
    getThemePreference: (): ThemePreference => get().themePreference,
    setAccentPreset: (preset: AccentPreset) => {
      set({ accentPreset: normalizeAccent(preset) })
    },
  }),
})

/**
 * The reactive store PROXY (what the removed global registry lookup
 * resolved to). `registerLazyStore` builds it ONCE and self-registers it under
 * the name `'ConfigClient'`, so this module's `stores: [...]` entry REUSES this
 * instance instead of building a second one with an independent ref count —
 * which would run `init` (and any `sync:*` listener) twice.
 */
export const ConfigClient = registerLazyStore(ConfigClientDef)

// SEAM: inject into the SDK shell's ThemeProvider (`@ziee/shell`
// theme/ThemeProvider.tsx reads `configClientSeam.get()`), replacing the old
// global registry lookup. Runs at module scope, and this file is
// imported by `config-client/module.tsx` — which `loadModules()` pulls in
// eagerly (`import.meta.glob('./**/module.tsx', { eager: true })`) before
// `<AppShell>` ever renders, so the seam is always set before the first read.
configClientSeam.set(ConfigClient)

export const useConfigClientStore = ConfigClientDef.store

declare module '@ziee/framework/stores' {
  interface RegisteredStores {
    ConfigClient: StoreProxy<
      ReturnType<typeof ConfigClientDef.store.getState>
    >
  }
}
