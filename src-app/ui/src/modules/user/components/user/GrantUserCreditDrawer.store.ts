import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

/**
 * Open/close + target state for the per-user Grant-credit drawer (#43). Tiny UI-only
 * store, mirroring `modules/billing/components/GrantCreditDrawer.store.ts` — but it
 * also carries the TARGET personal-account id + a human LABEL (`display_name ??
 * username`, never a raw UUID — INV-3) so the drawer grants to the row it was opened
 * from without a separate selection store.
 */
const GrantUserCreditDrawerDef = defineStore('GrantUserCreditDrawer', {
  state: {
    isOpen: false,
    accountId: null as string | null,
    label: '' as string,
  },
  actions: set => ({
    open: (accountId: string, label: string) => set({ isOpen: true, accountId, label }),
    close: () => set({ isOpen: false, accountId: null, label: '' }),
  }),
})

export const useGrantUserCreditDrawerStore = GrantUserCreditDrawerDef.store
export const GrantUserCreditDrawer = registerLazyStore(GrantUserCreditDrawerDef)
