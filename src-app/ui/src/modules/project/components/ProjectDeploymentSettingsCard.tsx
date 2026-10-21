import { useEffect, useState } from 'react'
import { Permissions } from '@/api-client/permissions'
import { usePermission } from '@/core/permissions'
import { ProjectSettings } from '@/modules/project/stores/ProjectSettings.store'
import { Card, Spinner, Switch } from '@ziee/kit'
import { SettingsFormActions } from '@/modules/settings/components/SettingsFormActions'

/**
 * The deployment-wide ownership-transfer toggle, as a card. Folded into the admin
 * Projects page (DEC-1) — keeps the `project-settings-card` /
 * `project-settings-transfer-toggle` testids that the merged transfer-settings e2e
 * depends on. Reads the `ProjectSettings` singleton store.
 */
export function ProjectDeploymentSettingsCard() {
  const { settings, loading, saving } = ProjectSettings
  const canManage = usePermission(Permissions.ProjectSettingsManage)
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    if (settings) setEnabled(settings.transfer_enabled)
  }, [settings?.transfer_enabled])

  const dirty = settings != null && enabled !== settings.transfer_enabled

  return (
    <Card
      title="Ownership transfer"
      data-testid="project-settings-card"
      footer={
        canManage ? (
          <SettingsFormActions
            onSave={() => void ProjectSettings.update(enabled)}
            onCancel={() => settings && setEnabled(settings.transfer_enabled)}
            saving={saving}
            saveUnavailableReason={!dirty ? 'No changes to save' : undefined}
            saveTestid="project-settings-save"
            cancelTestid="project-settings-cancel"
          />
        ) : undefined
      }
    >
      {loading && !settings ? (
        <div className="flex justify-center py-6">
          <Spinner label="Loading settings" />
        </div>
      ) : (
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium">Allow ownership transfer</div>
            <div className="text-sm text-muted-foreground">
              When enabled, a project owner can transfer ownership to another user (who
              must accept). Disabling hides the transfer affordance for everyone.
            </div>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={!canManage}
            data-testid="project-settings-transfer-toggle"
          />
        </div>
      )}
    </Card>
  )
}
