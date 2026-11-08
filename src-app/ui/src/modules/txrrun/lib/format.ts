/**
 * txrrun board copy + state vocabulary (PROV-UI-RUN-2).
 *
 * Screen F's per-method line renders three facts the engine already
 * structured (PROV-EE-3's `TxrRunMethod`): the state (its chip label and
 * tone), the detail line, and the elapsed/left texts. The functions below
 * are the module's board copy layer — structured engine facts in, the
 * boards' bytes out (`Busy.dc.html`, `BusyRunning.dc.html` and the run
 * screens' shared copy), with no client-side timing or byte math beyond
 * what a display string needs (INV-4: the estimate text is the engine's
 * own; nothing here re-derives a schedule).
 *
 * Board copy rules that shape this file:
 *
 * - every state yields a constant label and tone — the tables below are
 *   the whole vocabulary, and no state may render blank (the chip is the
 *   row's first fact; INV-2's "failure kept with its reason" is the
 *   detail line);
 * - the time texts are the board's words: exact durations read whole
 *   minutes and seconds, anything under a minute reads "under a minute",
 *   and the time-left line reads "about N minutes left" (announced as
 *   about); a whole-minute duration reads the minutes only;
 * - the download line reads "N of M MB" — `bytes_downloaded` /
 *   `bytes_total` are byte counters, the display unit is MB (the boards'
 *   download lines), and a null total renders the bytes only;
 * - the research notice is ONE constant, whatever the screen: the E
 *   bottom bar takes it through the shared list's `notice` slot and F
 *   renders it as its header caption (DEC-11 — one string, both run
 *   screens; FLOW.md's "Research-use notice on every run screen").
 *
 * Never blank: the bucket function is a complete partition of the state
 * vocabulary and its fallback bucket (a state a future regen adds between
 * regens) is a constant; a failed/cannot-run row whose reason the engine
 * did not record renders a constant line, never empty detail.
 *
 * The boards' example facts (patient counts, elapsed figures) are design
 * examples, never data (INV-6): this file formats whatever the engine
 * sends — the exact bytes above come from the run rows and frames.
 */
import type {
  TxrMethodState,
  TxrRunLogLine,
  TxrRunMethod,
  TxrRunProgressFrame,
} from '@/api-client/types'
import type { TxrRunBucket } from '../types'

/**
 * The F screens' per-state chip label (board casing: the state word lower
 * case — the counts strip's "waiting", the row's "cannot run").
 */
export const STATE_LABEL: Record<TxrMethodState, string> = {
  waiting: 'waiting',
  downloading: 'downloading',
  running: 'running',
  finished: 'finished',
  failed: 'failed',
  stopped: 'stopped',
  skipped: 'skipped',
  cannot_run: 'cannot run',
}

/**
 * The F screens' per-state chip tone — the shared list's status palette,
 * in the boards' own hex: neutral `#5e5e5e` (waiting, stopped, skipped —
 * nothing is happening and nothing went wrong), the work colours
 * `#8a5a00` (downloading) / `#143a68` (running), the done green `#1f6b3a`
 * and the `#b3261e` failure red (failed / cannot run — INV-2 keeps the
 * failure visible).
 */
export const STATE_TONE: Record<TxrMethodState, string> = {
  waiting: '#5e5e5e',
  downloading: '#8a5a00',
  running: '#143a68',
  finished: '#1f6b3a',
  failed: '#b3261e',
  stopped: '#5e5e5e',
  skipped: '#5e5e5e',
  cannot_run: '#b3261e',
}

/**
 * The research-use notice (the run screens' shared copy — DEC-11). One
 * constant, the boards' bytes verbatim; E hosts it through the shared
 * list's bar and F renders it as its header caption.
 */
export const RESEARCH_NOTICE = "For research. Not for deciding a patient's treatment."

/**
 * Screen F's leave-and-continue note (the board's footer words, verbatim —
 * INV-2's "the run continues, and it stays in History"): one constant, the
 * page's own wiring renders it under the method table, always (a live run
 * and a completed one both read it; running continues when the user leaves).
 */
export const LEAVE_AND_CONTINUE_NOTE =
  'Finished methods keep their results. You can leave this screen: the run continues, and it stays in History.'

/**
 * The F tabs' state partition (DEC-2): All = every row; Working =
 * waiting/downloading/running (a method is doing or will do something);
 * Finished = finished/stopped/skipped (a terminal, non-error row — a
 * user-stopped method is never called a failure); Failed = failed /
 * cannot run. A complete partition of the engine's eight states.
 *
 * A state outside the vocabulary (a regen between regens) falls to
 * Working — the live bucket — never to a blank or a miscounted tab.
 */
