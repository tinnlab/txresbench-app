/**
 * txrmodels board copy formatters — PROV-UI-MODELS-4 (ITEM-2).
 *
 * Every user-facing string the model screens derive from a number or a
 * structured fact, spelled verbatim from the boards: `Models.dc.html` (the
 * J table's Predicts / Trained on / Made column entries and the Model-column
 * subline), `Pretrained.dc.html` + `Saved.dc.html` (the bottom-bar research
 * notice) and `SaveModels.dc.html` + `SaveOne.dc.html` (the save dialogs'
 * ruled copy and the training-data warning sentence).
 *
 * The boards are the copy source (the module's copy rule, INV-4): the
 * formatters take the structured facts the providers send — typed against
 * the GENERATED api-client vocabulary (`TxrTask`, `TxrEndpoint`,
 * `ModelProvenance` — the provider regen drives the typecheck, never a
 * locally restated enum) — and produce the boards' words. Board numbers
 * (patient and model counts, percents, sizes, days, AUCs) are design
 * examples, never data and never fixtures; these functions format whatever
 * the host passes.
 *
 * Never blank, with two deliberate exceptions the boards themselves pin:
 * `formatModelSublines` is `""` when a row carries no marker, covariate or
 * import fact at all (the column shows the name alone), and
 * `formatTrainingDataWarning` is `""` for an empty model list (the dialog
 * renders no line). Every other null datum renders the constant
 * `UNRECORDED` ("not recorded" — the board's own fallback wording) or, for
 * the total-time estimate's siblings, is the caller's decision; never an
 * empty entry, never a number-shaped null.
 *
 * Dates: `Intl.DateTimeFormat` with a PINNED `en-GB` locale — the boards'
 * "21 Oct 2026" day-month-year spelling. The app's copy is English
 * throughout, so the client locale is deliberately not trusted to re-word
 * a board fact; the instant still renders in the machine's local zone like
 * every other date label in the app.
 */
import type { MarkerKind, ModelProvenance, TxrEndpoint, TxrTask } from '@/api-client/types'

// ─────────────────────────────────────────────────────────────────────────────
// The board copy constants (ITEM-2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The bottom-bar research notice, shared by the D and I bottom bars
 * (`Pretrained.dc.html` / `Saved.dc.html`, verbatim — INV-3). One constant
 * so the two screens can never diverge.
 */
export const RESEARCH_NOTICE = "For research. Not for deciding a patient's treatment."

/**
 * The J-table "not recorded" fallback ("Trained on" for an imported row,
 * `Models.dc.html`) — the board's own wording for an absent fact, reused
 * wherever a nullable column has no value (never a blank entry).
 */
export const UNRECORDED = 'not recorded'

/**
 * The save dialog's ruled copy, lead labels + sentences (`SaveModels.dc.html` /
 * `SaveOne.dc.html`, verbatim; the dialogs render the labels emphasised and
 * the sentences as body text):
 *
 * - `WHAT_IS_SAVED_LABEL` + `NOT_SAVED_LABEL` — the two leads ("What is
 *   saved:" / "Not saved:");
 * - `SAVE_SET_WHAT_IS_SAVED_TEXT` — dialog L's sentence (every model of the
 *   set: "each trained model, its settings, the markers and units it needs,
 *   and how it did on your data.");
 * - `SAVE_ONE_WHAT_IS_SAVED_TEXT` — dialog L2's sentence (one model: "the
 *   trained model, …" — the board's singular wording);
 * - `NOT_SAVED_TEXT` — the shared "your patients' tables." sentence.
 */
export const WHAT_IS_SAVED_LABEL = 'What is saved:'
export const NOT_SAVED_LABEL = 'Not saved:'
export const SAVE_SET_WHAT_IS_SAVED_TEXT =
  'each trained model, its settings, the markers and units it needs, and how it did on your data.'
