import { useEffect } from 'react'
import { Alert, Card, Form, FormField, Input, message, useForm } from '@ziee/kit'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldTitle } from '@ziee/kit/shadcn/field'
import { Permissions } from '@/api-client/permissions'
import { usePermission } from '@/core/permissions'
import { SandboxSettings } from '@/modules/sandbox/stores/SandboxSettings.store'
import { SandboxStatus } from '@/modules/sandbox/stores/SandboxStatus.store'
import { runAction } from '@/core/actions/defineAction'
import { SettingsFormActions } from '@/modules/settings/components/SettingsFormActions'

type FormValues = { default_env_id: string }

/**
 * Environment-image settings (#54): the deployment DEFAULT env-id analyses run in
 * (editable — DATA declared by installed processors), plus the READ-ONLY registry
 * base + moving tag that images are pulled from and verified against. The registry
 * base is a release-time security boundary (the binary cannot be made to pull from
 * elsewhere), so it is displayed, never editable. Save gated on
 * `sandbox::settings::manage`.
 */
export function EnvImageCard() {
  const { limits, saving } = SandboxSettings
  const { status } = SandboxStatus
  const canManage = usePermission(Permissions.SandboxSettingsManage)

  const form = useForm<FormValues>()

  useEffect(() => {
    if (limits && !form.formState.isDirty) {
      form.reset({ default_env_id: limits.default_env_id ?? '' })
    }
  }, [limits, form])

  const onSubmit = async (v: FormValues) => {
    try {
      // Empty string clears the default back to auto-detect (server treats "" as unset).
      const ok = await runAction('sandbox.updateSettings', {
        default_env_id: v.default_env_id.trim(),
      })
      if (ok) {
        form.reset(v)
        message.success('Environment image settings saved')
      } else {
        message.error(SandboxSettings.$.error ?? 'Failed to save environment image settings')
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to save environment image settings')
    }
  }

  return (
    <Card
      data-testid="sandbox-env-image-card"
      title="Environment image"
      footer={
        <SettingsFormActions
          onSave={form.handleSubmit(onSubmit)}
          onCancel={() => form.reset()}
          saving={saving}
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
          saveTestid="sandbox-env-image-save"
          cancelTestid="sandbox-env-image-cancel"
        />
      }
    >
      {!canManage && (
        <Alert
          data-testid="sandbox-env-image-readonly-alert"
          tone="info"
          title="Read-only view"
          description="You can view the environment image settings but not change them."
          className="mb-3"
        />
      )}

      <Form
        data-testid="sandbox-env-image-form"
        form={form}
        layout="horizontal"
        disabled={!canManage}
        onSubmit={onSubmit}
      >
        <FormField
          name="default_env_id"
          label="Default environment id"
          description="The environment image analyses run in when a processor names none. Leave blank to auto-detect from installed processors. Lowercase letters, digits, and . _ - only."
        >
          <Input data-testid="sandbox-default-env-id" placeholder="auto-detect" className="w-full" />
        </FormField>
      </Form>

      {/* READ-ONLY: the registry base + moving tag are a security boundary, shown but
          never editable (they cannot be changed from the admin surface). */}
      <FieldGroup className="mt-2">
        <Field orientation="responsive">
          <FieldContent>
            <FieldTitle>Registry</FieldTitle>
            <FieldDescription>
              Where environment images are pulled from and cryptographically verified. Fixed for this
              build and not operator-configurable.
            </FieldDescription>
          </FieldContent>
          <span data-testid="sandbox-env-registry-base" className="text-sm text-muted-foreground break-all">
            {status?.env_registry_base ?? '—'}
          </span>
        </Field>
        <Field orientation="responsive">
          <FieldContent>
            <FieldTitle>Image tag</FieldTitle>
            <FieldDescription>
              The moving tag resolved to a content digest at pull time (schema + architecture scoped).
            </FieldDescription>
          </FieldContent>
          <span data-testid="sandbox-env-moving-tag" className="text-sm text-muted-foreground break-all">
            {status?.env_moving_tag ?? '—'}
          </span>
        </Field>
      </FieldGroup>
    </Card>
  )
}
