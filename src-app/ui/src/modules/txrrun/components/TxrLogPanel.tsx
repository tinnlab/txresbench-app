/**
 * TxrLogPanel — screen F's right-hand log column (ITEM-11, board
 * `BusyRunning.dc.html`'s Log section): the "All methods" + one-chip-per-
 * method filter (the board's select rendered as the module's pill chips —
 * the same kit `Button` pills the F tabs use), the live lines (the run
 * store's `liveLogs` tail, the board's `HH:MM:SS [method] content` bytes
 * via `lib/format.ts`'s one line formatter — the engine's `content` is
 * rendered end to end, timestamp bracketed and method labelled, never
 * re-worded), "Follow the newest line" (kit `Switch` — the scroll pins to
 * the newest line while it is on, the JobDetail log idiom) and "Copy the
 * log" (the same formatter joined for the clipboard — display and copy are
 * one text, what the user sees is what the paste gets).
 *
 * Ownership per the frozen props: the panel reads ONLY its props (the
 * store's `liveLogs`/`logTotal`/`logFilter`/`logFollow`/`logOpen` flow
 * through the page) and reports the user's intentions (`onFilter` /
 * `onFollow` / `onOpenChange` for the Hide control; `onBackfill` for the
 * pre-SSE history — the page owns the store call, the CONS-UI-RUN-10
 * consume, so the panel never imports the store). The two GROWN slots are
 * recorded (DRIFT-1 ITEM-11): `methods` — "one per run method" (TEST-RUN-22)
 * is the run's ROWS, and the frozen props list carried no method list, a
 * panel that derives chips from the lines' occurrences would miss a method
 * whose engine lines never arrived (a `waiting` row has none); and the
 * backfill hook — a panel that never asked for history would show only the
 * live tail, and the store's `loadLogs` is exactly the provider surface
 * (CONS-UI-RUN-10's "the log panel's backfill"). The frozen `onCopy` host
 * callback is NOT taken: copy is the panel's own pure client behaviour (the
 * plan's own audit line), the copied text is the panel's CURRENT filtered
 * view, and TEST-RUN-22 pins the clipboard write in the panel's own test —
 * the sibling G screen's log dialog owns its clipboard the same way.
 *
 * The rendered lines are capped at 200 (`RENDER_CAP`) with the count shown
 * — the store's tail is the same bound (TEST-RUN-10's LIVE_LOGS_CAP), the
 * cap at the paint site is the defensive half a panel that is handed a
 * longer list cannot rely on the store for.
 *
 * The unread badge (plate prose: "a logUnread count on the filter chip"):
 * the panel keeps a per-key SEEN watermark (the newest seq its own render
 * painted under that key — the All view marks every method, a method view
 * marks only that method), seeded at mount so lines that arrived before the
 * panel opened never count; a chip's badge is the count of the key's lines
 * newer than the watermark — new lines for a method you are not watching
 * are visible on its chip before you switch to it. Only lines the panel
 * itself painted are "read"; nothing is ever refetched to count.
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Button, Switch, message } from '@ziee/kit'
import type { TxrRunLogLine } from '@/api-client/types'
import {
  filterLogLines,
  formatLogText,
  type TxrLogMethodRef,
} from '../lib/format'

/** The panel's own render cap (the store's tail bound is the same number). */
export const LOG_PANEL_RENDER_CAP = 200

/** The board's aside look (right column, tinted, hairline left rule). */
const ASIDE: CSSProperties = {
  flex: '2 1 380px',
  minWidth: 0,
  boxSizing: 'border-box',
  padding: '26px 28px',
  background: '#fbfaf8',
  borderLeft: '1px solid #e7e5e0',
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
  color: '#3a3a3a',
}

const SPACER: CSSProperties = { flexGrow: 1 }

const CLOSE: CSSProperties = { fontSize: 13, padding: '2px 4px' }

/** The filter chips' row (the board's select slot; the module's pill idiom). */
const CHIP_ROW: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  alignItems: 'center',
}

const CHIP = {
  borderRadius: 999,
  padding: '4px 10px',
  fontSize: 12.5,
  background: '#ffffff',
  color: '#3a3a3a',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: '#cfcdc7',
} as const

const ACTIVE_CHIP = {
  ...CHIP,
  background: '#e8eef6',
  color: '#143a68',
  borderColor: '#1d4e89',
} as const

/** The chip's unread badge (new lines for a method the panel is not showing). */
const UNREAD_BADGE: CSSProperties = {
  color: '#b3261e',
  fontWeight: 700,
  marginLeft: 5,
}

/** The lines box (the board's pre: mono, the panel's scroll container). */
const PRE: CSSProperties = {
  margin: 0,
  flexGrow: 1,
  minHeight: 140,
  boxSizing: 'border-box',
  padding: '12px 14px',
  border: '1px solid #e7e5e0',
  borderRadius: 8,
  background: '#ffffff',
  fontFamily: "'Source Code Pro', ui-monospace, monospace",
  fontSize: 12,
  lineHeight: 1.6,
  color: '#3a3a3a',
  whiteSpace: 'pre-wrap',
  overflowY: 'auto',
}

/** The 'Showing N of M lines' count (the capped tail's honest count line). */
const COUNT: CSSProperties = { fontSize: 12, color: '#5e5e5e' }

/** The follow/copy row (the board's footer row). */
const FOOTER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  fontSize: 13,
  color: '#3a3a3a',
}

