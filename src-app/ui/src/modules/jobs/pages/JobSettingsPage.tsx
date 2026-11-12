import { ErrorState, Spin } from '@txresbench/kit'
import { SettingsPageContainer } from '@txresbench/shell'
import { JobSettings } from '@/modules/jobs/JobSettings.store'
import { JobConcurrencyCard } from '@/modules/jobs/components/JobConcurrencyCard'
import { JobStreamingCard } from '@/modules/jobs/components/JobStreamingCard'
import { JobAdmissionCard } from '@/modules/jobs/components/JobAdmissionCard'
import { JobSchedulerCard } from '@/modules/jobs/components/JobSchedulerCard'

const SUBTITLE =
  'How the job scheduler admits, streams, and reclaims work: the concurrency caps ' +
  '(queued jobs run first-come-first-serve up to the limit), the live job-stream ' +
  '(SSE) tunables, the background-admission wait, and the multi-worker scheduler & ' +
  'reaper cadences. Available on desktop too.'

/**
 * Admin "Jobs" settings page — the deployment-wide scheduler settings, grouped
 * into Concurrency, Streaming (SSE) and Admission section cards (each a partial
 * update through the permissioned `jobs.updateSettings` action). Route + slot are
 * gated on `jobs::settings::read`, so an unpermitted user never reaches here.
 * Mirrors SandboxSettingsPage's multi-card composition.
 */
export function JobSettingsPage() {
  const { settings, loading, error } = JobSettings

  if (loading && !settings) {
    return (
      <SettingsPageContainer title="Jobs" subtitle={SUBTITLE}>
        <div className="flex justify-center py-12">
          <Spin size="lg" label="Loading job settings" />
        </div>
      </SettingsPageContainer>
    )
  }

  if (error && !settings) {
    return (
      <SettingsPageContainer title="Jobs" subtitle={SUBTITLE}>
        <ErrorState
          variant="page"
          resource="job settings"
          description="The job settings couldn't be loaded. Check your connection and try again."
          details={error}
          onRetry={() => void JobSettings.load()}
          data-testid="job-settings-error"
        />
      </SettingsPageContainer>
    )
  }

  const updatedAt = settings?.updated_at ? new Date(settings.updated_at) : null

  return (
    <SettingsPageContainer title="Jobs" subtitle={SUBTITLE}>
      <div data-testid="job-settings-page" className="flex flex-col gap-4">
        <JobConcurrencyCard />
        <JobStreamingCard />
        <JobAdmissionCard />
        <JobSchedulerCard />
        {updatedAt && (
          <p data-testid="job-settings-updated-at" className="text-muted-foreground px-1 text-xs">
            Last updated {updatedAt.toLocaleString()}
          </p>
        )}
      </div>
    </SettingsPageContainer>
  )
}
