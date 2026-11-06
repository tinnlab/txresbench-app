import type { CSSProperties } from 'react'
import { useLocation } from 'react-router-dom'
import { Alert } from '@ziee/kit'

/**
 * Screen F — Running (board `BusyRunning.dc.html`): one analysis run's live
 * surface — the header (methods count, time left, elapsed, concurrency line,
 * "See the results" when any method is done), the five-count strip, the
 * All/Working/Finished/Failed tabs, the per-method table (state chip,
 * detail, progress, time, per-state action), Stop all, the leave-and-
 * continue note and the log panel (method filter, follow-newest, copy).
 *
 * This scaffold carries the board's main-line bytes (flex-grow row, the
 * wrap the content column + log panel sit in) and the title line; the
 * header and counts strip (ITEM-9), the table + at-a-time control (ITEM-10)
 * and the log panel + leave-and-continue (ITEM-11) build on this shell.
 * The methods count joins the title from the run's rows, so the scaffold's
 * line is the board's static words without the count.
 *
 * ITEM-8 adds the one line this page must render from the E create path:
 * the 409 RUN_ALREADY_ACTIVE resolution (DEC-18) navigates here with the
 * router state `{ resumed: true }` — the duplicate-run button is never
 * seen, and the user gets the one notice that they are watching the run
 * that was already active.
 */
const PAGE_MAIN: CSSProperties = {
  flexGrow: 1,
  display: 'flex',
  flexWrap: 'wrap',
}

const TITLE: CSSProperties = {
  margin: 0,
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 26,
  lineHeight: 1.2,
}

/** The resumed notice's full-width row (the page's flex-wrap layout). */
const NOTICE_ROW: CSSProperties = { flexBasis: '100%' }

/** The DEC-18 one-line notice (the 409 resolution's handoff line). */
const RESUMED_NOTICE_LINE = 'A run was already active — you are watching it now.'

export function RunningPage() {
  const location = useLocation()
  const resumed =
    (location.state as { resumed?: boolean } | null)?.resumed === true

  return (
    <main data-testid="txr-run" style={PAGE_MAIN}>
      {resumed ? (
        <div style={NOTICE_ROW}>
          <Alert
            data-testid="txr-run-resumed-notice"
            tone="info"
            title={RESUMED_NOTICE_LINE}
          />
        </div>
      ) : null}
      <h1 style={TITLE}>Running methods</h1>
    </main>
  )
}
