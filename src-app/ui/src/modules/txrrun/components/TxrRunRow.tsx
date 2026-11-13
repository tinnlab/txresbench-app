/**
 * TxrRunRow — one method row of screen F's per-method table (ITEM-10,
 * board `BusyRunning.dc.html`): the Method (the board's monospace
 * catalogue id), State (the state word in the state's tone — the module's
 * ONE per-state palette, `STATE_TONE`), Progress (the state-coloured bar
 * with the state's detail line), Time (the row's own timing sentence) and
 * the per-state action.
 *
 * Row facts, state by state (PROV-UI-RUN-2's formatters, TEST-RUN-20):
 *
 * - waiting → "waiting" chip, empty detail (the run schedules it; the
 *   schedule is the header's time-left, DEC-3), empty time, "Skip";
 * - downloading → "downloading" chip, the download line (`formatBytes`
 *   over the row's byte counters — the board's "N of M MB" words), the
 *   empty time, "Skip";
 * - running → "running" chip, the latest engine progress frame's message
 *   (the board's "tree 140 of 500" class; empty between frames — the log
 *   panel carries the stream), the frame's `pct` bar, the row's own
 *   elapsed, "Stop";
 * - finished/stopped/skipped → the state word, an empty detail (the rows
 *   are completed; their lines are in the log panel), a full bar, "done in
 *   M min S s" via `duration_ms`, "View result" / "Show log";
 * - failed/cannot_run → the state word in the failure tone, the engine's
 *   reason line (never blank — `formatProgress`'s recorded-reason fallback,
 *   INV-2 keeps the failure visible), the failure bar, the row's elapsed,
 *   "Show log"; a failed row carries the board's light failure tint.
 *
 * The action is REPORTED, never executed here: `onAction` carries the
 * kind ('stop' | 'skip' | 'log' | 'view') + the method id, and the host
 * (the F page) owns the store calls and the navigation (the `view` kind
 * targets `txrresults`' `methodResultsPath` — PROV-UR-1, never a URL
 * literal; the `log` kind opens the log panel at the method). The board's
 * own action labels are the design-example set (its downloading rows read
 * "Cancel", finished "Open", failed "Details"); the labels here are the
 * plan's frozen mapping (TEST-RUN-20) — skip/stop/view/log — one verb per
 * engine capability (PROV-EE-6's stop/skip + the screen's two
 * navigations).
 *
 * The row error (GROWN — DRIFT-1 ITEM-5 #1): a stop/skip that the engine
 * refused (409 METHOD_NOT_ACTIVE / METHOD_NOT_SKIPPABLE) lands as the
 * row's error — the row KEEPS its state, its action disables (the
 * assertion TEST-RUN-11 pins) and the error line renders under the
 * action, never a crash and never a silent no-op.
 */
import type { CSSProperties } from 'react'
import { Button } from '@txresbench/kit'
import type { TxrRunMethod, TxrRunProgressFrame } from '@/api-client/types'
import {
  formatBarValue,
  formatProgress,
  formatRowTime,
  STATE_LABEL,
  STATE_TONE,
} from '../lib/format'

/** The action vocabulary the row reports (the host maps kinds to store/navigation). */
export type TxrRunRowActionKind = 'stop' | 'skip' | 'log' | 'view'

export interface TxrRunRowAction {
  kind: TxrRunRowActionKind
  methodId: string
}

/** The per-state action label + kind (the plan's frozen mapping, TEST-RUN-20). */
const ROW_ACTIONS: Record<TxrRunMethod['state'], { label: string; kind: TxrRunRowActionKind }> = {
  waiting: { label: 'Skip', kind: 'skip' },
  downloading: { label: 'Skip', kind: 'skip' },
  running: { label: 'Stop', kind: 'stop' },
  finished: { label: 'View result', kind: 'view' },
  failed: { label: 'Show log', kind: 'log' },
  stopped: { label: 'Show log', kind: 'log' },
  skipped: { label: 'Show log', kind: 'log' },
  cannot_run: { label: 'Show log', kind: 'log' },
}

/**
 * The board's shared column look (the board CSS's `td,th` rule: the 8/12
 * padding, the hairline rule under the row, the middle vertical align).
 */
const COLUMN_LOOK: CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  borderBottom: '1px solid var(--txr-border-subtle)',
  verticalAlign: 'middle',
}

/** The board's method column look (mono, semibold — the catalogue id). */
const METHOD_LOOK: CSSProperties = {
  ...COLUMN_LOOK,
  fontFamily: "'Source Code Pro', monospace",
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--txr-text)',
  whiteSpace: 'nowrap',
}

/** The board's state column look (the state word in its tone, bold). */
const STATE_WORD: CSSProperties = { ...COLUMN_LOOK, fontWeight: 600, whiteSpace: 'nowrap' }

