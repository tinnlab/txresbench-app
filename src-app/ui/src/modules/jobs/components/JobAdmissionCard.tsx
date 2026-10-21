import { useEffect } from 'react'
import { Alert, Card, Form, FormField, InputNumber, message, useForm } from '@ziee/kit'
import { Permissions } from '@/api-client/permissions'
import { usePermission } from '@/core/permissions'
import { JobSettings } from '@/modules/jobs/JobSettings.store'
import { runAction } from '@/core/actions/defineAction'
import { SettingsFormActions } from '@/modules/settings/components/SettingsFormActions'

type FormValues = {
  admission_wait_secs: number
  admission_poll_ms: number
}

/**
 * The jobs ADMISSION section — how long a detached background run (the conformance
 * gate) waits for a free compute slot before giving up, and how often it re-checks.
 * The wait is a deliberate guardrail (a longer wait is a hang), and the poll must
 * fit inside it. Save is the permissioned `jobs.updateSettings` action (a partial
 * update of just these fields). Mirrors ResourceLimitsCard.
 */
export function JobAdmissionCard() {
  const { settings, saving } = JobSettings
  const canManage = usePermission(Permissions.JobsSettingsManage)

  const form = useForm<FormValues>()

  useEffect(() => {
    if (settings && !form.formState.isDirty) {
      form.reset({
        admission_wait_secs: settings.admission_wait_secs,
        admission_poll_ms: settings.admission_poll_ms,
      })
    }
  }, [settings, form])

  const onSubmit = async (v: FormValues) => {
    try {
      const ok = await runAction('jobs.updateSettings', {
        admission_wait_secs: v.admission_wait_secs,
        admission_poll_ms: v.admission_poll_ms,
      })
      if (ok) {
        form.reset(v)
        message.success('Admission settings saved')
      } else {
        message.error(JobSettings.$.error ?? 'Failed to save admission settings')
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to save admission settings')
    }
  }

  return (
    <Card
      data-testid="job-admission-card"
      title="Admission"
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
          saveTestid="job-admission-save"
          cancelTestid="job-admission-cancel"
        />
      }
    >
      {!canManage && (
        <Alert
          data-testid="job-admission-readonly-alert"
          tone="info"
          title="Read-only view"
          description="You can view the admission settings but not change them."
          className="mb-3"
        />
      )}

      <Form
        data-testid="job-admission-form"
        form={form}
        layout="horizontal"
        disabled={!canManage}
        onSubmit={onSubmit}
      >
        <FormField
          name="admission_wait_secs"
          label="Slot wait budget"
          description="How long a background run waits for a free compute slot before giving up and reporting the work unchecked. Kept short on purpose — a long wait is indistinguishable from a hang."
        >
          <InputNumber
            data-testid="job-settings-admission-wait"
            min={1}
            max={60}
            suffix="seconds"
            className="w-full"
          />
        </FormField>
        <FormField
          name="admission_poll_ms"
          label="Slot poll interval"
          description="How often that wait re-checks for a free slot. Must be smaller than the wait budget above, so it checks more than once."
        >
          <InputNumber
            data-testid="job-settings-admission-poll"
            min={10}
            max={10000}
            suffix="ms"
            className="w-full"
          />
        </FormField>
      </Form>
    </Card>
  )
}
