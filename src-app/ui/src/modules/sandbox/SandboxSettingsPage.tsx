import { ErrorState, Spin } from '@ziee/kit'
import { SettingsPageContainer } from '@ziee/shell'
import { SandboxSettings } from '@/modules/sandbox/stores/SandboxSettings.store'
import { RootfsStatusCard } from '@/modules/sandbox/components/RootfsStatusCard'
import { ResourceLimitsCard } from '@/modules/sandbox/components/ResourceLimitsCard'
import { PerClassDefaultsCard } from '@/modules/sandbox/components/PerClassDefaultsCard'
import { EnvImageCard } from '@/modules/sandbox/components/EnvImageCard'

const SUBTITLE =
  'The isolated environment analysis scripts (R/Python) run in. Set the resource ' +
  'caps every run is bounded by, and check the embedded analysis rootfs status.'

/**
 * Admin "Sandbox" settings page — resource limits (editable, permission-gated)
 * + embedded-rootfs status (read-only). Route + slot are gated on
 * `sandbox::settings::read`, so an unpermitted user never reaches here.
 */
export default function SandboxSettingsPage() {
  const { limits, loading, error } = SandboxSettings

  if (loading && !limits) {
    return (
      <SettingsPageContainer title="Sandbox" subtitle={SUBTITLE}>
        <div className="flex justify-center py-12">
          <Spin size="lg" label="Loading sandbox settings" />
        </div>
      </SettingsPageContainer>
    )
  }

  // Primary settings load failed → replace the form with a retryable error, but
  // still show the rootfs status card (which loads independently).
  return (
    <SettingsPageContainer title="Sandbox" subtitle={SUBTITLE}>
      <div data-testid="sandbox-settings-page" className="flex flex-col gap-4">
        <RootfsStatusCard />
        {error && !limits ? (
          <ErrorState
            variant="page"
            resource="sandbox settings"
            description="The sandbox limits couldn't be loaded. Check your connection and try again."
            details={error}
            onRetry={() => void SandboxSettings.loadSettings()}
            data-testid="sandbox-settings-error"
          />
        ) : (
          <>
            <ResourceLimitsCard />
            <PerClassDefaultsCard />
            <EnvImageCard />
          </>
        )}
      </div>
    </SettingsPageContainer>
  )
}
