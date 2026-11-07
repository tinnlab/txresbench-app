/**
 * TxrHistoryError — the K list's failure state (PROV-HIST-5): the kit
 * `Alert` with the board-facing line "Could not load the history." + the
 * Retry affordance (the store's `retryLoad` — a failed page load is never
 * a blank page and never a silent no-op). The error state replaces the
 * list; the toolbar stays usable (search/filter still work on a fresh
 * load).
 */
import type { CSSProperties } from 'react'
import { Alert, Button } from '@ziee/kit'

export const HISTORY_ERROR_TITLE = 'Could not load the history.'

const RETRY: CSSProperties = { marginTop: 4, fontSize: 13 }

export interface TxrHistoryErrorProps {
  /** The Retry affordance (the store's `retryLoad`). */
  onRetry: () => void
}

export function TxrHistoryError({ onRetry }: TxrHistoryErrorProps) {
  return (
    <Alert data-testid="txr-history-error" tone="error" title={HISTORY_ERROR_TITLE}>
      <Button
        data-testid="txr-history-error-retry"
        variant="outline"
        style={RETRY}
        onClick={onRetry}
      >
        Retry
      </Button>
    </Alert>
  )
}