export function bucketOf(state: TxrMethodState): Exclude<TxrRunBucket, 'all'> {
  switch (state) {
    case 'waiting':
    case 'downloading':
    case 'running':
      return 'working'
    case 'finished':
    case 'stopped':
    case 'skipped':
      return 'finished'
    case 'failed':
    case 'cannot_run':
      return 'failed'
  }
  // Exhaustive over TxrMethodState (a state added to the engine's union
  // fails THIS line at typecheck until this switch handles it — the
  // partition may never silently drop a state).
  const _unreachable: never = state
  return 'working'
}

/**
 * An exact duration in the board's words (whole minutes and seconds), a
 * whole-number minute reading as the minutes only, and anything under a
 * minute reading "under a minute". `null` (no duration yet) and
 * non-finite/negative spans (clock skew must not print) render the
 * constant "—".
 */
export function formatSecs(secs: number | null): string {
  if (secs === null || !Number.isFinite(secs) || secs < 0) return '—'
  if (secs < 60) return 'under a minute'
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return s === 0 ? `${m} min` : `${m} min ${s} s`
}

/**
 * The F header's time-left line (DEC-3): the run's own create-time
 * estimate minus the elapsed seconds (a missing elapsed counts as 0 — a
 * just-started run), floored at 0 (an overrun never reads negative),
 * rounded to whole minutes and announced as "about" — the estimate is the
 * engine's packed schedule, never re-computed here (INV-4). A `null`
 * estimate (the run carries none — a provider failure / an empty queued
 * set; PROV-EE-3) → `null`, so the header omits the segment entirely
 * rather than fabricating a zero.
 */
export function formatTimeLeft(
  estimate: { schedule_seconds: number } | null,
  elapsedSecs: number | null,
): string | null {
  if (estimate === null) return null
  const remaining = Math.max(0, estimate.schedule_seconds - (elapsedSecs ?? 0))
  if (remaining < 60) return 'under a minute left'
  const minutes = Math.round(remaining / 60)
  return `about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left`
}

/** One megabyte, as the boards' "MB" unit is applied to the byte counters. */
const MB = 1024 * 1024

/** Bytes → the boards' "N of M MB" line, or "N MB" when the total is null. */
export function formatBytes(done: number, total: number | null): string {
  const doneMb = Math.round(done / MB)
  if (total === null) return `${doneMb} MB`
  return `${doneMb} of ${Math.round(total / MB)} MB`
}

/**
 * The F row's detail line, state by state:
 *
 * - downloading → the download line (`formatBytes` over the row's
 *   counters — the board's download rows);
 * - running → the latest message the engine pushed (the frame's own
 *   words, never re-derived; a run between messages renders empty, the
 *   bar carries the row);
 * - failed / cannot run → the engine's reason line; a row the engine did
 *   not record a reason for renders the constant "no reason recorded" —
 *   a failure is never blank (INV-2);
 * - finished / stopped / skipped → empty (the state chip + time columns
 *   carry these rows; the engine lines are in the log panel).
 */
export function formatProgress(r: TxrRunMethod, progress: TxrRunProgressFrame | null): string {
  switch (r.state) {
    case 'downloading':
      return formatBytes(r.bytes_downloaded, r.bytes_total ?? null)
    case 'running':
      return progress?.message ?? ''
    case 'failed':
    case 'cannot_run':
      return r.reason?.detail ?? 'no reason recorded'
    default:
      return ''
  }
}

/**
 * The F row's TIME column — the row's own timing sentence (the board's
 * per-row Time column): a running row reads its elapsed ("1 min 40 s"), a
 * completed row reads "done in M min S s" (the board's log line's words at
 * the row's own duration, `duration_ms`), and a failed / cannot-run row
 * reads its elapsed (the board's "5 s"). Waiting and downloading rows read
 * nothing: the engine contracts a per-row estimate nowhere — the header's
 * time-left line carries the schedule (DEC-3) and the board's per-row
 * "about 1 min" facts are design examples, never data (INV-6) — so an empty
 * empty column is the honest reading, never an invented duration.
 *
 * The absent tests are `== null` (NOT `=== undefined`): the engine's
 * `Option` counters serialize their absent value as JSON `null` while the
 * generated types render them optional-only (the qa-fixes RES-01
 * null-vs-undefined rule) — a `duration_ms: null` wire value must read an
 * empty cell, never "done in —".
 */
