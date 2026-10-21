import { Alert, Button, Card, Spinner } from '@ziee/kit'

interface SettingsSectionStatusProps {
  /** Card title, kept identical to the loaded section so the page layout is stable. */
  title: string
  /** Load error message, if the settings fetch failed. */
  error?: string | null
  /** Retry callback — re-invokes the store's load action. */
  onRetry?: () => void
}

/**
 * Shared fallback body for settings sections whose data is still loading or
 * failed to load. Previously each section did `if (!settings) return null`,
 * which left a permanently-blank card on a load failure with no way to retry.
 * Render this instead: an error+Retry alert when `error` is set, otherwise a
 * centered spinner while the fetch is in flight.
 */
export function SettingsSectionStatus({
  title,
  error,
  onRetry,
}: SettingsSectionStatusProps) {
  return (
    <Card title={title} data-testid="settings-section-status">
      {error ? (
        <Alert
          tone="error"
          title={`Failed to load ${title.toLowerCase()} settings`}
          description={error}
          data-testid="settings-section-status-error"
        >
          {onRetry ? (
            <div className="mt-2">
              <Button
                size="default"
                onClick={onRetry}
                data-testid="settings-section-status-retry"
              >
                Retry
              </Button>
            </div>
          ) : null}
        </Alert>
      ) : (
        <div className="flex justify-center py-6">
          <Spinner
            label={`Loading ${title.toLowerCase()} settings`}
            data-testid="settings-section-status-spinner"
          />
        </div>
      )}
    </Card>
  )
}
