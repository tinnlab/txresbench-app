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
 *   minutes and seconds — a sub-minute span reads its whole seconds
 *   ("12 s"; qa-fixes2 R2-2/R2-4 — "under a minute" was a display
 *   segment that never moved on a sub-minute run), the time-left line
 *   reads "about N minutes left" (announced as about; a sub-minute
 *   remainder reads "under a minute left" — the estimate is a rough
 *   promise); a whole-minute duration reads the minutes only;
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
  TimingQuality,
} from '@/api-client/types'
import { safeText } from '@/modules/txrshell/lib/safeText'
// The ONE env-missing sentence (the list's CM-1 wording — R3-methods-9).
import { NO_PUBLISHED_ENVIRONMENT_REASON } from '@/modules/txrlist/lib/format'
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
 * in the boards' own hex: neutral `var(--txr-muted)` (waiting, stopped, skipped —
 * nothing is happening and nothing went wrong), the work colours
 * `var(--txr-warning)` (downloading) / `var(--txr-brand-ink)` (running), the done green `var(--txr-success)`
 * and the `var(--txr-danger)` failure red (failed / cannot run — INV-2 keeps the
 * failure visible).
 */
export const STATE_TONE: Record<TxrMethodState, string> = {
  waiting: 'var(--txr-muted)',
  downloading: 'var(--txr-warning)',
  running: 'var(--txr-brand-ink)',
  finished: 'var(--txr-success)',
  failed: 'var(--txr-danger)',
  stopped: 'var(--txr-muted)',
  skipped: 'var(--txr-muted)',
  cannot_run: 'var(--txr-danger)',
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
 * The F tabs' state partition (qa-fixes ITEM-3, RP-3): All = every row;
 * Working = waiting/downloading/running (a method is doing or will do
 * something); Finished = finished; Failed = failed; Stopped = stopped;
 * Skipped = skipped; Cannot run = cannot run — the terminal states keep
 * their own state word, one bucket per state, so a skipped method is
 * never counted as finished (and a cannot-run method never as failed) and
 * every tab's count equals that state's own count in the strip. A
 * complete partition of the engine's eight states.
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
      return 'finished'
    case 'failed':
      return 'failed'
    case 'stopped':
      return 'stopped'
    case 'skipped':
      return 'skipped'
    case 'cannot_run':
      return 'cannot_run'
  }
  // Exhaustive over TxrMethodState (a state added to the engine's union
  // fails THIS line at typecheck until this switch handles it — the
  // partition may never silently drop a state).
  const _unreachable: never = state
  return 'working'
}

/**
 * An exact duration in the board's words (whole minutes and seconds), a
 * whole-number minute reading as the minutes only, and a sub-minute span
 * reading its whole seconds ("12 s" — qa-fixes2 R2-2/R2-4: "under a
 * minute" was a fact that never moved on a sub-minute run, so the Time
 * column and the header elapsed read the exact seconds; the ~1 s floor
 * keeps a just-started row from running off the left edge of a second).
 * `null` (no duration yet) and non-finite/negative spans (clock skew must
 * not print) render the constant "—".
 */
export function formatSecs(secs: number | null): string {
  if (secs === null || !Number.isFinite(secs) || secs < 0) return '—'
  if (secs < 60) return `${Math.max(1, Math.round(secs))} s`
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return s === 0 ? `${m} min` : `${m} min ${s} s`
}

/**
 * The F header's time-left line (DEC-3): the run's own create-time
 * estimate minus the elapsed seconds (a missing elapsed counts as 0 — a
 * just-started run), announced as "about" — the estimate is the engine's
 * packed schedule, never re-computed here (INV-4). qa-fixes4 ITEM-3
 * (methods-r3 R2-2 leftover): the line is a REAL figure that counts down —
 * a sub-minute remainder reads its own seconds ("about 20 s left", never
 * the constant "under a minute left") and a run whose estimate's schedule
 * has fully elapsed reads "finishing up" (the overrun is the run's own
 * finalizing, no longer a promise of more work). A `null` estimate (the
 * run carries none — a provider failure / an empty queued set;
 * PROV-EE-3) → `null`, so the header omits the segment entirely rather
 * than fabricating a zero.
 */
export function formatTimeLeft(
  estimate: { schedule_seconds: number } | null,
  elapsedSecs: number | null,
): string | null {
  if (estimate === null) return null
  const remaining = estimate.schedule_seconds - (elapsedSecs ?? 0)
  if (remaining <= 0) return 'finishing up'
  if (remaining < 60) return `about ${Math.max(1, Math.round(remaining))} s left`
  const minutes = Math.round(remaining / 60)
  return `about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left`
}

