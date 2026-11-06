import type { CSSProperties } from 'react'

/**
 * Screen I — Choose the saved models to run (board `Saved.dc.html`): the
 * "Checked against your file: …" line, the "N saved models shown · N can
 * run, N cannot, N partly" totals, the shared `TxrSelectList` with ONE
 * section per saved set (facts line, select-all, Rename / Delete-the-run's-
 * models), the search + "Same outcome as my file" chip + the sort control,
 * and the bottom bar (selected count, total time, at-a-time, research
 * notice, Run).
 *
 * This scaffold carries the board's page chrome (the flex-grow row + the
 * 26×36 section with the 12 gap), the "Step 4 of 4" walk line and the
 * board's static h1. The data line, the list + sections and the Run
 * handler (ITEM-7) build on this shell; no board number is data (INV-4).
 */
const PAGE_OUTER: CSSProperties = {
  flexGrow: 1,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
}

const PAGE_MAIN: CSSProperties = {
  flexGrow: 1,
  boxSizing: 'border-box',
  padding: '26px 36px',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  minWidth: 0,
}

const STEP_LINE: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: '#1d4e89',
}

const TITLE: CSSProperties = {
  margin: '2px 0 6px',
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 28,
  lineHeight: 1.2,
}

export function SavedModelsPage() {
  return (
    <main data-testid="txr-models-i" style={PAGE_OUTER}>
      <div style={PAGE_MAIN}>
        <div style={STEP_LINE}>Step 4 of 4</div>
        <h1 style={TITLE}>Choose the saved models to run</h1>
      </div>
    </main>
  )
}
