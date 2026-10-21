import { useEffect } from 'react'
import { Alert, Card, Form, FormField, InputNumber, Switch, message, useForm } from '@ziee/kit'
import { Permissions } from '@/api-client/permissions'
import { usePermission } from '@/core/permissions'
import { WorkstoreSettings } from '@/modules/workstore/stores/WorkstoreSettings.store'
import { runAction } from '@/core/actions/defineAction'
import { SettingsFormActions } from '@/modules/settings/components/SettingsFormActions'

const GIB = 1024 * 1024 * 1024
const MIB = 1024 * 1024

/**
 * What the form DISPLAYS for the stored upload ceiling: whole **MiB**.
 *
 * ## Why this field is in MiB when its two neighbours are in GiB
 *
 * The server validates all three byte ceilings against a **1 MiB floor**
 * (`modules/workstore/settings.rs:151-162`). A GiB-granular input therefore cannot
 * represent the bottom three orders of magnitude of the field's own legal range, and
 * every problem this control has had came from that one mismatch, not from the code
 * built on top of it:
 *
 * * a stored value below 0.5 GiB rounds to `0`, which is under the input's `min` — on
 *   the two GiB siblings that is not hypothetical: with `max_output_file_bytes` at
 *   300 MiB the field renders `0`, the save PUTs `0`, the server refuses it 422, and
 *   the whole card — including its unrelated fields — becomes unsaveable;
 * * clamping the display to dodge that (which this field used to do) silently widens
 *   the ceiling instead: a stored 1 MiB displayed as `1` GiB and was written back as
 *   1 GiB on the next save of any other field — a **1024x** loosening of a SaaS
 *   security ceiling, reported as "saved";
 * * and because the display was lossy, an admin could not LOWER a 2.4 GiB ceiling to
 *   2 GiB at all: the typed `2` equalled the displayed `2`, so the form never became
 *   dirty and Save stayed disabled.
 *
 * Two rounds of trying to recover the admin's intent from the rounded value failed,
 * both fail-open, because the information was destroyed before any of that code ran.
 * MiB granularity does not destroy it: every value the server will accept is at least
 * 1 MiB, so it round-trips exactly, the clamp below never fires for a legal row, the
 * conversion is unconditional, and lowering works because the typed number differs
 * from the displayed one.
 *
 * The divergence from the two sibling fields is deliberate and is the point — they
 * carry the same latent defect, demonstrated above, on the same 1 MiB floor. Bringing
 * them along is a change to the shipped card and belongs in its own issue, not smuggled
 * into this one.
 *
 * Residual: a ceiling set through the API to something that is not a whole number of
 * MiB is rewritten to the nearest MiB on the next save of this card — at most ±512 KiB,
 * against the ±512 MiB the GiB version could move it.
 */
export function uploadBodyMibForDisplay(bytes: number): number {
  // The clamp cannot fire for a value the server would have accepted (its floor is
  // 1 MiB); it only guards a hand-corrupted row from rendering 0 and jamming the form.
  return Math.max(1, Math.round(bytes / MIB))
}

type FormValues = {
  gc_enabled: boolean
  gc_interval_hours: number
  gc_grace_secs: number
  max_output_file_gib: number
  max_multifile_total_gib: number
  max_upload_body_mib: number
  max_upload_parts: number
}

/**
 * The workstore limits form (issue #54): GC policy (sweep on/off, cadence, orphan
 * grace) + ingest size caps (max single-file, max multi-file total). The byte caps
 * are edited in GiB; GC grace in seconds; cadence in hours. Save is gated on
 * `workstore::settings::manage`; a read-without-manage user sees a read-only view.
 * The caps are SAFETY limits — the server bounds them (a raise is rejected 422).
 * Mirrors `ResourceLimitsCard`.
 */
