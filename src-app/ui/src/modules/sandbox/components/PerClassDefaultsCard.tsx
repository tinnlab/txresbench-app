import { useEffect } from 'react'
import { Alert, Card, Form, FormField, InputNumber, message, useForm } from '@ziee/kit'
import { Permissions } from '@/api-client/permissions'
import { usePermission } from '@/core/permissions'
import { SandboxSettings } from '@/modules/sandbox/stores/SandboxSettings.store'
import { runAction } from '@/core/actions/defineAction'
import { SettingsFormActions } from '@/modules/settings/components/SettingsFormActions'

const MIB = 1024 * 1024

type FormValues = {
  interactive_cpu_cores: number
  interactive_mem_mib: number
  normal_cpu_cores: number
  normal_mem_mib: number
  batch_cpu_cores: number
  batch_mem_mib: number
}

/**
 * The per-class resource DEFAULTS form (#54): the CPU/memory a job of each priority
 * class gets by default when it names no explicit request. These are a REQUEST that
 * the server clamps DOWN to the box-wide ceiling (the Resource limits card above), so
 * a class default can only LOWER what its jobs ask for, never exceed the ceiling.
 * Save is gated on `sandbox::settings::manage`; a read-without-manage user sees a
 * read-only view. Mirrors ResourceLimitsCard.
 */
export function PerClassDefaultsCard() {
  const { limits, saving } = SandboxSettings
  const canManage = usePermission(Permissions.SandboxSettingsManage)

  const form = useForm<FormValues>()

  useEffect(() => {
    if (limits && !form.formState.isDirty) {
      form.reset({
        interactive_cpu_cores: limits.interactive_cpu_cores,
        interactive_mem_mib: Math.round(limits.interactive_mem_bytes / MIB),
        normal_cpu_cores: limits.normal_cpu_cores,
        normal_mem_mib: Math.round(limits.normal_mem_bytes / MIB),
        batch_cpu_cores: limits.batch_cpu_cores,
        batch_mem_mib: Math.round(limits.batch_mem_bytes / MIB),
      })
    }
  }, [limits, form])

  const onSubmit = async (v: FormValues) => {
    try {
      const ok = await runAction('sandbox.updateSettings', {
        interactive_cpu_cores: v.interactive_cpu_cores,
        interactive_mem_bytes: Math.round(v.interactive_mem_mib * MIB),
        normal_cpu_cores: v.normal_cpu_cores,
        normal_mem_bytes: Math.round(v.normal_mem_mib * MIB),
        batch_cpu_cores: v.batch_cpu_cores,
        batch_mem_bytes: Math.round(v.batch_mem_mib * MIB),
      })
      if (ok) {
        form.reset(v)
        message.success('Per-class defaults saved')
      } else {
        message.error(SandboxSettings.$.error ?? 'Failed to save per-class defaults')
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to save per-class defaults')
    }
  }

  return (
    <Card
      data-testid="sandbox-per-class-card"
      title="Per-class defaults"
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
          saveTestid="sandbox-per-class-save"
          cancelTestid="sandbox-per-class-cancel"
        />
      }
    >
      <Alert
        data-testid="sandbox-per-class-hint"
        tone="info"
        title="Defaults are capped by the resource limits above"
        description="These are the CPU and memory a job of each priority class receives when it makes no explicit request. A run can ask for less; anything above the box-wide ceiling is clamped down to it."
        className="mb-3"
      />
      {!canManage && (
        <Alert
          data-testid="sandbox-per-class-readonly-alert"
          tone="info"
          title="Read-only view"
          description="You can view the per-class defaults but not change them."
          className="mb-3"
        />
      )}

      <Form
        data-testid="sandbox-per-class-form"
        form={form}
        layout="horizontal"
        disabled={!canManage}
        onSubmit={onSubmit}
      >
        <FormField name="interactive_cpu_cores" label="Interactive · CPU" description="Default cores for snappy, foreground runs.">
          <InputNumber data-testid="sandbox-interactive-cpu" min={1} max={256} suffix="cores" className="w-full" />
        </FormField>
        <FormField name="interactive_mem_mib" label="Interactive · Memory" description="Default memory for interactive runs.">
          <InputNumber data-testid="sandbox-interactive-mem" min={64} max={262144} suffix="MiB" className="w-full" />
        </FormField>
        <FormField name="normal_cpu_cores" label="Normal · CPU" description="Default cores for the standard working profile.">
          <InputNumber data-testid="sandbox-normal-cpu" min={1} max={256} suffix="cores" className="w-full" />
        </FormField>
        <FormField name="normal_mem_mib" label="Normal · Memory" description="Default memory for normal runs.">
          <InputNumber data-testid="sandbox-normal-mem" min={64} max={262144} suffix="MiB" className="w-full" />
        </FormField>
        <FormField name="batch_cpu_cores" label="Batch · CPU" description="Default cores for long-running batch jobs.">
          <InputNumber data-testid="sandbox-batch-cpu" min={1} max={256} suffix="cores" className="w-full" />
        </FormField>
        <FormField name="batch_mem_mib" label="Batch · Memory" description="Default memory for batch runs.">
          <InputNumber data-testid="sandbox-batch-mem" min={64} max={262144} suffix="MiB" className="w-full" />
        </FormField>
      </Form>
    </Card>
  )
}