export const SAVE_ONE_WHAT_IS_SAVED_TEXT =
  'the trained model, its settings, the markers and units it needs, and how it did on your data.'
export const NOT_SAVED_TEXT = "your patients' tables."

/**
 * The training-data warning sentence's two halves
 * (`SaveModels.dc.html`, verbatim) — the dynamic count + name list is
 * composed by `formatTrainingDataWarning`; the warning glyph belongs to
 * the dialog's Alert, not to this sentence.
 */
export const TRAINING_WARNING_KEEP = 'keep parts of the training data inside them.'
export const TRAINING_WARNING_STAYS =
  'They stay in the saved model files; check before you copy or share them.'

// ─────────────────────────────────────────────────────────────────────────────
// `formatPredicts` — the J "Predicts" column (Models.dc.html)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The J table's Predicts entry, from the model's outcome facts:
 *
 * - `pfs` → "progression, death by day <horizon>" (the board's CRC row);
 * - `os` → "death by day <horizon>";
 * - `response` → "no response by day <horizon>";
 * - a task outside the pinned vocabulary (or not yet classified — the
 *   model row's `task` is nullable until the run's method row classifies
 *   it) falls to the endpoint flavor: `pfs` keeps the board's
 *   "progression, death" spelling, `os` reads "death by day <horizon>";
 * - no horizon, or neither task nor endpoint → `UNRECORDED` (never a
 *   half-spelled "by day" entry).
 *
 * Exhaustiveness: the switch over the generated `TxrTask` makes the
 * provider's next task value fail THIS file's compile until its board
 * spelling is written here (the txrlist `TxrReasonCode` precedent).
 */
export function formatPredicts(
  task: TxrTask | null | undefined,
  endpoint: TxrEndpoint | null | undefined,
  horizon: number | null | undefined,
): string {
  if (horizon === null || horizon === undefined || !Number.isFinite(horizon)) return UNRECORDED
  const day = `by day ${horizon}`
  switch (task) {
    case 'pfs':
      return `progression, death ${day}`
    case 'os':
      return `death ${day}`
    case 'response':
      return `no response ${day}`
    case null:
    case undefined:
      break
    default: {
      // A runtime value outside the pinned vocabulary — the endpoint flavor
      // below decides the spelling; never a blank or a raw id. The
      // exhaustiveness pin: a provider regen adding a task value fails this
      // assignment at compile time until its board spelling is added above.
      const _unreachable: never = task
      void _unreachable
    }
  }
  if (endpoint === 'pfs') return `progression, death ${day}`
  if (endpoint === 'os') return `death ${day}`
  return UNRECORDED
}

// ─────────────────────────────────────────────────────────────────────────────
// `formatMade` / `formatTrainedOn` — the J "Made" and "Trained on" columns
// ─────────────────────────────────────────────────────────────────────────────

/** The Made-column date formatter (the boards' day-month-year spelling;
 *  the instant renders in the viewer's local time zone, like every other
 *  date label in the app — only the locale is pinned, never the zone). */
const MADE_DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

function parseDate(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) return null
  const t = Date.parse(value)
  if (Number.isNaN(t)) return null
  return new Date(t)
}

/**
 * The J table's Made entry: "21 Oct 2026" for a row trained by a run
 * (`provenance === 'run'` — the run's creation date), "opened 14 Oct 2026"
 * for a row that came into the inventory from outside (`imported` — the
 * board's verb — or `pretrained`, an installed catalogue model with no
 * local training). A missing or unparseable instant → the
 * `UNRECORDED` constant, never an empty entry.
 */
export function formatMade(
  createdAt: string | null | undefined,
  provenance: ModelProvenance | null,
): string {
  const date = parseDate(createdAt)
  if (date === null) return UNRECORDED
  const spelled = MADE_DATE_FORMAT.format(date)
  return provenance === 'run' ? spelled : `opened ${spelled}`
}

