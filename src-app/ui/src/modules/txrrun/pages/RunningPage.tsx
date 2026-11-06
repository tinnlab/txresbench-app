import type { CSSProperties } from 'react'

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

export function RunningPage() {
  return (
    <main data-testid="txr-run" style={PAGE_MAIN}>
      <h1 style={TITLE}>Running methods</h1>
    </main>
  )
}
