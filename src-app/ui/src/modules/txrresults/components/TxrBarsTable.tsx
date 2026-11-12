/**
 * TxrBarsTable — the H screen's patient × method bar table
 * (`Results.dc.html`): one row per patient and one per-method chance bar
 * (the board's `height: 10px` rounded track + `var(--txr-brand)` fill) beside its
 * percent, plus the board's footer sentence and the "Show all M" link.
 *
 * The rows arrive ALREADY sorted and windowed by the page (DEC-6: "sorted
 * by the first method" — the page applies `sortByFirstMethod` over the
 * view and then the store's patient limit, the same "Showing N of M"
 * affordance the G screen has). This component renders and reports
 * "Show all M"; it never sorts, filters or windows itself.
 *
 * app-shell ITEM-3 — the native byte: the old kit-`Table` (the plain,
 * NON-sticky path) is replaced by the board's own native table with
 * per-cell sticky header cells — the table sits in the page's ScrollRegion
 * and its header must stick to the REGION's top (the audit's
 * "the 94-row table (sticky header)"; the region is the two-axis
 * scrollport, so the old `overflow-x: auto` box is gone). This is the
 * same DEC-11 reasoning the G heatmap already used, and the DRIFT-1
 * ITEM-10 #1 precedent (the kit's virtualized grid cannot express the
 * row surface here either): the bar cells and the row test-ids
 * (`txr-bars-row-<patientId>`, `txr-bars-<methodId>`) keep their frozen
 * contracts. The G heatmap is the sticky-FIRST-COLUMN twin; a future kit
 * gain (real sticky support on the plain path) is the refactor trigger.
 *
 * Copy facts (board-verbatim): "Chance of treatment failure by day 238,
 * sorted by the first method. Showing 8 of 40." + "Show all 40". The
 * outcome phrase for the sentence is the board's words for the pfs tab;
 * the os / response readings ("Chance of death", "Chance of no response")
 * are this node's extrapolation at the same design gap as the outcome-tab
 * labels (recorded in the drift ledger — one-line changeable in
 * `OUTCOME_PHRASE`). The board's percents/ids are design examples, never
 * data (INV-5).
 *
 * Test-id surface: the table (`txr-bars`), the rows
 * `txr-bars-row-<patientId>`, the per-method value box
 * `txr-bars-<methodId>` (one per row — the G heatmap id convention),
 * and `txr-bars-show-more` (the plan's list names no H show-more
 * selector; same class as `txr-heatmap-show-more`).
 */
import type { CSSProperties } from 'react'
import { Button, Progress } from '@txresbench/kit'
import type { TxrHeatmapColumn, TxrHeatmapRow, TxrOutcomeKey } from '../types'
import { formatPct } from '../lib/format'

const MONO_FONT = "'Source Code Pro', ui-monospace, monospace"

/** The board's table card (the REGION scrolls it — ITEM-3, no inner box). */
const TABLE_BOX: CSSProperties = {
  border: '1px solid var(--txr-border)',
  borderRadius: 10,
  minWidth: 0,
}

const TABLE: CSSProperties = {
  width: '100%',
  borderCollapse: 'separate',
  borderSpacing: 0,
  fontSize: 14,
}

/** The sticky header cell (per-cell sticky — the opaque surface token). */
const TH: CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 2,
  padding: '10px 14px',
  textAlign: 'left',
  fontWeight: 600,
  fontSize: 12.5,
  color: 'var(--txr-text-2)',
  borderBottom: '1px solid var(--txr-border)',
  background: 'var(--txr-surface-dim)',
  whiteSpace: 'nowrap',
}

const TD: CSSProperties = {
  padding: '10px 14px',
  borderBottom: '1px solid var(--txr-border-subtle)',
  verticalAlign: 'middle',
  background: 'var(--txr-surface)',
}

const TD_PATIENT: CSSProperties = {
  ...TD,
  fontFamily: MONO_FONT,
  fontSize: 13,
  whiteSpace: 'nowrap',
  fontWeight: 400,
}