/**
 * The J table's Trained-on entry: "N patients" for a run row (the board's
 * count word, "1 patient" singular), `UNRECORDED` ("not recorded" — the
 * board's imported-row word) for an unknown cohort size.
 */
export function formatTrainedOn(patients: number | null | undefined): string {
  if (patients === null || patients === undefined || !Number.isFinite(patients)) return UNRECORDED
  return `${patients} ${patients === 1 ? 'patient' : 'patients'}`
}

// ─────────────────────────────────────────────────────────────────────────────
// `formatModelSublines` — the J Model-column subline (Models.dc.html)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The J table's model subline, the board's three facts joined with the
 * board's " · " separator, in the board's order — the import source first
 * ("opened from breast-panel.txr · 5 markers"), then the marker fact, then
 * the covariate note ("uses age"), then the set it was saved in
 * ("from the set 'qa-results-set'" — ITEM-5, RES-17: two runs' models can
 * carry the same default name; the set is the row's distinguisher in the
 * inventory table):
 *
 * - `(6, true, null)` → "6 markers · uses age";
 * - `(4, false, null)` → "4 markers" (singular at one marker);
 * - `(5, false, 'breast-panel.txr')` → "opened from breast-panel.txr · 5
 *   markers";
 * - `(null, false, null)` → `""` — the column shows the name alone (the
 *   board's `null`-facts row), THE deliberate blank this file allows.
 *
 * The marker fact is the row's recorded kind, never a bare count (ITEM-5,
 * RES-19): the catalogue's `any` mode (77 of the 359 shipped methods —
 * e.g. the ctDNA delta/landmark families) records count 0, and "0 markers"
 * would read as "uses no markers" for a method that runs on ANY marker.
 * The kind's word is the honest fact: `any` → "any marker"; `single` /
 * `panel` / `multi` → the count with the board's plural. A row with no
 * kind fact (a grown response's defensive read) falls back to the count.
 *
 * The covariate note is the board's spell verbatim ("uses age" — the
 * `uses_covariates` fact carries no names on the summary row, DEC-11).
 * The set segment renders only when the set name is present AND differs
 * from the model's own display name — the caller passes the name's
 * duplicate as `null`: a set named after its models (the board's example
 * rows) would spell the same fact twice.
 */
export function formatModelSublines(
  markerCount: number | null | undefined,
  usesCovariates: boolean,
  importedFrom: string | null | undefined,
  setName: string | null | undefined,
  markerKind: MarkerKind | null | undefined,
): string {
  const parts: string[] = []
  const source = importedFrom?.trim()
  if (source && source.length > 0) parts.push(`opened from ${source}`)
  const anyMarker = markerKind === 'any'
  if (markerKind === 'single' || markerKind === 'panel' || markerKind === 'multi') {
    if (markerCount !== null && markerCount !== undefined && Number.isFinite(markerCount)) {
      parts.push(`${markerCount} ${markerCount === 1 ? 'marker' : 'markers'}`)
    }
  } else if (anyMarker) {
    parts.push('any marker')
  } else if (markerCount !== null && markerCount !== undefined && Number.isFinite(markerCount)) {
    parts.push(`${markerCount} ${markerCount === 1 ? 'marker' : 'markers'}`)
  }
  if (usesCovariates) parts.push('uses age')
  const set = setName?.trim()
  if (set && set.length > 0) parts.push(`from the set '${set}'`)
  return parts.join(' \u00b7 ')
}

// ─────────────────────────────────────────────────────────────────────────────
// `formatTrainedDateShort` — the I run-facts date (Saved.dc.html's section
// subtitle: "trained 19 Oct on patients.csv · …")
// ─────────────────────────────────────────────────────────────────────────────

/** The section-subtitle date formatter (day + month, no year — the board's
 *  "trained 19 Oct" spelling; the year is the "Made" column's business). */
const TRAINED_DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
})

