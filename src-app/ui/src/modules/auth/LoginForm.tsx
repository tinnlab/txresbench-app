import { z } from 'zod'
import {
  Alert,
  Button,
  Card,
  Form,
  FormField,
  Input,
  PasswordInput,
  Text,
  Title,
  useForm,
  zodResolver,
  dialog,
} from '@ziee/kit'
import { Lock, User } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Auth } from '@/modules/auth/Auth.store'
import type { LoginRequest } from '@/api-client/types'
import { ProviderButtons } from './ProviderButtons'

interface LoginFormProps {
  onSwitchToRegister?: () => void
}

const loginSchema = z.object({
  username: z.string().min(1, 'Please input your username or email!'),
  password: z.string().min(1, 'Please input your password!'),
})

export const LoginForm: React.FC<LoginFormProps> = ({ onSwitchToRegister }) => {
  const form = useForm<LoginRequest>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: '', password: '' },
  })
  const { isLoading, error } = Auth
  const navigate = useNavigate()

  const onSubmit = async (values: LoginRequest) => {
    try {
      Auth.clearAuthenticationError()
      await Auth.authenticateUser(values)
      // Redirect to home page after successful login
      navigate('/', { replace: true })
    } catch (error) {
      // Error is handled by the store
      console.error('Login failed:', error)
    }
  }

  return (
    <Card data-testid="auth-login-card" className="w-full max-w-md mx-auto">
      <div className="text-center mb-6">
        <Title level={2}>Welcome back</Title>
      </div>

      {error && (
        <div className="py-4" role="alert" aria-live="assertive">
          <Alert
            data-testid="auth-login-error"
            title={error}
            tone="error"
            onClose={Auth.clearAuthenticationError}
            closeLabel="Close"
          />
        </div>
      )}

      <Form data-testid="auth-login-form" form={form} name="login" onSubmit={onSubmit} layout="vertical" size="lg" disabled={isLoading}>
        <FormField label="Username or Email" name="username">
          <Input
            data-testid="auth-login-username"
            prefix={<User />}
            placeholder="Enter your username or email"
            autoComplete="username"
          />
        </FormField>

        <FormField label="Password" name="password">
          <PasswordInput
            data-testid="auth-login-password"
            prefix={<Lock />}
            placeholder="Enter your password"
            autoComplete="current-password"
            showLabel="Show password"
            hideLabel="Hide password"
          />
        </FormField>

        <div className="text-right -mt-2 mb-2">
          <Button
            data-testid="auth-login-forgot-password"
            variant="link"
            className="p-0"
            onClick={() =>
              dialog.info({
                title: 'Forgot your password?',
                description:
                  'Password recovery is handled by your administrator. ' +
                  'Contact them to have your password reset — once reset, ' +
                  'you can sign in and change it from Profile settings.',
                okText: 'Got it',
              })
            }
          >
            Forgot password?
          </Button>
        </div>

        <Button data-testid="auth-login-submit" type="submit" loading={isLoading} className="w-full">
          Sign In
        </Button>

        {onSwitchToRegister && (
          <div className="text-center">
            <Text type="secondary">
              Don't have an account?{' '}
              <Button data-testid="auth-login-switch-to-register" variant="link" onClick={onSwitchToRegister} className="p-0">
                Sign Up
              </Button>
            </Text>
          </div>
        )}
      </Form>

      <ProviderButtons />
    </Card>
  )
}