/**
 * The estimate's honest provenance word (qa-fixes2 R2-3): the engine
 * reports each estimate as `measured` (real per-fold seconds — with the
 * app's calibration those are THIS app's own measured durations) or as an
 * `estimate` (the generated fallback facts). The header's time line
 * renders the word so an "about N minutes" number never claims more
 * precision than its source has. `null` (no quality fact — the run has no
 * estimate) renders no word.
 */
export function estimateQualityWord(quality: TimingQuality | null | undefined): string | null {
  if (quality === null || quality === undefined) return null
  return quality === 'measured' ? 'measured estimate' : 'rough estimate'
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
    case 'downloading': {
      // R2-4: a "downloading" row that has fetched NOTHING (no total, a
      // 0 total, or a total that rounds to 0 MB — the engine's cache-hit
      // env phase, `bytes_total` 4096) must not read the silly "0 of 0 MB":
      // the state chip carries the row, the detail line stays empty until a
      // real download exists.
      const total = r.bytes_total ?? null
      if (
        (r.bytes_downloaded ?? 0) === 0 &&
        (total === null || Math.round(total / MB) === 0)
      ) {
        return ''
      }
      return formatBytes(r.bytes_downloaded, total)
    }
    case 'running':
      // qa-fixes4 ITEM-1: the frame's message passes the UI-side `safeText`
      // guard too (a producer's path would never be rendered).
      return safeText(progress?.message ?? '')
    case 'failed':
    case 'cannot_run':
      // qa-fixes4 ITEM-3 (methods-r3 R3-methods-9): the reason CODE is the
      // one closed vocabulary and its fact has ONE sentence — an
      // `ENV_IMAGE_MISSING` row reads the list's "no published environment
      // available" (CM-1's plain reason), never the engine's stored
      // pre-vocabulary detail ("no published environment for method
      // <id>" — the same fact, two wordings). Any other code keeps the
      // engine's stored detail verbatim; a row the engine recorded no
      // reason for reads the constant below — a failure is never blank
      // (INV-2).
      if (r.reason?.code === 'ENV_IMAGE_MISSING') {
        return NO_PUBLISHED_ENVIRONMENT_REASON
      }
      return safeText(r.reason?.detail ?? 'no reason recorded')
    default:
      return ''
  }
}

/**
 * The F row's TIME column — the row's own timing sentence (the board's
 * per-row Time column): a running (or downloading) row reads its LIVE
 * elapsed — `nowMs` (the page's one-second clock; the server and the page
 * are the same machine, so the row's `started_at` is directly readable)
 * against the row's `started_at`, falling back to the row's last engine
 * `elapsed_secs` snapshot when the clock or the anchor is missing
 * (qa-fixes2 R2-4 — the column was empty during the run because the rows
 * only carry an engine snapshot, and a sub-minute run never saw one), a
 * completed row reads "done in M min S s" (the board's log line's words at
 * the row's own duration — qa-fixes4 ITEM-3, methods-r3 R3-methods-8: the
 * row reads the engine's `elapsed_secs` FIRST, the same seconds fact the
 * engine's own log line words, so the row cell and the log quote can never
 * disagree; `duration_ms` is the fallback for an old row the engine gave no
 * elapsed), a failed / cannot-run row reads its elapsed (the board's "5 s"),
 * and a stopped row reads the elapsed it
 * reached (it ran for a while before the user cleared it). A SKIPPED row
 * reads nothing: it never ran (qa-fixes ITEM-3, RP-7 — its "done in …"
 * was the engine's duration_ms of a row that never started). Waiting rows
 * read nothing: the row has no start yet and the engine contracts a
 * per-row estimate nowhere — the header's time-left line carries the
 * schedule (DEC-3) and the board's per-row "about 1 min" facts are design
 * examples, never data (INV-6) — so an empty column is the honest
 * reading, never an invented duration.
 *
 * The absent tests are `== null` (NOT `=== undefined`): the engine's
 * `Option` counters serialize their absent value as JSON `null` while the
 * generated types render them optional-only (the qa-fixes RES-01
 * null-vs-undefined rule) — a `duration_ms: null` wire value must read an
 * empty read, never "done in —".
 */
