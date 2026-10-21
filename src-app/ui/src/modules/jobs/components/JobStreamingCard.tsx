import { useEffect } from 'react'
import { Alert, Card, Form, FormField, InputNumber, message, useForm } from '@ziee/kit'
import { Permissions } from '@/api-client/permissions'
import { usePermission } from '@/core/permissions'
import { JobSettings } from '@/modules/jobs/JobSettings.store'
import { runAction } from '@/core/actions/defineAction'
import { SettingsFormActions } from '@/modules/settings/components/SettingsFormActions'

type FormValues = {
  sse_keep_alive_secs: number
  sse_max_clients: number
}

/**
 * The jobs STREAMING (SSE) section — the live `GET /jobs/{id}/stream` tunables:
 * the keep-alive heartbeat interval and the global cap on concurrent per-job
 * subscribers (an OOM guard). Both are read at each stream connect. Save is the
 * permissioned `jobs.updateSettings` action (a partial update of just these
 * fields). Mirrors ResourceLimitsCard.
 */
export function JobStreamingCard() {
  const { settings, saving } = JobSettings
  const canManage = usePermission(Permissions.JobsSettingsManage)

  const form = useForm<FormValues>()

  useEffect(() => {
    if (settings && !form.formState.isDirty) {
      form.reset({
        sse_keep_alive_secs: settings.sse_keep_alive_secs,
        sse_max_clients: settings.sse_max_clients,
      })
    }
  }, [settings, form])

  const onSubmit = async (v: FormValues) => {
    try {
      const ok = await runAction('jobs.updateSettings', {
        sse_keep_alive_secs: v.sse_keep_alive_secs,
        sse_max_clients: v.sse_max_clients,
      })
      if (ok) {
        form.reset(v)
        message.success('Streaming settings saved')
      } else {
        message.error(JobSettings.$.error ?? 'Failed to save streaming settings')
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to save streaming settings')
    }
  }

  return (
    <Card
      data-testid="job-streaming-card"
      title="Streaming (SSE)"
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
          saveTestid="job-streaming-save"
          cancelTestid="job-streaming-cancel"
        />
      }
    >
      {!canManage && (
        <Alert
          data-testid="job-streaming-readonly-alert"
          tone="info"
          title="Read-only view"
          description="You can view the streaming settings but not change them."
          className="mb-3"
        />
      )}

      <Form
        data-testid="job-streaming-form"
        form={form}
        layout="horizontal"
        disabled={!canManage}
        onSubmit={onSubmit}
      >
        <FormField
          name="sse_keep_alive_secs"
          label="Keep-alive heartbeat"
          description="How often the live job stream sends a heartbeat to keep the connection open through proxies. Too long and an idle stream is dropped."
        >
          <InputNumber
            data-testid="job-settings-sse-keep-alive"
            min={1}
            max={300}
            suffix="seconds"
            className="w-full"
          />
        </FormField>
        <FormField
          name="sse_max_clients"
          label="Max stream subscribers"
          description="A safety cap on how many live job-stream connections the server holds at once, protecting it from running out of memory. Raise only if you genuinely have many simultaneous viewers."
        >
          <InputNumber
            data-testid="job-settings-sse-max-clients"
            min={1}
            max={4096}
            suffix="clients"
            className="w-full"
          />
        </FormField>
      </Form>
    </Card>
  )
}
