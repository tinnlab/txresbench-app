/**
 * TxrRunTable — screen F's per-method section (ITEM-10, board
 * `BusyRunning.dc.html`): the Method/State/Progress/Time/Actions table
 * (one row per method, keyed by method_id, `TxrRunRow` as the row), the
 * Stop-all control with its confirmation and the at-a-time control (DEC-5 /
 * CONS-UI-RUN-11's lane-change GAP call site) below it.
 *
 * Ownership (the frozen props): the host passes the ROWS ALREADY FILTERED
 * by the active tab (DEC-2's bucket partition + the page's tab state,
 * PLAN ITEM-9 note (a) — the table never filters), each row's live facts
 * from the run store's `perMethod` slot, and the REPORTING callbacks —
 * `onAction` (the per-state action: the host maps the kinds to the store
 * calls and the txrresults builders, PROV-UI-RUN-5), `onStopAll` (called
 * ONLY after the confirm — DEC-10's confirmation gate: a confirm per
 * row is friction, but Stop all aborts several sandboxes at once) and
 * `onAtATime` (the row's lane pick). The grown selection
 * (DRIFT-1 ITEM-5 #1): `rowErrors` (the stop/skip 409 surface — the row
 * keeps its state, its action disables), `stopping` (a run-level action in
 * flight: the Stop-all button turns busy, the at-a-time row disables) and
 * the two error lines (`rowErrors` per row, `actionError` for Stop all,
 * `atATimeError` for the lane pick) — a failed control is never silent.
 *
 * The replacement of the kit `Table` by the board's own table markup is
 * recorded (DRIFT-1 ITEM-10 #1): the kit grid derives its row test-ids as
 * `<testid>-row-<key>` — it cannot produce the module's frozen
 * `txr-run-row-<method_id>` contract (PROV-UI-RUN-1, TEST-RUN-21), and
 * the board's row surface (the `th scope="row"` mono id, the 26 %
 * progress column, the row-tinted failure, the screen-reader-only
 * "Actions" header) is not expressible through the kit's column options
 * either; the sibling G screen's table (txrresults' `TxrHeatmapTable`)
 * hand-rolls its rows for the same reason. Every CONTROL in this section
 * stays a kit control (`Button`, `Confirm`, `Segmented`).
 */
import type { CSSProperties } from 'react'
import { Button, Confirm } from '@ziee/kit'
import type { TxrRunMethod } from '@/api-client/types'
import type { TxrRunPerMethod } from '../stores/TxrRun.store'
import { TxrAtATimeControl } from './TxrAtATimeControl'
import { TxrRunRow, type TxrRunRowAction } from './TxrRunRow'

/** The board's table card (rounded, hairline border; horizontal scroll on a narrow screen). */
const TABLE_BOX: CSSProperties = {
  border: '1px solid var(--txr-border)',
  borderRadius: 10,
  overflowX: 'auto',
  background: 'var(--txr-surface)',
}

const TABLE: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 14 }

const HEADER_LOOK: CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  borderBottom: '1px solid var(--txr-border)',
  fontWeight: 600,
  color: 'var(--txr-text-2)',
  background: 'var(--txr-surface-dim)',
  whiteSpace: 'nowrap',
}

/** The board's screen-reader-only "Actions" header (a real column, a hidden label). */
const VISUALLY_HIDDEN: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
}

const EMPTY_LOOK: CSSProperties = {
  padding: '14px 12px',
  fontSize: 13,
  color: 'var(--txr-muted)',
  textAlign: 'center',
}

/** The section footer: Stop all + the failure line (left), the at-a-time row (right). */
const FOOTER: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '8px 16px',
}

const STOP_ALL: CSSProperties = {
  padding: '10px 22px',
  fontWeight: 700,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--txr-danger)',
  color: 'var(--txr-danger)',
  background: 'var(--txr-surface)',
  borderRadius: 8,
}

