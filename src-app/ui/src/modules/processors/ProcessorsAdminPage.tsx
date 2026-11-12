import { ErrorState } from '@txresbench/kit'
import { SettingsPageContainer } from '@txresbench/shell'
import { ProcessorsAdmin } from '@/modules/processors/stores/ProcessorsAdmin.store'
import { ProcessorsListCard } from '@/modules/processors/components/ProcessorsListCard'

const SUBTITLE =
  'Analysis processors discovered at runtime by scanning the processors folder. Each ' +
  'package (a datatype/converter/view contribution + its compute) loads with no ' +
  'rebuild — drop one in and Reload. Skipped packages show their package-scoped error.'

/**
 * Admin "Processors" settings page — the runtime folder-scan control plane (D2).
 * Lists the discovered packages with per-package load status + a Reload action.
 * Route + slot are gated on `sandbox::settings::read` (DEC-6, reused — no new
 * permission), so an unpermitted user never reaches here.
 */
export default function ProcessorsAdminPage() {
  const { error, loaded } = ProcessorsAdmin

  return (
    <SettingsPageContainer title="Processors" subtitle={SUBTITLE}>
      <div data-testid="processors-settings-page" className="flex flex-col gap-4">
        {/* Page-level ErrorState only for an INITIAL load failure (never loaded). A later
            reload failure keeps the card (which renders its own inline error + Reload). */}
        {error && !loaded ? (
          <ErrorState
            variant="page"
            resource="processors"
            description="The discovered processors couldn't be loaded. Check your connection and try again."
            details={error}
            onRetry={() => void ProcessorsAdmin.loadProcessors()}
            data-testid="processors-settings-error"
          />
        ) : (
          <ProcessorsListCard />
        )}
      </div>
    </SettingsPageContainer>
  )
}
