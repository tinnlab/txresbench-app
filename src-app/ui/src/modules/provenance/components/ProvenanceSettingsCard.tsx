import { useEffect } from 'react'
import { Alert, Card, Form, FormField, InputNumber, Switch, message, useForm } from '@ziee/kit'
import { Permissions } from '@/api-client/permissions'
import { usePermission } from '@/core/permissions'
import { ProvenanceSettings } from '@/modules/provenance/stores/ProvenanceSettings.store'
import { runAction } from '@/core/actions/defineAction'
import { SettingsFormActions } from '@/modules/settings/components/SettingsFormActions'

const MIB = 1024 * 1024

const SECS_PER_HOUR = 3600

type FormValues = {
  export_bundle_max_mib: number
  export_retention_days: number
  methods_llm_polish_enabled: boolean
  verify_default_tolerance: number
  verify_time_budget_secs: number
  verify_size_budget_mib: number
  rootfs_gc_interval_hours: number
  rootfs_cache_max_digests: number
}

/**
 * The deployment-wide provenance settings form (export caps + the reserved
 * reproduction-verification budgets + the optional methods-polish toggle). Byte-valued
 * limits are edited in MiB. Save is gated on `provenance::settings::manage`; a
 * read-without-manage user sees a read-only view. Mirrors ResourceLimitsCard.
 */
export function ProvenanceSettingsCard() {
  const { settings, saving } = ProvenanceSettings
  const canManage = usePermission(Permissions.ProvenanceSettingsManage)

  const form = useForm<FormValues>()

  useEffect(() => {
    if (settings && !form.formState.isDirty) {
      form.reset({
        export_bundle_max_mib: Math.round(settings.export_bundle_max_bytes / MIB),
        export_retention_days: settings.export_retention_days,
        methods_llm_polish_enabled: settings.methods_llm_polish_enabled,
        verify_default_tolerance: settings.verify_default_tolerance,
        verify_time_budget_secs: settings.verify_time_budget_secs,
        verify_size_budget_mib: Math.round(settings.verify_size_budget_bytes / MIB),
        // Byte-valued interval is stored in seconds; edited in whole hours (min 1h).
        rootfs_gc_interval_hours: Math.max(1, Math.round(settings.rootfs_gc_interval_secs / SECS_PER_HOUR)),
        rootfs_cache_max_digests: settings.rootfs_cache_max_digests,
      })
    }
  }, [settings, form])

  const onSubmit = async (v: FormValues) => {
    // Permissioned `provenance.updateSettings` action (thin wrapper over the SAME store
    // method) so the save is equally AI-drivable, not a human-only form submit (INV-1).
    try {
      const ok = await runAction('provenance.updateSettings', {
        export_bundle_max_bytes: Math.round(v.export_bundle_max_mib * MIB),
        export_retention_days: v.export_retention_days,
        methods_llm_polish_enabled: v.methods_llm_polish_enabled,
        verify_default_tolerance: v.verify_default_tolerance,
        verify_time_budget_secs: v.verify_time_budget_secs,
        verify_size_budget_bytes: Math.round(v.verify_size_budget_mib * MIB),
        rootfs_gc_interval_secs: Math.round(v.rootfs_gc_interval_hours * SECS_PER_HOUR),
        rootfs_cache_max_digests: v.rootfs_cache_max_digests,
      })
      if (ok) {
        form.reset(v)
        message.success('Provenance settings saved')
      } else {
        message.error(ProvenanceSettings.$.error ?? 'Failed to save provenance settings')
      }
    } catch (e) {
      // The action layer adds zod validation over the prior direct store call, so a
      // rejected param surfaces as a toast (the old direct save never threw client-side).
      message.error(e instanceof Error ? e.message : 'Failed to save provenance settings')
    }
  }

  return (
    <Card
      data-testid="provenance-settings-card"
      title="Provenance settings"
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
          saveTestid="provenance-settings-save"
          cancelTestid="provenance-settings-cancel"
        />
      }
    >
      {!canManage && (
        <Alert
          data-testid="provenance-settings-readonly-alert"
          tone="info"
          title="Read-only view"
          description="You can view the provenance settings but not change them."
          className="mb-3"
        />
      )}

      <Form
        data-testid="provenance-settings-form"
        form={form}
        layout="horizontal"
        disabled={!canManage}
        onSubmit={onSubmit}
      >
        <FormField
          name="export_bundle_max_mib"
          label="Export bundle size cap"
          description="Files larger than this are listed for external download instead of being embedded in the bundle."
        >
          <InputNumber data-testid="provenance-settings-bundle-max" min={1} max={1048576} suffix="MiB" className="w-full" />
        </FormField>
        <FormField
          name="export_retention_days"
          label="Export retention"
          description="Intended lifetime of built export bundles (0 = keep forever). Reserved — not enforced yet: bundles are currently transient and removed after download."
        >
          <InputNumber data-testid="provenance-settings-retention" min={0} max={3650} suffix="days" className="w-full" />
        </FormField>
        <FormField
          name="methods_llm_polish_enabled"
          label="LLM methods polish"
          description="Optional LLM-assisted methods write-up (OFF = fully deterministic)."
          valuePropName="checked"
        >
          <Switch aria-label="LLM methods polish" data-testid="provenance-settings-polish" />
        </FormField>
        <Alert
          data-testid="provenance-settings-verify-note"
          tone="info"
          title="Reserved for upcoming re-run verification"
          description="These three settings configure an upcoming feature that re-runs an analysis to confirm it reproduces. They have no effect yet."
          className="mb-3"
        />
        <FormField
          name="verify_default_tolerance"
          label="Reproduction tolerance"
          description="How close a re-run's results must be to the original to count as reproduced."
        >
          <InputNumber data-testid="provenance-settings-tolerance" min={0} max={1} step={0.001} className="w-full" />
        </FormField>
        <FormField
          name="verify_time_budget_secs"
          label="Reproduction time budget"
          description="Longest a reproduction re-run is allowed to take."
        >
          <InputNumber data-testid="provenance-settings-time-budget" min={1} max={86400} suffix="seconds" className="w-full" />
        </FormField>
        <FormField
          name="verify_size_budget_mib"
          label="Reproduction size budget"
          description="Largest input a reproduction re-run will re-download."
        >
          <InputNumber data-testid="provenance-settings-size-budget" min={1} max={1048576} suffix="MiB" className="w-full" />
        </FormField>
        <Alert
          data-testid="provenance-settings-gc-note"
          tone="info"
          title="Rootfs image cache"
          description="The local cache of reproducibility environment images (rootfs). A background sweep bounds it — it only evicts re-obtainable images, never a running one and never a provenance record."
          className="mb-3"
        />
        <FormField
          name="rootfs_gc_interval_hours"
          label="Cache sweep interval"
          description="How often the background sweep runs to bound the local image cache."
        >
          <InputNumber
            data-testid="provenance-settings-gc-interval"
            min={1}
            max={168}
            suffix="hours"
            className="w-full"
          />
        </FormField>
        <FormField
          name="rootfs_cache_max_digests"
          label="Cache size"
          description="How many environment images the local cache keeps. Older, unreferenced images beyond this are evicted (they stay re-downloadable)."
        >
          <InputNumber
            data-testid="provenance-settings-cache-size"
            min={1}
            max={1000}
            suffix="images"
            className="w-full"
          />
        </FormField>
      </Form>
    </Card>
  )
}
