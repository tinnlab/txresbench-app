/**
 * txrresults board copy formatters (ITEM-3) — every user-facing string the
 * G/H screens derive from a number or a structured fact, written verbatim
 * from `BusyResults.dc.html` / `Results.dc.html`, plus the copy constants the
 * compare card templates.
 *
 * The boards are the copy source (PROV-UR-5, README's "Copy source"): the
 * subtitle segments (the counts segment, the learned-from segment, the
 * decision-day segment, the took segment — board-joined with " · "), the
 * outcome-tab labels ("Progression or death by day 238"), the banner
 * sentence ("could not run: LDH is not in your measurements."), the
 * compare-card sentences and the legend. The boards' NUMBERS (their patient
 * and method counts, the day values, the P0xxx ids) are design examples,
 * never data — these formatters only format whatever the engine's run
 * detail/predictions response passes.
 *
 * The formatters are pure and never blank: a null datum yields a null SEGMENT
 * (the header omits it — a run whose elapsed time is unknown shows no
 * "took …" piece, never an empty run in the sentence), and
 * `formatReasonText` always returns a non-empty sentence (the engine's
 * detail verbatim when it has one, a constant fallback line otherwise —
 * DEC-15: the display text is the consumer's; this node never reconstructs
 * the provider's per-code reasons).
 *
 * DEC-10: `formatTook` is module-local. `txrlist`'s `formatDurationShort`
 * renders the list-screen row time ("about 5 min") — a different rendering
 * from the results subtitle's precise "11 minutes 20 seconds"; no cross-node
 * seam is created for it.
 */
import { safeText } from '@/modules/txrshell/lib/safeText'
import type { TxrOutcomeKey } from '../types'

