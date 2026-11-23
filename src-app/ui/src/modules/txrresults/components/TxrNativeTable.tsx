/**
 * TxrNativeTable — the "Methods' own results" section under the chances: for
 * each patient and method, what the method itself returned before its result
 * was turned into a chance — its yes/no answer (when the method gives one:
 * "Judged failing" / "Not failing", the contract's `call`) over its own score
 * (the contract's `risk`: higher = more likely failing, on the method's own
 * scale).
 *
 * The rows arrive ALREADY sorted, filtered and windowed by the page (the same
 * rows the chance table shows, in the same order); the method columns are
 * the page's choice too (`ownResultColumnsOf` — the shown chance columns plus
 * the ones dropped for having no chance at all). This component renders; it
 * never sorts, filters or windows.
 *
 * Deliberately NO colour scale: a chance has one 0–100 % scale the heatmap
 * colours, a score does not (each method uses its own), so the values are
 * plain text and the intro line says the scores cannot be compared across
 * methods. The table is the heatmap's native-table twin (DEC-11: a sticky
 * header, pinned patient column, tokens only) in its own bounded scroll box
 * of `RESULTS_TABLE_MAX_HEIGHT` (results-table-height — the user's
 * fixed-height byte); the page's ScrollRegion still scrolls the page around
 * the boxes. It is not row-windowed — it renders the page's row window
 * (default 100 patients, "Show all" raises it), like the H bars table.
 *
 * A column without own results recorded (a run from before they were kept, a
 * demo replay) is not drawn as a dash wall: it is left out and named in one
 * line under the table; with none recorded at all the section is that one
 * line.
 */
import type { CSSProperties } from 'react'
import { useMemo } from 'react'
import type { TxrHeatmapColumn, TxrHeatmapRow } from '../types'
import {
  OWN_CHANCE_MARK,
  OWN_RESULTS_INTRO,
  OWN_RESULTS_NONE_RECORDED,
  OWN_RESULTS_TITLE,
  OWN_RETURNED_CALLS,
  OWN_RETURNED_SCORE,
  RESULTS_TABLE_MAX_HEIGHT,
  formatOwnCall,
  formatOwnNotRecordedNote,
  formatOwnScore,
} from '../lib/format'
import { hasOwnResults, ownResultOf, patientIndexOf } from '../lib/native'

const MONO_FONT = "'Source Code Pro', ui-monospace, monospace"

const SECTION: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  marginTop: 20,
  minWidth: 0,
}

const TITLE: CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 600,
  color: 'var(--txr-text)',
}

const LINE: CSSProperties = {
  margin: 0,
  fontSize: 13.5,
  color: 'var(--txr-text-2)',
}

/**
 * The table's OWN scroll box (results-table-height — the user's fixed-height
 * byte): the border/radius card is bounded to `RESULTS_TABLE_MAX_HEIGHT` and
 * scrolls on both axes; the page's ScrollRegion still scrolls the page.
 */
const BOX: CSSProperties = {
  border: '1px solid var(--txr-border)',
  borderRadius: 10,
  minWidth: 0,
  maxHeight: RESULTS_TABLE_MAX_HEIGHT,
  overflow: 'auto',
}

const TABLE: CSSProperties = {
  borderCollapse: 'separate',
  borderSpacing: 0,
  fontSize: 13.5,
  minWidth: '100%',
}

const CORNER: CSSProperties = {
  position: 'sticky',
  top: 0,
  left: 0,
  zIndex: 3,
  background: 'var(--txr-surface-dim)',
  textAlign: 'left',
  padding: '8px 12px',
  borderBottom: '1px solid var(--txr-border)',
  borderRight: '1px solid var(--txr-border)',
}

const HEADER: CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 2,
  background: 'var(--txr-surface-dim)',
  padding: '6px 10px',
  borderBottom: '1px solid var(--txr-border)',
  textAlign: 'left',
  verticalAlign: 'bottom',
  minWidth: 112,
  fontFamily: MONO_FONT,
  fontSize: 11,
  fontWeight: 500,
  lineHeight: 1.25,
  overflowWrap: 'break-word',
}

const HEADER_SUB: CSSProperties = {
  display: 'block',
  fontFamily: "'Source Sans 3', 'Segoe UI', sans-serif",
  fontSize: 10.5,
  color: 'var(--txr-muted)',
  fontWeight: 400,
}

const PATIENT: CSSProperties = {
  position: 'sticky',
  left: 0,
  zIndex: 1,
  background: 'var(--txr-surface)',
  textAlign: 'left',
  padding: '6px 12px',
  borderBottom: '1px solid var(--txr-border-subtle)',
  borderRight: '1px solid var(--txr-border)',
  fontFamily: MONO_FONT,
  fontSize: 12.5,
  fontWeight: 400,
  whiteSpace: 'nowrap',
}

