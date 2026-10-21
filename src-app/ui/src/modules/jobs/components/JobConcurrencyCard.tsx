import { useEffect } from 'react'
import { Alert, Card, Form, FormField, InputNumber, message, useForm } from '@ziee/kit'
import { Permissions } from '@/api-client/permissions'
import { usePermission } from '@/core/permissions'
import { JobSettings } from '@/modules/jobs/JobSettings.store'
import { runAction } from '@/core/actions/defineAction'
import { SettingsFormActions } from '@/modules/settings/components/SettingsFormActions'

type FormValues = {
  max_concurrent_jobs: number
  reserved_interactive_slots: number
  per_tenant_max_concurrent: number
}

/**
 * The jobs CONCURRENCY section — the deployment-wide admission caps the scheduler
 * enforces: how many jobs run at once, how many slots are reserved for interactive
 * re-runs, and the per-tenant cap. Save is the permissioned `jobs.updateSettings`
 * action (a partial update of just these fields). Mirrors ResourceLimitsCard.
 */
export function JobConcurrencyCard() {
  const { settings, saving } = JobSettings
  const canManage = usePermission(Permissions.JobsSettingsManage)

  const form = useForm<FormValues>()

  useEffect(() => {
    if (settings && !form.formState.isDirty) {
      form.reset({
        max_concurrent_jobs: settings.max_concurrent_jobs,
        reserved_interactive_slots: settings.reserved_interactive_slots,
        per_tenant_max_concurrent: settings.per_tenant_max_concurrent,
      })
    }
  }, [settings, form])

  const onSubmit = async (v: FormValues) => {
    try {
      const ok = await runAction('jobs.updateSettings', {
        max_concurrent_jobs: v.max_concurrent_jobs,
        reserved_interactive_slots: v.reserved_interactive_slots,
        per_tenant_max_concurrent: v.per_tenant_max_concurrent,
      })
      if (ok) {
        form.reset(v)
        message.success('Concurrency settings saved')
      } else {
        message.error(JobSettings.$.error ?? 'Failed to save concurrency settings')
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to save concurrency settings')
    }
  }

  return (
    <Card
      data-testid="job-concurrency-card"
      title="Concurrency"
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
          saveTestid="job-concurrency-save"
          cancelTestid="job-concurrency-cancel"
        />
      }
    >
      {!canManage && (
        <Alert
          data-testid="job-concurrency-readonly-alert"
          tone="info"
          title="Read-only view"
          description="You can view the job settings but not change them."
          className="mb-3"
        />
      )}

      <Form
        data-testid="job-concurrency-form"
        form={form}
        layout="horizontal"
        disabled={!canManage}
        onSubmit={onSubmit}
      >
        <FormField
          name="max_concurrent_jobs"
          label="Max concurrent jobs"
          description="How many jobs run at the same time. Higher uses more CPU + memory; lower keeps more jobs waiting in the queue."
        >
          <InputNumber data-testid="job-settings-max-concurrent" min={1} max={64} className="w-full" />
        </FormField>
        <FormField
          name="reserved_interactive_slots"
          label="Reserved interactive slots"
          description="Slots held back from batch work so a just-arrived interactive re-run is not head-of-line-blocked. Must be less than max concurrent jobs."
        >
          <InputNumber data-testid="job-settings-reserved" min={0} max={63} className="w-full" />
        </FormField>
        <FormField
          name="per_tenant_max_concurrent"
          label="Per-tenant max concurrent"
          description="The most jobs any single owner may have running at once, on top of the global cap — so one tenant cannot occupy every slot."
        >
          <InputNumber data-testid="job-settings-per-tenant" min={1} max={64} className="w-full" />
        </FormField>
      </Form>
    </Card>
  )
}
