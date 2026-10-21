import { Card, Form, FormField, useForm, Switch, Text, message } from '@ziee/kit'
import { useEffect } from 'react'
import { Users } from '@/modules/user/stores/Users.store'

export function UserRegistrationSettings() {
  const form = useForm<{ enabled: boolean }>({
    defaultValues: { enabled: false },
  })

  // Users store
  const { userRegistrationEnabled, loadingRegistrationSettings, error } =
    Users

  // Show errors
  useEffect(() => {
    if (error) {
      message.error(error)
      Users.clearError()
    }
  }, [error])

  // Update form when registration status changes
  useEffect(() => {
    form.setValue('enabled', userRegistrationEnabled)
  }, [userRegistrationEnabled]) // Removed form from dependencies to prevent infinite rerenders

  const handleToggle = async (newValue: boolean) => {
    try {
      await Users.updateUserRegistrationSettings(newValue)
      message.success(
        `User registration ${newValue ? 'enabled' : 'disabled'} successfully`,
      )
    } catch (error) {
      console.error('Failed to update registration status:', error)
      // Error is handled by the store
    }
  }

  return (
    <Card title="User Registration" data-testid="user-registration-card">
      <Form form={form} onSubmit={() => {}} data-testid="user-registration-form">
        <div className="flex justify-between items-center">
          <div>
            <Text strong>Enable User Registration</Text>
            <div>
              <Text type="secondary">
                Allow new users to register for accounts
              </Text>
            </div>
          </div>
          <FormField
            name="enabled"
            aria-label="Enable user registration"
            valuePropName="checked"
            className="mb-0"
          >
            <Switch
              loading={loadingRegistrationSettings}
              onChange={handleToggle}
              data-testid="user-registration-enabled-switch"
            />
          </FormField>
        </div>
      </Form>
    </Card>
  )
}
