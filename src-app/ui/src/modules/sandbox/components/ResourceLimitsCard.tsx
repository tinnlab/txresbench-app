import { useEffect } from 'react'
import { Alert, Card, Form, FormField, Input, InputNumber, message, useForm } from '@txresbench/kit'
import { Permissions } from '@/api-client/permissions'
import { usePermission } from '@/core/permissions'
import { SandboxSettings } from '@/modules/sandbox/stores/SandboxSettings.store'
import { runAction } from '@/core/actions/defineAction'
import { SettingsFormActions } from '@/modules/settings/components/SettingsFormActions'

const MIB = 1024 * 1024

type FormValues = {
  memory_max_mib: number
  memory_swap_max_mib: number
  address_space_mib: number
  fsize_mib: number
  pids_max: number
  nproc_max: number
  nofile_max: number
  cpu_secs_max: number
  timeout_secs: number
  staging_timeout_secs: number
  cpu_max: string
}

/**
 * The sandbox resource-limits form (the caps every analysis run is bounded by).
 * Byte-valued limits are edited in MiB; `cpu_max` is bwrap/cgroup's
 * "<quota> <period>" form. Save is gated on `sandbox::settings::manage`;
 * a read-without-manage user sees a read-only view. Mirrors SessionSettingsPage.
 */
export function ResourceLimitsCard() {
  const { limits, saving } = SandboxSettings
  const canManage = usePermission(Permissions.SandboxSettingsManage)

  const form = useForm<FormValues>()

  // Re-seed from the store only when the form has no unsaved edits.
  useEffect(() => {
    if (limits && !form.formState.isDirty) {
      form.reset({
        memory_max_mib: Math.round(limits.memory_max_bytes / MIB),
        memory_swap_max_mib: Math.round(limits.memory_swap_max_bytes / MIB),
        address_space_mib: Math.round(limits.address_space_bytes / MIB),
        fsize_mib: Math.round(limits.fsize_bytes / MIB),
        pids_max: limits.pids_max,
        nproc_max: limits.nproc_max,
        nofile_max: limits.nofile_max,
        cpu_secs_max: limits.cpu_secs_max,
        timeout_secs: limits.timeout_secs,
        staging_timeout_secs: limits.staging_timeout_secs,
        cpu_max: limits.cpu_max,
      })
    }
  }, [limits, form])

  const onSubmit = async (v: FormValues) => {
    // Permissioned `sandbox.updateSettings` action (thin wrapper over the SAME store
    // method) so the save is equally AI-drivable, not a human-only form submit (INV-1).
    try {
      const ok = await runAction('sandbox.updateSettings', {
        memory_max_bytes: Math.round(v.memory_max_mib * MIB),
        memory_swap_max_bytes: Math.round(v.memory_swap_max_mib * MIB),
        address_space_bytes: Math.round(v.address_space_mib * MIB),
        fsize_bytes: Math.round(v.fsize_mib * MIB),
        pids_max: v.pids_max,
        nproc_max: v.nproc_max,
        nofile_max: v.nofile_max,
        cpu_secs_max: v.cpu_secs_max,
        timeout_secs: v.timeout_secs,
        staging_timeout_secs: v.staging_timeout_secs,
        cpu_max: v.cpu_max,
      })
      if (ok) {
        form.reset(v)
        message.success('Sandbox limits saved')
      } else {
        message.error(SandboxSettings.$.error ?? 'Failed to save sandbox limits')
      }
    } catch (e) {
      // The action layer adds zod validation over the prior direct store call, so a
      // rejected param surfaces as a toast (the old direct save never threw client-side).
      message.error(e instanceof Error ? e.message : 'Failed to save sandbox limits')
    }
  }

  return (
    <Card
      data-testid="sandbox-limits-card"
      title="Resource limits"
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
          saveTestid="sandbox-limits-save"
          cancelTestid="sandbox-limits-cancel"
        />
      }
    >
      {!canManage && (
        <Alert
          data-testid="sandbox-limits-readonly-alert"
          tone="info"
          title="Read-only view"
          description="You can view the sandbox limits but not change them."
          className="mb-3"
        />
      )}

      <Form
        data-testid="sandbox-limits-form"
        form={form}
        layout="horizontal"
        disabled={!canManage}
        onSubmit={onSubmit}
      >
        <FormField name="memory_max_mib" label="Memory limit" description="Max resident memory per analysis run.">
          <InputNumber data-testid="sandbox-limits-memory" min={64} max={262144} suffix="MiB" className="w-full" />
        </FormField>
        <FormField name="memory_swap_max_mib" label="Memory + swap limit" description="Max memory including swap.">
          <InputNumber data-testid="sandbox-limits-memory-swap" min={0} max={262144} suffix="MiB" className="w-full" />
        </FormField>
        <FormField name="address_space_mib" label="Address space (rlimit AS)" description="Virtual address-space cap.">
          <InputNumber data-testid="sandbox-limits-as" min={128} max={524288} suffix="MiB" className="w-full" />
        </FormField>
        <FormField name="fsize_mib" label="Max file size" description="Largest single file a run may write.">
          <InputNumber data-testid="sandbox-limits-fsize" min={1} max={262144} suffix="MiB" className="w-full" />
        </FormField>
        <FormField name="pids_max" label="Max processes (cgroup pids)" description="Concurrent processes/threads a run may spawn.">
          <InputNumber data-testid="sandbox-limits-pids" min={16} max={100000} className="w-full" />
        </FormField>
        <FormField name="nproc_max" label="Max processes (rlimit NPROC)" description="Per-user process rlimit inside the sandbox.">
          <InputNumber data-testid="sandbox-limits-nproc" min={16} max={100000} className="w-full" />
        </FormField>
        <FormField name="nofile_max" label="Max open files" description="Open file-descriptor rlimit.">
          <InputNumber data-testid="sandbox-limits-nofile" min={64} max={1048576} className="w-full" />
        </FormField>
        <FormField name="cpu_max" label="CPU quota (cgroup cpu.max)" description={'bwrap/cgroup "<quota> <period>" microseconds — e.g. "200000 100000" is 2 cores.'}>
          <Input data-testid="sandbox-limits-cpu-max" className="w-full" />
        </FormField>
        <FormField name="cpu_secs_max" label="CPU time limit" description="rlimit on total CPU seconds per run.">
          <InputNumber data-testid="sandbox-limits-cpu-secs" min={1} max={86400} suffix="seconds" className="w-full" />
        </FormField>
        <FormField name="timeout_secs" label="Wall-clock timeout" description="A run is SIGKILLed after this many seconds.">
          <InputNumber data-testid="sandbox-limits-timeout" min={1} max={86400} suffix="seconds" className="w-full" />
        </FormField>
        <FormField
          name="staging_timeout_secs"
          label="Staging timeout"
          description="Cap on the setup phase BEFORE a run starts (environment image fetch/verify/mount, input staging). The wall-clock timeout above only starts once the run's process exists, so this is what stops a job hanging forever on an unreachable registry. Raise it if first runs on a slow link legitimately need longer."
        >
          <InputNumber data-testid="sandbox-limits-staging-timeout" min={5} max={86400} suffix="seconds" className="w-full" />
        </FormField>
      </Form>
    </Card>
  )
}
