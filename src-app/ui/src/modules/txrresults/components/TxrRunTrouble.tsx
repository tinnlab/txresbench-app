/**
 * TxrRunTrouble — qa-fixes4 ITEM-2's truthful summary of the methods of a
 * run that did not finish (results-r3 R3-results-3, methods-r3
 * R3-methods-10/-11; DEC-3): the cannot-run/failed/stopped/skipped rows,
 * grouped by (state, reason code) so a run where 203 methods could not run
 * for the same reason shows ONE summary card ("203 methods could not run:
 * their environments are not available yet") with the per-method reasons
 * in an expandable list — NEVER 203 cards, and the "other N are shown"
 * tail is the true finished count ("The other 6 methods are shown.", never
 * the false "208").
 *
 * Layout rules:
 * - a group of ONE row keeps the board's single-line banner (the board's
 *   cannot-run sentence verbatim for `cannot_run`; the same surface with
 *   the state word for a single failed/stopped/skipped method);
 * - a group of 2+ rows is ONE summary card (danger box, the board's
 *   warning surface) whose list is collapsed by default and expands in
 *   place;
 * - every row line is the SAME stacked-capable component the terminal
 *   failure state uses (`TxrTroubleRowLine` — PLAN ITEM-2 (c): the failed
 *   and stopped pages use the same card component as desktop with a
 *   stacked layout at phone width; the CSS `txr-results-trouble-row`
 *   media rule stacks it below 640 px and no child is ever `nowrap`
 *   except the method id, so the reason never collapses into a
 *   one-word-per-line column and never overlaps "Show the log").
 *
 * The board's single-banner copy stays byte-identical (the QA pin)
 * through `othersShownTail`'s true count; the summary card's heading is
 * `lib/trouble.ts`'s code-informed sentence.
 */
import { useState } from 'react'
import type { CSSProperties } from 'react'
import { Button } from '@txresbench/kit'
import { formatReasonText } from '../lib/format'
import {
  groupTroubleRows,
  othersShownTail,
  troubleHeading,
  troubleStateWord,
  type TxrTroubleGroup,
  type TxrTroubleRow,
} from '../lib/trouble'

/** The column of banners/cards (the old banner column's own gap). */
const COLUMN: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 }

/** The board's single-line banner surface (danger tone, the wrap row). */
const BANNER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--txr-danger-border)',
  borderRadius: 8,
  background: 'var(--txr-danger-soft)',
  fontSize: 14,
  flexWrap: 'wrap',
  minWidth: 0,
}

/** The summary card's surface (the board's warning box — one card per group). */
const CARD: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '12px 14px',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--txr-danger-border)',
  borderRadius: 8,
  background: 'var(--txr-danger-soft)',
  minWidth: 0,
}

/** The card's head row (icon + the count sentence). */
const CARD_HEAD: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }

/** The card's heading (wraps — never a one-word column, ITEM-2 (c)). */
const CARD_HEADING: CSSProperties = { margin: 0, fontSize: 14, minWidth: 0, flex: '1 1 auto' }

/** The "other N are shown" tail line (the true finished count). */
const TAIL: CSSProperties = { margin: 0, fontSize: 13, color: 'var(--txr-text-2)', paddingLeft: 28 }

/** The card's expand toggle (the one affordance of the list). */
const TOGGLE: CSSProperties = { fontSize: 13, padding: 0, height: 'auto', alignSelf: 'flex-start', marginLeft: 28 }

/** The expandable list's column (the per-method reasons). */
const LIST: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  borderTop: '1px solid var(--txr-danger-border)',
  paddingTop: 8,
  marginLeft: 28,
  minWidth: 0,
}

/** One stacked-capable row line (the same component everywhere — ITEM-2 (c)). */
const ROW: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  gap: '4px 10px',
  fontSize: 14,
  minWidth: 0,
}

const METHOD_ID: CSSProperties = {
  fontFamily: "'Source Code Pro', ui-monospace, monospace",
  fontSize: 13,
  fontWeight: 700,
  whiteSpace: 'nowrap',
}

const STATE: CSSProperties = { color: 'var(--txr-danger)', fontSize: 13.5, whiteSpace: 'nowrap' }

const REASON: CSSProperties = { color: 'var(--txr-text-2)', flex: '1 1 240px', minWidth: 0 }

const SHOW_LOG: CSSProperties = { fontSize: 13, color: 'var(--txr-brand)', whiteSpace: 'nowrap' }

/** One trouble row's state word (the F chip words). */
function stateWordOf(row: TxrTroubleRow): string {
  return troubleStateWord(row.state)
}

/** The row's reason sentence (`formatReasonText` — the one consumer copy). */
function reasonTextOf(row: TxrTroubleRow): string {
  return formatReasonText(row.reason?.code, row.reason?.detail)
}

/**
 * One trouble row line — the SAME stacked-capable row for the summary
 * lists and the terminal failure state (ITEM-2 (c)). The test ids are
 * caller-chosen (the two surfaces keep their pinned ids).
 */
export function TxrTroubleRowLine({
  row,
  testId,
  logTestId,
  onShowLog,
}: {
  row: TxrTroubleRow
  testId: string
  logTestId: string
  onShowLog: (methodId: string) => void
}) {
  return (
    <div data-testid={testId} className="txr-results-trouble-row" style={ROW}>
      <span style={METHOD_ID}>{row.label}</span>
      <span style={STATE}>{stateWordOf(row)}</span>
      <span style={REASON} className="txr-results-trouble-reason">
        {reasonTextOf(row)}
      </span>
      <Button
        data-testid={logTestId}
        variant="link"
        className="p-0"
        style={SHOW_LOG}
        onClick={() => onShowLog(row.methodId)}
      >
        Show the log
      </Button>
    </div>
  )
}

