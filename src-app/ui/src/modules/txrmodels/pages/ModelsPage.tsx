import type { CSSProperties } from 'react'

/**
 * Screen J — Your models (board `Models.dc.html`): the inventory table
 * (Model + subline, Method, Predicts, Decision day, Trained on, Made, the
 * row actions Use / Export / Rename / Delete), the search, "Open a model
 * file", the "Models are stored in …/models/ Open the folder" + delete
 * footnotes, and the `?set=` focus ("Showing the set … · Show all").
 *
 * This scaffold carries the board's page chrome (the 28×36 main column
 * with the 18 gap) and the header block's static bytes: the h1 and the
 * "Every model you train is kept here…" line (the board's permanent copy,
 * no data). The table, the search/import and the row actions (ITEM-8)
 * build on this shell; no board number is data (INV-4).
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

const HEADER: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-end',
  justifyContent: 'space-between',
  gap: 16,
}

const TITLE: CSSProperties = {
  margin: '0 0 2px',
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 28,
  lineHeight: 1.2,
}

const SUBTITLE: CSSProperties = {
  color: '#3a3a3a',
  fontSize: 14,
}

export function ModelsPage() {
  return (
    <main data-testid="txr-models-j" style={PAGE_MAIN}>
      <div style={HEADER}>
        <div>
          <h1 style={TITLE}>Your models</h1>
          <div style={SUBTITLE}>
            Every model you train is kept here, so you can predict new patients later without
            training again.
          </div>
        </div>
      </div>
    </main>
  )
}
