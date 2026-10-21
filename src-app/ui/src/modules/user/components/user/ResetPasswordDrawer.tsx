import { z } from 'zod'
import { Alert, Button, Form, FormField, useForm, zodResolver, PasswordInput, message } from '@ziee/kit'
import { Drawer } from '@ziee/shell'
import { ResetPasswordDrawer as ResetPasswordDrawerStore } from '@/modules/user/components/user/ResetPasswordDrawer.store'
import { runAction } from '@/core/actions/defineAction'
import { usePermission } from '@/core/permissions'
import { Permissions } from '@/api-client/permissions'
import { newPasswordField } from '@/core/passwordPolicy'

const resetPasswordSchema = z
  .object({
    // The server's band is 8–72 BYTES (`check_password`). A 6-character floor here refused
    // nothing the server allowed and allowed plenty it refuses.
    new_password: newPasswordField('Please enter new password'),
    confirm_password: z.string().min(1, 'Please confirm password'),
  })
  .refine((d) => d.confirm_password === d.new_password, {
    message: 'Passwords do not match',
    path: ['confirm_password'],
  })

type ResetPasswordValues = z.infer<typeof resetPasswordSchema>

export function ResetPasswordDrawer() {
  const { isOpen, user } = ResetPasswordDrawerStore
  const canReset = usePermission(Permissions.UsersResetPassword)
  const form = useForm<ResetPasswordValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { new_password: '', confirm_password: '' },
  })

  const handleResetPassword = async (values: ResetPasswordValues) => {
    if (!user) return

    try {
      // Dispatch the permissioned `user.resetPassword` action (thin wrapper over the SAME
      // store method) so the reset is equally AI-drivable, not a human-only submit (INV-1).
      await runAction('user.resetPassword', { id: user.id, new_password: values.new_password })

      message.success('Password reset successfully')
      ResetPasswordDrawerStore.closeResetPasswordDrawer()
      form.reset()
    } catch (error) {
      console.error('Failed to reset password:', error)
      // Error is handled by the store
    }
  }

  return (
    <Drawer
      title="Reset Password"
      size={600}
      open={isOpen}
      onClose={() => {
        ResetPasswordDrawerStore.closeResetPasswordDrawer()
        form.reset()
      }}
      footer={
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              ResetPasswordDrawerStore.closeResetPasswordDrawer()
              form.reset()
            }}
            data-testid="user-reset-password-cancel-button"
          >
            {canReset ? 'Cancel' : 'Close'}
          </Button>
          {canReset && (
            <Button type="submit" form="reset-password-form" data-testid="user-reset-password-submit-button">
              Reset
            </Button>
          )}
        </div>
      }
      mask={{ closable: false }}
    >
      {/* One wrapper so the Drawer body (a flex ROW) keeps banner-above-form. */}
      <div className="flex flex-col">
        {/* A disabled form whose Reset button is also gone refuses the user in
            silence. State the reason (the settings-page read-only banner). */}
        {!canReset && (
          <Alert
            data-testid="user-reset-password-readonly-alert"
            tone="info"
            title="Read-only view"
            description="You don't have the “users::reset_password” permission, so these fields are read-only and this password can't be reset here."
            className="mb-3"
          />
        )}

        <Form
          name="reset-password-form"
          form={form}
          layout="vertical"
          onSubmit={handleResetPassword}
          disabled={!canReset}
          data-testid="user-reset-password-form"
        >
          <FormField
            name="new_password"
            label="New Password"
          >
            <PasswordInput placeholder="Enter new password" showLabel="Show password" hideLabel="Hide password" data-testid="user-reset-new-password-input" />
          </FormField>
          <FormField
            name="confirm_password"
            label="Confirm Password"
          >
            <PasswordInput placeholder="Confirm new password" showLabel="Show password" hideLabel="Hide password" data-testid="user-reset-confirm-password-input" />
          </FormField>
        </Form>
      </div>
    </Drawer>
  )
}
