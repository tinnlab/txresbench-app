import { ErrorState, Spin } from '@ziee/kit'
import { SettingsPageContainer } from '@ziee/shell'
import { WorkstoreSettings } from '@/modules/workstore/stores/WorkstoreSettings.store'
import { WorkstoreLimitsCard } from '@/modules/workstore/components/WorkstoreLimitsCard'

const SUBTITLE =
  'The content-addressed working store. Set the garbage-collection policy (blob sweep ' +
  'cadence + orphan grace) and the ingest size caps every analysis output is bounded by.'

/**
 * Admin "Workstore" settings page — GC policy + ingest size caps (editable,
 * permission-gated). Route + slot are gated on `workstore::settings::read`, so an
 * unpermitted user never reaches here. Mirrors `SandboxSettingsPage`.
 */
export default function WorkstoreSettingsPage() {
  const { settings, loading, error } = WorkstoreSettings

  if (loading && !settings) {
    return (
      <SettingsPageContainer title="Workstore" subtitle={SUBTITLE}>
        <div className="flex justify-center py-12">
          <Spin size="lg" label="Loading workstore settings" />
        </div>
      </SettingsPageContainer>
    )
  }

  return (
    <SettingsPageContainer title="Workstore" subtitle={SUBTITLE}>
      <div data-testid="workstore-settings-page" className="flex flex-col gap-4">
        {error && !settings ? (
          <ErrorState
            variant="page"
            resource="workstore settings"
            description="The workstore settings couldn't be loaded. Check your connection and try again."
            details={error}
            onRetry={() => void WorkstoreSettings.loadSettings()}
            data-testid="workstore-settings-error"
          />
        ) : (
          <WorkstoreLimitsCard />
        )}
      </div>
    </SettingsPageContainer>
  )
}
