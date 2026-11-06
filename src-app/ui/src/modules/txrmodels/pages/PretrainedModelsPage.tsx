import type { CSSProperties } from 'react'

/**
 * Screen D — Choose the models to run (board `Pretrained.dc.html`): the
 * "Checked against your file: …" line (from the validated predict file,
 * CONS-UM-11), the "N can run, N cannot" totals, the shared
 * `TxrSelectList` with the model rows (tag, performance, status + detail,
 * time, Model card) and the download-state column, the four filter chips +
 * "Select all that can run" + the sort control, and the bottom bar
 * (selected count, total time, at-a-time, research notice, Run).
 *
 * This scaffold carries the board's page chrome (the main column: the
 * flex-grow row + the 26×36 section with the 14 gap), the "Step 4 of 4"
 * walk line and the board's static h1. The data line, the list + filters
 * and the download column (ITEM-6) build on this shell; no board number
 * is data (INV-4).
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
  gap: 14,
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

export function PretrainedModelsPage() {
  return (
    <main data-testid="txr-models-d" style={PAGE_OUTER}>
      <div style={PAGE_MAIN}>
        <div style={STEP_LINE}>Step 4 of 4</div>
        <h1 style={TITLE}>Choose the models to run</h1>
      </div>
    </main>
  )
}