export function WorkstoreLimitsCard() {
  const { settings, saving } = WorkstoreSettings
  const canManage = usePermission(Permissions.WorkstoreSettingsManage)

  const form = useForm<FormValues>()

  // Re-seed from the store only when the form has no unsaved edits.
  useEffect(() => {
    if (settings && !form.formState.isDirty) {
      form.reset({
        gc_enabled: settings.gc_enabled,
        gc_interval_hours: settings.gc_interval_hours,
        gc_grace_secs: settings.gc_grace_secs,
        max_output_file_gib: Math.round(settings.max_output_file_bytes / GIB),
        max_multifile_total_gib: Math.round(settings.max_multifile_total_bytes / GIB),
        max_upload_body_mib: uploadBodyMibForDisplay(settings.max_upload_body_bytes),
        max_upload_parts: settings.max_upload_parts,
      })
    }
  }, [settings, form])

  const onSubmit = async (v: FormValues) => {
    // Permissioned `workstore.updateSettings` action (thin wrapper over the SAME store
    // method) so the save is equally AI-drivable, not a human-only form submit.
    try {
      const ok = await runAction('workstore.updateSettings', {
        gc_enabled: v.gc_enabled,
        gc_interval_hours: v.gc_interval_hours,
        gc_grace_secs: v.gc_grace_secs,
        max_output_file_bytes: Math.round(v.max_output_file_gib * GIB),
        max_multifile_total_bytes: Math.round(v.max_multifile_total_gib * GIB),
        // Unconditional and lossless: MiB is the server's own granularity, so there
        // is no intent to recover. See `uploadBodyMibForDisplay`.
        max_upload_body_bytes: Math.round(v.max_upload_body_mib * MIB),
        max_upload_parts: v.max_upload_parts,
      })
      if (ok) {
        form.reset(v)
        message.success('Workstore settings saved')
      } else {
        message.error(WorkstoreSettings.$.error ?? 'Failed to save workstore settings')
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to save workstore settings')
    }
  }

  return (
    <Card
      data-testid="workstore-limits-card"
      title="Workstore limits"
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
          saveTestid="workstore-limits-save"
          cancelTestid="workstore-limits-cancel"
        />
      }
    >
      {!canManage && (
        <Alert
          data-testid="workstore-limits-readonly-alert"
          tone="info"
          title="Read-only view"
          description="You can view the workstore settings but not change them."
          className="mb-3"
        />
      )}

      <Form
        data-testid="workstore-limits-form"
        form={form}
        layout="horizontal"
        disabled={!canManage}
        onSubmit={onSubmit}
      >
        <div className="mb-2 text-sm font-medium text-muted-foreground">Garbage collection</div>
        <FormField
          name="gc_enabled"
          label="Enable GC sweep"
          description="The standing blob-GC sweep that reclaims orphaned objects. Toggling takes effect on the next cycle."
          valuePropName="checked"
        >
          <Switch data-testid="workstore-gc-enabled" />
        </FormField>
        <FormField
          name="gc_interval_hours"
          label="Sweep cadence"
          description="How often the GC sweep runs. Takes effect without a restart."
        >
          <InputNumber data-testid="workstore-gc-interval" min={1} max={720} suffix="hours" className="w-full" />
        </FormField>
        <FormField
          name="gc_grace_secs"
          label="Orphan grace"
          description="A blob younger than this is spared by the full sweep — it may be a still-committing ingest write. Floor-bounded so it can never free an in-flight artifact."
        >
          <InputNumber data-testid="workstore-gc-grace" min={300} max={604800} suffix="seconds" className="w-full" />
        </FormField>

        <div className="mb-2 mt-4 text-sm font-medium text-muted-foreground">Ingest size caps</div>
        <FormField
          name="max_output_file_gib"
          label="Max single-file size"
          description="Largest single output file (and each multi-file member) ingest will accept. A safety limit: the store reads the whole file into memory. Bounded 1–64 GiB."
        >
          <InputNumber data-testid="workstore-max-file" min={1} max={64} suffix="GiB" className="w-full" />
        </FormField>
        <FormField
          name="max_multifile_total_gib"
          label="Max multi-file total"
          description="Largest total size of a multi-file (directory) artifact ingest will accept. A safety limit. Bounded 1–256 GiB, and never below the single-file cap."
        >
          <InputNumber data-testid="workstore-max-total" min={1} max={256} suffix="GiB" className="w-full" />
        </FormField>

        <div className="mb-2 mt-4 text-sm font-medium text-muted-foreground">Upload limits</div>
        <FormField
          name="max_upload_body_mib"
          label="Max upload size (MiB)"
          description="Ceiling on a dataset UPLOAD request body. Applies to SaaS deployments; self-hosted uploads are uncapped — your own disk is the limit there. Bounded 1 MiB – 256 GiB (262144 MiB)."
        >
          <InputNumber data-testid="workstore-max-upload-body" min={1} max={262144} suffix="MiB" className="w-full" />
        </FormField>
        <FormField
          name="max_upload_parts"
          label="Max upload parts"
          description="The maximum number of files in one multipart upload. Applies in both SaaS and self-hosted deployments. Bounded 1–65536."
        >
          <InputNumber data-testid="workstore-max-upload-parts" min={1} max={65536} suffix="parts" className="w-full" />
        </FormField>
      </Form>
    </Card>
  )
}