// ─────────────────────────────────────────────────────────────────────────────
// The compare-card copy constants (DEC-7 / OWNER-UR-2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The divergent-only window: a patient "differs" when the two methods'
 * chances differ by ≥ 10 percentage points (the compare card's "Show only
 * the patients where they differ" filter). A named constant, never an inline
 * magic number — the owner-question default (OWNER-UR-2: 3 names / 3 names /
 * 10 points, confirmed D43).
 */
export const DIVERGENCE_PP = 10

/** The compare-card title (`Results.dc.html`: "How the two methods compare"). */
export const COMPARE_CARD_TITLE = 'How the two methods compare'

/** The first compare sentence's lead — "Both methods put <patients> …". */
export const SHARED_TOP_LEAD = 'Both methods put'

/** The first compare sentence's tail — "… among their five highest chances." */
export const SHARED_TOP_TAIL = 'among their five highest chances'

/** The first compare sentence when the top-5 sets do not intersect. */
export const SHARED_TOP_NONE = 'Both methods share no patients among their five highest chances'

/** The second compare sentence's lead — "They differ most for <patients> (a% and b%)". */
export const DIFFER_LEAD = 'They differ most for'

/** The second compare sentence when no patient diverges at all. */
export const DIFFER_NONE = 'They do not differ for any patient'

/** The divergent-only toggle label (`Results.dc.html`, verbatim). */
export const DIVERGENT_TOGGLE = 'Show only the patients where they differ'

/**
 * The compare-card title names the two methods it compares (qa-fixes
 * RES-10 — the board's "How the two methods compare" never says WHICH two):
 * "How landmark-cox-current and cox-cutpoint-risk compare".
 */
export function compareCardTitle(aLabel: string, bLabel: string): string {
  return `How ${aLabel} and ${bLabel} compare`
}

// ─────────────────────────────────────────────────────────────────────────────
// The legend label (qa-fixes RES-04 — the board's "Chance of failure" is the
// pfs reading; the third outcome's tab must not read "failure")
// ─────────────────────────────────────────────────────────────────────────────

/** The heatmap legend's label per outcome tab (the board's pfs words verbatim). */
export const LEGEND_LABEL: Record<TxrOutcomeKey, string> = {
  pfs: 'Chance of failure',
  os: 'Chance of death',
  response: 'Chance of no response',
}

// ─────────────────────────────────────────────────────────────────────────────
// `formatTook` — the subtitle's "took 11 minutes 20 seconds" duration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The precise duration the G/H subtitle carries (the board's "took 11
 * minutes 20 seconds" — deliberately NOT `txrlist`'s "about N min" row
 * form, DEC-10):
 *
 * - a null / non-finite / negative datum → `null` (the header omits the
 *   "took …" segment — never a fabricated zero);
 * - under a minute → "under a minute" (the board's short form; the
 *   tested pins: 45 → "under a minute", 59 → "under a minute");
 * - an exact minute count → "1 minute" / "N minutes" (60 → "1 minute");
 * - otherwise the exact minutes + seconds, singular/plural per part
 *   (90 → "1 minute 30 seconds", 680 → "11 minutes 20 seconds").
 *
 * Durations of an hour or more keep counting minutes (the board's longest
 * duration unit is minutes; a 5000-second run reads "83 minutes 20
 * seconds", never a new hours render).
 */
export function formatTook(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null
  if (seconds < 60) return 'under a minute'
  let mins = Math.floor(seconds / 60)
  let secs = Math.round(seconds - mins * 60)
  if (secs === 60) {
    mins += 1
    secs = 0
  }
  const minutePart = `${mins} ${mins === 1 ? 'minute' : 'minutes'}`
  if (secs === 0) return minutePart
  return `${minutePart} ${secs} ${secs === 1 ? 'second' : 'seconds'}`
}

// ─────────────────────────────────────────────────────────────────────────────
// `formatPct` — whole percents
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A chance as a whole percent string ("77%") — the heatmap value labels, the
 * Average column and the compare card's "(77% and 52%)".
 *
 * - null / non-finite → `null` (an abstain value renders empty, never "0%");
 * - rounded to the nearest whole percent and clamped to the board's 0–100
 *   legend (a provider value outside the window is a percentage of 0–100,
 *   never "101%");
 * - the returned digits are plain ASCII 0–9, so the tabular-numeral
 *   rendering (`font-variant-numeric: tabular-nums` on the value, PROV-UR-5)
 *   has fixed-width digits to work on.
 */
export function formatPct(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null
  const whole = Math.round(value)
  return `${Math.min(100, Math.max(0, whole))}%`
}

// ─────────────────────────────────────────────────────────────────────────────
// `formatTaskLabel` — the outcome-tab labels (DEC-4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The outcome-tab label for one task (DEC-4, the G/H tablist):
 *
 * - `pfs` → "Progression or death by day <horizon>" (the board's tab 1);
 * - `os` → "Death by day <horizon>" (the board's tab 2);
 * - `response` → "No response by day <horizon>" — the third tab appears
 *   only when a finished method's task normalizes to `response` (OWNER-UR-1
 *   default, confirmed D42: the response horizon is the run's label day
 *   when present, else the run horizon — the CALLER resolves the day, this
 *   formatter only spells it).
 */
export function formatTaskLabel(key: TxrOutcomeKey, horizon: number): string {
  switch (key) {
    case 'pfs':
      return `Progression or death by day ${horizon}`
    case 'os':
      return `Death by day ${horizon}`
    case 'response':
      return `No response by day ${horizon}`
  }
  // Exhaustive over TxrOutcomeKey: a new outcome key added to the pinned
  // union fails THIS line at compile time until its board label is spelled.
  const _exhaustive: never = key
  return _exhaustive
}

// ─────────────────────────────────────────────────────────────────────────────
// The header subtitle segments (PROV-UR-5)
// ─────────────────────────────────────────────────────────────────────────────

/** The facts the G/H header subtitle formats (PROV-UR-5). */
export interface TxrSubtitleFacts {
  /**
   * qa-fixes4 ITEM-2 (a): the run's status word on the SAME vocabulary as
   * the K status chip (the shared `txrshell/lib/runStatus` builder) — a
   * terminal run's subtitle leads with it ("Failed", "Stopped by you
   * (2 skipped)", "Done, 3 of 5 methods failed", "Done") and the counts
   * segment ("N of M methods finished") is omitted beside it — the status
   * word carries the same fact in the K vocabulary. Null/absent for a live
   * run (the counts segment stays, DEC-4).
   */
  status?: string | null
  /** `run.counts.finished` — methods that reached `finished`. */
  finished: number | null
  /** The run's selected-method count (`run.counts` total or `method_ids.length`). */
  total: number | null
  /** `run.input_summary.patients` — the training cohort size ("learned from …"). */
  trainedOn: number | null
  /** `run.config.decision_day`. */
  decisionDay: number | null
  /** `run.elapsed_secs` — null while the run has no elapsed time yet. */
  tookSeconds: number | null
}

/**
 * The counts segment ("<n> of <m> methods finished"). Either count null →
 * `null` (the header omits the segment); the noun is singular at a
 * single-method run ("0 of 1 method finished"), the board's plural stays
 * verbatim otherwise.
 */
export function formatCounts(finished: number | null, total: number | null): string | null {
  if (finished === null || total === null || !Number.isFinite(finished) || !Number.isFinite(total)) {
    return null
  }
  return `${finished} of ${total} ${total === 1 ? 'method' : 'methods'} finished`
}

/**
 * The learned-from segment ("learned from <n> patients", OWNER-UR-6,
 * confirmed D47: a reuse-mode run whose `input_summary.patients` is null
 * omits the segment).
 */
export function formatLearnedFrom(patients: number | null): string | null {
  if (patients === null || !Number.isFinite(patients)) return null
  return `learned from ${patients} ${patients === 1 ? 'patient' : 'patients'}`
}

/** The "decision day 56" segment. Null day → `null` (segment omitted). */
export function formatDecisionDay(day: number | null): string | null {
  if (day === null || !Number.isFinite(day)) return null
  return `decision day ${day}`
}

/**
 * The full subtitle, segment-wise: each segment is omitted when its datum is
 * null (no empty runs in the sentence — a run with no elapsed time yet
 * reads the counts, learned-from and decision-day segments only), and the
 * segments join with the board's " · " separator. A terminal run's STATUS
 * word (ITEM-2 (a), the K vocabulary) leads and replaces the counts
 * segment — the same fact, the K words. For a fully-populated live run
 * the board's verbatim bytes are:
 *
 * `<n> of <m> methods finished · learned from <p> patients · decision day <d> · took <s> minutes <z> seconds`
 */
export function formatSubtitle(facts: TxrSubtitleFacts): string {
  const segments: string[] = []
  const counts = formatCounts(facts.finished, facts.total)
  const status = facts.status ?? null
  if (status !== null) segments.push(status)
  else if (counts !== null) segments.push(counts)
  const learned = formatLearnedFrom(facts.trainedOn)
  const day = formatDecisionDay(facts.decisionDay)
  const took = formatTook(facts.tookSeconds)
  if (learned !== null) segments.push(learned)
  if (day !== null) segments.push(day)
  if (took !== null) segments.push(`took ${took}`)
  return segments.join(' \u00b7 ')
}

// ─────────────────────────────────────────────────────────────────────────────
// `formatReasonText` — the cannot-run banner's reason sentence (DEC-15)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The fallback sentence when the engine's reason carries no readable detail
 * (never a blank line — DEC-15). Points at the banner's own "Show the log"
 * affordance.
 */
export const REASON_FALLBACK = 'see the log for the reason'

/** A sentence ending: a detail already terminated stays as the engine wrote it. */
function ensureSentenceEnd(text: string): string {
  const trimmed = text.trim()
  if (/[.!?]$/.test(trimmed)) return trimmed
  return `${trimmed}.`
}

/**
 * The banner's reason sentence ("LDH is not in your measurements.",
 * `BusyResults.dc.html`). Display text is the consumer's (DEC-15): when the
 * engine's `reason.detail` is present it is rendered VERBATIM (trimmed,
 * sentence-terminated — the banner composes "could not run: <this>. The
 * other N methods are shown."); when it is empty, the code is unknown or
 * none exists, the constant `REASON_FALLBACK` sentence is returned — never a
 * blank or a bare code string (this node does not re-render `reason.code`s:
 * those are the intake/list screens' and the logs').
 */
export function formatReasonText(
  code: string | null | undefined,
  detail: string | null | undefined,
): string {
  void code
  const d = detail?.trim()
  // qa-fixes4 ITEM-1: the UI-side `safeText` guard is the second line
  // behind the server's API-boundary sanitiser — a leaked absolute path /
  // the app-data token is never rendered (the browser regression
  // test feeds a leaked detail through this exact formatter).
  if (d && d.length > 0) return ensureSentenceEnd(safeText(d))
  return ensureSentenceEnd(REASON_FALLBACK)
}

// ─────────────────────────────────────────────────────────────────────────────
// The compare-card sentence builders (DEC-7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Patient ids as the compare card names them: "S0081, S0092 and S0093"
 * (comma-joined, "and" before the last — the board's own punctuation, no
 * Oxford comma). One id → the id alone; none → "".
 */
export function formatPatientList(patientIds: ReadonlyArray<string>): string {
  const ids = patientIds.filter(id => id.length > 0)
  if (ids.length === 0) return ''
  if (ids.length === 1) return ids[0]
  return `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`
}

/**
 * The compare card's first sentence: "Both methods put S0081, S0092 and
 * S0093 among their five highest chances." — the intersection of the two
 * methods' top-5 sets, at most three names (DEC-7's cap is the report's;
 * this formatter spells whatever the report carries). An empty intersection
 * reads the constant `SHARED_TOP_NONE` sentence — never a blank line.
 */
export function formatSharedTopSentence(rows: ReadonlyArray<{ patientId: string }>): string {
  const ids = rows.map(r => r.patientId)
  if (ids.length === 0) return `${SHARED_TOP_NONE}.`
  return `${SHARED_TOP_LEAD} ${formatPatientList(ids)} ${SHARED_TOP_TAIL}.`
}

/**
 * The compare card's second sentence: "They differ most for S0099 (77% and
 * 52%) and S0101 (35% and 57%)." — the top divergences with both methods'
 * chances as whole percents, joined the board's way ("and", no Oxford
 * comma). A null chance (an abstain) renders "—" in that slot; a card with
 * no differing patient reads the constant `DIFFER_NONE` sentence.
 */
export function formatDifferSentence(
  rows: ReadonlyArray<{ patientId: string; a: number | null; b: number | null }>,
): string {
  const parts = rows.map(row => {
    const a = formatPct(row.a) ?? '\u2014'
    const b = formatPct(row.b) ?? '\u2014'
    return `${row.patientId} (${a} and ${b})`
  })
  if (parts.length === 0) return `${DIFFER_NONE}.`
  return `${DIFFER_LEAD} ${parts.join(' and ')}.`
}

// ─────────────────────────────────────────────────────────────────────────────
// qa-fixes ITEM-4 — the plain-voice notes (board-less states, RES-03/04)
// ─────────────────────────────────────────────────────────────────────────────

/** One hidden task in the mixed-outcome note (qa-fixes RES-04). */
export interface TxrOutcomeNoteTask {
  key: TxrOutcomeKey
  /** The day the task's label spells (the response tab's label-day rule). */
  day: number
}

/** The first letter lowercase — a task label embedded mid-sentence. */
function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0].toLowerCase() + text.slice(1)
}

