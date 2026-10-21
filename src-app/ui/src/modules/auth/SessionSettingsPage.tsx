import { useEffect } from 'react'
import {
  Alert,
  Card,
  ErrorState,
  Form,
  FormField,
  InputNumber,
  Spin,
  message,
  useForm,
} from '@ziee/kit'
import { Permissions } from '@/api-client/permissions'
import { usePermission } from '@/core/permissions'
import { SessionSettings } from '@/modules/auth/SessionSettings.store'
import { runAction } from '@/core/actions/defineAction'
import { SettingsFormActions } from '@/modules/settings/components/SettingsFormActions'
import { SettingsPageContainer } from '@ziee/shell'

type FormValues = {
  access_token_expiry_hours: number
  refresh_token_expiry_days: number
}

/**
 * Admin "Sessions" settings page — the deployment-wide JWT lifetimes:
 * how long an access token lives (clients silently refresh before it
 * expires) and the max session length (how long a session survives with
 * no activity before the user must sign in again). Changes apply to
 * tokens minted from that moment on; existing tokens keep their exp.
 */
export function SessionSettingsPage() {
  const { settings, loading, saving, error } = SessionSettings
  const canManage = usePermission(Permissions.SessionSettingsManage)

  const form = useForm<FormValues>()

  // Re-seed from the store ONLY when the form has no unsaved edits, so a
  // sync-driven refetch doesn't clobber in-progress values.
  useEffect(() => {
    if (settings && !form.formState.isDirty) {
      form.reset({
        access_token_expiry_hours: settings.access_token_expiry_hours,
        refresh_token_expiry_days: settings.refresh_token_expiry_days,
      })
    }
  }, [settings, form])

  const onSubmit = async (v: FormValues) => {
    try {
      // Permissioned `auth.updateSessionSettings` action (thin wrapper over the SAME store method).
      await runAction('auth.updateSessionSettings', {
        access_token_expiry_hours: v.access_token_expiry_hours,
        refresh_token_expiry_days: v.refresh_token_expiry_days,
      })
      form.reset(v) // saved → allow the next store update to re-seed
      message.success('Session settings saved')
    } catch (e: unknown) {
      message.error(
        e instanceof Error ? e.message : 'Failed to save session settings',
      )
    }
  }

  const subtitle =
    'How long sign-ins last. Active sessions silently renew their access ' +
    'token before it expires; the session length bounds how long an idle ' +
    'session survives before the user must sign in again.'

  if (loading && !settings) {
    return (
      <SettingsPageContainer title="Sessions" subtitle={subtitle}>
        <div className="flex justify-center py-12">
          <Spin size="lg" label="Loading session settings" />
        </div>
      </SettingsPageContainer>
    )
  }

  // Primary load failed (no settings to show) → replace the form with a
  // persistent, retryable ErrorState. A later save failure keeps `settings`
  // and is surfaced by the toast in onSubmit, not here.
  if (error && !settings) {
    return (
      <SettingsPageContainer title="Sessions" subtitle={subtitle}>
        <ErrorState
          variant="page"
          resource="session settings"
          description="The session settings couldn't be loaded. Check your connection and try again."
          details={error}
          onRetry={() => void SessionSettings.load()}
          data-testid="session-settings-error"
        />
      </SettingsPageContainer>
    )
  }

  return (
    <SettingsPageContainer title="Sessions" subtitle={subtitle}>
      <Card
        data-testid="session-settings-card"
        title="Token lifetimes"
        footer={
          <SettingsFormActions
            onSave={form.handleSubmit(onSubmit)}
            onCancel={() => form.reset()}
            saving={saving}
            // TWO refusals used to share one grey button, and neither was stated: a viewer who
            // cannot manage these settings and an author who has not changed anything need
            // different sentences with different remedies.
            saveUnavailableReason={
              !canManage
                ? 'You do not have permission to change these settings'
                : !form.formState.isDirty
                  ? 'No changes to save'
                  : undefined
            }
            cancelUnavailableReason={
              !canManage ? 'You do not have permission to change these settings' : undefined
            }
            saveTestid="session-settings-save"
            cancelTestid="session-settings-cancel"
          />
        }
      >
        {!canManage && (
          <Alert
            data-testid="session-settings-readonly-alert"
            tone="info"
            title="Read-only view"
            description="You can view session settings but not change them."
            className="mb-3"
          />
        )}

        <Form
          data-testid="session-settings-form"
          form={form}
          layout="horizontal"
          disabled={!canManage}
          onSubmit={onSubmit}
        >
          <FormField
            name="access_token_expiry_hours"
            label="Access token lifetime"
            description="Shorter is safer — a deactivated account is cut off at the next renewal. Signed-in clients renew automatically, so users don't notice."
          >
            <InputNumber
              data-testid="session-settings-access-hours"
              min={1}
              max={8760}
              suffix="hours"
              className="w-full"
            />
          </FormField>
          <FormField
            name="refresh_token_expiry_days"
            label="Session length"
            description="How long a session survives with no activity before the user must sign in again. Active sessions roll forward on every renewal."
          >
            <InputNumber
              data-testid="session-settings-session-days"
              min={1}
              max={3650}
              suffix="days"
              className="w-full"
            />
          </FormField>
        </Form>
      </Card>
    </SettingsPageContainer>
  )
}