/** One row of a 1-row group — the board's single-line banner. */
function SingleRowBanner({
  group,
  finishedCount,
  onShowLog,
}: {
  group: TxrTroubleGroup
  finishedCount: number
  onShowLog: (methodId: string) => void
}) {
  const row = group.rows[0]
  const tail = othersShownTail(finishedCount)
  if (group.state === 'cannot_run') {
    // The board's verbatim sentence: "<id> could not run: <reason>. The
    // other N methods are shown." — the tail's N is the TRUE finished count
    // (ITEM-2 (b): never "total minus one").
    return (
      <div data-testid={`txr-results-cannot-${row.methodId}`} className="txr-results-banner" style={BANNER}>
        <svg
          width={18}
          height={18}
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--txr-danger)"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          style={{ flexShrink: 0 }}
        >
          <circle cx={12} cy={12} r={10} />
          <path d="M12 7v6M12 16.5v.5" />
        </svg>
        <span style={{ minWidth: 0, flex: '1 1 240px' }}>
          <b style={METHOD_ID}>{row.label}</b> could not run: {reasonTextOf(row)}
          {tail !== null ? ` ${tail}` : ''}
        </span>
        <Button
          data-testid={`txr-results-show-log-${row.methodId}`}
          variant="link"
          className="p-0"
          style={SHOW_LOG}
          onClick={() => onShowLog(row.methodId)}
        >
          Show the log
        </Button>
      </div>
    )
  }
  return (
    <div data-testid={`txr-results-trouble-${row.methodId}`} className="txr-results-banner" style={BANNER}>
      <svg
        width={18}
        height={18}
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--txr-danger)"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        style={{ flexShrink: 0 }}
      >
        <circle cx={12} cy={12} r={10} />
        <path d="M12 7v6M12 16.5v.5" />
      </svg>
      <span style={{ minWidth: 0, flex: '1 1 240px' }}>
        <b style={METHOD_ID}>{row.label}</b> {stateWordOf(row)}: {reasonTextOf(row)}
        {tail !== null ? ` ${tail}` : ''}
      </span>
      <Button
        data-testid={`txr-results-trouble-log-${row.methodId}`}
        variant="link"
        className="p-0"
        style={SHOW_LOG}
        onClick={() => onShowLog(row.methodId)}
      >
        Show the log
      </Button>
    </div>
  )
}

/** One group's summary card (2+ rows): the count sentence + the expandable
 *  per-method list — ONE card per reason group (ITEM-2 (b)). */
function SummaryCard({
  group,
  finishedCount,
  onShowLog,
}: {
  group: TxrTroubleGroup
  finishedCount: number
  onShowLog: (methodId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const key = `${group.state}-${group.code ?? 'none'}`
  const tail = othersShownTail(finishedCount)
  const noun = group.rows.length === 1 ? 'method' : 'methods'
  return (
    <div data-testid={`txr-results-trouble-summary-${key}`} className="txr-results-trouble-summary" style={CARD}>
      <div style={CARD_HEAD}>
        <svg
          width={18}
          height={18}
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--txr-danger)"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          style={{ flexShrink: 0 }}
        >
          <circle cx={12} cy={12} r={10} />
          <path d="M12 7v6M12 16.5v.5" />
        </svg>
        <p style={CARD_HEADING}>{troubleHeading(group)}</p>
      </div>
      {tail !== null ? (
        <p data-testid={`txr-results-trouble-tail-${key}`} style={TAIL}>
          {tail}
        </p>
      ) : null}
      <Button
        data-testid={`txr-results-trouble-toggle-${key}`}
        variant="link"
        className="p-0"
        style={TOGGLE}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? 'Hide the methods' : `Show the ${group.rows.length} ${noun}`}
      </Button>
      {open ? (
        <div data-testid={`txr-results-trouble-list-${key}`} style={LIST}>
          {group.rows.map(row => (
            <TxrTroubleRowLine
              key={row.methodId}
              row={row}
              testId={`txr-results-trouble-row-${row.methodId}`}
              logTestId={`txr-results-trouble-show-log-${row.methodId}`}
              onShowLog={onShowLog}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export interface TxrRunTroubleProps {
  /** The run's non-finished terminal rows (failed/cannot_run/stopped/skipped) —
   *  already mapped by `lib/trouble.ts`'s `troubleRowsOf` (the label-first
   *  display rows; the pages never pass raw `TxrRunMethod`s). */
  rows: ReadonlyArray<TxrTroubleRow>
  /** The run's finished count (the tail's true "other N"). */
  finishedCount: number
  /** "Show the log" for the method (the page opens the store's dialog). */
  onShowLog: (methodId: string) => void
}

export function TxrRunTrouble({ rows, finishedCount, onShowLog }: TxrRunTroubleProps) {
  const groups = groupTroubleRows(rows)
  if (groups.length === 0) return null
  return (
    <div style={COLUMN}>
      {groups.map(group =>
        group.rows.length === 1 ? (
          <SingleRowBanner
            key={`${group.state}-${group.code ?? 'none'}-${group.rows[0].methodId}`}
            group={group}
            finishedCount={finishedCount}
            onShowLog={onShowLog}
          />
        ) : (
          <SummaryCard
            key={`${group.state}-${group.code ?? 'none'}`}
            group={group}
            finishedCount={finishedCount}
            onShowLog={onShowLog}
          />
        ),
      )}
    </div>
  )
}