export function formatRowTime(r: TxrRunMethod, nowMs: number | null = null): string {
  switch (r.state) {
    case 'running':
    case 'downloading':
      if (r.started_at != null && nowMs !== null) {
        const start = Date.parse(r.started_at)
        if (Number.isFinite(start) && nowMs >= start) {
          return formatSecs((nowMs - start) / 1000)
        }
      }
      return r.elapsed_secs == null ? '' : formatSecs(r.elapsed_secs)
    case 'failed':
    case 'cannot_run':
    case 'stopped':
      return r.elapsed_secs == null ? '' : formatSecs(r.elapsed_secs)
    case 'finished':
      // R3-methods-8 (qa-fixes4 ITEM-3): the engine's own log line words the
      // method's seconds as its `elapsed_secs` ("done in 7s"), so the row
      // reads THAT fact first — the table read and the log quote are one
      // count. An old row whose engine record has no elapsed falls back to
      // `duration_ms` (the R2-4 pin's word).
      return r.elapsed_secs == null
        ? r.duration_ms == null
          ? ''
          : `done in ${formatSecs(r.duration_ms / 1000)}`
        : `done in ${formatSecs(r.elapsed_secs)}`
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
 * The F log panel's empty-state lines (qa-fixes ITEM-3, RP-4): the lines
 * area is never a blank box — the All view reads "No log lines yet." and a
 * method view reads "No log lines for this method." (the plain-voice rule;
 * the board's log is a filled example, an empty log is this app's real
 * state and its words are the report's own suggestion).
 */
export const LOG_EMPTY_ALL = 'No log lines yet.'
export const LOG_EMPTY_METHOD = 'No log lines for this method.'

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

/**
 * One entry of the panel's collapsed view (qa-fixes4 ITEM-3, methods-r3
 * R3-methods-5): a line shown once plus the repeat facts of the run it
 * belongs to.
 */
export interface TxrCollapsedLogLine {
  line: TxrRunLogLine
  /** The raw lines THIS entry stands for (a block each of whose lines
   *  printed `N` times; `1` = a single line) — the viewing count sums to
   *  the raw lines shown. */
  count: number
  /** The whole run's raw line count (the "×N" badge's N; 1 = no repeat). */
  runLength: number
  /** The entry is the run's FIRST line — the "×N" badge's place. */
  runStart: boolean
}

/** The two collision facts one repeated run must be identical on (a line's
 *  identity in the log is WHICH method printed it + WHAT it says — the
 *  same text from two methods is two log lines, not a repeat). */
function sameLogLine(a: TxrRunLogLine, b: TxrRunLogLine): boolean {
  return a.content === b.content && a.method_id === b.method_id
}

/**
 * The F log panel's repeated-line collapse (qa-fixes4 ITEM-3, methods-r3
 * R3-methods-5 — "repeat R warnings are collapsed into 'x6'"): a maximal
 * run of lines that is one short sequence printed again (the engine's R
 * methods print the identical 3-line `colClasses` warning block twice or
 * three times; a line can also repeat verbatim) renders ONCE — the run's
 * last line carries the "×N" marker with N = the run's raw line count, so
 * a twice-printed 3-line warning reads its block once and ends in "×6"
 * and a line printed six times reads "×6" too.
 *
 * The period chosen is the one whose repeated run is LONGEST (a
 * `A,A,B,A,A,B` stream is the (A,A,B) block, never A,A-then-standalone),
 * so a run never fragments into a smaller coincidence; a line with no
 * repeat is a plain entry. The collapse is a VIEW presentation: the engine's
 * raw lines stay in the store, in `total` and in the copy's own facts —
 * what is folded is the reading, not the log.
 */
export function collapseRepeatedLines(lines: readonly TxrRunLogLine[]): TxrCollapsedLogLine[] {
  const out: TxrCollapsedLogLine[] = []
  let i = 0
  while (i < lines.length) {
    // The longest run from i that repeats its own prefix (the smallest
    // period that ties). Periodicity is checked position by position — a
    // run is a repetition only when EVERY position agrees with its
    // p-ago twin, so a [A,A,A,B] stream never claims the A-run for p=2
    // (A,A vs A,B) even though its first pair matches.
    let bestLen = 1
    let bestPeriod = 1
    for (let p = 1; p * 2 <= lines.length - i; p += 1) {
      let k = 0
      while (i + k < lines.length && sameLogLine(lines[i + (k % p)], lines[i + k])) {
        k += 1
      }
      const repeat = Math.floor(k / p) * p
      if (repeat >= 2 * p && (repeat > bestLen || (repeat === bestLen && p < bestPeriod))) {
        bestLen = repeat
        bestPeriod = p
      }
    }
    if (bestLen === 1) {
      out.push({ line: lines[i], count: 1, runLength: 1, runStart: false })
      i += 1
      continue
    }
    const repeat = bestLen / bestPeriod
    for (let k = 0; k < bestPeriod; k += 1) {
      out.push({ line: lines[i + k], count: repeat, runLength: bestLen, runStart: k === 0 })
    }
    i += bestLen
  }
  return out
}

/** One line of the panel's COLLAPSED view: the board's line shape + the
 *  repeated run's "×N" badge on the run's first line — the SAME text the
 *  copy writes (the collapse is a view presentation: what the user sees is
 *  what the paste gets, exactly like the technical filter). */
export function formatCollapsedLogLine(
  entry: TxrCollapsedLogLine,
  methods: ReadonlyArray<TxrLogMethodRef>,
): string {
  const base = formatLogLine(entry.line, methods)
  return entry.runStart && entry.runLength > 1 ? `${base} ×${entry.runLength}` : base
}
