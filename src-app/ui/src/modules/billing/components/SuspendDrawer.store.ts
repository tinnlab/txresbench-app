import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

/** Open/close state for the Suspend-account drawer (#45). Tiny UI-only store. */
const SuspendDrawerDef = defineStore('SuspendDrawer', {
  state: { isOpen: false },
  actions: set => ({
    open: () => set({ isOpen: true }),
    close: () => set({ isOpen: false }),
  }),
})

export const useSuspendDrawerStore = SuspendDrawerDef.store
export const SuspendDrawer = registerLazyStore(SuspendDrawerDef)
