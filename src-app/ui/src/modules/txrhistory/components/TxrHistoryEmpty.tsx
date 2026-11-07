/**
 * TxrHistoryEmpty — the K list's empty state (PROV-HIST-5): "Nothing here
 * yet" + the board's promise sentence ("Runs you start appear here,
 * newest first."). Rendered by the list when the loaded page set is empty
 * (the store's `total === 0` state after a successful load); a search or
 * filter that matches nothing renders the same state — the sentence still
 * holds, and no fabricated count is shown (INV-6).
 */
import { Empty } from '@ziee/kit'

export const HISTORY_EMPTY_TITLE = 'Nothing here yet'

export const HISTORY_EMPTY_BODY = 'Runs you start appear here, newest first.'

export function TxrHistoryEmpty() {
  return (
    <Empty
      data-testid="txr-history-empty"
      title={HISTORY_EMPTY_TITLE}
      description={HISTORY_EMPTY_BODY}
    />
  )
}
