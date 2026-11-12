import { useEffect } from 'react'
import { Alert, Card, Form, FormField, InputNumber, message, useForm } from '@txresbench/kit'
import { Permissions } from '@/api-client/permissions'
import { usePermission } from '@/core/permissions'
import { JobSettings } from '@/modules/jobs/JobSettings.store'
import { runAction } from '@/core/actions/defineAction'
import { SettingsFormActions } from '@/modules/settings/components/SettingsFormActions'

type FormValues = {
  heartbeat_secs: number
  reaper_tick_secs: number
  stale_threshold_secs: number
  max_reclaims: number
  reclaim_batch: number
  dispatch_tick_ms: number
  metric_tick_secs: number
}

/**
 * The jobs SCHEDULER section (#56) — the multi-worker reaper + loop cadences: how
 * often a worker heartbeats its claimed jobs, how often the single-leader reaper
 * sweeps for dead-worker jobs, how long a claim can go silent before it is reclaimed,
 * the poison-job discard cap + bounded sweep batch, and the dispatch/metric loop
 * cadences. Save is the permissioned `jobs.updateSettings` action (a partial update of
 * just these fields). Mirrors JobAdmissionCard.
 *
 * The stale-threshold field is the one CORRECTNESS guardrail: it must stay a generous
 * multiple of the heartbeat (>= 3x, enforced server-side) so the reaper never reclaims
 * a job a live worker is still running.
 */
export function JobSchedulerCard() {
  const { settings, saving } = JobSettings
  const canManage = usePermission(Permissions.JobsSettingsManage)

  const form = useForm<FormValues>()

  useEffect(() => {
    if (settings && !form.formState.isDirty) {
      form.reset({
        heartbeat_secs: settings.heartbeat_secs,
        reaper_tick_secs: settings.reaper_tick_secs,
        stale_threshold_secs: settings.stale_threshold_secs,
        max_reclaims: settings.max_reclaims,
        reclaim_batch: settings.reclaim_batch,
        dispatch_tick_ms: settings.dispatch_tick_ms,
        metric_tick_secs: settings.metric_tick_secs,
      })
    }
  }, [settings, form])

  const onSubmit = async (v: FormValues) => {
    try {
      const ok = await runAction('jobs.updateSettings', {
        heartbeat_secs: v.heartbeat_secs,
        reaper_tick_secs: v.reaper_tick_secs,
        stale_threshold_secs: v.stale_threshold_secs,
        max_reclaims: v.max_reclaims,
        reclaim_batch: v.reclaim_batch,
        dispatch_tick_ms: v.dispatch_tick_ms,
        metric_tick_secs: v.metric_tick_secs,
      })
      if (ok) {
        form.reset(v)
        message.success('Scheduler settings saved')
      } else {
        message.error(JobSettings.$.error ?? 'Failed to save scheduler settings')
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to save scheduler settings')
    }
  }

  return (
    <Card
      data-testid="job-scheduler-card"
      title="Scheduler & reaper"
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
          saveTestid="job-scheduler-save"
          cancelTestid="job-scheduler-cancel"
        />
      }
    >
      {!canManage && (
        <Alert
          data-testid="job-scheduler-readonly-alert"
          tone="info"
          title="Read-only view"
          description="You can view the scheduler settings but not change them."
          className="mb-3"
        />
      )}

      <Form
        data-testid="job-scheduler-form"
        form={form}
        layout="horizontal"
        disabled={!canManage}
        onSubmit={onSubmit}
      >
        <FormField
          name="heartbeat_secs"
          label="Worker heartbeat"
          description="How often each worker refreshes the claim on the jobs it is running, so the reaper knows it is still alive."
        >
          <InputNumber
            data-testid="job-settings-heartbeat"
            min={1}
            max={60}
            suffix="seconds"
            className="w-full"
          />
        </FormField>
        <FormField
          name="reaper_tick_secs"
          label="Reaper sweep interval"
          description="How often the reaper checks for jobs whose worker has died and reclaims them."
        >
          <InputNumber
            data-testid="job-settings-reaper-tick"
            min={1}
            max={300}
            suffix="seconds"
            className="w-full"
          />
        </FormField>
        <FormField
          name="stale_threshold_secs"
          label="Stale-reclaim threshold"
          description="How long a running job can go without a heartbeat before the reaper treats its worker as dead and reclaims it. Kept at least 3x the heartbeat on purpose, so a slow-but-live worker is never reclaimed mid-run."
        >
          <InputNumber
            data-testid="job-settings-stale-threshold"
            min={5}
            max={3600}
            suffix="seconds"
            className="w-full"
          />
        </FormField>
        <FormField
          name="max_reclaims"
          label="Max reclaims before failing"
          description="How many times a job may be reclaimed before it is treated as a poison job and marked failed instead of re-queued."
        >
          <InputNumber
            data-testid="job-settings-max-reclaims"
            min={1}
            max={100}
            suffix="count"
            className="w-full"
          />
        </FormField>
        <FormField
          name="reclaim_batch"
          label="Reclaim batch size"
          description="The most jobs a single reaper sweep will reclaim or discard, so the sweep never runs an unbounded update."
        >
          <InputNumber
            data-testid="job-settings-reclaim-batch"
            min={1}
            max={10000}
            suffix="count"
            className="w-full"
          />
        </FormField>
        <FormField
          name="dispatch_tick_ms"
          label="Dispatch interval"
          description="How often the scheduler wakes to claim and start the next queued job."
        >
          <InputNumber
            data-testid="job-settings-dispatch-tick"
            min={50}
            max={60000}
            suffix="ms"
            className="w-full"
          />
        </FormField>
        <FormField
          name="metric_tick_secs"
          label="Metric sampling interval"
          description="How often a running job's CPU and memory are sampled for its live metrics."
        >
          <InputNumber
            data-testid="job-settings-metric-tick"
            min={1}
            max={60}
            suffix="seconds"
            className="w-full"
          />
        </FormField>
      </Form>
    </Card>
  )
}
