/**
 * txrhistory board copy + formatters (PROV-HIST-4, DEC-9) — screen K's
 * display words, pure functions, no metrics or coverage math.
 *
 * The K module owns its display formatters deliberately: the K duration WORD
 * form (spelled-out minutes and seconds, the board's "Took" line) and the
 * F screen's compact `formatSecs` ("4 min 40 s") are DIFFERENT board
 * strings and are not shared (DEC-9) — one formatter would have to pick a
 * display contract; the phase-6 affordance-parity audit checks the
 * divergence on purpose. The reason strings, method ids, versions, counts
 * and durations are NEVER re-authored here: the provider records pass
 * through verbatim (INV-3, TEST-HIST-5) and the boards' example facts
 * (run counts, patient counts, sizes, durations) are design examples,
 * never constants in code (INV-6) — the formatters render whatever the
 * run records carry.
 *
 * Board rules that shape this file:
 *
 * - durations spell out whole minutes and seconds (the board's long
 *   duration words, whole-minute reads as the minutes only), anything
 *   under a minute reads "under a minute" (never "0 seconds" padding),
 *   and an estimate reads whole minutes with the board's "estimated"
 *   word ("estimated 4 minutes" — the one estimate form the board
 *   carries);
 * - a `null` duration OMITS the segment (returns `null`) — a fact the
 *   run did not record is never fabricated, and an estimate is only
 *   rendered against a recorded elapsed;
 * - bytes render in the board's MB unit (one decimal only when needed)
 *   — the wire carries BYTE counters (`total_bytes`, `size_bytes`) and
 *   the board's unit is MB;
 * - dates render in the machine's local clock (the board's "Today 10:02"
 *   / "19 Oct 14:36" — the run's own wall clock), "Today" for the same
 *   local day, else the short date, via `Intl.DateTimeFormat` (no
 *   hardcoded month table); the default locale is `en-GB` so the date
 *   reads BEFORE the month — the board's "19 Oct" order;
 * - the status words + tones are the K status palette (Running/Done/
 *   Stopped/Failed with the sibling status hexes — DEC-9), the mode chip
 *   words + tones are the ui-list chip palette (accent for a run that
 *   learned, neutral for a run that reused) — the consumer's display map
 *   over the provider's compact wire words (history-store DEC-4);
 * - a failed/stopped row's reason line reads the provider's detail
 *   VERBATIM ("Stopped: marker LDH is missing from the measurements");
 *   a row whose reason the run did not record reads the sibling's
 *   "no reason recorded" constant — a failure is never blank (INV-2);
 * - the endpoint line reads the board's words: progression or death for
 *   `pfs` ("progression, death by day 238"), death for `os` ("death by
 *   day 238").
 *
 * The two copy constants are the module's own long board strings (the
 * subtitle + the footer's trailing sentence) — one source for the page
 * shell (ITEM-1) and the footer (ITEM-4), pinned against the board
 * verbatim by TEST-HIST-6.
 */
import { safeText } from '@/modules/txrshell/lib/safeText'
import { runStatusWord, type RunCountsLike } from '@/modules/txrshell/lib/runStatus'
import type { TxrEndpoint, TxrHistoryBucket, TxrRunCounts, TxrRunMode, TxrRunReason } from '@/api-client/types'
import type { TxrChipTone } from '../types'

/**
 * The board's permanent subtitle (History.dc.html, verbatim — the only
 * facts-free copy of the screen: "Open a result again" and "everything you
 * ran" carry no numbers).
 */
export const HISTORY_SUBTITLE =
  'Everything you ran, newest first. Open a result again, or run it again with the same settings.'

/**
 * The footer usage line's trailing sentence: "… uses N MB of stored files.
 * Delete a run to free the space." — the size figure is the provider's
 * (`TxrHistoryUsage`; qa-fixes4 ITEM-1: the `data_dir` path segment is
 * no longer composed at all), set by the footer component; this constant
 * keeps the storage line verbatim in one place.
 */
export const HISTORY_USAGE_TRAIL = 'of stored files. Delete a run to free the space.'

/** The formatter options of `formatDurationWords` (`estimate: true` reads
 *  the duration in the board's estimate words — whole minutes). */
export interface DurationWordsOptions {
  estimate?: boolean
}

