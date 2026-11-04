import type { CSSProperties } from 'react'

/**
 * Screen N — Add the patients to predict (board PredictFiles.dc.html). The
 * flow header: step indicator, the screen title and the intro line, on the
 * board's page chrome.
 */

const PAGE_CONTAINER: CSSProperties = {
  flexGrow: 1,
  boxSizing: 'border-box',
  padding: '40px 48px',
  maxWidth: 1180,
  margin: '0 auto',
  width: '100%',
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

const INTRO: CSSProperties = {
  margin: 0,
  color: '#3a3a3a',
  maxWidth: '62ch',
}

export function PredictFilesPage() {
  return (
    <div style={PAGE_CONTAINER}>
      <div style={STEP_LINE}>Step 3 of 4</div>
      <h1 style={TITLE}>Add the patients to predict</h1>
      <p style={INTRO}>
        Only their blood measurements. Read on this computer only, never uploaded. Match the
        example; we check the file as soon as you choose it.
      </p>
    </div>
  )
}
