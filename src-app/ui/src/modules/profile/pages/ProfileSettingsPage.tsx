import { useEffect } from 'react'
import {
  Alert,
  Avatar,
  Card,
  Descriptions,
  Flex,
  Form,
  FormField,
  useForm,
  zodResolver,
  Input,
  PasswordInput,
  Tag,
  Text,
  message,
} from '@ziee/kit'
import { z } from 'zod'
import { User } from 'lucide-react'
import { Auth } from '@/modules/auth/Auth.store'
import { Profile } from '@/modules/profile/stores/Profile.store'
import { usePermission } from '@/core/permissions'
import { Permissions } from '@/api-client/permissions'
import { SettingsPageContainer } from '@ziee/shell'
import { newPasswordField } from '@/core/passwordPolicy'
import { SettingsFormActions } from '@/modules/settings/components/SettingsFormActions'

interface ProfileFormValues {
  display_name: string
  username: string
}

interface PasswordFormValues {
  current_password: string
  new_password: string
  confirm_password: string
}

const profileSchema = z.object({
  display_name: z.string(),
  username: z
    .string()
    .min(1, 'Username is required')
    .refine((v) => v.trim().length > 0, 'Username cannot be blank'),
})

const passwordSchema = z
  .object({
    // The CURRENT password is an existing secret, not a new choice: it carries no length rule
    // at all, because a password set before the 8–72-byte band still has to be enterable by
    // the person who owns it.
    current_password: z.string().min(1, 'Enter your current password'),
    new_password: newPasswordField('Enter a new password'),
    confirm_password: z.string().min(1, 'Re-enter the new password'),
  })
  .refine((d) => d.new_password === d.confirm_password, {
    message: 'Passwords do not match',
    path: ['confirm_password'],
  })