/**
 * A duration in the K board's word form:
 *
 * - `null`/non-finite/negative → `null` (the segment omits — never a
 *   fabricated zero, never a clock-skew print);
 * - under a minute → "under a minute" (the board's shortest-word rule,
 *   never "0 seconds" padding);
 * - a whole number of minutes → "2 minutes" / "1 minute";
 * - minutes + seconds → spelled as "N minutes M seconds" (singular
 *   forms: "1 minute 1 second").
 *
 * With `{ estimate: true }` the duration reads the board's estimate words
 * — whole minutes, prefixed "estimated" ("estimated 4 minutes"); a
 * sub-minute estimate still reads "under a minute" (that word already
 * reads approximate, and the board never writes "estimated under a
 * minute"). An estimate is the create-time schedule fact
 * (`estimate_total_seconds` / `use_estimate.total_seconds`), rounded to
 * the nearest whole minute — the board's estimates are whole-minute facts.
 */
export function formatDurationWords(secs: number | null, options: DurationWordsOptions = {}): string | null {
  if (secs === null || !Number.isFinite(secs) || secs < 0) return null
  const { estimate = false } = options
  if (secs < 60) return 'under a minute'
  if (estimate) {
    const minutes = Math.round(secs / 60)
    return `estimated ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  }
  const minutes = Math.floor(secs / 60)
  const seconds = Math.floor(secs % 60)
  const minuteWord = minutes === 1 ? 'minute' : 'minutes'
  if (seconds === 0) return `${minutes} ${minuteWord}`
  const secondWord = seconds === 1 ? 'second' : 'seconds'
  return `${minutes} ${minuteWord} ${seconds} ${secondWord}`
}

/** One mebibyte — the K board's MB unit applied to the wire's byte counters. */
const MIB = 1024 * 1024

/**
 * Byte→MB as the board's usage figure reads it (the board's MB unit; one
 * decimal only when needed). A non-finite/negative counter renders
 * "0 MB" — the footer never prints a broken number.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 MB'
  const mb = Math.round((bytes / MIB) * 10) / 10
  const text = Number.isInteger(mb) ? String(mb) : mb.toFixed(1)
  return `${text} MB`
}

/** The `formatDate` options (the `now` reference and the locale are
 *  injected by the tests — no hardcoded month table, TEST-HIST-5). */
export interface FormatDateOptions {
  /** The "today" reference (default: the current local clock). */
  now?: Date
  /** The `Intl.DateTimeFormat` locale (default `en-GB` — the board's
   *  "19 Oct" date-before-month order and 24-hour digits). */
  locale?: string
}

/**
 * The K card's date line: the board's "Today 10:02" for a run that
 * finished on the LOCAL calendar day, else the board's short date +
 * time ("19 Oct 14:36"). The parsed date flows through the injected
 * locale; an unparseable stamp returns the raw string (the honest
 * provider bytes, the datasets precedent), never a fabricated date.
 */
export function formatDate(iso: string, options: FormatDateOptions = {}): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const now = options.now ?? new Date()
  const locale = options.locale ?? 'en-GB'
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date)
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) return `Today ${time}`
  const day = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(date)
  return `${day} ${time}`
}

/**
 * The K status words + tones (DEC-9 — the sibling status palette): Running
 * in the work blue, Done in the family green, Stopped in the neutral grey
 * and Failed in the failure red. The map is complete over the provider's
 * four buckets; a bucket a future regen adds fails THIS switch at
 * typecheck, and the runtime fallback keeps the failure visible.
 *
 * qa-fixes4 ITEM-2: the word is the shared truthful vocabulary
 * (`txrshell/lib/runStatus` — the same words the results-page header
 * renders) over the engine's OWN per-state counts ("Done" only when every
 * method finished; "Done, 3 of 5 methods failed"; "Stopped by you
 * (2 skipped)"). A row whose counts the wire does not carry (a pre-ITEM-2
 * server) falls back to the four bucket words — the truth it cannot
 * compute is never invented.
 */
export function statusLabel(
  bucket: TxrHistoryBucket,
  counts: TxrRunCounts | null | undefined,
  methodCount: number,
): { text: string; tone: string } {
  // The DEC-9 per-bucket palette, with one ITEM-2 override: a `finished`
  // bucket whose methods did NOT all finish is the "some/partly" truth and
  // reads the warning amber, never the family green (a plain "Done" is the
  // only green; the board's palette has no other "partly" token). The
  // stopped/failed/running buckets keep their own hues — the amber is the
  // partial-finished token only.
  const tone =
    bucket === 'finished' && isTroubleRun(bucket, counts, methodCount)
      ? 'var(--txr-warning)'
      : STATUS_TONES[bucket]
  if (counts === undefined || counts === null) {
    return { text: PLAIN_STATUS_WORDS[bucket], tone }
  }
  return { text: runStatusWord(bucket, counts, methodCount), tone }
}

/** The four bucket words (the pre-ITEM-2 fallback — the DEC-9 palette). */
const PLAIN_STATUS_WORDS: Record<TxrHistoryBucket, string> = {
  running: 'Running',
  finished: 'Done',
  stopped: 'Stopped',
  failed: 'Failed',
}

/** The per-bucket tones (unchanged — the palette is the board's). */
const STATUS_TONES: Record<TxrHistoryBucket, string> = {
  running: 'var(--txr-brand-ink)',
  finished: 'var(--txr-success)',
  stopped: 'var(--txr-muted)',
  failed: 'var(--txr-danger)',
}

/**
 * The bucket the K card PRESENTS (qa-fixes2 R2-02): the provider's
 * `finished` covers any run whose scheduler ran to the end — including a
 * run where NOTHING finished (every method failed or could not run). That
 * run is not "Done" on the board's palette: the engine's own
 * `predictions_ready` (= `counts.finished > 0`, TEST-EE-9) is the truth
 * the row already carries — `can_reopen`/`can_download` — so a
 * `finished` run with no finished method presents as `failed` (with the
 * provider's reason, the row's `reason` already carries the first terminal
 * method's). The wire bucket stays the provider's (DEC-4's map); this is
 * the CONSUMER's display map — the K module's own documented seam.
 *
 * The filter nuance is recorded (DRIFT-1 ITEM-7): the provider's
 * `status=` filter still selects on the engine status, so "Stopped or
 * failed" does not include these finished-with-nothing runs — the
 * display-vs-filter divergence is the provider's to unify.
 */
export function displayBucketOf(item: {
  bucket: TxrHistoryBucket
  can_reopen: boolean
}): TxrHistoryBucket {
  if (item.bucket === 'finished' && !item.can_reopen) return 'failed'
  return item.bucket
}

/**
 * qa-fixes4 ITEM-2 (R3-results-3): whether the run's COUNT truth still has
 * methods that did not finish — a `finished` bucket whose counts report
 * unmet methods is not all-done ("Done, 3 of 5 methods failed" / "…could
 * not run" / "…were stopped or skipped"). A row without the engine's
 * counts (a pre-ITEM-2 server) cannot compute the truth and reads false —
 * the four bucket words stay the fallback. `failed`/`stopped` are always
 * trouble (their own truth), `running` is not.
 */
export function isTroubleRun(
  bucket: TxrHistoryBucket,
  counts: TxrRunCounts | null | undefined,
  methodCount: number,
): boolean {
  if (bucket === 'failed' || bucket === 'stopped') return true
  if (bucket !== 'finished') return false
  if (counts === undefined || counts === null || methodCount <= 0) return false
  return counts.finished < methodCount
}

/**
 * The one-line reason of a PARTIAL run (qa-fixes4 ITEM-2): the status chip
 * already names the count ("Done, 3 of 5 methods failed"); this line says
 * WHY, with the word chosen by the counts' dominant state and the provider's
 * detail VERBATIM (never re-authored — a blank detail reads the sibling's
 * "no reason recorded" constant, a failure is never blank, INV-2). The
 * bucket-prefix drop is the `reasonLineFor` rule (R3-results-9: "Stopped:
 * stopped by the user" next to a chip that already names the stop).
 */
export function troubleReasonLine(
  counts: TxrRunCounts,
  reason: TxrRunReason | null | undefined,
): string {
  const detail =
    reason != null && reason.detail.trim().length > 0
      ? safeText(reason.detail)
      : NO_REASON_RECORDED
  if (counts.failed > 0) return reasonLineFor('Failed', detail)
  if (counts.cannot_run > 0) return reasonLineFor('Could not run', detail)
  return reasonLineFor('Stopped', detail)
}

/**
 * The K mode chip (the ui-list chip palette, DEC-9): a run that learned
 * reads the accent "Learned and predicted", a run that reused reads the
 * neutral "Saved model". The chip's hexes live with the component (the
 * palette words are shared with the ui-list module's own chip tone
 * vocabulary).
 */
export function modeChip(mode: TxrRunMode): { label: string; tone: TxrChipTone } {
  switch (mode) {
    case 'train':
      return { label: 'Learned and predicted', tone: 'accent' }
    case 'reuse':
      return { label: 'Saved model', tone: 'neutral' }
  }
  const _unreachable: never = mode
  return { label: 'Saved model', tone: 'neutral' }
}

/**
 * The endpoint + horizon line (board bytes / DEC-9): `pfs` reads the
 * composite "progression, death by day N", `os` reads "death by day N".
 * The switch is exhaustive over the provider's endpoint union; a grown
 * endpoint fails typecheck here until a rendering branch is chosen (the
 * board's "progression by day 224" row is a design example — the frozen
 * vocabulary carries two endpoints, INV-6).
 */
export function endpointLabel(endpoint: TxrEndpoint, lookAheadDay: number): string {
  switch (endpoint) {
    case 'pfs':
      return `progression, death by day ${lookAheadDay}`
    case 'os':
      return `death by day ${lookAheadDay}`
  }
  const _unreachable: never = endpoint
  return `death by day ${lookAheadDay}`
}

/**
 * The row's reason line: the board's "Stopped: <detail>" / "Failed:
 * <detail>" with the provider's detail VERBATIM (never re-authored —
 * TEST-HIST-5; a re-authored detail is a test failure); a running or
 * finished run has no reason (null — the segment omits). A stopped or
 * failed row whose run recorded no reason (or only blank detail) reads
 * the sibling run module's constant — a failure is never blank (INV-2).
 *
 * R3-results-9: a detail that already carries the bucket's word ("stopped
 * by the user" next to the "Stopped" badge) drops the "Stopped: " prefix —
 * "Stopped by the user" — the row never reads the same word twice in one
 * line.
 *
 * The `null`-vs-`undefined` rule (qa-fixes RES-01): the openapi generator
 * renders a nullable-and-optional provider field as the TS optional-only
 * shape (`TxrRunReason | undefined`), while the engine's `Option`
 * serializes the ABSENT value as JSON `null` — so the wire can carry
 * `reason: null` exactly where the type says "no property". The guard is
 * `!= null` (both spellings absent), never `!== undefined` — a `null`
 * reason reading `.detail` is the history-page crash RES-01 (the
 * generator's shape is the documented collapse, the `txrrun` `toRunConfig`
 * bridge class; the provider-side fix is the regen's recorded owner).
 */

/** The reason line of one bucket, with the prefix dropped when the detail
 *  already starts with the bucket's word (R3-results-9). */
function reasonLineFor(bucketWord: string, detail: string): string {
  const lower = detail.trim().toLowerCase()
  const stem = bucketWord.toLowerCase()
  if (lower === stem || lower.startsWith(`${stem} `) || lower.startsWith(`${stem}:`)) {
    return detail.trim().charAt(0).toUpperCase() + detail.trim().slice(1)
  }
  return `${bucketWord}: ${detail}`
}

export function reasonLine(bucket: TxrHistoryBucket, reason: TxrRunReason | null | undefined): string | null {
  // qa-fixes4 ITEM-1: the detail passes through the UI-side `safeText`
  // guard (the server sanitiser already made it plain; the guard is the
  // never-render-a-path second line).
  const detail =
    reason != null && reason.detail.trim().length > 0
      ? safeText(reason.detail)
      : NO_REASON_RECORDED
  switch (bucket) {
    case 'running':
    case 'finished':
      return null
    case 'stopped':
      return reasonLineFor('Stopped', detail)
    case 'failed':
      return reasonLineFor('Failed', detail)
  }
  const _unreachable: never = bucket
  return null
}

/**
 * The sibling run module's "no reason recorded" constant (the txrrun
 * `formatProgress` fallback — the SAME honesty rule: a failure is never an
 * empty line).
 */
export const NO_REASON_RECORDED = 'no reason recorded'

/**
 * The Took line (the board's words): the spelled elapsed with the
 * estimate parenthetical. `null` elapsed → the whole segment omits
 * (null — the run carries no recorded took figure); a null/absent
 * estimate attaches no parenthetical; an estimate that cannot be read
 * drops the parenthetical too (the recorded elapsed stands alone, never
 * a fabricated estimate). R3-results-9: an estimate that reads the SAME
 * duration as the elapsed in the estimate's own whole-minute rounding
 * ("Took under a minute (under a minute)", "Took 2 minutes (estimated 2
 * minutes)") attaches nothing — the parenthetical would restate the fact,
 * not add it.
 */
export function tookLine(
  elapsedSecs: number | null | undefined,
  estimateSecs: number | null | undefined,
): string | null {
  if (elapsedSecs === undefined || elapsedSecs === null) return null
  const elapsed = formatDurationWords(elapsedSecs)
  if (elapsed === null) return null
  if (estimateSecs === undefined || estimateSecs === null) return elapsed
  const estimate = formatDurationWords(estimateSecs, { estimate: true })
  if (estimate === null) return elapsed
  // The comparison is on the ESTIMATE reading of both figures: an estimate
  // of 118 s reads "estimated 2 minutes" beside a 120 s elapsed ("2
  // minutes") — the same fact in the estimate's own rounding, and the
  // parenthetical would restate it.
  if (formatDurationWords(elapsedSecs, { estimate: true }) === estimate) return elapsed
  return `${elapsed} (${estimate})`
}