const COPY: CSSProperties = { fontSize: 13, padding: '2px 4px' }

export interface TxrLogPanelProps {
  /** The run store's live tail (capped, seq-sorted — the store's own bound). */
  lines: readonly TxrRunLogLine[]
  /** The run's engine line count (the detail's `log_lines`; the count line's total). */
  total: number
  /** The run's method rows (the chip set — GROWN, DRIFT-1 ITEM-11). */
  methods: readonly TxrLogMethodRef[]
  /** The panel's method filter; `null` = all methods. */
  filter: string | null
  /** The chip pick (the host's `setLogFilter` — the store's frozen action). */
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

/**
 * The per-key seen watermark after painting `rendered` under `filter`: the
 * All view paints every method's lines (each is seen), a method view paints
 * only its own — the waiting/other methods' lines stay unread. Returns the
 * previous record unchanged when nothing moved (the state setter's bail-out
 * keeps the post-paint mark from re-rendering forever).
 */
function markSeen(
  rendered: readonly TxrRunLogLine[],
  filter: string | null,
  prev: Record<string, number>,
): Record<string, number> {
  let changed = false
  const next = { ...prev }
  const bump = (key: string, seq: number): void => {
    if (seq > (next[key] ?? -1)) {
      next[key] = seq
      changed = true
    }
  }
  for (const line of rendered) {
    bump(filter ?? 'all', line.seq)
    if (filter === null && line.method_id !== undefined) bump(line.method_id, line.seq)
  }
  return changed ? next : prev
}

/** The newest seq of a key's lines (the seed's per-key watermark). */
function maxSeqOf(lines: readonly TxrRunLogLine[]): number {
  let max = -1
  for (const line of lines) if (line.seq > max) max = line.seq
  return max
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
  // The per-key seen watermark, seeded at mount with the lines that already
  // existed: lines that arrived before the panel opened are history, never
  // unread (a first paint must not badge the whole tail).
  const [seen, setSeen] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = { all: maxSeqOf(lines) }
    for (const method of methods) {
      initial[method.method_id] = maxSeqOf(filterLogLines(lines, method.method_id))
    }
    return initial
  })

  const filtered = filterLogLines(lines, filter)
  const rendered = filtered.slice(-LOG_PANEL_RENDER_CAP)
  const text = formatLogText(rendered, methods)

  // Mark the painted lines seen (after paint — a line that renders is read).
  useEffect(() => {
    setSeen(prev => markSeen(rendered, filter, prev))
  })

  // Backfill history on open and on a method switch (the store's loadLogs
  // merges by seq — a re-open continues, a first open starts at the page).
  useEffect(() => {
    if (!open) return
    onBackfill(filter)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the backfill is
    // keyed on the OPEN/METHOD transition exactly (the sibling dialog's rule).
  }, [open, filter])

  // Follow the newest line (the JobDetail log idiom: pin on the line count;
  // turning follow on pins immediately with the current tail).
  useEffect(() => {
    const el = preRef.current
    if (el !== null && follow) el.scrollTop = el.scrollHeight
  }, [rendered.length, follow])

  const copyLog = (): void => {
    if (text.length === 0) return
    void navigator.clipboard
      ?.writeText(text)
      .then(() => message.success('Log copied to clipboard'))
      .catch(() => {
        /* a blocked clipboard keeps the visible text selectable — no crash */
      })
  }

  const unreadOf = (id: string | null): number => {
    const watermark = seen[id ?? 'all'] ?? -1
    const keyLines = id === null ? lines : filterLogLines(lines, id)
    let unread = 0
    for (const line of keyLines) if (line.seq > watermark) unread += 1
    return unread
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
      <div data-testid="txr-run-log-filters" style={CHIP_ROW}>
        <Button
          data-testid="txr-run-log-filter-all"
          variant="outline"
          className="rounded-full font-normal"
          style={filter === null ? ACTIVE_CHIP : CHIP}
          aria-pressed={filter === null}
          onClick={() => onFilter(null)}
        >
          All methods
          {unreadOf(null) > 0 ? (
            <span data-testid="txr-run-log-unread-all" style={UNREAD_BADGE}>
              {unreadOf(null)}
            </span>
          ) : null}
        </Button>
        {methods.map(method => {
          const active = filter === method.method_id
          const unread = unreadOf(method.method_id)
          return (
            <Button
              key={method.method_id}
              data-testid={`txr-run-log-filter-${method.method_id}`}
              variant="outline"
              className="rounded-full font-normal"
              style={active ? ACTIVE_CHIP : CHIP}
              aria-pressed={active}
              onClick={() => onFilter(method.method_id)}
            >
              {method.label}
              {unread > 0 ? (
                <span
                  data-testid={`txr-run-log-unread-${method.method_id}`}
                  style={UNREAD_BADGE}
                >
                  {unread}
                </span>
              ) : null}
            </Button>
          )
        })}
      </div>
      <pre ref={preRef} data-testid="txr-run-log-lines" style={PRE}>
        {text}
      </pre>
      {total > 0 ? (
        <div data-testid="txr-run-log-count" style={COUNT}>
          Showing {rendered.length} of {total} lines
        </div>
      ) : null}
      <div data-testid="txr-run-log-controls" style={FOOTER}>
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
          disabled={rendered.length === 0}
          onClick={copyLog}
        >
          Copy the log
        </Button>
      </div>
    </aside>
  )
}