/**
 * The mixed-outcome note (qa-fixes RES-04): when the active outcome tab
 * hides finished methods of another task, the screen says so plainly —
 * "Showing the 5 of 6 finished methods on this tab; the other 1 predicts no
 * response by day 30 and is shown on its own tab." Null when every finished
 * method is on the tab. The sentence is the app's plain voice (the boards
 * never show a mixed run); the labels are `formatTaskLabel`'s.
 */
export function formatMixedOutcomeNote(
  visible: number,
  total: number,
  hidden: TxrOutcomeNoteTask[],
): string | null {
  if (hidden.length === 0) return null
  const byKey = new Map<TxrOutcomeKey, TxrOutcomeNoteTask>()
  for (const task of hidden) {
    if (!byKey.has(task.key)) byKey.set(task.key, task)
  }
  const labels = [...byKey.values()]
    .map(task => lowerFirst(formatTaskLabel(task.key, task.day)))
    .sort()
  const tail =
    hidden.length === 1
      ? 'and is shown on its own tab.'
      : 'and are shown on their own tabs.'
  const verb = hidden.length === 1 ? 'predicts' : 'predict'
  return `Showing the ${visible} of ${total} finished methods on this tab; the other ${hidden.length} ${verb} ${labels.join(' or ')} ${tail}`
}

