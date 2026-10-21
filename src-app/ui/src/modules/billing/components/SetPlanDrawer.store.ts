import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

/** Open/close state for the Set-plan drawer (#45). Tiny UI-only store, mirroring
 *  `CreateOrgDrawer.store.ts`. */
const SetPlanDrawerDef = defineStore('SetPlanDrawer', {
  state: { isOpen: false },
  actions: set => ({
    open: () => set({ isOpen: true }),
    close: () => set({ isOpen: false }),
  }),
})

export const useSetPlanDrawerStore = SetPlanDrawerDef.store
export const SetPlanDrawer = registerLazyStore(SetPlanDrawerDef)
