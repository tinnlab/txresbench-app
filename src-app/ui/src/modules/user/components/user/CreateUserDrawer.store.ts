import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

const CreateUserDrawerDef = defineStore('CreateUserDrawer', {
  state: { isOpen: false },
  actions: set => ({
    openCreateUserDrawer: () => set({ isOpen: true }),
    closeCreateUserDrawer: () => set({ isOpen: false }),
  }),
})

export const useCreateUserDrawerStore = CreateUserDrawerDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'CreateUserDrawer'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const CreateUserDrawer = registerLazyStore(CreateUserDrawerDef)

