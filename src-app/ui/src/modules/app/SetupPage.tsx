import React from 'react'
import { z } from 'zod'
import { Card, Form, FormField, useForm, zodResolver, Input, Button, Alert, Title, Paragraph } from '@ziee/kit'
import { useNavigate } from 'react-router-dom'
import { Auth } from '@/modules/auth/Auth.store'
import { App } from '@/modules/app/App.store'
import { AuthScreenLayout } from '@/modules/auth/AuthScreenLayout'
import { EMAIL_RE } from '@/lib/validation'
import { newPasswordField } from '@/core/passwordPolicy'

const setupSchema = z
  .object({
    username: z
      .string()
      .min(1, 'Username is required')
      .min(3, 'Username must be at least 3 characters')
      .max(100, 'Username must be less than 100 characters')
      .regex(
        /^[a-zA-Z0-9_-]+$/,
        'Username can only contain letters, numbers, hyphens, and underscores',
      ),
    email: z
      .string()
      .min(1, 'Email is required')
      .regex(EMAIL_RE, 'Invalid email format')
      .max(255, 'Email must be less than 255 characters'),
    // 8 was right but counted in CHARACTERS; the setup handler counts bytes
    // (`req.password.len() < 8 || > 72`). The upper bound was missing entirely, so the very
    // first account a deployment creates could be refused with no client-side explanation.
    password: newPasswordField('Password is required'),
    confirm_password: z.string().min(1, 'Please confirm your password'),
    display_name: z.string().optional(),
  })
  .refine((data) => data.password === data.confirm_password, {
    message: 'Passwords do not match',
    path: ['confirm_password'],
  })

type SetupValues = z.infer<typeof setupSchema>

export default function SetupPage() {
  const { needsSetup, isSettingUpAdmin, setupError } = App
  const navigate = useNavigate()
  const form = useForm<SetupValues>({
    resolver: zodResolver(setupSchema),
    defaultValues: {
      username: '',
      email: '',
      password: '',
      confirm_password: '',
      display_name: '',
    },
  })

  // Redirect away if setup is already done (admin exists). Two paths
  // benefit:
  //   1. Cross-tab: tab A still on /setup when tab B completes setup.
  //   2. Direct nav: tests / users hitting /setup when admin already
  //      exists (e.g. an API-only setup happened before the page load).
  //
  // The earlier race (this navigate firing mid-onFinish and aborting
  // the in-flight /me from authenticateUser) is now defused upstream:
  // Auth.store's catch keeps the token across a TypeError/Failed-to-
  // fetch (abort) so the next mount can retry. Re-enabled here.
  React.useEffect(() => {
    if (needsSetup === false) {
      navigate('/', { replace: true })
    }
  }, [needsSetup, navigate])

  const onSubmit = async (values: SetupValues) => {
    try {
      await App.setupAdmin({
        username: values.username,
        email: values.email,
        password: values.password,
        display_name: values.display_name,
      })

      // Use the login credentials to authenticate
      await Auth.authenticateUser({
        username: values.username,
        password: values.password,
      })

      // Redirect to dashboard
      navigate('/', { replace: true })
    } catch (err) {
      // Error is already handled in the store
      console.error('Setup failed:', err)
    }
  }

  return (
    <AuthScreenLayout>
      <Card
        className="w-full"
        data-testid="app-setup-card"
        footer={
          <Button
            type="submit"
            form="setup-form"
            data-testid="app-setup-submit-button"
            block
            loading={isSettingUpAdmin}
            size="lg"
            className="w-full"
          >
            Create Admin Account
          </Button>
        }
      >
        <div className="mb-6" data-testid="app-setup-welcome">
          <Title level={2} className="text-center mb-3">Welcome to CytoAnalyst</Title>
          <Paragraph>
            No administrator account exists. Let's create your first admin
            account to get started.
          </Paragraph>
        </div>

        {setupError && (
          <Alert
            tone="error"
            data-testid="app-setup-error-alert"
            title={setupError}
            className="mb-4"
            onClose={App.clearSetupError}
            closeLabel="Close"
          />
        )}

        <Form
          name="setup-form"
          data-testid="app-setup-form"
          form={form}
          layout="vertical"
          onSubmit={onSubmit}
        >
          <FormField
            label="Username"
            name="username"
            required
          >
            <Input data-testid="app-setup-username-input" placeholder="admin" autoComplete="username" autoFocus />
          </FormField>

          <FormField
            label="Email"
            name="email"
            required
          >
            <Input
              data-testid="app-setup-email-input"
              placeholder="admin@example.com"
              type="email"
              autoComplete="email"
            />
          </FormField>

          <FormField
            label="Password"
            name="password"
            required
            description="8 to 72 bytes. Most characters count as 1 byte; accented letters and emoji count as more."
          >
            <Input
              data-testid="app-setup-password-input"
              type="password"
              placeholder="Enter a strong password"
              autoComplete="new-password"
            />
          </FormField>

          <FormField
            label="Confirm Password"
            name="confirm_password"
            required
          >
            <Input
              data-testid="app-setup-confirm-password-input"
              type="password"
              placeholder="Confirm your password"
              autoComplete="new-password"
            />
          </FormField>

          <FormField label="Display Name (Optional)" name="display_name">
            <Input data-testid="app-setup-display-name-input" placeholder="System Administrator" />
          </FormField>
        </Form>
      </Card>
    </AuthScreenLayout>
  )
}