const FOOTER: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'space-between',
  gap: 10,
  fontSize: 13,
  color: 'var(--txr-muted)',
  marginTop: 8,
}

/** The bar row: track filler + the right-aligned percent (the board's bytes). */
const BAR_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 130,
}

const PERCENT: CSSProperties = {
  width: 36,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
}

/** The outcome word of the footer's "Chance of <phrase> by day N" (board pfs). */
export const OUTCOME_PHRASE: Record<TxrOutcomeKey, string> = {
  pfs: 'treatment failure',
  os: 'death',
  response: 'no response',
}

/**
 * The footer's leading sentence: "Chance of treatment failure by day 238,
 * sorted by the first method." — the board's bytes with the outcome phrase
 * and the day from the run (never the board's example numbers).
 */
export function formatBarsHeading(outcome: TxrOutcomeKey, horizon: number): string {
  return `Chance of ${OUTCOME_PHRASE[outcome]} by day ${horizon}, sorted by the first method.`
}

export interface TxrBarsTableProps {
  /** The active outcome tab's method columns (the table's column set). */
  columns: ReadonlyArray<TxrHeatmapColumn>
  /** The page-sorted + windowed rows (DEC-6's first-method order). */
  rows: ReadonlyArray<TxrHeatmapRow>
  /** The pre-window row count — the footer's "Showing N of M". */
  totalCount: number
  /** The active outcome tab (the footer's "Chance of …" phrase). */
  outcome: TxrOutcomeKey
  /** The day the heading spells (the response tab's day already resolved). */
  horizon: number
  /** "Show all M" — the host raises the store's patient limit. */
  onShowAll: () => void
}

export function TxrBarsTable({
  columns,
  rows,
  totalCount,
  outcome,
  horizon,
  onShowAll,
}: TxrBarsTableProps) {
  return (
    <div>
      <div style={TABLE_BOX}>
        <table data-testid="txr-bars" className="txr-bars" style={TABLE}>
          <thead>
            <tr>
              <th scope="col" style={TH} data-testid="txr-bars-header-patient">
                Patient
              </th>
              {columns.map(col => (
                <th
                  key={col.methodId}
                  scope="col"
                  style={TH}
                  data-testid={`txr-bars-header-${col.methodId}`}
                  title={col.methodId}
                >
                  <span style={{ fontFamily: MONO_FONT, fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' }}>
                    {col.label}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              return (
                <tr key={row.patientId} data-testid={`txr-bars-row-${row.patientId}`}>
                  <th scope="row" style={TD_PATIENT}>
                    {row.patientId}
                  </th>
                  {columns.map((col, index) => (
                    <td key={col.methodId} style={TD}>
                      <BarValue
                        value01={row.cells[index] ?? null}
                        note={row.notes[index] ?? null}
                        methodId={col.methodId}
                        patientId={row.patientId}
                      />
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div style={FOOTER}>
        <span data-testid="txr-bars-footer">
          {formatBarsHeading(outcome, horizon)} Showing {rows.length} of {totalCount}.
        </span>
        {rows.length < totalCount ? (
          <Button
            data-testid="txr-bars-show-more"
            variant="link"
            className="p-0"
            onClick={onShowAll}
          >
            {`Show all ${totalCount}`}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function BarValue({
  value01,
  note,
  methodId,
  patientId,
}: {
  value01: number | null
  note: string | null
  methodId: string
  patientId: string
}) {
  const label = formatPct(value01 === null ? null : value01 * 100)
  return (
    <div
      data-testid={`txr-bars-${methodId}`}
      style={BAR_ROW}
      title={value01 === null && note !== null ? note : undefined}
    >
      <div style={{ flex: 1 }}>
        <Progress
          value={value01 === null ? 0 : value01 * 100}
          size="sm"
          aria-label={`Chance for ${patientId}${label ? `: ${label}` : ''}`}
          data-testid={`txr-bars-progress-${methodId}`}
          className="w-full"
        />
      </div>
      <span style={PERCENT}>{value01 === null && note !== null ? '\u2013' : (label ?? '')}</span>
    </div>
  )
}
