import {
  Alert,
  Button,
  Card,
  Form,
  FormField,
  Input,
  PasswordInput,
  Title,
  Text,
  useForm,
  zodResolver,
} from '@ziee/kit'
import { z } from 'zod'
import { EMAIL_RE } from '@/lib/validation'
import { Lock, Mail, User } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Auth } from '@/modules/auth/Auth.store'
import { newPasswordField } from '@/core/passwordPolicy'
import type { CreateUserRequest } from '@/api-client/types'

interface RegisterFormProps {
  onSwitchToLogin?: () => void
}

interface RegisterFormValues {
  username: string
  email: string
  password: string
  confirmPassword: string
}

const schema = z
  .object({
    username: z
      .string()
      .min(1, 'Please input your username!')
      .min(3, 'Username must be at least 3 characters long!'),
    email: z
      .string()
      .min(1, 'Please input your email!')
      .regex(EMAIL_RE, 'Please enter a valid email address!'),
    // 6 was the client's own invention: the server refuses anything under 8 BYTES and anything
    // over 72, so a 6-character password was accepted here and rejected on submit, and a
    // 90-character one was accepted here and rejected there. One rule, in the server's unit.
    password: newPasswordField('Please input your password!'),
    confirmPassword: z.string().min(1, 'Please confirm your password!'),
  })
  .refine(data => data.password === data.confirmPassword, {
    message: 'Passwords do not match!',
    path: ['confirmPassword'],
  })

export const RegisterForm: React.FC<RegisterFormProps> = ({
  onSwitchToLogin,
}) => {
  const form = useForm<RegisterFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      username: '',
      email: '',
      password: '',
      confirmPassword: '',
    },
  })
  const { isLoading, error } = Auth
  const navigate = useNavigate()

  const onSubmit = async (values: RegisterFormValues) => {
    try {
      Auth.clearAuthenticationError()
      await Auth.registerNewUser({
        username: values.username,
        email: values.email,
        password: values.password,
      } as CreateUserRequest)
      // Redirect to home page after successful registration
      navigate('/', { replace: true })
    } catch (error) {
      // Error is handled by the store
      console.error('Registration failed:', error)
    }
  }

  return (
    <Card data-testid="auth-register-card" className="w-full max-w-md mx-auto">
      <div className="text-center mb-6">
        <Title level={2}>Create Account</Title>
      </div>

      {error && (
        <Alert
          data-testid="auth-register-error"
          title={error}
          tone="error"
          onClose={Auth.clearAuthenticationError}
          closeLabel="Close"
          className="mb-4"
        />
      )}

      <Form
        data-testid="auth-register-form"
        form={form}
        name="register"
        onSubmit={onSubmit}
        layout="vertical"
        size="lg"
      >
        <FormField label="Username" name="username">
          <Input
            data-testid="auth-register-username"
            prefix={<User />}
            placeholder="Enter your username"
            autoComplete="username"
          />
        </FormField>

        <FormField label="Email" name="email">
          <Input
            data-testid="auth-register-email"
            prefix={<Mail />}
            placeholder="Enter your email address"
            autoComplete="email"
          />
        </FormField>

        <FormField label="Password" name="password">
          <PasswordInput
            data-testid="auth-register-password"
            prefix={<Lock />}
            placeholder="Enter your password"
            autoComplete="new-password"
            showLabel="Show password"
            hideLabel="Hide password"
          />
        </FormField>

        <FormField label="Confirm Password" name="confirmPassword">
          <PasswordInput
            data-testid="auth-register-confirm-password"
            prefix={<Lock />}
            placeholder="Confirm your password"
            autoComplete="new-password"
            showLabel="Show password"
            hideLabel="Hide password"
          />
        </FormField>

        <Button data-testid="auth-register-submit" type="submit" loading={isLoading} className="w-full">
          Sign Up
        </Button>

        {onSwitchToLogin && (
          <div className="text-center">
            <Text type="secondary">
              Already have an account?{' '}
              <Button data-testid="auth-register-switch-to-login" variant="link" onClick={onSwitchToLogin} className="p-0">
                Sign In
              </Button>
            </Text>
          </div>
        )}
      </Form>
    </Card>
  )
}
