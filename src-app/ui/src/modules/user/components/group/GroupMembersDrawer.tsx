import { User } from 'lucide-react'
import { useEffect } from 'react'
import { Drawer } from '@ziee/shell'
import { GroupMembersDrawer as GroupMembersDrawerStore } from '@/modules/user/components/group/GroupMembersDrawer.store'
import { UserGroups } from '@/modules/user/stores/UserGroups.store'
import { List, Tag } from '@ziee/kit'

export function GroupMembersDrawer() {
  const { isOpen: open, selectedGroup: group } = GroupMembersDrawerStore
  const { currentGroupMembers, loadingGroupMembers } = UserGroups

  // Load group members when group changes
  useEffect(() => {
    if (group && open) {
      UserGroups.loadUserGroupMembers(group.id)
    }
  }, [group, open])

  const handleClose = () => {
    GroupMembersDrawerStore.closeGroupMembersDrawer()
  }

  return (
    <Drawer
      title={group ? `Members of ${group.name}` : 'Group Members'}
      placement="right"
      onClose={handleClose}
      open={open}
      size={600}
    >
      <List
        loading={loadingGroupMembers}
        dataSource={currentGroupMembers}
        rowKey="id"
        data-testid="user-group-members-list"
        renderItem={user => (
          <div className="flex items-start gap-3" data-testid={`user-group-member-row-${user.username}`}>
            <User aria-hidden="true" className="mt-0.5 shrink-0" />
            <div className="flex flex-col gap-1">
              <span className="font-medium">{user.username}</span>
              <div>
                <div>{user.email}</div>
                <Tag variant="outline" tone={user.is_active ? 'success' : 'error'} data-testid={`user-group-member-status-tag-${user.id}`}>
                  {user.is_active ? 'Active' : 'Inactive'}
                </Tag>
              </div>
            </div>
          </div>
        )}
      />
    </Drawer>
  )
}
