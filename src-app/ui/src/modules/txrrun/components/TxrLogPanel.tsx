/**
 * TxrLogPanel — screen F's right-hand log column (ITEM-11, board
 * `BusyRunning.dc.html`'s Log section): the method filter (the BOARD's
 * select — "All methods" + one option per run method — in the module's
 * own rendering of the kit Select slot, replacing the one-chip-per-method
 * pills that stacked 209 chips for a 209-method run, qa-fixes ITEM-3
 * RP-4), the live lines (the run store's `liveLogs` tail, the board's
 * `HH:MM:SS [method] content` bytes via `lib/format.ts`'s one line
 * formatter — the engine's `content` is rendered end to end, timestamp
 * bracketed and method labelled, never re-worded), "Follow the newest
 * line" (kit `Switch` — the scroll pins to the newest line while it is
 * on, the JobDetail log idiom) and "Copy the log" (the same formatter
 * joined for the clipboard — display and copy are one text, what the user
 * sees is what the paste gets). An empty lines area reads one of the
 * module's empty-state lines (never a blank box).
 *
 * qa-fixes4 ITEM-3 (methods-r3 R3-methods-5/6): the controls (the method
 * filter, "Show technical output", "Follow the newest line", "Copy the
 * log") sit ABOVE the lines box — a bounded panel keeps them in view, and
 * a panel that ever outgrew its slot (the phone stack's 9,100 px pre of
 * the round-3 build) could still not push the controls below the fold.
 * The repeated lines are COLLAPSED (`lib/format.ts`'s
 * `collapseRepeatedLines`): the R methods' `colClasses` warning block is
 * printed once with "×N" on its last line instead of two or three
 * identical 3-line blocks; the collapse is a view presentation (the copy
 * carries the collapsed view, like the technical filter), the raw lines
 * stay in the store and in the count line's facts.
 *
 * Ownership per the frozen props: the panel reads ONLY its props (the
 * store's `liveLogs`/`logTotal`/`logFilter`/`logFollow`/`logOpen` flow
 * through the page) and reports the user's intentions (`onFilter` /
 * `onFollow` / `onOpenChange` for the Hide control; `onBackfill` for the
 * pre-SSE history — the page owns the store call, the CONS-UI-RUN-10
 * consume, so the panel never imports the store). The two GROWN slots are
 * recorded (DRIFT-1 ITEM-11): `methods` — "one per run method" (TEST-RUN-22)
 * is the run's ROWS, and the frozen props list carried no method list, a
 * panel that derived options from the lines' occurrences would miss a
 * method whose engine lines never arrived (a `waiting` row has none); and
 * the backfill hook — a panel that never asked for history would show only
 * the live tail, and the store's `loadLogs` is exactly the provider surface
 * (CONS-UI-RUN-10's "the log panel's backfill"). The frozen `onCopy` host
 * callback is NOT taken: copy is the panel's own pure client behaviour (the
 * plan's own audit line), the copied text is the panel's CURRENT filtered
 * view, and TEST-RUN-22 pins the clipboard write in the panel's own test —
 * the sibling G screen's log dialog owns its clipboard the same way.
 *
 * The rendered lines are capped at 200 (`RENDER_CAP`) with the count shown
 * — the store's tail is the same bound (TEST-RUN-10's LIVE_LOGS_CAP), the
 * cap at the paint site is the defensive half a panel that is handed a
 * longer list cannot rely on the store for. The lines AREA is height-
 * bounded (the page's definite-height frame makes the panel column the
 * box; the pre scrolls inside it — RP-4's 22,590 px blank expanse is the
 * unbound layout, not the data).
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Button, message, Select, Switch } from '@txresbench/kit'
import type { TxrRunLogLine } from '@/api-client/types'
import {
  collapseRepeatedLines,
  filterLogLines,
  formatCollapsedLogLine,
  isTechnicalLogNoise,
  LOG_EMPTY_ALL,
  LOG_EMPTY_METHOD,
  type TxrLogMethodRef,
} from '../lib/format'

/** The panel's own render cap (the store's tail bound is the same number). */
export const LOG_PANEL_RENDER_CAP = 200

/** The board's aside look (right column, tinted, hairline left rule).
 *  app-shell ITEM-2: the aside sits IN the page's Log ScrollRegion — the
 *  `minHeight: 100%` fills the region's scrollport so the fixed chrome
 *  (heading, filter, controls) never scrolls away and the lines area keeps
 *  its bounded internal viewport (the ITEM-11 byte: the pre scrolls the
 *  lines, the region is the log's zone). */