/** The progress column: track + fill (the board's 7 px rounded bar).
 *  qa-fixes4 ITEM-3 (methods-r3 R2-9): on the phone's stacked card the
 *  cell is a flex row, and the track must be a flex item that TAKES the
 *  leftover — the old auto-width track resolved the fill's percentage
 *  against an indefinite width and collapsed to 0 px (the report's "no
 *  bar at all" on the phone cards while the desktop showed a grey
 *  track). `flex: 1 1 0` (grow into the row's leftover after the label
 *  column) with the desktop-block `width: 100%` fallback; `minWidth: 0`
 *  so the percentage fill can never hold the row open. */
const BAR_TRACK: CSSProperties = {
  height: 7,
  width: '100%',
  flex: '1 1 0',
  minWidth: 0,
  borderRadius: 999,
  background: 'var(--txr-border-subtle)',
  overflow: 'hidden',
}

const BAR_FILL: CSSProperties = { height: '100%', borderRadius: 999 }

/** The detail line under the bar (the board's 12 px grey). */
const DETAIL: CSSProperties = { fontSize: 12, color: 'var(--txr-muted)', marginTop: 2 }

/** The time column look (the board's right-aligned tabular digits). */
const TIME_LOOK: CSSProperties = {
  ...COLUMN_LOOK,
  textAlign: 'right',
  whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
}

/** The action column look (the board's right-aligned link). */
const ACTION_LOOK: CSSProperties = { ...COLUMN_LOOK, textAlign: 'right', whiteSpace: 'nowrap' }

/** The row-level error line (the stop/skip 409 surface, DRIFT-1 ITEM-5 #1). */
const ROW_ERROR: CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: 'var(--txr-danger)',
  marginTop: 2,
}

/** The action link's look (the shared list's own action link). */
const ACTION_LINK: CSSProperties = { fontSize: 13, fontWeight: 600 }

/** A failed / cannot-run row's light tint (the board's failure row). */
const FAILURE_TINT = 'var(--txr-danger-soft)'

export interface TxrRunRowProps {
  /** The row's method facts (the engine's own — PROV-EE-3). */
  row: TxrRunMethod
  /** The row's latest live progress frame (the store's perMethod slot). */
  progress: TxrRunProgressFrame | null
  /** The row's action error (a stop/skip the engine refused) — disables the action. */
  rowError: string | null
  /** The page's wall clock — the live Time column reads it against the row's
   *  `started_at` (R2-4; null falls back to the engine's last snapshot). */
  nowMs?: number | null
  /** Reports the per-state action; the host executes (store calls + navigation). */
  onAction: (action: TxrRunRowAction) => void
}

export function TxrRunRow({ row, progress, rowError, nowMs = null, onAction }: TxrRunRowProps) {
  const action = ROW_ACTIONS[row.state]
  const detail = formatProgress(row, progress)
  const time = formatRowTime(row, nowMs)
  const bar = formatBarValue(row, progress)
  const failed = row.state === 'failed' || row.state === 'cannot_run'
  return (
    <tr
      data-testid={`txr-run-row-${row.method_id}`}
      className="txr-run-row"
      style={{ background: failed ? FAILURE_TINT : 'var(--txr-surface)' }}
    >
      <th scope="row" style={METHOD_LOOK}>
        {row.label}
      </th>
      <td data-label="State" style={STATE_WORD}>
        <span
          data-testid={`txr-run-state-${row.method_id}`}
          style={{ color: STATE_TONE[row.state] }}
        >
          {STATE_LABEL[row.state]}
        </span>
      </td>
      <td data-label="Progress" style={{ ...COLUMN_LOOK, width: '26%' }}>
        <div
          data-testid={`txr-run-bar-track-${row.method_id}`}
          style={BAR_TRACK}
        >
          <div
            data-testid={`txr-run-bar-${row.method_id}`}
            style={{ ...BAR_FILL, width: `${bar}%`, background: STATE_TONE[row.state] }}
          />
        </div>
        {detail !== '' ? (
          <div data-testid={`txr-run-detail-${row.method_id}`} style={DETAIL}>
            {detail}
          </div>
        ) : null}
      </td>
      <td data-label="Time" style={TIME_LOOK}>
        {time !== '' ? <span data-testid={`txr-run-time-${row.method_id}`}>{time}</span> : null}
      </td>
      <td data-label="Actions" style={ACTION_LOOK}>
        <Button
          data-testid={`txr-run-action-${row.method_id}`}
          variant="link"
          style={ACTION_LINK}
          disabled={rowError !== null}
          onClick={() => onAction({ kind: action.kind, methodId: row.method_id })}
        >
          {action.label}
        </Button>
        {rowError !== null ? (
          <span
            data-testid={`txr-run-row-error-${row.method_id}`}
            style={ROW_ERROR}
            role="status"
          >
            {rowError}
          </span>
        ) : null}
      </td>
    </tr>
  )
}
