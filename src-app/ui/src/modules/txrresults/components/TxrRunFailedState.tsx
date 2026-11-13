/**
 * TxrRunFailedState — the honest terminal-failure state of screens G/H
 * (qa-fixes RES-02): a run that stopped before any method finished has no
 * predictions, and the results page must say WHY instead of rendering an
 * empty page under "0 of N methods finished". The state carries the
 * engine's own per-method reasons (VERBATIM, the INV-2 "failure kept with
 * its reason" rule — never a re-authored sentence) and one "Show the log"
 * action per row (the engine's log lines are the remaining evidence).
 *
 * Copy facts:
 * - the title reads the failure honestly: "This run failed" / "This run
 *   was stopped" — a genuinely stopped run is stopped, everything else is
 *   a failure (qa-fixes2 R2-02: a `finished` run with no finished method
 *   presents the failure state, never a "was stopped" the user did not
 *   do);
 * - the lead sentence states honestly that no method finished (the 409
 *   empty state's fact — a stopped run was stopped before its first
 *   finished method, a failed run failed them all), with the board's
 *   promise that the run stays in History (the sibling screen's
 *   leave-and-continue honesty, INV-2);
 * - one row per method that did not reach `finished` (qa-fixes4 ITEM-2
 *   (d): a Stop-all run lists ALL of its methods — the 4 stopped AND the
 *   2 skipped, never "4 of 6"), rendered through the SAME
 *   `TxrTroubleRowLine` the summary cards use (ITEM-2 (c): one card
 *   component, stacked at phone width); the mono catalogue id, the
 *   method's own state word (the F screen's chip words: "failed" /
 *   "stopped" / "cannot run") and the reason sentence —
 *   `formatReasonText` (the engine's detail verbatim, or the fallback
 *   that points at the log); a finished method is not listed (a stopped
 *   run may have finished some — those results are the header's business,
 *   and their column appears when the SSE delivers it);
 * - the engine's reason STRING is never re-authored here (`formatReasonText`
 *   is the one consumer copy); a row whose detail is absent reads the
 *   fallback, never a blank or a bare code.
 *
 * The block is the page's empty-state branch: only the terminal failed /
 * stopped run with `predictions === null` renders it (a live run without a
 * finished method stays the board's empty-heatmap state — the SSE fills
 * it, no failure is claimed).
 */
import type { CSSProperties } from 'react'
import { Button } from '@txresbench/kit'
import type { TxrRunDetail } from '@/api-client/types'
import { TxrTroubleRowLine } from './TxrRunTrouble'
import { troubleRowsOf } from '../lib/trouble'

/** The board's failure-box look (the cannot-run banner's own surface). */
const BOX: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '16px 18px',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--txr-danger-border)',
  borderRadius: 8,
  background: 'var(--txr-danger-soft)',
}

const TITLE: CSSProperties = {
  margin: 0,
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 20,
  lineHeight: 1.3,
}

const LEAD: CSSProperties = { margin: 0, fontSize: 14, color: 'var(--txr-text-2)' }

const ROWS: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  paddingTop: 8,
  borderTop: '1px solid var(--txr-danger-border)',
  minWidth: 0,
}

export interface TxrRunFailedStateProps {
  /** The terminal failed/stopped run (the page passes it only in the 409
   *  empty state — the block is that state's failure branch). */
  run: TxrRunDetail
  /** "Show the log" for the method (the page opens the store's log dialog). */
  onShowLog: (methodId: string) => void
  /** "See it in History" (the page navigates — RES-02's way out). */
  onShowHistory: () => void
}

export function TxrRunFailedState({ run, onShowLog, onShowHistory }: TxrRunFailedStateProps) {
  // The honest terminal word: only a genuinely STOPPED run reads "was
  // stopped"; a `finished` run with nothing finished is a failure (R2-02 —
  // the engine's `finished` status covers the scheduler racing to the end
  // while every method failed or could not run).
  const stopped = run.status === 'stopped'
  // The block's rows are the run's terminal-error methods ONLY: the
  // `cannot_run` rows are the trouble surface's own (a would-be
  // duplicate), and a method a terminal run never started has no reason to
  // show here. ITEM-2 (d): a Stop-all run's SKIPPED methods are listed
  // too — the "4 of 6" report came from omitting them.
  const rows = troubleRowsOf(run.methods).filter(row => row.state !== 'cannot_run')
  const title = stopped ? 'This run was stopped' : 'This run failed'
  const lead = stopped
    ? 'The run was stopped before its first method finished, so there are no predictions to show. What it did finish stays in History with its log.'
    : 'No method finished, so there are no predictions to show. The run stays in History with its log.'
  return (
    <div data-testid="txr-results-run-failed" style={BOX}>
      <h2 style={TITLE}>{title}</h2>
      <p style={LEAD}>{lead}</p>
      {rows.length > 0 ? (
        <div style={ROWS}>
          {rows.map(row => (
            <TxrTroubleRowLine
              key={row.methodId}
              row={row}
              testId={`txr-results-run-failed-${row.methodId}`}
              logTestId={`txr-results-failed-show-log-${row.methodId}`}
              onShowLog={onShowLog}
            />
          ))}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Button
          data-testid="txr-results-failed-show-history"
          variant="link"
          className="p-0"
          style={{ fontSize: 13, color: 'var(--txr-brand)', whiteSpace: 'nowrap' }}
          onClick={onShowHistory}
        >
          See it in History
        </Button>
        <span style={{ fontSize: 13, color: 'var(--txr-muted)' }}>
          The log lines and the reasons above stay with the run.
        </span>
      </div>
    </div>
  )
}