const ASIDE: CSSProperties = {
  flex: '2 1 380px',
  minWidth: 0,
  minHeight: '100%',
  boxSizing: 'border-box',
  padding: '26px 28px',
  background: 'var(--txr-bg)',
  borderLeft: '1px solid var(--txr-border-subtle)',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
}

/** The Log heading row (the board's uppercase title + the Hide control). */
const HEAD_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
}

const HEADING: CSSProperties = {
  margin: 0,
  fontSize: 15,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--txr-text-2)',
}

const SPACER: CSSProperties = { flexGrow: 1 }

const CLOSE: CSSProperties = { fontSize: 13, padding: '2px 4px' }

/** The filter row (the board's select slot — one line, never a stack). */
const FILTER_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}

const FILTER_LABEL: CSSProperties = { fontSize: 12.5, color: 'var(--txr-muted)' }

const SELECT: CSSProperties = { width: '100%', maxWidth: 240 }

/** The lines box (the board's pre: mono, the panel's scroll container). */
const PRE: CSSProperties = {
  margin: 0,
  flexGrow: 1,
  minHeight: 140,
  boxSizing: 'border-box',
  padding: '12px 14px',
  border: '1px solid var(--txr-border-subtle)',
  borderRadius: 8,
  background: 'var(--txr-surface)',
  fontFamily: "'Source Code Pro', ui-monospace, monospace",
  fontSize: 12,
  lineHeight: 1.6,
  color: 'var(--txr-text-2)',
  whiteSpace: 'pre-wrap',
  overflowY: 'auto',
}

/** The 'Showing N of M lines' count (the capped tail's honest count line). */
const COUNT: CSSProperties = { fontSize: 12, color: 'var(--txr-muted)' }

/** The follow/copy row (the board's footer row — qa-fixes4 ITEM-3,
 *  R3-methods-6: the controls sit DIRECTLY ABOVE the lines box, so a
 *  bounded panel always keeps them in view; the board's below-the-pre
 *  placement is what left them 3,621 px down a 6,759 px pre). */
const FOOTER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 10,
  fontSize: 13,
  color: 'var(--txr-text-2)',
}

const COPY: CSSProperties = { fontSize: 13, padding: '2px 4px' }

export interface TxrLogPanelProps {
  /** The run store's live tail (capped, seq-sorted — the store's own bound). */
  lines: readonly TxrRunLogLine[]
  /** The run's engine line count (the detail's `log_lines`; the count line's total). */
  total: number
  /** The run's method rows (the option set — GROWN, DRIFT-1 ITEM-11). */
  methods: readonly TxrLogMethodRef[]
  /** The panel's method filter; `null` = all methods. */
  filter: string | null
  /** The option pick (the host's `setLogFilter` — the store's frozen action). */
  onFilter: (methodId: string | null) => void
  /** The follow switch's state (the store's `logFollow`). */
  follow: boolean
  /** The follow switch's report (the host's `setLogFollow`). */
  onFollow: (follow: boolean) => void
  /** The panel's visibility (the page mounts it only when open). */
  open: boolean
  /** The Hide control's report (the host's `setLogOpen`). */
  onOpenChange: (open: boolean) => void
  /** The backfill hook — GROWN (DRIFT-1 ITEM-11): the history fetch on
   *  open and on a method switch (the host's `TxrRun.loadLogs`, the
   *  CONS-UI-RUN-10 consume; the sibling G dialog owns its own). */
  onBackfill: (methodId: string | null) => void
}