export function ProfileSettingsPage() {
  // Read ALL store fields at the top, before any early return (hooks rule).
  const { user, hasPassword } = Auth
  const { savingProfile, savingPassword } = Profile
  const canEdit = usePermission(Permissions.ProfileEdit)
  const profileForm = useForm<ProfileFormValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: { display_name: '', username: '' },
  })
  const passwordForm = useForm<PasswordFormValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: {
      current_password: '',
      new_password: '',
      confirm_password: '',
    },
  })

  // Refresh /me on mount so `hasPassword` + profile fields are accurate
  // even when the user arrived via an in-session login (authenticateUser
  // sets `user` from the login response, which carries no `has_password`).
  useEffect(() => {
    void Auth.refreshCurrentUser()
  }, [])

  useEffect(() => {
    if (user) {
      profileForm.reset({
        display_name: user.display_name ?? '',
        username: user.username,
      })
    }
  }, [user, profileForm])

  if (!user) return null

  const handleProfileSubmit = async (values: ProfileFormValues) => {
    try {
      await Profile.updateProfile({
        username: values.username.trim(),
        display_name: values.display_name.trim(),
      })
      message.success('Profile saved.')
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : 'Failed to save profile.',
      )
    }
  }

  const handlePasswordSubmit = async (values: PasswordFormValues) => {
    try {
      await Profile.changePassword({
        current_password: values.current_password,
        new_password: values.new_password,
      })
      message.success('Password changed.')
      passwordForm.reset()
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : 'Failed to change password.',
      )
    }
  }

  return (
    <SettingsPageContainer title="Profile">
      <Card
        title="Account"
        data-testid="profile-account-card"
        footer={canEdit ? (
          <SettingsFormActions
            onSave={profileForm.handleSubmit(handleProfileSubmit)}
            onCancel={() => profileForm.reset({ display_name: user.display_name ?? '', username: user.username })}
            saving={savingProfile}
            saveTestid="profile-save-button"
            cancelTestid="profile-cancel-btn"
          />
        ) : undefined}
      >
        {/* Wrap the body in a flex column with explicit gap. Per-child
            mb-* wasn't taking effect — antd v6's Card body layout
            collapses sibling margins; flex gap is the reliable lever. */}
        <Flex vertical gap="lg">
        <Flex align="center" gap="md">
          {user.avatar_url ? (
            <Avatar
              className="size-16"
              src={user.avatar_url}
              alt={user.username}
              fallback={<User />}
            />
          ) : (
            <Avatar className="size-16" fallback={<User />} />
          )}
          <Flex gap="sm" wrap>
            <Tag variant="outline" data-testid="profile-role-tag" tone={user.is_admin ? 'warning' : undefined}>
              {user.is_admin ? 'Administrator' : 'User'}
            </Tag>
            <Tag variant="outline" data-testid="profile-email-verified-tag" tone={user.email_verified ? 'success' : 'warning'}>
              {user.email_verified ? 'Email verified' : 'Email unverified'}
            </Tag>
          </Flex>
        </Flex>

        <Descriptions
          data-testid="profile-account-descriptions"
          size="sm"
          column={2}
          items={[
            { key: 'email', label: 'Email', children: user.email },
            {
              key: 'member-since',
              label: 'Member since',
              children: new Date(user.created_at).toLocaleDateString(),
            },
            {
              key: 'last-login',
              label: 'Last login',
              children: user.last_login_at
                ? new Date(user.last_login_at).toLocaleDateString()
                : 'Never',
            },
          ]}
        />

        {!canEdit && (
          <Alert
            data-testid="profile-readonly-alert"
            tone="info"
            title="You don't have permission to edit your profile. Fields are read-only."
            className="mb-3"
          />
        )}
        <Form
          name="profile-form"
          data-testid="profile-info-form"
          form={profileForm}
          layout="horizontal"
          onSubmit={handleProfileSubmit}
          disabled={!canEdit}
        >
          <FormField
            name="display_name"
            label="Display name"
            description="The name shown to others. Optional."
          >
            <Input data-testid="profile-display-name-input" maxLength={255} placeholder="Your display name" />
          </FormField>
          <FormField name="username" label="Username" required>
            <Input data-testid="profile-username-input" maxLength={255} placeholder="Your username" />
          </FormField>
        </Form>
        </Flex>
      </Card>

      {canEdit && (
        <Card
          title="Password"
          data-testid="profile-password-card"
          footer={hasPassword ? (
            <SettingsFormActions
              onSave={passwordForm.handleSubmit(handlePasswordSubmit)}
              onCancel={() => passwordForm.reset()}
              saving={savingPassword}
              saveLabel="Change password"
              saveTestid="profile-change-password-button"
              cancelTestid="profile-password-cancel-btn"
            />
          ) : undefined}
        >
          {hasPassword ? (
            <Form
              name="password-form"
              data-testid="profile-password-form"
              form={passwordForm}
              layout="horizontal"
              onSubmit={handlePasswordSubmit}
            >
              <FormField
                name="current_password"
                label="Current password"
                required
              >
                <PasswordInput
                  data-testid="profile-current-password-input"
                  showLabel="Show password"
                  hideLabel="Hide password"
                  autoComplete="current-password"
                  placeholder="Current password"
                />
              </FormField>
              <FormField name="new_password" label="New password" required>
                <PasswordInput
                  data-testid="profile-new-password-input"
                  showLabel="Show password"
                  hideLabel="Hide password"
                  autoComplete="new-password"
                  placeholder="New password"
                />
              </FormField>
              <FormField
                name="confirm_password"
                label="Confirm new password"
                required
              >
                <PasswordInput
                  data-testid="profile-confirm-password-input"
                  showLabel="Show password"
                  hideLabel="Hide password"
                  autoComplete="new-password"
                  placeholder="Confirm new password"
                />
              </FormField>
            </Form>
          ) : (
            <Text type="secondary" data-testid="profile-no-password-notice">
              You sign in through an external provider, so there is no password
              to change here.
            </Text>
          )}
        </Card>
      )}
    </SettingsPageContainer>
  )
}
