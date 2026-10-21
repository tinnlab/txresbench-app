import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

/**
 * Open/close state for the Create-organization drawer (#44, ITEM-4). Mirrors
 * `CreateUserDrawer.store.ts` — a tiny UI-only store the page and drawer share.
 */
const CreateOrgDrawerDef = defineStore('CreateOrgDrawer', {
  state: { isOpen: false },
  actions: set => ({
    open: () => set({ isOpen: true }),
    close: () => set({ isOpen: false }),
  }),
})

export const useCreateOrgDrawerStore = CreateOrgDrawerDef.store

export const CreateOrgDrawer = registerLazyStore(CreateOrgDrawerDef)
