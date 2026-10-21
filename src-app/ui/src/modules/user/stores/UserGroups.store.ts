import { ApiClient } from '@/api-client'
import {
  type CreateGroupRequest,
  type Group,
  type UpdateGroupRequest,
} from '@/api-client/types'
import {
  Permissions,
} from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'
import { echoLocalSync } from '@/core/sync/localEcho'

// Tracks in-flight group-member fetch promises so concurrent requests for the
// same group await the in-flight call instead of returning stale data (a false
// negative when a user belongs to 2+ groups).
const pendingMemberRequests = new Map<string, Promise<void>>()

interface GroupMember {
  id: string
  username: string
  email: string
  is_active: boolean
  joined_at: string
}

const UserGroupsDef = defineStore('UserGroups', {
  state: {
    groups: [] as Group[],
    currentGroupMembers: [] as GroupMember[],
    total: 0,
    currentPage: 1,
    pageSize: 10,
    isInitialized: false,
    currentGroupId: null as string | null,
    loading: false,
    loadingGroups: false,
    loadingGroupMembers: false,
    creating: false,
    updating: false,
    deleting: false,
    error: null as string | null,
  },
  actions: (set, get) => {
    const loadUserGroups = async (page?: number, pageSize?: number) => {
      if (!hasPermissionNow(Permissions.GroupsRead)) return
      try {
        const currentState = get()
        const requestPage = page || currentState.currentPage
        const requestPageSize = pageSize || currentState.pageSize
        // Skip if already initialized and loading first page without explicit page.
        if (currentState.isInitialized && currentState.loadingGroups && !page) return
        set({ loadingGroups: true, error: null })
        const response = await ApiClient.UserGroup.list({
          page: requestPage,
          per_page: requestPageSize,
        })
        set({
          // Guard: a malformed/edge response must not set `groups` undefined —
          // consumers (UserGroupsDrawer) map over it unconditionally.
          groups: Array.isArray(response.groups) ? response.groups : [],
          total: response.total,
          currentPage: response.page,
          pageSize: response.per_page,
          isInitialized: true,
          loadingGroups: false,
        })
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : 'Failed to load groups',
          loadingGroups: false,
        })
        throw error
      }
    }
    const loadUserGroupMembers = async (groupId: string) => {
      // Await an in-flight fetch for this group so the caller reads fresh data
      // rather than a stale false-negative membership check.
      const inFlight = pendingMemberRequests.get(groupId)
      if (inFlight) {
        await inFlight
        return
      }
      try {
        set({ loadingGroupMembers: true, error: null, currentGroupId: groupId })
        const promise = ApiClient.UserGroup.getMembers({
          group_id: groupId,
          page: 1,
          per_page: 50,
        }).then(response => {
          set({
            currentGroupMembers: (Array.isArray(response.users)
              ? response.users
              : []
            ).map(u => ({
              id: u.id,
              username: u.username,
              email: u.email,
              is_active: u.is_active,
              joined_at: new Date().toISOString(),
            })),
            loadingGroupMembers: false,
          })
        })
        pendingMemberRequests.set(groupId, promise)
        await promise
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : 'Failed to load group members',
          loadingGroupMembers: false,
        })
        throw error
      } finally {
        pendingMemberRequests.delete(groupId)
      }
    }
    return {
      loadUserGroups,
      loadUserGroupMembers,
      createUserGroup: async (data: CreateGroupRequest): Promise<Group | undefined> => {
        if (get().creating) return
        try {
          set({ creating: true, error: null })
          const group = await ApiClient.UserGroup.create(data)
          set({ creating: false })
          await echoLocalSync('group', 'create', group.id)
          return group
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Failed to create group',
            creating: false,
          })
          throw error
        }
      },
      updateUserGroup: async (
        id: string,
        data: UpdateGroupRequest,
      ): Promise<Group | undefined> => {
        if (get().updating) return
        try {
          set({ updating: true, error: null })
          const group = await ApiClient.UserGroup.update({ group_id: id, ...data })
          set({ updating: false })
          await echoLocalSync('group', 'update', id)
          return group
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Failed to update group',
            updating: false,
          })
          throw error
        }
      },
      deleteUserGroup: async (id: string) => {
        if (get().deleting) return
        try {
          set({ deleting: true, error: null })
          await ApiClient.UserGroup.delete({ group_id: id })
          set({ deleting: false })
          await echoLocalSync('group', 'delete', id)
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Failed to delete group',
            deleting: false,
          })
          throw error
        }
      },
      assignUserToUserGroup: async (userId: string, groupId: string) => {
        const state = get()
        if (state.updating) return
        try {
          set({ updating: true, error: null })
          await ApiClient.UserGroup.assignUser({ user_id: userId, group_id: groupId })
          set({ updating: false })
          // `assign_user_to_group` publishes Group/Update (id = the GROUP). The member
          // list refresh hangs off that same frame in `init`, so it happens here and on
          // every other device by one mechanism — not inline here and by refetch there.
          await echoLocalSync('group', 'update', groupId)
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Failed to assign user to group',
            updating: false,
          })
          throw error
        }
      },
      removeUserFromUserGroup: async (userId: string, groupId: string) => {
        if (get().updating) return
        try {
          set({ updating: true, error: null })
          await ApiClient.UserGroup.removeUser({ user_id: userId, group_id: groupId })
          set({ updating: false })
          await echoLocalSync('group', 'update', groupId)
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Failed to remove user from group',
            updating: false,
          })
          throw error
        }
      },
      clearError: () => {
        set({ error: null })
      },
    }
  },
  init: ({ on, get, set, actions }) => {
    // ONE channel — the parallel `group.*` / `user.*` EventBus space is gone (see
    // `Users.store` for the argument). Everything it carried is expressible as
    // notify-and-refetch, because every fact it carried is on the server:
    //
    //   group.created/updated/deleted  → `sync:group` + the list refetch below
    //   group.member_added/removed     → `sync:group` (the server publishes
    //                                     Group/Update on assign AND remove, id = the
    //                                     group) + the member refetch below
    //   user.deleted                   → `sync:user` (a deleted member leaves the
    //                                     member list)
    //
    // Remote sync: loadUserGroups self-gates on GroupsRead.
    const reload = () => void actions.loadUserGroups()
    on('sync:group', event => {
      reload()
      // A membership change publishes Group/Update naming the group; refresh the OPEN
      // group's member list. Refetched rather than spliced: the removal case used to
      // filter locally from a payload, which cannot see a membership change made
      // anywhere else.
      if (get().currentGroupId && event.data.id === get().currentGroupId) {
        void actions.loadUserGroupMembers(event.data.id)
      }
    })
    on('sync:user', event => {
      if (event.data.action !== 'delete') return
      set(state => ({
        currentGroupMembers: state.currentGroupMembers.filter(m => m.id !== event.data.id),
      }))
    })
    on('sync:reconnect', () => {
      reload()
      const open = get().currentGroupId
      if (open) void actions.loadUserGroupMembers(open)
    })
    void actions.loadUserGroups()
  },
})

export const useUserGroupsStore = UserGroupsDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'UserGroups'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const UserGroups = registerLazyStore(UserGroupsDef)

