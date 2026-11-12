import { defineStore, registerLazyStore } from '@txresbench/framework/store-kit'

/**
 * Open/close state for the Jobs drawer. A tiny global store so the sidebar
 * button (and anything else) can open the drawer from anywhere (mirrors
 * `CreateUserDrawer.store.ts`).
 */
const JobsDrawerDef = defineStore('JobsDrawer', {
  state: { isOpen: false },
  actions: set => ({
    open: () => set({ isOpen: true }),
    close: () => set({ isOpen: false }),
  }),
})

export const useJobsDrawerStore = JobsDrawerDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'JobsDrawer'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const JobsDrawer = registerLazyStore(JobsDrawerDef)