/**
 * The constant-column note (qa-fixes RES-03): "N methods gave the same chance
 * (0%) for every patient." — the screen never shows a wall of identical
 * percents unexplained. The values are the columns' common 0–1 values as the
 * display's whole percents, distinct and ascending; null when nothing is
 * constant.
 */
export function formatConstantNote(
  columns: ReadonlyArray<{ constantValue: number | null }>,
): string | null {
  const constants = columns.filter(c => c.constantValue !== null)
  if (constants.length === 0) return null
  const values = [
    ...new Set(constants.map(c => formatPct((c.constantValue as number) * 100) ?? '')),
  ].sort()
  const valueText = values.length === 1 ? values[0] : values.join(' and ')
  const verb = constants.length === 1 ? 'method gave' : 'methods gave'
  return `${constants.length} ${verb} the same chance (${valueText}) for every patient.`
}

/**
 * The grouped-chance note (results-r3 R3-results-13): a method whose column
 * carries only 2–3 DISTINCT values (cfmedip's three-category clearance call
 * — 82 %, 35 % and 6 %) reads like a constant next to a graded scale. The
 * note names the column and its groups, in the report's plain hint ("this
 * method gives three groups"); null when no column is grouped (the
 * one-value constant case stays the constant note's, RES-03).
 */
