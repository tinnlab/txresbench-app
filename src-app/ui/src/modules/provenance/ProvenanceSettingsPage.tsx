import { ErrorState, Spin } from '@ziee/kit'
import { SettingsPageContainer } from '@ziee/shell'
import { ProvenanceSettings } from '@/modules/provenance/stores/ProvenanceSettings.store'
import { ProvenanceSettingsCard } from '@/modules/provenance/components/ProvenanceSettingsCard'

const SUBTITLE =
  'Deployment-wide reproducibility settings — the export-bundle caps, retention, ' +
  'the optional methods write-up, and the verification budgets.'

/**
 * Admin "Provenance" settings page — export/verify caps (editable,
 * permission-gated). Route + slot are gated on `provenance::settings::read`, so
 * an unpermitted user never reaches here. Mirrors SandboxSettingsPage.
 */
export default function ProvenanceSettingsPage() {
  const { settings, loading, error } = ProvenanceSettings

  if (loading && !settings) {
    return (
      <SettingsPageContainer title="Provenance" subtitle={SUBTITLE}>
        <div className="flex justify-center py-12">
          <Spin size="lg" label="Loading provenance settings" />
        </div>
      </SettingsPageContainer>
    )
  }

  return (
    <SettingsPageContainer title="Provenance" subtitle={SUBTITLE}>
      <div data-testid="provenance-settings-page" className="flex flex-col gap-4">
        {error && !settings ? (
          <ErrorState
            variant="page"
            resource="provenance settings"
            description="The provenance settings couldn't be loaded. Check your connection and try again."
            details={error}
            onRetry={() => void ProvenanceSettings.loadSettings()}
            data-testid="provenance-settings-error"
          />
        ) : (
          <ProvenanceSettingsCard />
        )}
      </div>
    </SettingsPageContainer>
  )
}