const TD: CSSProperties = {
  padding: '6px 10px',
  borderBottom: '1px solid var(--txr-border-subtle)',
  background: 'var(--txr-surface)',
  verticalAlign: 'middle',
  whiteSpace: 'nowrap',
}

const CALL: CSSProperties = { display: 'block', fontWeight: 600, color: 'var(--txr-text)' }

const SCORE: CSSProperties = {
  display: 'block',
  fontFamily: MONO_FONT,
  fontSize: 12,
  color: 'var(--txr-text-2)',
  fontVariantNumeric: 'tabular-nums',
}

const NONE: CSSProperties = { color: 'var(--txr-muted)' }

export interface TxrNativeTableProps {
  /** The method columns the section covers (the page's `ownResultColumnsOf`). */
  columns: ReadonlyArray<TxrHeatmapColumn>
  /** The page's rows: the chance table's own rows, in its order and window. */
  rows: ReadonlyArray<Pick<TxrHeatmapRow, 'patientId'>>
  /** The response's patient order (the native arrays' alignment). */
  patients: ReadonlyArray<string>
  /** Show the section heading + intro (false when the host gives its own). */
  withHeading?: boolean
}

export function TxrNativeTable({ columns, rows, patients, withHeading = true }: TxrNativeTableProps) {
  const index = useMemo(() => patientIndexOf(patients), [patients])
  const recorded = columns.filter(hasOwnResults)
  const missingNote = formatOwnNotRecordedNote(
    recorded.length === 0 ? [] : columns.filter(c => !hasOwnResults(c)).map(c => c.label),
  )
  // Nothing to show: no method column, or no patient row (a search with no
  // match — the chance table above already says so).
  if (columns.length === 0 || rows.length === 0) return null
  return (
    <section data-testid="txr-own-results" aria-label={OWN_RESULTS_TITLE} style={SECTION}>
      {withHeading ? (
        <>
          <h2 style={TITLE}>{OWN_RESULTS_TITLE}</h2>
          {recorded.length > 0 ? <p style={LINE}>{OWN_RESULTS_INTRO}</p> : null}
        </>
      ) : null}
      {recorded.length === 0 ? (
        <p data-testid="txr-own-results-none" style={LINE}>
          {OWN_RESULTS_NONE_RECORDED}
        </p>
      ) : (
        <div
          data-testid="txr-own-table-scroll"
          data-txr-table-scroll=""
          role="region"
          aria-label="Methods' own results per patient"
          tabIndex={0}
          style={BOX}
          className="txr-results-table-box"
        >
          <table data-testid="txr-own-table" style={TABLE}>
            <thead>
              <tr>
                <th scope="col" style={CORNER}>
                  Patient
                </th>
                {recorded.map(col => (
                  <th
                    key={col.methodId}
                    scope="col"
                    title={col.methodId}
                    style={HEADER}
                    data-testid={`txr-own-header-${col.methodId}`}
                  >
                    <span>{col.label}</span>
                    <span style={HEADER_SUB} data-testid={`txr-own-returned-${col.methodId}`}>
                      {col.native?.calls != null ? OWN_RETURNED_CALLS : OWN_RETURNED_SCORE}
                    </span>
                    {col.probSource === 'native' ? (
                      <span style={HEADER_SUB} data-testid={`txr-own-chance-mark-${col.methodId}`}>
                        {OWN_CHANCE_MARK}
                      </span>
                    ) : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.patientId} data-testid={`txr-own-row-${row.patientId}`}>
                  <th scope="row" style={PATIENT}>
                    {row.patientId}
                  </th>
                  {recorded.map(col => (
                    <td key={col.methodId} style={TD} data-testid={`txr-own-value-${col.methodId}`}>
                      <OwnResultValue own={ownResultOf(col, index, row.patientId)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {missingNote !== null ? (
        <p data-testid="txr-own-results-missing" style={LINE}>
          {missingNote}
        </p>
      ) : null}
    </section>
  )
}

/** One entry: the yes/no answer (when the method gives one) over the score; a dash for nothing. */
export function OwnResultValue({ own }: { own: ReturnType<typeof ownResultOf> }) {
  const call = own === null ? null : formatOwnCall(own.call)
  const score = own === null ? null : formatOwnScore(own.score)
  if (call === null && score === null) return <span style={NONE}>{'–'}</span>
  return (
    <>
      {call !== null ? <span style={CALL}>{call}</span> : null}
      {score !== null ? <span style={SCORE}>{score}</span> : null}
    </>
  )
}