export function formatGroupedChanceNote(
  columns: ReadonlyArray<{ label: string; values: ReadonlyArray<number | null> }>,
): string | null {
  const grouped: Array<{ label: string; distinct: number[] }> = []
  for (const column of columns) {
    const distinct: number[] = []
    for (const value of column.values) {
      if (value === null || !Number.isFinite(value)) continue
      if (!distinct.some(existing => Math.abs(existing - value) < 1e-9)) {
        distinct.push(value)
      }
    }
    if (distinct.length >= 2 && distinct.length <= 3) {
      grouped.push({ label: column.label, distinct })
    }
  }
  if (grouped.length === 0) return null
  const parts = grouped.map(group => {
    const values = formatPatientList(
      group.distinct
        .sort((a, b) => a - b)
        .map(value => formatPct(value * 100) ?? ''),
    )
    const numberWord = group.distinct.length === 2 ? 'two' : 'three'
    return `${group.label} gives ${numberWord} distinct chances (${values}) — its chances are its ${numberWord} groups`
  })
  return `${parts.join('; ')}.`
}

/**
 * The missing-chance note (qa-fixes2 R2-10): the table is built from the
 * engine's prediction columns, and a finished method with no recorded
 * chance column is absent from them — the header's "N of M methods
 * finished" (a true run fact) then counts more than the table shows.
 * The note is the report's option A ("say plainly"): "Showing the 5 of 6
 * finished methods that give chances; ctdna-clearance finished without a
 * recorded chance column and is not shown." Null when every finished
 * method carries a column.
 */
export function formatChanceMissingNote(
  finished: ReadonlyArray<{ methodId: string; label: string }>,
  columns: ReadonlyArray<{ methodId: string }>,
): string | null {
  const withColumn = new Set(columns.map(c => c.methodId))
  const missing = finished.filter(m => !withColumn.has(m.methodId))
  if (missing.length === 0) return null
  const names = missing.map(m => m.label || m.methodId).join(', ')
  const remaining = finished.length - missing.length
  const verb = missing.length === 1 ? 'is' : 'are'
  return `Showing the ${remaining} of ${finished.length} finished methods that give chances; ${names} finished without a recorded chance column and ${verb} not shown.`
}

/**
 * The H method-facts card's coverage line (qa-fixes RES-11): "Scored for 68
 * of 94 patients" — the coverage record counts null when the column carries
 * none.
 */
export function formatCoverage(
  scored: number | null,
  eligible: number | null,
): string | null {
  if (scored === null || eligible === null || !Number.isFinite(scored) || !Number.isFinite(eligible)) {
    return null
  }
  return `Scored for ${scored} of ${eligible} ${eligible === 1 ? 'patient' : 'patients'}`
}

/** Why a column has no chances (the engine's `prob_source: none`): a saved
 * model reused on new patients without a score-to-chance conversion for the
 * run's outcome and day (saved before conversions were kept, or kept for
 * another outcome/day — the per-patient note names which). */
export const NO_CHANCE_REASON =
  'the saved model has no score-to-chance conversion for this outcome and day'

/** The flat-result sentence: the conversion is the event-rate map (the
 * engine's `flat_conversion`), so every patient has the same chance. */
export const FLAT_CONVERSION_LINE =
  "This method's score did not track the outcome in the training data, so every patient gets the same chance: the event rate."

/** The prob-source sentence of the method facts card (qa-fixes RES-11/05),
 * plus the flat-result sentence when the column's conversion is flat. */
