import type { CSSProperties } from 'react'
import { HISTORY_SUBTITLE } from '../lib/format'

/**
 * Screen K — History (board `History.dc.html`): the newest-first run list
 * (search + the four-option filter), the collapsible per-run cards and the
 * footer (run count + disk usage + the two retention controls).
 *
 * This scaffold carries the board's page chrome (the main column: the
 * flex-grow row + the 28×36 section with the 18 gap) and the board's
 * static title block (the h1 "History" + the permanent subtitle). The
 * toolbar's search/filter controls (Item 4) and the list + footer (Item 5)
 * build on this shell; the board's rows, counts and sizes are design
 * examples, never data (INV-6).
 */
const PAGE_MAIN: CSSProperties = {
  flexGrow: 1,
  boxSizing: 'border-box',
  padding: '28px 36px',
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
  minWidth: 0,
}

const TITLE: CSSProperties = {
  margin: '0 0 2px',
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 28,
  lineHeight: 1.2,
}

const SUBTITLE: CSSProperties = { color: '#3a3a3a', fontSize: 14 }

/** The board's h1. */
const TITLE_TEXT = 'History'

/** The board's permanent subtitle — one source in the lib's board-copy
 *  layer (verbatim; no facts, no numbers). */
const SUBTITLE_TEXT = HISTORY_SUBTITLE

export function HistoryPage() {
  return (
    <main data-testid="txr-history" style={PAGE_MAIN}>
      <div>
        <h1 data-testid="txr-history-title" style={TITLE}>
          {TITLE_TEXT}
        </h1>
        <div data-testid="txr-history-subtitle" style={SUBTITLE}>
          {SUBTITLE_TEXT}
        </div>
      </div>
    </main>
  )
}