export function TxrLogPanel({
  lines,
  total,
  methods,
  filter,
  onFilter,
  follow,
  onFollow,
  open,
  onOpenChange,
  onBackfill,
}: TxrLogPanelProps) {
  const preRef = useRef<HTMLPreElement>(null)
  // R2-5: the setlocale / R start-up noise is HIDDEN by default — a log that
  // opens with one warning per method hides the run's own lines. The switch
  // is the panel's presentation preference (the lines stay in the store; the
  // copy button copies the VIEW, so "Show technical output" on makes the
  // paste include them too).
  const [showTechnical, setShowTechnical] = useState(false)

  const filtered = filterLogLines(lines, filter)
  const visible = showTechnical ? filtered : filtered.filter(l => !isTechnicalLogNoise(l))
  const hiddenTechnical = filtered.length - visible.length
  // R3-methods-5: the repeated blocks are collapsed BEFORE the render cap,
  // so a twice-printed 3-line warning occupies one block and never pushes
  // the run's own lines out of the box.
  const collapsed = collapseRepeatedLines(visible)
  const rendered = collapsed.slice(-LOG_PANEL_RENDER_CAP)
  const shownRaw = rendered.reduce((n, entry) => n + entry.count, 0)
  // The raw lines the collapse folded out of the rendered view (a 3-line
  // block printed twice = 3 entries showing 6 raw lines → 3 absorbed).
  const repeatedRaw = shownRaw - rendered.length
  const text =
    rendered.length > 0
      ? rendered
          .map(entry => formatCollapsedLogLine(entry, methods))
          .join('\n')
      : null

  // Backfill history on open and on a method switch (the store's loadLogs
  // merges by seq — a re-open continues, a first open starts at the page).
  useEffect(() => {
    if (!open) return
    onBackfill(filter)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the backfill is
    // keyed on the OPEN/METHOD transition exactly (the sibling dialog's rule).
  }, [open, filter])

  // Follow the newest line (the JobDetail log idiom: pin on the raw line
  // count — a stream that appends one more copy of a repeated block grows
  // the run's count, not the collapsed entry count).
  useEffect(() => {
    const el = preRef.current
    if (el !== null && follow) el.scrollTop = el.scrollHeight
  }, [shownRaw, follow])

  const copyLog = (): void => {
    if (text === null) return
    void navigator.clipboard
      ?.writeText(text)
      .then(() => message.success('Log copied to clipboard'))
      .catch(() => {
        /* a blocked clipboard keeps the visible text selectable — no crash */
      })
  }

  return (
    <aside data-testid="txr-run-log" style={ASIDE}>
      <div style={HEAD_ROW}>
        <h2 style={HEADING}>Log</h2>
        <span style={SPACER} />
        <Button
          data-testid="txr-run-log-close"
          variant="link"
          style={CLOSE}
          onClick={() => onOpenChange(false)}
        >
          Hide
        </Button>
      </div>
      <div data-testid="txr-run-log-filters" style={FILTER_ROW}>
        <span style={FILTER_LABEL}>Show the log of</span>
        <div style={SELECT}>
          <Select
            data-testid="txr-run-log-filter"
            aria-label="Show the log of"
            size="sm"
            options={[
              { value: 'all', label: 'All methods' },
              ...methods.map(m => ({ value: m.method_id, label: m.label })),
            ]}
            value={filter ?? 'all'}
            onValueChange={value => onFilter(value === 'all' ? null : value)}
          />
        </div>
      </div>
      {/* qa-fixes4 ITEM-3 (R3-methods-6): the controls row sits DIRECTLY
          ABOVE the lines box — the filter, the technical switch, follow and
          copy are all in view, whatever the panel's height; the board's
          below-the-pre row is what left them 3,621 px down a 6,759 px pre. */}
      <div data-testid="txr-run-log-controls" style={FOOTER}>
        <Switch
          data-testid="txr-run-log-technical"
          aria-label="Show technical output"
          checked={showTechnical}
          onCheckedChange={setShowTechnical}
        />
        <span>Show technical output</span>
        <span style={SPACER} />
        <Switch
          data-testid="txr-run-log-follow"
          aria-label="Follow the newest line"
          checked={follow}
          onCheckedChange={onFollow}
        />
        <span>Follow the newest line</span>
        <span style={SPACER} />
        <Button
          data-testid="txr-run-log-copy"
          variant="link"
          style={COPY}
          disabled={text === null}
          onClick={copyLog}
        >
          Copy the log
        </Button>
      </div>
      <pre ref={preRef} data-testid="txr-run-log-lines" style={PRE}>
        {text ?? (filter === null ? LOG_EMPTY_ALL : LOG_EMPTY_METHOD)}
      </pre>
      {total > 0 ? (
        <div data-testid="txr-run-log-count" style={COUNT}>
          Showing {shownRaw} of {total} lines
          {!showTechnical && hiddenTechnical > 0 ? (
            <span data-testid="txr-run-log-technical-count">
              {' · '}
              {hiddenTechnical} start-up lines hidden
            </span>
          ) : null}
          {repeatedRaw > 0 ? (
            <span data-testid="txr-run-log-repeated-count">
              {' · '}
              {repeatedRaw} repeated lines collapsed
            </span>
          ) : null}
        </div>
      ) : null}
    </aside>
  )
}
