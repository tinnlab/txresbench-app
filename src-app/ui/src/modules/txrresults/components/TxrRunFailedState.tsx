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
 * - the title reads the run's own terminal word: "This run failed" /
 *   "This run was stopped" (the engine's `status` — one word, never a
 *   third vocabulary);
 * - the lead sentence states honestly that no method finished (the 409
 *   empty state's fact — a stopped run was stopped before its first
 *   finished method, a failed run failed them all), with the board's
 *   promise that the run stays in History (the sibling screen's
 *   leave-and-continue honesty, INV-2);
 * - one row per method that did not reach `finished`: the mono catalogue
 *   id, the method's own state word (the F screen's chip words: "failed" /
 *   "stopped" / "cannot run") and the reason sentence — `formatReasonText`
 *   (the engine's detail verbatim, or the fallback that points at the
 *   log); a finished method is not listed (a stopped run may have
 *   finished some — those results are the header's business, and their
 *   column appears when the SSE delivers it);
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
import { Button } from '@ziee/kit'
import type { TxrRunDetail, TxrRunMethod } from '@/api-client/types'
import { formatReasonText } from '../lib/format'

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

const ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  fontSize: 14,
  paddingTop: 8,
  borderTop: '1px solid var(--txr-danger-border)',
}

const METHOD_ID: CSSProperties = {
  fontFamily: "'Source Code Pro', ui-monospace, monospace",
  fontSize: 13,
  fontWeight: 700,
  whiteSpace: 'nowrap',
}

const STATE: CSSProperties = { color: 'var(--txr-danger)', fontSize: 13.5, whiteSpace: 'nowrap' }

const REASON: CSSProperties = { color: 'var(--txr-text-2)', flex: '1 1 auto', minWidth: 0 }

const SHOW_LOG: CSSProperties = { fontSize: 13, color: 'var(--txr-brand)', whiteSpace: 'nowrap' }

/** The row's state word — the F screen's chip words (DEC-2's vocabulary). */
function stateWord(state: TxrRunMethod['state']): string {
  switch (state) {
    case 'failed':
      return 'failed'
    case 'stopped':
      return 'stopped'
    default:
      return state
  }
}

export interface TxrRunFailedStateProps {
  /** The terminal failed/stopped run (the page passes it only in the 409
   *  empty state — the block is that state's failure branch). */
  run: TxrRunDetail
  /** "Show the log" for the method (the page opens the store's log dialog). */
  onShowLog: (methodId: string) => void
}

export function TxrRunFailedState({ run, onShowLog }: TxrRunFailedStateProps) {
  const failed = run.status === 'failed'
  // The block's rows are the run's terminal-error methods ONLY: the
  // `cannot_run` rows are the banner's own (a would-be duplicate), and a
  // method a terminal run never started has no reason to show here.
  const rows = run.methods.filter(m => m.state === 'failed' || m.state === 'stopped')
  if (rows.length === 0) return null
  const title = failed ? 'This run failed' : 'This run was stopped'
  const lead = failed
    ? 'No method finished, so there are no predictions to show. The run stays in History with its log.'
    : 'The run was stopped before its first method finished, so there are no predictions to show. What it did finish stays in History with its log.'
  return (
    <div data-testid="txr-results-run-failed" style={BOX}>
      <h2 style={TITLE}>{title}</h2>
      <p style={LEAD}>{lead}</p>
      {rows.map(method => (
        <div key={method.method_id} data-testid={`txr-results-run-failed-${method.method_id}`} style={ROW}>
          <span style={METHOD_ID}>{method.method_id}</span>
          <span style={STATE}>{stateWord(method.state)}</span>
          <span style={REASON}>{formatReasonText(method.reason?.code, method.reason?.detail)}</span>
          <Button
            data-testid={`txr-results-failed-show-log-${method.method_id}`}
            variant="link"
            className="p-0"
            style={SHOW_LOG}
            onClick={() => onShowLog(method.method_id)}
          >
            Show the log
          </Button>
        </div>
      ))}
    </div>
  )
}
