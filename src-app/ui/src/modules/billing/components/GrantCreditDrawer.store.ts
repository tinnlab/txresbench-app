import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

/** Open/close state for the Grant-credit drawer (#47). Tiny UI-only store,
 *  mirroring `CreateOrgDrawer.store.ts`. */
const GrantCreditDrawerDef = defineStore('GrantCreditDrawer', {
  state: { isOpen: false },
  actions: set => ({
    open: () => set({ isOpen: true }),
    close: () => set({ isOpen: false }),
  }),
})

export const useGrantCreditDrawerStore = GrantCreditDrawerDef.store
export const GrantCreditDrawer = registerLazyStore(GrantCreditDrawerDef)
