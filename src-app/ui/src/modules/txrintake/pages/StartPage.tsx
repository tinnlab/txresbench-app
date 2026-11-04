import type { CSSProperties } from 'react'

/**
 * Screen A — Start (board Start.dc.html). The flow header: step indicator,
 * the screen title and the intro line, on the board's page chrome.
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

export function StartPage() {
  return (
    <div style={PAGE_CONTAINER}>
      <div style={STEP_LINE}>Step 1 of 4</div>
      <h1 style={TITLE}>What do you want to do?</h1>
      <p style={INTRO}>
        Everything runs on this computer. Pick the way that fits what you have; you can change
        your mind later.
      </p>
    </div>
  )
}
