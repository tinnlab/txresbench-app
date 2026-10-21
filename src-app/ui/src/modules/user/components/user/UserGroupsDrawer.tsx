import { Plus, Users } from 'lucide-react'
import { Loading } from '@ziee/shell'
import { Drawer } from '@ziee/shell'
import { UserGroupsDrawer as UserGroupsDrawerStore } from '@/modules/user/components/user/UserGroupsDrawer.store'
import { UserGroups } from '@/modules/user/stores/UserGroups.store'
import { AssignGroupDrawer } from '@/modules/user/components/user/AssignGroupDrawer.store'
import { runAction } from '@/core/actions/defineAction'
import { usePermission } from '@/core/permissions'
import { Permissions } from '@/api-client/permissions'
import { useEffect, useState } from 'react'
import {
  message,
  Tag,
  Confirm,
  Button,
  Empty,
  List,
} from '@ziee/kit'

export function UserGroupsDrawer() {
  const { isOpen, user } = UserGroupsDrawerStore
  const { groups } = UserGroups
  const [userGroupIds, setUserGroupIds] = useState<Set<string>>(new Set())
  const [loadingUserGroups, setLoadingUserGroups] = useState(false)
  const canAssign = usePermission(Permissions.GroupsAssignUsers)

  // Load user's group memberships when drawer opens
  useEffect(() => {
    if (!isOpen || !user) return

    const loadUserGroups = async () => {
      setLoadingUserGroups(true)
      try {
        // Load members for each group to determine user's memberships
        const membershipPromises = groups.map(async group => {
          try {
            await UserGroups.loadUserGroupMembers(group.id)
            return { groupId: group.id, isMember: false } // Will update based on members
          } catch {
            return { groupId: group.id, isMember: false }
          }
        })

        await Promise.all(membershipPromises)

        // Check which groups the user belongs to by examining currentGroupMembers
        const userGroups = new Set<string>()
        for (const group of groups) {
          await UserGroups.loadUserGroupMembers(group.id)
          const members = UserGroups.$.currentGroupMembers
          if (members.some(m => m.id === user.id)) {
            userGroups.add(group.id)
          }
        }

        setUserGroupIds(userGroups)
      } catch (error) {
        console.error('Failed to load user group memberships:', error)
      } finally {
        setLoadingUserGroups(false)
      }
    }

    loadUserGroups()
  }, [isOpen, user, groups])

  const handleRemoveFromGroup = async (groupId: string) => {
    if (!user) return

    try {
      // Permissioned `group.removeUser` action (thin wrapper over the SAME store method) —
      // equally AI-drivable, not a human-only handler (INV-1).
      await runAction('group.removeUser', { user_id: user.id, group_id: groupId })
      message.success('User removed from group successfully')

      // Update user groups list
      setUserGroupIds(prev => {
        const updated = new Set(prev)
        updated.delete(groupId)
        return updated
      })
    } catch (error) {
      console.error('Failed to remove user from group:', error)
      // Error is handled by the store
    }
  }

  const handleAssignToGroup = async (groupId: string) => {
    if (!user) return

    try {
      await runAction('group.assignUser', { user_id: user.id, group_id: groupId })
      message.success('User assigned to group')
      setUserGroupIds(prev => new Set([...prev, groupId]))
    } catch (error) {
      console.error('Failed to assign:', error)
    }
  }

  return (
    <Drawer
      title={`Groups for ${user?.username}`}
      placement="right"
      onClose={() => {
        UserGroupsDrawerStore.closeUserGroupsDrawer()
        setUserGroupIds(new Set())
      }}
      open={isOpen}
      size={600}
      footer={
        canAssign ? (
          <div className="flex justify-end">
            <Button
              variant="default"
              icon={<Plus aria-hidden="true" />}
              onClick={() => {
                UserGroupsDrawerStore.closeUserGroupsDrawer()
                if (user) {
                  AssignGroupDrawer.openAssignGroupDrawer(user)
                }
              }}
              data-testid="user-groups-drawer-assign-button"
            >
              Assign group
            </Button>
          </div>
        ) : undefined
      }
    >
      {loadingUserGroups ? (
        <Loading tip="Loading group memberships..." />
      ) : groups.length === 0 ? (
        <Empty description="No groups yet" data-testid="user-groups-drawer-empty" />
      ) : (
        <List
          dataSource={groups}
          rowKey="id"
          data-testid="user-groups-drawer-list"
          renderItem={group => {
            const isMember = userGroupIds.has(group.id)
            const action = canAssign ? (
              isMember ? (
                <Confirm
                  title="Remove user from this group?"
                  onConfirm={() => handleRemoveFromGroup(group.id)}
                  okText="OK"
                  cancelText="Cancel"
                  data-testid={`user-groups-drawer-remove-confirm-${group.id}`}
                >
                  <Button variant="link" size="default" data-testid={`user-groups-drawer-remove-button-${group.id}`}>
                    Remove
                  </Button>
                </Confirm>
              ) : (
                <Button
                  variant="link"
                  size="default"
                  onClick={() => handleAssignToGroup(group.id)}
                  data-testid={`user-groups-drawer-assign-row-button-${group.id}`}
                >
                  Assign
                </Button>
              )
            ) : null
            return (
              <div className="flex items-center gap-3" data-testid={`user-groups-drawer-row-${group.name}`}>
                <Users />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    {group.name}
                    {isMember && <Tag variant="outline" tone="success" data-testid={`user-groups-drawer-member-tag-${group.id}`}>Member</Tag>}
                    {group.is_system && <Tag variant="outline" tone="warning" data-testid={`user-groups-drawer-system-tag-${group.id}`}>System</Tag>}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {group.description || 'No description'}
                  </div>
                </div>
                {action && <div>{action}</div>}
              </div>
            )
          }}
        />
      )}
    </Drawer>
  )
}
