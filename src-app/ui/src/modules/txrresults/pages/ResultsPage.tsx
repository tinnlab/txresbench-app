import type { CSSProperties } from 'react'

/**
 * Screen G — the run's predictions (board BusyResults.dc.html): the patient ×
 * method heatmap of one analysis run, readable while the run continues.
 *
 * This scaffold carries the board's page chrome (the main column: flex-grow
 * column, the 24×32 padding, the 14 gap between the page's stacked blocks)
 * and the title line the whole screen hangs below. The heatmap, the outcome
 * tabs, the search/sort/method filters, the cannot-run banner, the per-patient
 * Average column and the header actions (download-all CSV, save-the-models,
 * new analysis) build on this shell.
 */

const PAGE_MAIN: CSSProperties = {
  flexGrow: 1,
  boxSizing: 'border-box',
  padding: '24px 32px',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  minWidth: 0,
}

const TITLE: CSSProperties = {
  margin: '0 0 2px',
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 26,
  lineHeight: 1.2,
}

export function ResultsPage() {
  return (
    <main data-testid="txr-results" style={PAGE_MAIN}>
      <h1 style={TITLE}>Predictions</h1>
    </main>
  )
}