/**
 * The I section facts line's date ("19 Oct"): the run's `finished_at`
 * instant, day + short month, machine-local zone like every other date
 * label in the app. A missing or unparseable instant → `null` — the
 * facts-line composer OMITS the "trained … on …" segment instead of
 * spelling a blank (the segment's companion facts may still be present).
 */
export function formatTrainedDateShort(value: string | null | undefined): string | null {
  const date = parseDate(value)
  if (date === null) return null
  return TRAINED_DATE_FORMAT.format(date)
}

// ─────────────────────────────────────────────────────────────────────────────
// `formatSetFacts` — screen J's section facts line (Models.dc.html)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The screen-J set row's facts line (ONE-TABLE round — the set's name has
 * the facts UNDER it; the count and the made date moved OUT: the Model
 * column spells the count through `formatSetModelCount`, the Made column
 * spells the date through `formatSetMade`):
 *
 * - `from the run “<source_label>”` — the set came from a training run
 *   (`source_run_id` present) and carries a `source_label`;
 * - `from the file “<imported_from>”` — the set is an import (no run) and
 *   the rows carry the file they were opened from (`imported_from`);
 * - `from “<source_label>”` — the honest fallback when the set has a
 *   source label but it cannot be told apart as run or file (the
 *   brief's degraded spelling);
 * - `training files kept` — the set's `keep_training_files` fact.
 *
 * The caller decides run/file/ambiguous from the provider facts; this
 * function only spells them. `""` when no part applies (a fallback group
 * while the sets read has not answered — the page renders no facts line;
 * the Model column still spells the count).
 */
export interface ModelSetFactsInput {
  /** The set's `keep_training_files`. */
  keepTrainingFiles: boolean
  /** The set's `source_label` ("patients.csv"-style); null = omit. */
  sourceLabel: string | null | undefined
  /** True when the set came from a run (`source_run_id` present). */
  fromRun: boolean
  /** The rows' own `imported_from` (the file an imported set was opened
   *  from); null = omit. */
  importedFrom: string | null | undefined
}

export function formatSetFacts(input: ModelSetFactsInput): string {
  const parts: string[] = []
  const label = input.sourceLabel?.trim() ?? ''
  const file = input.importedFrom?.trim() ?? ''
  if (input.fromRun && label.length > 0) {
    parts.push(`from the run \u201c${label}\u201d`)
  } else if (!input.fromRun && file.length > 0) {
    parts.push(`from the file \u201c${file}\u201d`)
  } else if (!input.fromRun && label.length > 0) {
    parts.push(`from \u201c${label}\u201d`)
  }
  if (input.keepTrainingFiles) parts.push('training files kept')
  return parts.join(' \u00b7 ')
}

/**
 * The set row's Model-column count (ONE-TABLE round — the "N models" fact
 * the facts line used to spell): the board's singular/plural, `3 models` /
 * `1 model`. The caller passes the set's `model_count` when the record is
 * known, the listed count for a fallback group (the same source the old
 * facts line used).
 */
export function formatSetModelCount(count: number): string {
  return `${count} ${count === 1 ? 'model' : 'models'}`
}

/**
 * The set row's Model-column count during a PARTIAL client-side search
 * (part 2 — the brief's "@matchCount of @total models match"): the matches
 * over the set's total, the SAME total the plain "3 models" entry spells,
 * always in the one plan string "{m} of {n} models match" (never a
 * `matches` agreement, never a singular `model` form — "1 of 7 models
 * match", "2 of 3 models match", "1 of 1 models match").
 */
export function formatSetModelMatchText(matchCount: number, total: number): string {
  return `${matchCount} of ${total} models match`
}

/**
 * The set row's Made-column entry (ONE-TABLE round — the set's made date
 * moved from the facts line's "made <date>" part into this column):
 * "21 Oct 2026" through the same en-GB day-month-year formatter; a missing
 * or unparseable instant (a fallback group while the sets read has not
 * answered) → the `UNRECORDED` constant, never a blank entry.
 */
export function formatSetMade(createdAt: string | null | undefined): string {
  const date = parseDate(createdAt)
  return date === null ? UNRECORDED : MADE_DATE_FORMAT.format(date)
}

// ─────────────────────────────────────────────────────────────────────────────
// `formatBytes` — the sizes (the L checklist's per-model + total rows; the D
// cards' asset sizes)
// ─────────────────────────────────────────────────────────────────────────────

const KB = 1024
const MB = KB * 1024

/**
 * The Details dialog's Environment fact: the layer's publish tag of the
 * environment image the model was trained in (and runs in: a reuse binds the
 * model's own image), e.g. `cox-model-2.0.1-amd64-5ce304e213ac`. A record
 * without a tag (a model saved before tags were kept, a demo model) says
 * "not recorded" rather than inventing one or guessing why.
 */
export function formatEnvironment(env: { layer_tag?: string | null } | null | undefined): string {
  const tag = env?.layer_tag?.trim() ?? ''
  return tag.length > 0 ? tag : UNRECORDED
}

/**
 * A byte size as the boards spell them:
 *
 * - 10 MB and up → whole megabytes ("41 MB", nearest);
 * - 0.1 MB – 10 MB → one decimal ("1.2 MB", "6.3 MB", "0.1 MB" — the
 *   board's checklist sizes);
 * - 1 KB – 0.1 MB → whole kilobytes ("100 KB" — a sub-board granularity
 *   only because a tiny file never reads "0.0 MB");
 * - below 1 KB → plain bytes ("512 B");
 * - null / negative / non-finite → the `UNRECORDED` constant. A caller
 *   that wants NO size text for a missing value (the pre-growth row in the
 *   L checklist) gates on null before formatting — this function never
 *   writes a blank or a fabricated zero-sized number into an entry that
 *   should carry a fact.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return UNRECORDED
  }
  if (bytes >= 10 * MB) return `${Math.round(bytes / MB)} MB`
  if (bytes >= 0.1 * MB) return `${(bytes / MB).toFixed(1)} MB`
  if (bytes >= KB) return `${Math.round(bytes / KB)} KB`
  return `${bytes} B`
}

// ─────────────────────────────────────────────────────────────────────────────
// The training-data warning line (SaveModels.dc.html)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The L dialog's training-data warning sentence — the board's wording with
 * the dynamic count + name list composed here:
 *
 * `"2 models (dynforest, flirti) keep parts of the training data inside
 * them. They stay in the saved model files; check before you copy or share
 * them."`
 *
 * An empty list → `""` (the dialog renders no warning line — never a
 * "0 models" sentence). The board shows the plural case only; the singular
 * reading agrees the verb and pronouns ("1 model (… ) keeps parts of the
 * training data inside it. It stays in the saved model file; check before
 * you copy or share it."). The caller passes exactly the models whose
 * `embeds_training_data` fact is true, in the run's method order (never an
 * invented warning — DEC-15).
 */
export function formatTrainingDataWarning(modelNames: ReadonlyArray<string>): string {
  const names = modelNames.map(n => n.trim()).filter(n => n.length > 0)
  const count = names.length
  if (count === 0) return ''
  if (count === 1) {
    return `1 model (${names[0]}) keeps parts of the training data inside it. It stays in the saved model file; check before you copy or share it.`
  }
  return `${count} models (${names.join(', ')}) ${TRAINING_WARNING_KEEP} ${TRAINING_WARNING_STAYS}`
}

// ─────────────────────────────────────────────────────────────────────────────
// `formatCheckedAgainstLine` — the D/I "Checked against your file" line
// ─────────────────────────────────────────────────────────────────────────────

/** The board's draw-days spelling: [0, 14, 28, 56] → "0, 14, 28 and 56". */
function drawDaysText(days: ReadonlyArray<number>): string {
  if (days.length === 0) return ''
  if (days.length === 1) return `${days[0]}`
  return `${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}`
}

/**
 * The D/I "Checked against your file" line from the validation
 * (CONS-UM-11): `"Checked against your file: 42 patients, 4 markers, draws
 * at day 0, 14, 28 and 56."` with the board's own tail — I's "Models from
 * one training run are grouped; pick any of them." (Saved.dc.html) or D's
 * "Pick as many as you like." (Pretrained.dc.html; the two live in the
 * pages as one `tail` argument, one formatter).
 *
 * The draw-days segment is bounded (ITEM-5, RES-22): the board's example
 * shows four days; a real file with many draw days used to list every one
 * (a 14-day meas-urements file spelled a 14-item list in the intro). Four
 * or fewer days keep the board's spelling; more read as a count — "draws
 * on 14 days" — with the segment then omitted from the sentence when there
 * are no draw days at all.
 */
export function formatCheckedAgainstLine(
  raw: {
    inventory: { patients: number; markers: ReadonlyArray<unknown> }
    measurements?: { distinct_draw_days?: ReadonlyArray<number> } | null
  },
  tail: string,
): string {
  const days = raw.measurements?.distinct_draw_days ?? []
  const drawSegment =
    days.length === 0
      ? ''
      : days.length <= 4
        ? `, draws at day ${drawDaysText(days)}`
        : `, draws on ${days.length} days`
  return `Checked against your file: ${raw.inventory.patients} patients, ${raw.inventory.markers.length} markers${drawSegment}. ${tail}`
}

// ─────────────────────────────────────────────────────────────────────────────
// `formatSavedTotals` — screen I's totals line (Saved.dc.html)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Screen I's header totals line — the shown count + the one accounting
 * over the eligibility response's three verdicts (ITEM-5, RES-22):
 *
 * - "can run" is the count of what the engine can ACTUALLY START — the
 *   `fit` AND `some` verdicts (a "Can run for some patients" model starts
 *   and scores its eligible cohort; the 0-eligible verdict is `cannot`),
 *   the same definition the built-in "Can run N" chip counts (the shared
 *   bar's non-disabled rows), so the sentence and the chip can never
 *   disagree again;
 * - the `some` split is spelled inline with the chip's word ("6 of them
 *   for some patients") and is omitted entirely when none — never a
 *   "0 for some patients" sentence;
 * - the totals sum to the shown count (fit + some + cannot == shown), a
 *   closed accounting the page's `shown` count obeys.
 *
 * The boards' two examples disagree with each other here (I counts
 * can-run as fit-only in its example, D folds the some-verdicts into its
 * own can-run count) — the app's ONE definition is this item's
 * (qa-fixes ITEM-2's CM-1 "what can really start"); the board's "partly"
 * shorthand is deliberately unused (DEC-12, the module's own rule).
 */
export function formatSavedTotals(
  shown: number,
  fit: number,
  some: number,
  cannot: number,
): string {
  const canRun = fit + some
  const someSegment = some > 0 ? ` (${some} of them for some patients)` : ''
  return `${shown} saved models shown \u00b7 ${canRun} can run, ${cannot} cannot${someSegment}`
}

/**
 * The merged model step's header totals line (predict-card merge round 2):
 * "N models · X can run, Y cannot" ("1 model · …" singular) — the one
 * accounting over the eligibility response's three verdicts (can run =
 * fit + some, the same definition the built-in "Can run N" chip counts;
 * the "N saved models shown" old line's word goes: the list shows every
 * source).
 */
export function formatChooseTotals(
  shown: number,
  fit: number,
  some: number,
  cannot: number,
): string {
  const canRun = fit + some
  const noun = shown === 1 ? 'model' : 'models'
  return `${shown} ${noun} \u00b7 ${canRun} can run, ${cannot} cannot`
}
