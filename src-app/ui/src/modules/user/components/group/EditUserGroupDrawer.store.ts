import { ApiClient } from '@/api-client'
import { Permissions } from '@/api-client/permissions'
import type { Group } from '@/api-client/types'
import { hasPermissionNow } from '@/core/permissions'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

const EditUserGroupDrawerDef = defineStore('EditUserGroupDrawer', {
  state: { isOpen: false, editingGroup: null as Group | null },
  actions: set => ({
    openUserGroupDrawer: (group: Group) => set({ isOpen: true, editingGroup: group }),
    closeUserGroupDrawer: () => set({ isOpen: false, editingGroup: null }),
  }),
  init: ({ on, get, set, actions }) => {
    // See `EditUserDrawer.store` — notify-and-refetch, not a payload patch.
    on('sync:group', event => {
      const held = get().editingGroup
      if (!held || held.id !== event.data.id) return
      if (event.data.action === 'delete') {
        actions.closeUserGroupDrawer()
        return
      }
      if (!hasPermissionNow(Permissions.GroupsRead)) return
      void ApiClient.UserGroup.get({ group_id: held.id })
        .then(fresh => {
          if (get().editingGroup?.id === fresh.id) set({ editingGroup: fresh })
        })
        .catch(() => {})
    })
  },
})

export const useUserGroupDrawerStore = EditUserGroupDrawerDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'EditUserGroupDrawer'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const EditUserGroupDrawer = registerLazyStore(EditUserGroupDrawerDef)