export function formatProbSourceLine(
  source: 'native' | 'recalibrated' | 'converted' | null,
  flatConversion = false,
): string {
  const flat = flatConversion && (source === 'recalibrated' || source === 'converted')
  const withFlat = (line: string) => (flat ? `${line} ${FLAT_CONVERSION_LINE}` : line)
  switch (source) {
    case 'native':
      return "The chances are the method's own estimates, as it was trained."
    case 'recalibrated':
      return withFlat('The chances were recalibrated on your patients before being shown.')
    case 'converted':
      return withFlat(
        'The method gives a score; the chances use the score-to-chance conversion learned when the model was trained.',
      )
    case null:
      return `No chances are shown: ${NO_CHANCE_REASON}.`
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// qa-fixes2 R2-02/RES-02 — the terminal-failed-run truth (status + methods)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether the run's results should present the failure state (qa-fixes2
 * R2-02 / round-1 RES-02 — still broken because the engine's `finished`
 * status covers a run whose scheduler ran to the end while EVERY method
 * failed or could not run). The honest condition is the engine's own
 * `predictions_ready` rule (`counts.finished > 0`, TEST-EE-9): a terminal
 * run with no finished method has no predictions and is presented as the
 * failure the method rows record — the run's own terminal word for
 * `failed`/`stopped`, the "nothing finished" fact for `finished`.
 */
export function txrRunFailed(run: {
  status: string
  methods: ReadonlyArray<{ state: string }>
}): boolean {
  if (run.status === 'failed' || run.status === 'stopped') return true
  if (run.status === 'finished') {
    return !run.methods.some(m => m.state === 'finished')
  }
  return false
}

/**
 * The plural wording of the no-chance reason (qa-fixes4 ITEM-6 on top of the
 * conversion semantics): several saved models, none with a score-to-chance
 * conversion for the run's outcome and day. One column reads
 * `NO_CHANCE_REASON`.
 */
export const NO_CHANCE_REASON_PLURAL =
  'the saved models have no score-to-chance conversion for this outcome and day'

/** The fallback reason of an all-abstain column whose notes differ per patient. */
const EMPTY_COLUMN_REASON_FALLBACK = 'no chances were produced for any patient'

/**
 * The per-column reason of a DROPPED empty column (qa-fixes4 ITEM-6, R2-03):
 * `prob_source: none` reads the reuse sentence; an all-abstain column reads
 * its own uniform note (the one sentence every patient's abstain shares —
 * "fewer than 3 draws by day 56 for every patient" — the honest "why" of
 * the empty column); differing notes read the fallback (never a fabricated
 * single reason).
 */
export function formatEmptyColumnReason(
  column: { probSource: 'native' | 'recalibrated' | 'converted' | null; notes: ReadonlyArray<string | null> },
): string {
  if (column.probSource === null) return ensureSentenceEnd(NO_CHANCE_REASON)
  const notes = [
    ...new Set(
      column.notes.filter((note): note is string => note !== null && note.trim().length > 0),
    ),
  ]
  if (notes.length === 1) return ensureSentenceEnd(notes[0])
  return ensureSentenceEnd(EMPTY_COLUMN_REASON_FALLBACK)
}

/**
 * The one line under the table naming EVERY dropped empty column and its
 * reason (qa-fixes4 ITEM-6 — R2-03's "blank columns plus a note" becomes
 * "no columns, one line): "No chances are shown for A, B: <reason>." — one
 * sentence per distinct reason, in the columns' order; null when nothing
 * was dropped. The names are the columns' display labels.
 */
export function formatEmptyColumnsNote(
  columns: ReadonlyArray<{
    label: string
    probSource: 'native' | 'recalibrated' | 'converted' | null
    notes: ReadonlyArray<string | null>
  }>,
): string | null {
  if (columns.length === 0) return null
  const byReason = new Map<string, string[]>()
  for (const column of columns) {
    const reason = formatEmptyColumnReason(column)
    const names = byReason.get(reason) ?? []
    names.push(column.label)
    byReason.set(reason, names)
  }
  const noConversion = ensureSentenceEnd(NO_CHANCE_REASON)
  return [...byReason.entries()]
    .map(([reason, names]) => {
      const said =
        reason === noConversion && names.length > 1
          ? ensureSentenceEnd(NO_CHANCE_REASON_PLURAL)
          : reason
      return `No chances are shown for ${names.join(', ')}: ${said}`
    })
    .join(' ')
}
