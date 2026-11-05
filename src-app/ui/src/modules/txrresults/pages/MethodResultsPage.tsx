import type { CSSProperties } from 'react'

/**
 * Screen H — one run's methods in detail (boards Results.dc.html /
 * SaveOne.dc.html): the method tablist (Compare methods + one tab per
 * finished method), the outcome tabs, the patient × method bar table, the
 * two-method compare card, the explanatory cards ("Read these with care",
 * "How the chance is calculated") and the saved-in / open-folder line.
 *
 * This scaffold carries the board's page chrome (the main column: flex-grow
 * column, the 24×32 padding, the 14 gap between the page's stacked blocks)
 * and the title line the whole screen hangs below; the tablist, the bar
 * table, the compare card and the aside build on this shell.
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

export function MethodResultsPage() {
  return (
    <main style={PAGE_MAIN}>
      <h1 style={TITLE}>Predictions</h1>
    </main>
  )
}
