import type { User } from '@/api-client/types'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

const UserGroupsDrawerDef = defineStore('UserGroupsDrawer', {
  state: { isOpen: false, user: null as User | null },
  actions: set => ({
    openUserGroupsDrawer: (user: User) => set({ isOpen: true, user }),
    closeUserGroupsDrawer: () => set({ isOpen: false, user: null }),
  }),
  init: ({ on, get, actions }) => {
    // Close-on-delete needs only `{action, id}`, which is exactly what the wire
    // carries — no payload channel was ever required for this.
    on('sync:user', event => {
      if (event.data.action !== 'delete') return
      if (get().user?.id === event.data.id) actions.closeUserGroupsDrawer()
    })
  },
})

export const useUserGroupsDrawerStore = UserGroupsDrawerDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'UserGroupsDrawer'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const UserGroupsDrawer = registerLazyStore(UserGroupsDrawerDef)

