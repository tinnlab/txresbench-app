import type { CSSProperties } from 'react'

/**
 * Screen E — Choose the methods and settings (board `Busy.dc.html`): the
 * file-slot lines (Patients / Measurements / Predict with "Change files"),
 * the four setting rows (Predict, Decision day, Look ahead to, Extra
 * inputs + More settings), the shared method list with its group chips and
 * the bottom bar (selected count, total time, run-N-at-a-time, save-the-
 * trained-models, research notice, Run).
 *
 * This scaffold carries the board's page chrome (the main column:
 * flex-grow, the 24×36 padding and the 12 gap between the page's stacked
 * blocks) and the title the screen hangs below. The slot lines and the
 * change-files dialog (ITEM-6), the settings block (ITEM-7) and the list +
 * run creation (ITEM-8) build on this shell; the "Step 4 of 4" line is the
 * walk the intake screens already show (board `Files.dc.html`).
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
  padding: '24px 36px',
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

export function ChooseMethodsPage() {
  return (
    <main data-testid="txr-run" style={PAGE_OUTER}>
      <div style={PAGE_MAIN}>
        <div style={STEP_LINE}>Step 4 of 4</div>
        <h1 style={TITLE}>Choose the methods and settings</h1>
      </div>
    </main>
  )
}
