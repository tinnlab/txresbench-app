import { z } from 'zod'
import { Alert, Button, Form, FormField, Input, PasswordInput, message, useForm, zodResolver } from '@ziee/kit'
import { Drawer } from '@ziee/shell'
import { CreateUserDrawer as CreateUserDrawerStore } from '@/modules/user/components/user/CreateUserDrawer.store'
import { Users } from '@/modules/user/stores/Users.store'
import { runAction } from '@/core/actions/defineAction'
import { usePermission } from '@/core/permissions'
import type { CreateUserRequest } from '@/api-client/types'
import { Permissions } from '@/api-client/permissions'
import { PermissionsField } from '@/modules/user/components/PermissionsField.tsx'
import { EMAIL_RE } from '@/lib/validation'
import { newPasswordField } from '@/core/passwordPolicy'

const createUserSchema = z.object({
  username: z.string().min(1, 'Please enter username'),
  email: z.string().min(1, 'Please enter valid email').regex(EMAIL_RE, 'Please enter valid email'),
  // 8–72 BYTES, matching `check_password` — see core/passwordPolicy.
  password: newPasswordField('Please enter password'),
  display_name: z.string().optional(),
  permissions: z.array(z.string()).optional(),
})

type CreateUserValues = z.infer<typeof createUserSchema>

export function CreateUserDrawer() {
  const { isOpen } = CreateUserDrawerStore
  const { creating: creatingUser } = Users
  const createForm = useForm<CreateUserValues>({
    resolver: zodResolver(createUserSchema),
    defaultValues: {
      username: '',
      email: '',
      password: '',
      display_name: '',
      permissions: [],
    },
  })
  const canCreate = usePermission(Permissions.UsersCreate)

  const handleCreateUser = async (values: CreateUserValues) => {
    try {
      const userData: CreateUserRequest = {
        username: values.username,
        email: values.email,
        password: values.password,
        display_name: values.display_name,
        permissions: values.permissions?.length
          ? values.permissions
          : undefined,
      }

      // Dispatch the permissioned `user.create` action (a thin wrapper over the SAME store
      // method) so this mutation is equally AI-drivable, not a human-only submit (INV-1).
      await runAction('user.create', userData)

      message.success('User created successfully')
      CreateUserDrawerStore.closeCreateUserDrawer()
      createForm.reset()
    } catch (error) {
      console.error('Failed to create user:', error)
      // Error is handled by the store
    }
  }

  return (
    <Drawer
      title="Create User"
      open={isOpen}
      onClose={() => {
        CreateUserDrawerStore.closeCreateUserDrawer()
        createForm.reset()
      }}
      footer={
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              CreateUserDrawerStore.closeCreateUserDrawer()
              createForm.reset()
            }}
            disabled={creatingUser}
            data-testid="user-create-cancel-button"
          >
            {canCreate ? 'Cancel' : 'Close'}
          </Button>
          {canCreate && (
            <Button type="submit" form="create-user" loading={creatingUser} data-testid="user-create-submit-button">
              Create
            </Button>
          )}
        </div>
      }
      size={600}
      mask={{ closable: false }}
    >
      {/* One wrapper so the Drawer body (a flex ROW) keeps banner-above-form; a
          second direct child would sit BESIDE the form. */}
      <div className="flex flex-col">
        {/* A disabled form whose submit button is also gone refuses the user in
            silence. State the reason — the same read-only banner the settings
            pages render (`job-settings-readonly-alert`). */}
        {!canCreate && (
          <Alert
            data-testid="user-create-readonly-alert"
            tone="info"
            title="Read-only view"
            description="You don't have the “users::create” permission, so these fields are read-only and no user can be created here."
            className="mb-3"
          />
        )}

        <Form
          name="create-user"
          form={createForm}
          layout="vertical"
          onSubmit={handleCreateUser}
          disabled={!canCreate}
          data-testid="user-create-form"
        >
          <FormField
            name="username"
            label="Username"
            required
          >
            <Input placeholder="Enter username" data-testid="user-create-username-input" />
          </FormField>
          <FormField
            name="email"
            label="Email"
            required
          >
            <Input placeholder="Enter email" data-testid="user-create-email-input" />
          </FormField>
          <FormField
            name="password"
            label="Password"
            required
          >
            <PasswordInput placeholder="Enter password" showLabel="Show" hideLabel="Hide" data-testid="user-create-password-input" />
          </FormField>
          <FormField name="display_name" label="Display Name">
            <Input placeholder="Enter display name (optional)" data-testid="user-create-display-name-input" />
          </FormField>
          <FormField name="permissions" label="Permissions">
            <PermissionsField disabled={!canCreate} />
          </FormField>
        </Form>
      </div>
    </Drawer>
  )
}
