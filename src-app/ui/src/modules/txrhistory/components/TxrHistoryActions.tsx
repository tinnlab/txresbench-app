/**
 * TxrHistoryActions — the expanded block's action column (PROV-HIST-5),
 * the K board's four affordances resolved per capability (ITEM-3's
 * `actionsFor`, TEST-HIST-6): the primary "Open the results" (a finished
 * row; a RUNNING row's primary is "Open the running run"), the secondary
 * "Run again with the same settings" (the copy-kept row) or "Use these
 * settings again" (the copy-cleared row — DEC-6's honest fallback), and
 * the three links "Download predictions" / "Open the folder" / "Show the
 * log".
 *
 * The component is pure-presentational and REPORTED, never executed here:
 * `actionsFor` resolves the flags over the row facts + the desktop mode
 * (the PROV-UR-7 gate's fact, passed in — K never re-derives it), and
 * each control reports its run id through the callback; the page binds
 * the builders/helpers (ITEM-5) so a `false` flag hides its control
 * completely — never a dead button (INV-3).
 *
 * Board layout bytes: the actions column sits right of the dl grid
 * (flex 0 1 320 px, column, 8 px gaps), the primary is the board's
 * filled accent button, the secondary the bordered accent outline, the
 * links row the board's 16 px gap under them.
 */
import type { CSSProperties } from 'react'
import { Button } from '@ziee/kit'
import { actionsFor, type TxrActionFacts } from '../lib/actions'

/** The action column (the board's right block of the expanded row). */
const ACTIONS_COLUMN: CSSProperties = {
  flex: '0 1 320px',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

/** The primary/secondary buttons (the board's 9×18 padding). */
const BUTTON: CSSProperties = { padding: '9px 18px', fontWeight: 700 }

/** The links row (the board's 16 px gap under the buttons). */
const LINKS_ROW: CSSProperties = { display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 2 }

/** The link look (the board's 13.5 px action links). */
const LINK: CSSProperties = { fontSize: 13.5, fontWeight: 600, padding: 0, height: 'auto' }

export interface TxrHistoryActionsProps {
  /** The row facts the resolution reads (the item's pick — the detail
   *  satisfies the same pick, so the expanded block passes the loaded
   *  detail record). */
  item: TxrActionFacts
  /** The run id — the callback payload + the test-ids' suffix. */
  runId: string
  /** The desktop mode (the PROV-UR-7 gate's fact). */
  isDesktop: boolean
  onOpenResults?: (runId: string) => void
  onOpenRunning?: (runId: string) => void
  onRerun?: (runId: string) => void
  onSettingsAgain?: (runId: string) => void
  onDownload?: (runId: string) => void
  onReveal?: (runId: string) => void
  onLog?: (runId: string) => void
}

export function TxrHistoryActions({
  item,
  runId,
  isDesktop,
  onOpenResults,
  onOpenRunning,
  onRerun,
  onSettingsAgain,
  onDownload,
  onReveal,
  onLog,
}: TxrHistoryActionsProps) {
  const actions = actionsFor(item, { isDesktop })
  return (
    <div
      data-testid={`txr-history-actions-${runId}`}
      className="txr-history-actions"
      style={ACTIONS_COLUMN}
    >
      {actions.openResults ? (
        <Button
          data-testid={`txr-history-open-results-${runId}`}
          style={BUTTON}
          onClick={() => onOpenResults?.(runId)}
        >
          Open the results
        </Button>
      ) : null}
      {actions.openRunning ? (
        <Button
          data-testid={`txr-history-open-running-${runId}`}
          style={BUTTON}
          onClick={() => onOpenRunning?.(runId)}
        >
          Open the running run
        </Button>
      ) : null}
      {actions.rerun ? (
        <Button
          data-testid={`txr-history-rerun-${runId}`}
          variant="outline"
          style={BUTTON}
          onClick={() => onRerun?.(runId)}
        >
          Run again with the same settings
        </Button>
      ) : null}
      {actions.settingsAgain ? (
        <Button
          data-testid={`txr-history-settings-again-${runId}`}
          variant="outline"
          style={BUTTON}
          onClick={() => onSettingsAgain?.(runId)}
        >
          Use these settings again
        </Button>
      ) : null}
      <div style={LINKS_ROW}>
        {actions.download ? (
          <Button
            data-testid={`txr-history-download-${runId}`}
            variant="link"
            style={LINK}
            onClick={() => onDownload?.(runId)}
          >
            Download predictions
          </Button>
        ) : null}
        {actions.reveal ? (
          <Button
            data-testid={`txr-history-open-folder-${runId}`}
            variant="link"
            style={LINK}
            onClick={() => onReveal?.(runId)}
          >
            Open the folder
          </Button>
        ) : null}
        {actions.log ? (
          <Button
            data-testid={`txr-history-log-${runId}`}
            variant="link"
            style={LINK}
            onClick={() => onLog?.(runId)}
          >
            Show the log
          </Button>
        ) : null}
      </div>
    </div>
  )
}
