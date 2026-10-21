import { ApiClient } from '@/api-client'
import { Permissions } from '@/api-client/permissions'
import type { Group } from '@/api-client/types'
import { hasPermissionNow } from '@/core/permissions'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

const GroupMembersDrawerDef = defineStore('GroupMembersDrawer', {
  state: { isOpen: false, selectedGroup: null as Group | null },
  actions: set => ({
    openGroupMembersDrawer: (group: Group) => set({ isOpen: true, selectedGroup: group }),
    closeGroupMembersDrawer: () => set({ isOpen: false, selectedGroup: null }),
  }),
  init: ({ on, get, set, actions }) => {
    // See `EditUserDrawer.store` — notify-and-refetch, not a payload patch.
    on('sync:group', event => {
      const held = get().selectedGroup
      if (!held || held.id !== event.data.id) return
      if (event.data.action === 'delete') {
        actions.closeGroupMembersDrawer()
        return
      }
      if (!hasPermissionNow(Permissions.GroupsRead)) return
      void ApiClient.UserGroup.get({ group_id: held.id })
        .then(fresh => {
          if (get().selectedGroup?.id === fresh.id) set({ selectedGroup: fresh })
        })
        .catch(() => {})
    })
  },
})

export const useGroupMembersDrawerStore = GroupMembersDrawerDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'GroupMembersDrawer'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const GroupMembersDrawer = registerLazyStore(GroupMembersDrawerDef)

