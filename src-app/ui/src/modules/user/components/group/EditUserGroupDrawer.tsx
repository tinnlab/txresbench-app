import { z } from 'zod'
import { Alert, Button, Form, FormField, Input, Switch, Textarea, message, useForm, zodResolver } from '@ziee/kit'
import { Drawer } from '@ziee/shell'
import { useEffect, useState } from 'react'
import { EditUserGroupDrawer as EditUserGroupDrawerStore } from '@/modules/user/components/group/EditUserGroupDrawer.store'
import { runAction } from '@/core/actions/defineAction'
import { usePermission } from '@/core/permissions'
import { type UpdateGroupRequest } from '@/api-client/types'
import { Permissions } from '@/api-client/permissions'
import { PermissionsField } from '@/modules/user/components/PermissionsField.tsx'

const editUserGroupSchema = z.object({
  name: z
    .string()
    .min(1, 'Please enter a group name')
    .min(2, 'Group name must be at least 2 characters'),
  description: z.string().optional(),
  permissions: z.array(z.string()).optional(),
  is_active: z.boolean().optional(),
})

type EditUserGroupValues = z.infer<typeof editUserGroupSchema>

export function EditUserGroupDrawer() {
  const [loading, setLoading] = useState(false)

  const { isOpen: open, editingGroup: group } = EditUserGroupDrawerStore
  const canEdit = usePermission(Permissions.GroupsEdit)

  const form = useForm<EditUserGroupValues>({
    resolver: zodResolver(editUserGroupSchema),
    defaultValues: {
      name: '',
      description: '',
      permissions: [],
      is_active: true,
    },
  })

  // Load group data when it changes
  useEffect(() => {
    if (group && open) {
      form.reset({
        name: group.name,
        description: group.description,
        permissions: group.permissions ?? [],
        is_active: group.is_active,
      })
    }
  }, [group, open, form])

  const handleClose = () => {
    form.reset()
    EditUserGroupDrawerStore.closeUserGroupDrawer()
  }

  const handleSubmit = async (values: EditUserGroupValues) => {
    if (!group) return

    try {
      setLoading(true)

      const updateData: UpdateGroupRequest = {
        name: values.name,
        description: values.description,
        permissions: values.permissions ?? [],
        is_active: values.is_active,
      }

      // Permissioned `group.update` action (thin wrapper over the SAME store method).
      await runAction('group.update', { id: group.id, ...updateData })
      message.success('User group updated successfully')
      handleClose()
    } catch (error) {
      console.error('Failed to update user group:', error)
      message.error('Failed to update user group')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Drawer
      title={group ? `Edit Group: ${group.name}` : 'Edit User Group'}
      open={open}
      onClose={handleClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={handleClose} disabled={loading} data-testid="user-edit-group-cancel-button">
            {canEdit ? 'Cancel' : 'Close'}
          </Button>
          {canEdit && (
            <Button type="submit" form="edit-user-group-form" loading={loading} data-testid="user-edit-group-save-button">
              Save
            </Button>
          )}
        </div>
      }
      size={600}
      mask={{ closable: false }}
    >
      {/* One wrapper so the Drawer body (a flex ROW) keeps banner-above-form. */}
      <div className="flex flex-col">
        {/* A disabled form whose Save button is also gone refuses the user in
            silence. State the reason (the settings-page read-only banner). */}
        {!canEdit && (
          <Alert
            data-testid="user-edit-group-readonly-alert"
            tone="info"
            title="Read-only view"
            description="You don't have the “groups::edit” permission, so these fields are read-only and this group can't be changed here."
            className="mb-3"
          />
        )}

        <Form
          name="edit-user-group-form"
          form={form}
          layout="vertical"
          onSubmit={handleSubmit}
          disabled={!canEdit}
          data-testid="user-edit-group-form"
        >
          <FormField
            name="name"
            label="Group Name"
          >
            <Input placeholder="Enter group name" data-testid="user-edit-group-name-input" />
          </FormField>

          <FormField name="is_active" label="Active" valuePropName="checked">
            <Switch aria-label="Set group as active or inactive" data-testid="user-edit-group-active-switch" />
          </FormField>

          <FormField name="description" label="Description">
            <Textarea
              placeholder="Enter group description (optional)"
              rows={3}
              maxLength={500}
              data-testid="user-edit-group-description-textarea"
            />
          </FormField>

          <FormField name="permissions" label="Permissions">
            <PermissionsField disabled={!canEdit} />
          </FormField>
        </Form>
      </div>
    </Drawer>
  )
}
