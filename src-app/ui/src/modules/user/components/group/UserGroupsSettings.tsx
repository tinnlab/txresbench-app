import { Plus } from 'lucide-react'
import {
  Alert,
  Button,
  Empty,
  Form,
  FormField,
  useForm,
  zodResolver,
  Input,
  Textarea,
  Tooltip,
  message,
  ErrorState,
} from '@ziee/kit'
import { ListPagination } from '@/components/common/ListPagination'
import { z } from 'zod'
import { Loading } from '@ziee/shell'
import { Drawer } from '@ziee/shell'
import { useEffect, useState } from 'react'
import { UserGroups } from '@/modules/user/stores/UserGroups.store'
import { runAction } from '@/core/actions/defineAction'
import { GroupMembersDrawer as GroupMembersDrawerStore } from '@/modules/user/components/group/GroupMembersDrawer.store'
import { EditUserGroupDrawer as EditUserGroupDrawerStore } from '@/modules/user/components/group/EditUserGroupDrawer.store'
import { Can, usePermission } from '@/core/permissions'
import { type CreateGroupRequest, type Group } from '@/api-client/types'
import { Permissions } from '@/api-client/permissions'
import { SettingsPageContainer } from '@ziee/shell'
import { EditUserGroupDrawer } from '@/modules/user/components/group/EditUserGroupDrawer.tsx'
import { GroupMembersDrawer } from '@/modules/user/components/group/GroupMembersDrawer.tsx'
import { GroupListItem } from '@/modules/user/components/group/GroupListItem.tsx'
import { PermissionsField } from '@/modules/user/components/PermissionsField.tsx'

interface CreateGroupFormValues {
  name: string
  description?: string
  permissions?: string[]
}

const schema = z.object({
  name: z.string().min(1, 'Please enter group name'),
  description: z.string().optional(),
  permissions: z.array(z.string()).optional(),
})