const ACTION_ERROR: CSSProperties = {
  fontSize: 12.5,
  color: 'var(--txr-danger)',
  maxWidth: 420,
}

const SPACER: CSSProperties = { flexGrow: 1 }

export interface TxrRunTableProps {
  /** The page's tab-filtered rows (DEC-2's partition; the table never filters). */
  rows: TxrRunMethod[]
  /** The rows' live facts (the run store's perMethod slot). */
  perMethod: Readonly<Record<string, TxrRunPerMethod>>
  /** The per-row action errors (a stop/skip the engine refused — the 409 surface). */
  rowErrors: Readonly<Record<string, string>>
  /** The per-state action (the host maps the kinds to the store + navigation). */
  onAction: (action: TxrRunRowAction) => void
  /** The run's current lane count (the at-a-time control's value). */
  atATime: number | null
  /** The lane pick's host call (the run store's `setAtATime` — the engine's GAP route). */
  onAtATime: (n: number) => void
  /** The lane pick's typed failure line (the store's `atATimeError`). */
  atATimeError: string | null
  /** Stop all's host call — fired ONLY after the confirmation (DEC-10). */
  onStopAll: () => void
  /** A run-level action in flight (Stop all's own call): button busy, at-a-time disabled. */
  stopping: boolean
  /** The run is over (terminal status): Stop all and the lane pick are
   *  disabled — a finished run's controls must not claim a live run
   *  (qa-fixes ITEM-3, RP-1). */
  terminal: boolean
  /** Stop all's failure line (the run-level action error). */
  actionError: string | null
}

export function TxrRunTable({
  rows,
  perMethod,
  rowErrors,
  onAction,
  atATime,
  onAtATime,
  atATimeError,
  onStopAll,
  stopping,
  terminal,
  actionError,
}: TxrRunTableProps) {
  return (
    <section data-testid="txr-run-table-section" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="txr-run-table-box" style={TABLE_BOX}>
        <table data-testid="txr-run-table" className="txr-run-table" style={TABLE}>
          <thead>
            <tr>
              <th scope="col" style={HEADER_LOOK}>
                Method
              </th>
              <th scope="col" style={HEADER_LOOK}>
                State
              </th>
              <th scope="col" style={{ ...HEADER_LOOK, width: '26%' }}>
                Progress
              </th>
              <th scope="col" style={{ ...HEADER_LOOK, textAlign: 'right' }}>
                Time
              </th>
              <th scope="col" style={{ ...HEADER_LOOK, textAlign: 'right' }}>
                <span style={VISUALLY_HIDDEN}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr data-testid="txr-run-table-empty">
                <td colSpan={5} style={EMPTY_LOOK}>
                  No methods in this view.
                </td>
              </tr>
            ) : (
              rows.map(row => (
                <TxrRunRow
                  key={row.method_id}
                  row={row}
                  progress={perMethod[row.method_id]?.progress ?? null}
                  rowError={rowErrors[row.method_id] ?? null}
                  onAction={onAction}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
      <div style={FOOTER}>
        <Confirm
          data-testid="txr-run-stop-all-confirm"
          title="Stop all running methods?"
          okText="Stop all"
          cancelText="Cancel"
          danger
          onConfirm={() => onStopAll()}
        >
          <Button
            data-testid="txr-run-stop-all"
            variant="outline"
            className="rounded-lg"
            style={STOP_ALL}
            loading={stopping}
            disabled={terminal}
          >
            Stop all
          </Button>
        </Confirm>
        {actionError !== null ? (
          <span data-testid="txr-run-action-error" style={ACTION_ERROR} role="status" aria-live="polite">
            {actionError}
          </span>
        ) : null}
        <span style={SPACER} />
        <TxrAtATimeControl
          value={atATime}
          onChange={onAtATime}
          busy={stopping || terminal}
          error={atATimeError}
        />
      </div>
    </section>
  )
}