export function formatRowTime(r: TxrRunMethod): string {
  switch (r.state) {
    case 'running':
    case 'failed':
    case 'cannot_run':
      return r.elapsed_secs == null ? '' : formatSecs(r.elapsed_secs)
    case 'finished':
    case 'stopped':
    case 'skipped':
      return r.duration_ms == null
        ? ''
        : `done in ${formatSecs(r.duration_ms / 1000)}`
    default:
      return ''
  }
}

/**
 * The F row's progress-bar value (0–100): a finished row reads 100 (the
 * work is done — the board's completed bar), a failed row reads 100 (it
 * ran to its end — the board's failure bar; its reason is the detail
 * line), a cannot-run row reads 0 (nothing ran; its slot is a note, not a
 * bar), a waiting row reads 0 (the board's own empty bar), and an
 * active/stopped/skipped row reads the latest live progress frame's
 * `pct`, the row's own `progress_pct` (the env download's ratio) when no
 * frame arrived, and 0 when neither — a stopped/skipped row keeps the
 * progress it reached, never a fabricated 100 (it did not complete).
 */
export function formatBarValue(r: TxrRunMethod, progress: TxrRunProgressFrame | null): number {
  switch (r.state) {
    case 'finished':
    case 'failed':
      return 100
    case 'cannot_run':
    case 'waiting':
      return 0
    default: {
      const pct = progress?.pct ?? r.progress_pct ?? 0
      return Math.max(0, Math.min(100, pct))
    }
  }
}

/** The run's method rows — the F log panel's chip/label surface (the id
 *  in the engine's line, the label in the board's log lines). */
export type TxrLogMethodRef = Readonly<Pick<TxrRunMethod, 'method_id' | 'label'>>

/**
 * The F log panel's line-time formatter (the board's clock "10:02:12" —
 * the local wall clock of the machine that ran the method, `created_at`
 * as the engine stamped it; a line the store cannot parse reads the
 * "—" place the module uses for an absent fact, never a crash).
 */
export function formatLogTime(createdAt: string): string {
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * The method segment of one log line: the run's method LABEL (the board's
 * "[dynforest]" — the catalogue display name the method row itself uses),
 * the raw method id for a line whose method is not in this run's rows (a
 * provider line for a dropped method — the id stays visible, never a blank
 * bracket), and the line's own STREAM for an engine-level line without a
 * method (`method_id` absent — the whole-run view's own facts, the
 * sibling G screen's log dialog treats them the same way). The absent
 * test is `== null`: the engine's `Option` emits JSON `null` where the
 * generated type claims a missing property (the RES-01 null-vs-undefined
 * rule) — a `null` method id is an engine-level line, never a "[null]"
 * bracket.
 */
export function methodLabelOf(line: TxrRunLogLine, methods: ReadonlyArray<TxrLogMethodRef>): string {
  if (line.method_id == null) return line.stream
  const method = methods.find(m => m.method_id === line.method_id)
  return method?.label ?? line.method_id
}

/**
 * One paste line in the board's words: the clock, the method segment, the
 * engine's content — the boards' own line shape ("10:02:12 [dynforest]
 * fitting the model" class; the exact content is the engine's, never a
 * board example). Display and "Copy the log" share this one formatter
 * (what the user sees is what the clipboard gets).
 */
export function formatLogLine(line: TxrRunLogLine, methods: ReadonlyArray<TxrLogMethodRef>): string {
  return `${formatLogTime(line.created_at)} [${methodLabelOf(line, methods)}] ${line.content}`
}

/** The copy text: the lines joined the way a log file reads (the board's
 *  one line per entry; the plan's TEST-RUN-22 bytes). */
export function formatLogText(
  lines: readonly TxrRunLogLine[],
  methods: ReadonlyArray<TxrLogMethodRef>,
): string {
  return lines.map(line => formatLogLine(line, methods)).join('\n')
}

/**
 * The F log panel's method filter: `null` = every line (the "All methods"
 * view, including the engine-level lines that name no method), a method id
 * = that method's lines only (the sibling G screen's log dialog's rule: an
 * engine-level line belongs to the whole-run view, never to a method it
 * did not name — a method's own lines are always attributed to it).
 */
export function filterLogLines(
  lines: readonly TxrRunLogLine[],
  methodId: string | null,
): TxrRunLogLine[] {
  if (methodId === null) return [...lines]
  return lines.filter(line => line.method_id === methodId)
}
