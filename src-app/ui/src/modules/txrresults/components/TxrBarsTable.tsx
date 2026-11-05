/**
 * TxrBarsTable — the H screen's patient × method bar table
 * (`Results.dc.html`): the kit `Table` (DEC-11's twin of the G heatmap — a
 * handful of columns, no two-axis pinning, so the kit grid table is the
 * right primitive) with one row per patient and one per-method chance bar
 * (the board's `height: 10px` rounded track + `#1d4e89` fill) beside its
 * percent, plus the board's footer sentence and the "Show all M" link.
 *
 * The rows arrive ALREADY sorted and windowed by the page (DEC-6: "sorted
 * by the first method" — the page applies `sortByFirstMethod` over the
 * view and then the store's patient limit, the same "Showing N of M"
 * affordance the G screen has). This component renders and reports
 * "Show all M"; it never sorts, filters or windows itself.
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
 * Test-id surface: the kit Table root (`txr-bars`, derived `txr-bars-root`
 * + `txr-bars-row-<patientId>`), the per-method value box
 * `txr-bars-<methodId>` (one per row — the G heatmap id convention),
 * and `txr-bars-show-more` (additive; the plan's list names no H
 * show-more selector, same class as `txr-heatmap-show-more`).
 */
import type { CSSProperties } from 'react'
import { Button, Progress, Table } from '@ziee/kit'
import type { TableColumn } from '@ziee/kit'
import type { TxrHeatmapColumn, TxrHeatmapRow, TxrOutcomeKey } from '../types'
import { formatPct } from '../lib/format'

const MONO_FONT = "'Source Code Pro', ui-monospace, monospace"

/** The board's table box (the H board's `overflow-x: auto` rounded box). */
const TABLE_BOX: CSSProperties = {
  overflowX: 'auto',
  border: '1px solid #cfcdc7',
  borderRadius: 10,
}

const FOOTER: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'space-between',
  gap: 10,
  fontSize: 13,
  color: '#5e5e5e',
  marginTop: 8,
}

const PATIENT_ID_STYLE: CSSProperties = {
  fontFamily: MONO_FONT,
  fontSize: 13,
  whiteSpace: 'nowrap',
}

const METHOD_LABEL_STYLE: CSSProperties = {
  fontFamily: MONO_FONT,
  fontSize: 13,
  whiteSpace: 'nowrap',
  fontWeight: 500,
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
  const tableColumns: Array<TableColumn<TxrHeatmapRow>> = [
    {
      key: 'patient',
      title: 'Patient',
      render: row => <span style={PATIENT_ID_STYLE}>{row.patientId}</span>,
    },
    // The index is captured per column: a row's aligned values follow the
    // view's columns (the run's method order, lib/heatmap.ts's viewOf).
    ...columns.map((col, index) => ({
      key: col.methodId,
      title: <span style={METHOD_LABEL_STYLE}>{col.label}</span>,
      render: (row: TxrHeatmapRow) => (
        <BarValue
          value01={row.cells[index] ?? null}
          methodId={col.methodId}
          patientId={row.patientId}
        />
      ),
    })),
  ]
  return (
    <div>
      <div style={TABLE_BOX}>
        <Table
          columns={tableColumns}
          dataSource={[...rows]}
          rowKey={row => row.patientId}
          data-testid="txr-bars"
        />
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
  methodId,
  patientId,
}: {
  value01: number | null
  methodId: string
  patientId: string
}) {
  const label = formatPct(value01 === null ? null : value01 * 100)
  return (
    <div data-testid={`txr-bars-${methodId}`} style={BAR_ROW}>
      <div style={{ flex: 1 }}>
        <Progress
          value={value01 === null ? 0 : value01 * 100}
          size="sm"
          aria-label={`Chance for ${patientId}${label ? `: ${label}` : ''}`}
          data-testid={`txr-bars-progress-${methodId}`}
          className="w-full"
        />
      </div>
      <span style={PERCENT}>{label ?? ''}</span>
    </div>
  )
}
