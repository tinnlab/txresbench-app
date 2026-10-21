import { useEffect } from 'react'
import { z } from 'zod'
import {
  Alert,
  Button,
  Form,
  FormField,
  Input,
  Select,
  Text,
  message,
  useForm,
  zodResolver,
} from '@ziee/kit'
import { Drawer } from '@ziee/shell'
import { CreateOrgDrawer as CreateOrgDrawerStore } from '@/modules/admin-accounts/components/CreateOrgDrawer.store'
import { AdminAccounts } from '@/modules/admin-accounts/stores/AdminAccounts.store'
import { Users } from '@/modules/user/stores/Users.store'
import { usePermission } from '@/core/permissions'
import { Permissions } from '@/api-client/permissions'
import { runAction } from '@/core/actions/defineAction'

const createOrgSchema = z.object({
  name: z.string().min(1, 'Please enter an organization name'),
  // Optional owner id (the picker's value). Absent → backend defaults to the caller.
  owner_id: z.string().optional(),
})
type CreateOrgValues = z.infer<typeof createOrgSchema>

/**
 * Create-organization drawer (#44, ITEM-4) — the twin of `CreateUserDrawer`. A
 * required `name` plus an OPTIONAL owner picker (a kit `Select` over the users
 * list, shown only when the admin holds `users::read`; omitted → the backend
 * seeds the caller as owner). Submitting drives the `admin.account.createOrg`
 * `defineAction` via `runAction` (never a bare store call), so the same create
 * path is AI-drivable. The store's `createOrg` refetches so the new org appears.
 */
export function CreateOrgDrawer() {
  // Defaults guard against a transient undefined from the lazy-store proxy before
  // hydration (see AccountsAdminPage).
  const { isOpen = false } = CreateOrgDrawerStore
  const { creating = false } = AdminAccounts
  const { users = [] } = Users
  const canManage = usePermission(Permissions.AccountManage)
  const canReadUsers = usePermission(Permissions.UsersRead)

  const form = useForm<CreateOrgValues>({
    resolver: zodResolver(createOrgSchema),
    defaultValues: { name: '', owner_id: undefined },
  })

  // Load users once for the owner picker when it's available and shown.
  useEffect(() => {
    if (isOpen && canReadUsers && users.length === 0) {
      void Users.loadUsers()
    }
  }, [isOpen, canReadUsers, users.length])

  const close = () => {
    CreateOrgDrawerStore.close()
    form.reset()
  }

  const handleSubmit = async (values: CreateOrgValues) => {
    try {
      // createOrg returns the new Account, or undefined when a concurrent
      // create dropped this call — don't report a guarded no-op as success.
      const account = await runAction('admin.account.createOrg', {
        name: values.name,
        ...(values.owner_id ? { owner_id: values.owner_id } : {}),
      })
      if (!account) return
      message.success('Organization created successfully')
      close()
    } catch (error) {
      message.error(
        error instanceof Error
          ? error.message
          : 'Failed to create organization',
      )
    }
  }

  const ownerOptions = users.map(u => ({ label: u.username, value: u.id }))

  return (
    <Drawer
      title="Create organization"
      open={isOpen}
      onClose={close}
      size={600}
      mask={{ closable: false }}
      footer={
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={close}
            disabled={creating}
            data-testid="account-create-cancel-button"
          >
            {canManage ? 'Cancel' : 'Close'}
          </Button>
          {canManage && (
            <Button
              type="submit"
              form="create-org-form"
              loading={creating}
              data-testid="account-create-submit-button"
            >
              Create
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col">
        {!canManage && (
          <Alert
            data-testid="account-create-readonly-alert"
            tone="info"
            title="Read-only view"
            description="You don't have the “account::manage” permission, so no organization can be created here."
            className="mb-3"
          />
        )}

        <Form
          name="create-org-form"
          form={form}
          layout="vertical"
          onSubmit={handleSubmit}
          disabled={!canManage}
          data-testid="account-create-form"
        >
          <FormField name="name" label="Organization name" required>
            <Input
              placeholder="Enter organization name"
              data-testid="account-create-name-input"
            />
          </FormField>
          {canReadUsers ? (
            <FormField
              name="owner_id"
              label="Owner"
              description="Optional — defaults to you."
            >
              <Select
                options={ownerOptions}
                placeholder="Select an owner (optional)"
                allowClear
                clearLabel="Clear owner"
                showSearch
                data-testid="account-create-owner-select"
                aria-label="Organization owner"
              />
            </FormField>
          ) : (
            <Text type="secondary" className="!text-sm">
              You'll be set as the owner. (Selecting a different owner requires the
              “users::read” permission.)
            </Text>
          )}
        </Form>
      </div>
    </Drawer>
  )
}
