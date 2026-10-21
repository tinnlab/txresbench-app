import { useEffect } from 'react'
import { Alert, Card, Form, FormField, InputNumber, message, useForm } from '@ziee/kit'
import { Permissions } from '@/api-client/permissions'
import { usePermission } from '@/core/permissions'
import { McpSettings } from '@/modules/mcp/stores/McpSettings.store'
import { runAction } from '@/core/actions/defineAction'
import { SettingsFormActions } from '@/modules/settings/components/SettingsFormActions'

const KIB = 1024

type FormValues = {
  max_control_sessions: number
  max_inflight_per_user: number
  pairing_ttl_secs: number
  action_wall_clock_secs: number
  max_list_results: number
  max_result_kib: number
}

/**
 * The MCP limits form (issue #54): agent caps (max control sessions, max in-flight
 * invokes per user, per-action wall-clock backstop), the pairing-code TTL, and tool
 * caps (list-capabilities cap, invoke result-byte cap). Durations are edited in
 * seconds; the result cap in KiB. Save is gated on `mcp::settings::manage`; a
 * read-without-manage user sees a read-only view. Several caps are SAFETY limits —
 * the server bounds them (a raise is rejected 422). Mirrors `WorkstoreLimitsCard`.
 */
export function McpLimitsCard() {
  const { settings, saving } = McpSettings
  const canManage = usePermission(Permissions.McpSettingsManage)

  const form = useForm<FormValues>()

  // Re-seed from the store only when the form has no unsaved edits.
  useEffect(() => {
    if (settings && !form.formState.isDirty) {
      form.reset({
        max_control_sessions: settings.max_control_sessions,
        max_inflight_per_user: settings.max_inflight_per_user,
        pairing_ttl_secs: settings.pairing_ttl_secs,
        action_wall_clock_secs: settings.action_wall_clock_secs,
        max_list_results: settings.max_list_results,
        max_result_kib: Math.round(settings.max_result_bytes / KIB),
      })
    }
  }, [settings, form])

  const onSubmit = async (v: FormValues) => {
    // Permissioned `mcp.updateSettings` action (thin wrapper over the SAME store
    // method) so the save is equally AI-drivable, not a human-only form submit.
    try {
      const ok = await runAction('mcp.updateSettings', {
        max_control_sessions: v.max_control_sessions,
        max_inflight_per_user: v.max_inflight_per_user,
        pairing_ttl_secs: v.pairing_ttl_secs,
        action_wall_clock_secs: v.action_wall_clock_secs,
        max_list_results: v.max_list_results,
        max_result_bytes: Math.round(v.max_result_kib * KIB),
      })
      if (ok) {
        form.reset(v)
        message.success('MCP settings saved')
      } else {
        message.error(McpSettings.$.error ?? 'Failed to save MCP settings')
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to save MCP settings')
    }
  }

  return (
    <Card
      data-testid="mcp-limits-card"
      title="MCP limits"
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
          saveTestid="mcp-limits-save"
          cancelTestid="mcp-limits-cancel"
        />
      }
    >
      {!canManage && (
        <Alert
          data-testid="mcp-limits-readonly-alert"
          tone="info"
          title="Read-only view"
          description="You can view the MCP settings but not change them."
          className="mb-3"
        />
      )}

      <Form
        data-testid="mcp-limits-form"
        form={form}
        layout="horizontal"
        disabled={!canManage}
        onSubmit={onSubmit}
      >
        <div className="mb-2 text-sm font-medium text-muted-foreground">Agent session caps</div>
        <FormField
          name="max_control_sessions"
          label="Max control sessions"
          description="Global cap on concurrent AI-paired browser sessions (one per user). A safety limit that bounds server memory; the server refuses a raise beyond 16384."
        >
          <InputNumber data-testid="mcp-max-control-sessions" min={16} max={16384} suffix="sessions" className="w-full" />
        </FormField>
        <FormField
          name="max_inflight_per_user"
          label="Max in-flight per user"
          description="How many dispatched frontend actions one user may have awaiting a result at once. A safety limit against a flood of unanswered invokes. Bounded 1–256."
        >
          <InputNumber data-testid="mcp-max-inflight" min={1} max={256} suffix="per user" className="w-full" />
        </FormField>
        <FormField
          name="action_wall_clock_secs"
          label="Action wall-clock cap"
          description="Outer backstop on how long one dispatched action may run before it is failed as unresponsive. In seconds (default 900 = 15 min). Bounded 30–3600."
        >
          <InputNumber data-testid="mcp-wall-clock" min={30} max={3600} suffix="seconds" className="w-full" />
        </FormField>

        <div className="mb-2 mt-4 text-sm font-medium text-muted-foreground">Pairing</div>
        <FormField
          name="pairing_ttl_secs"
          label="Pairing-code TTL"
          description="How long a one-time pairing code stays claimable before it expires. In seconds (default 300 = 5 min). Bounded 30–3600."
        >
          <InputNumber data-testid="mcp-pairing-ttl" min={30} max={3600} suffix="seconds" className="w-full" />
        </FormField>

        <div className="mb-2 mt-4 text-sm font-medium text-muted-foreground">Tool result caps</div>
        <FormField
          name="max_list_results"
          label="Max listed capabilities"
          description="How many operations one list_capabilities call returns before it truncates. Bounded 1–2000."
        >
          <InputNumber data-testid="mcp-max-list-results" min={1} max={2000} suffix="ops" className="w-full" />
        </FormField>
        <FormField
          name="max_result_kib"
          label="Max invoke result size"
          description="Largest invoke result body relayed back to the model before truncation. A safety limit on memory. In KiB (default 1024 = 1 MiB). Bounded 1 KiB–64 MiB."
        >
          <InputNumber data-testid="mcp-max-result-kib" min={1} max={65536} suffix="KiB" className="w-full" />
        </FormField>
      </Form>
    </Card>
  )
}
