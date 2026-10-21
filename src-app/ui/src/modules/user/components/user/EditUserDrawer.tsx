import { Alert, Button, Form, FormField, useForm, zodResolver, Input, Switch, message } from '@ziee/kit'
import { z } from 'zod'
import { Drawer } from '@ziee/shell'
import { EditUserDrawer as EditUserDrawerStore } from '@/modules/user/components/user/EditUserDrawer.store'
import { runAction } from '@/core/actions/defineAction'
import { usePermission } from '@/core/permissions'
import { type UpdateUserRequest } from '@/api-client/types'
import { Permissions } from '@/api-client/permissions'
import { useEffect } from 'react'

const editUserSchema = z.object({
  username: z.string().min(1, 'Please enter username'),
  display_name: z.string().optional(),
  is_active: z.boolean(),
})
type EditUserValues = z.infer<typeof editUserSchema>

export function EditUserDrawer() {
  const { isOpen, editingUser } = EditUserDrawerStore
  const editForm = useForm<EditUserValues>({
    resolver: zodResolver(editUserSchema),
    defaultValues: { username: '', display_name: '', is_active: true },
  })
  const canEdit = usePermission(Permissions.UsersEdit)

  // Update form when editingUser changes
  useEffect(() => {
    if (editingUser) {
      editForm.reset({
        username: editingUser.username,
        display_name: editingUser.display_name ?? '',
        is_active: editingUser.is_active,
      })
    }
  }, [editingUser, editForm])

  const handleEditUser = async (values: EditUserValues) => {
    if (!editingUser) return

    try {
      // NOTE: `email` and `permissions` are intentionally NOT included.
      // The backend's UpdateUserRequest dropped both fields:
      //   - `email`: changing email without confirmation enables OAuth
      //     account takeover (03-user F-03 closure).
      //   - `permissions`: lets any users::edit holder escalate to
      //     wildcard '*' (03-user F-01 closure). Permissions are now
      //     managed via group assignment only.
      const updateData: UpdateUserRequest = {
        username: values.username,
        display_name: values.display_name || undefined,
        is_active: values.is_active,
      }

      // Dispatch the permissioned `user.update` action (thin wrapper over the SAME store
      // method) so the edit is equally AI-drivable, not a human-only submit (INV-1).
      await runAction('user.update', { id: editingUser.id, ...updateData })

      message.success('User updated successfully')
      EditUserDrawerStore.closeEditUserDrawer()
      editForm.reset()
    } catch (error) {
      console.error('Failed to update user:', error)
      // Error is handled by the store
    }
  }

  return (
    <Drawer
      title="Edit User"
      open={isOpen}
      onClose={() => {
        EditUserDrawerStore.closeEditUserDrawer()
        editForm.reset()
      }}
      footer={
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              EditUserDrawerStore.closeEditUserDrawer()
              editForm.reset()
            }}
            data-testid="user-edit-cancel-button"
          >
            {canEdit ? 'Cancel' : 'Close'}
          </Button>
          {canEdit && (
            <Button type="submit" form="edit-user-form" data-testid="user-edit-submit-button">
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
            data-testid="user-edit-readonly-alert"
            tone="info"
            title="Read-only view"
            description="You don't have the “users::edit” permission, so these fields are read-only and this user can't be changed here."
            className="mb-3"
          />
        )}

        <Form
          name="edit-user-form"
          form={editForm}
          layout="vertical"
          onSubmit={handleEditUser}
          disabled={!canEdit}
          data-testid="user-edit-form"
        >
          <FormField name="username" label="Username" required>
            <Input placeholder="Enter username" data-testid="user-edit-username-input" />
          </FormField>
          <FormField name="is_active" label="Active" valuePropName="checked">
            <Switch aria-label="Active" data-testid="user-edit-active-switch" />
          </FormField>
          <FormField name="display_name" label="Display Name">
            <Input placeholder="Enter display name (optional)" data-testid="user-edit-display-name-input" />
          </FormField>
          {/*
         * Email + Permissions removed from this form per security work:
         * - Email: changing without confirmation enables OAuth takeover
         *   (03-user F-03). Add a verification-token flow before
         *   restoring.
         * - Permissions: editing them here let a sub-admin grant
         *   themselves wildcard '*' (03-user F-01). Use group
         *   assignment (POST /api/groups/{id}/users) instead.
         */}
        </Form>
      </div>
    </Drawer>
  )
}