export function UserGroupsSettings() {
  const {
    groups,
    total: totalGroups,
    currentPage: storePage,
    pageSize: storePageSize,
    loadingGroups,
    error,
  } = UserGroups

  const [createModalVisible, setCreateModalVisible] = useState(false)
  const createForm = useForm<CreateGroupFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', description: '', permissions: [] },
  })
  const canCreate = usePermission(Permissions.GroupsCreate)

  // Toast only user-action failures (a mutation against already-loaded data).
  // A load failure renders as a persistent ErrorState below, not toast-only.
  useEffect(() => {
    if (error && groups.length > 0) {
      message.error(error)
      UserGroups.clearError()
    }
  }, [error, groups.length])

  const handleCreateGroup = async (values: CreateGroupFormValues) => {
    try {
      const groupData: CreateGroupRequest = {
        name: values.name,
        description: values.description,
        permissions: values.permissions ?? [],
      }
      // Permissioned `group.create` action (thin wrapper over the SAME store method).
      await runAction('group.create', groupData)
      message.success('User group created successfully')
      setCreateModalVisible(false)
      createForm.reset()
    } catch (error) {
      console.error('Failed to create user group:', error)
      // Error is handled by the store
    }
  }

  const handleDeleteGroup = async (groupId: string) => {
    try {
      await runAction('group.delete', { id: groupId })
      message.success('User group deleted successfully')
    } catch (error) {
      console.error('Failed to delete user group:', error)
      // Error is handled by the store
    }
  }

  const handleViewMembers = (group: Group) => {
    GroupMembersDrawerStore.openGroupMembersDrawer(group)
  }

  const openEditModal = (group: Group) => {
    EditUserGroupDrawerStore.openUserGroupDrawer(group)
  }

  const handlePageChange = (page: number, size?: number) => {
    const newPageSize = size || storePageSize
    const newPage = size && size !== storePageSize ? 1 : page // Reset to page 1 if page size changes

    UserGroups.loadUserGroups(newPage, newPageSize)
  }

  // Title row with the Add button on the right — matches the
  // pattern used by HardwareSettings (Monitor button) and the
  // other settings pages that hoist their primary action up to
  // the page title.
  const titleWithButton = (
    <div className="flex items-center justify-between w-full">
      <span>User Groups</span>
      <Can permission={Permissions.GroupsCreate}>
        <Tooltip title="Create group">
          <Button
            variant="default"
            size="icon"
            icon={<Plus aria-hidden="true" />}
            onClick={() => setCreateModalVisible(true)}
            aria-label="Create group"
            data-testid="user-groups-create-button"
          />
        </Tooltip>
      </Can>
    </div>
  )

  return (
    <SettingsPageContainer title={titleWithButton}>
      {loadingGroups ? (
        <Loading />
      ) : groups.length === 0 ? (
        error ? (
          <ErrorState
            resource="user groups"
            description="The user groups couldn't be loaded. Check your connection and try again."
            details={error}
            onRetry={() => UserGroups.loadUserGroups(storePage, storePageSize)}
            data-testid="user-groups-error"
          />
        ) : (
          <Empty description="No user groups yet" data-testid="user-groups-empty" />
        )
      ) : (
        // Each GroupListItem already renders its own <Card>, so
        // dropping the outer wrapping card makes every group a
        // direct child of SettingsPageContainer — the container's
        // gap-3 handles the spacing between them.
        <>
          {groups.map(group => (
            <GroupListItem
              key={group.id}
              group={group}
              onEdit={openEditModal}
              onDelete={handleDeleteGroup}
              onViewMembers={handleViewMembers}
            />
          ))}
          <ListPagination
          data-testid="user-groups-pagination"
          current={storePage}
          total={totalGroups}
          pageSize={storePageSize}
          onChange={(page) => handlePageChange(page)}
          onPageSizeChange={(size) => handlePageChange(1, size)}
          itemNoun="groups"
          aria-label="Groups pagination"
        />
        </>
      )}

      {/* Create Group Modal */}
      <Drawer
        title="Create User Group"
        open={createModalVisible}
        onClose={() => {
          setCreateModalVisible(false)
          createForm.reset()
        }}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setCreateModalVisible(false)
                createForm.reset()
              }}
              data-testid="user-create-group-cancel-button"
            >
              {canCreate ? 'Cancel' : 'Close'}
            </Button>
            {canCreate && (
              <Button type="submit" form="create-group-form" data-testid="user-create-group-submit-button">
                Create
              </Button>
            )}
          </div>
        }
        size={600}
        mask={{ closable: false }}
      >
        {/* One wrapper so the Drawer body (a flex ROW) keeps banner-above-form. */}
        <div className="flex flex-col">
          {/* The opener above is itself `Can`-gated, so this state is only reached
              when `groups::create` is REVOKED while the drawer is already open (a
              live Session sync). It is still a silent refusal — greyed fields, no
              Create button — so it says why. */}
          {!canCreate && (
            <Alert
              data-testid="user-create-group-readonly-alert"
              tone="info"
              title="Read-only view"
              description="You don't have the “groups::create” permission, so these fields are read-only and no group can be created here."
              className="mb-3"
            />
          )}

          <Form
            name="create-group-form"
            form={createForm}
            layout="vertical"
            onSubmit={handleCreateGroup}
            disabled={!canCreate}
            data-testid="user-create-group-form"
          >
            <FormField name="name" label="Group Name" required>
              <Input placeholder="Enter group name" data-testid="user-create-group-name-input" />
            </FormField>
            <FormField name="description" label="Description">
              <Textarea rows={3} placeholder="Enter group description" data-testid="user-create-group-description-textarea" />
            </FormField>
            <FormField name="permissions" label="Permissions">
              <PermissionsField disabled={!canCreate} />
            </FormField>
          </Form>
        </div>
      </Drawer>

      {/* Edit Group Drawer */}
      <EditUserGroupDrawer />

      {/* Group Members Drawer */}
      <GroupMembersDrawer />
    </SettingsPageContainer>
  )
}
