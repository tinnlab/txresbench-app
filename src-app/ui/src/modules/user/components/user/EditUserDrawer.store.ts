import { ApiClient } from '@/api-client'
import { Permissions } from '@/api-client/permissions'
import type { User } from '@/api-client/types'
import { hasPermissionNow } from '@/core/permissions'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

const EditUserDrawerDef = defineStore('EditUserDrawer', {
  state: { isOpen: false, editingUser: null as User | null },
  actions: set => ({
    openEditUserDrawer: (user: User) => set({ isOpen: true, editingUser: user }),
    closeEditUserDrawer: () => set({ isOpen: false, editingUser: null }),
  }),
  init: ({ on, get, set, actions }) => {
    // `sync:user` carries `{action, id}` only, so a row this drawer is holding is
    // REFETCHED rather than patched from an event payload. That is the whole point of
    // converging: the payload channel could only ever carry what the ACTING tab
    // happened to know, so an edit made on another device left this drawer stale.
    on('sync:user', event => {
      const held = get().editingUser
      if (!held || held.id !== event.data.id) return
      if (event.data.action === 'delete') {
        actions.closeEditUserDrawer()
        return
      }
      if (!hasPermissionNow(Permissions.UsersRead)) return
      void ApiClient.User.get({ user_id: held.id })
        .then(fresh => {
          // Re-check: the drawer may have been closed or re-pointed while in flight.
          if (get().editingUser?.id === fresh.id) set({ editingUser: fresh })
        })
        .catch(() => {
          /* the row is gone or no longer visible — the delete branch handles removal */
        })
    })
  },
})

export const useEditUserDrawerStore = EditUserDrawerDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'EditUserDrawer'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const EditUserDrawer = registerLazyStore(EditUserDrawerDef)

