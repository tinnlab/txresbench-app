/**
 * txrlist board copy formatters — PROV-UI-LIST-4.
 *
 * Every string here is board copy (DEC-12): the bytes below are the bytes
 * the E/D/I screens show, written verbatim from `Busy.dc.html`,
 * `Pretrained.dc.html` and `Saved.dc.html` — the duration rows ("12 s",
 * "under 1 min", "about 5 min"), the coverage lines ("all 151 patients" /
 * "120 of 151 patients"), the three run headlines, the per-code "what is
 * missing" reason lines, the total line ("about 14 minutes in total"),
 * and the plurals ("Run 5 methods" / "Run 3 models").
 *
 * The formatters are pure: structure goes in (the eligibility response's
 * structured facts), board copy comes out (DEC-5 — the server sends
 * structured fields; the display text is the consumer's). A row's reason
 * templates read the STRUCTURED fields only (`reasons[].code`,
 * `coverage`, `min_draws`, `missing_markers[].display_name`), plus — for
 * the three study-answer codes (step2-filters: `DISEASE_NOT_MATCHED`,
 * `TREATMENT_NOT_MATCHED`, `OUTCOME_NOT_MATCHED`) — the per-code params
 * the server's `filter_reasons` pins (`made_for` / `predicts`); the other
 * codes keep reading no params (their key set stays unpinned — DEC-5).
 *
 * Never blank: every documented code — and any unexpected code a future
 * provider or model-list emits — maps to a non-empty constant line (the
 * post-switch fallback), and `formatTotalTime(null)` shows the loading
 * ellipsis, never empty text.
 *
 * Board rules that shape this file:
 * - the row time is the SHORT form ("about 5 min"); the bottom-bar total
 *   is the LONG form ("about 5 minutes in total") — the
 *   boards consistently spell the two differently;
 * - the FLOW.md shorthand "partly" is never used (DEC-12); the three
 *   statuses are "Can run" / "Can run for some patients" / "Cannot run";
 * - board example numbers ("151 patients", "AUC 0.64") are design
 *   examples, never data (FLOW.md): the formatters only format whatever
 *   the host passes.
 */
import type { ReasonCode } from '@/api-client/types'
import type { TxrMethodNeeds, TxrMethodRank, TxrRunStatus } from '../types'

/**
 * The reason-code vocabulary the formatter renders.
 *
 * The provider's own 18 codes (PROV-MC-5, `ReasonCode` from the generated
 * api-client — the closed set `method-catalogue` may emit) plus the two
 * model-list codes the grown branches render (PROV-MS-9
 * `MODEL_REQUIREMENTS_UNRECORDED`, PROV-PC-8 `ASSET_NOT_AVAILABLE` — the
 * model builders on D/I emit these, not the method endpoint). Anything
 * else falls to the constant fallback — a code is never rendered blank.
 */
export type TxrReasonCode =
  | ReasonCode
  | 'MODEL_REQUIREMENTS_UNRECORDED'
  | 'ASSET_NOT_AVAILABLE'

/** The per-code params a reason carries (`params` keys are per-code; the
 *  study-answer codes' ones are pinned by the server — see
 *  `method_catalogue/eligibility.rs` — so this surface names the fields the
 *  formatter reads). */
export interface TxrReasonParams {
  /** DISEASE_NOT_MATCHED / TREATMENT_NOT_MATCHED: what the method is made for
   *  (the method's disease groups joined with ", ", a scope name, or the
   *  treatment-class ids joined with ", "). */
  made_for?: string
  /** OUTCOME_NOT_MATCHED: the method's group (the `MethodGroup` wire code). */
  predicts?: string
  /** The answered ids (not rendered; the sentence speaks the method's side). */
  answer?: unknown
}

/** The reasons' shape the formatter reads (code + the study-answer params). */
export interface TxrReasonFacts {
  code: TxrReasonCode
  params?: TxrReasonParams | undefined
}

/**
 * The vocabulary label table a reason line may read (step2-filters): the
 * treatment-class display labels from `filter_options.treatment_classes`.
 * When absent (or before it loads) the line falls back to the class id
 * itself — the ids are plain, readable words, so the fallback is never a
 * guess.
 */
export interface TxrReasonLabels {
  treatmentClasses?: ReadonlyArray<{ id: string; label: string }>
}

/** The coverage facts the reason line reads (the wire `coverage` shape). */
export interface TxrCoverageFacts {
  /** Patients the method/model can run for. */
  eligible: number
  /** Patients with an uploaded file. */
  total: number
}

/** The minimum-draws verdict the reason line reads (the wire `min_draws` shape). */
export interface TxrMinDrawsFacts {
  /** The draw count the method needs. */
  required: number
  /** Patients meeting the minimum. */
  met: number
  /** Patients falling short. */
  unmet_patients: number
}

/**
 * The row's short duration string (boards' row time cells):
 *
 * - whole seconds below 30 → `"N s"` (the board's "12 s"; the raw
 *   `f64` seconds from the wire are ROUNDED — "5.577333333333334 s" is
 *   never rendered, CM-4);
 * - 30–59 s → `"under 1 min"` (the board's shortest rows);
 * - 60 s and up → `"about N min"` with N = the nearest minute (the
 *   board's "about 1 min"/"about 2 min"/"about 5 min" — 120 s → "about
 *   2 min", 300 s → "about 5 min").
 *
 * The board-example boundary (12 s is shown as "12 s" while 45 s would be
 * "under 1 min") pins the seconds cutoff below 45; 30 s is the chosen
 * half-minute boundary. The long form lives in `formatTotalTime`.
 */
export function formatDurationShort(seconds: number): string {
  const whole = Math.round(seconds)
  if (whole < 30) return `${whole} s`
  if (whole < 60) return 'under 1 min'
  return `about ${Math.round(whole / 60)} min`
}

/**
 * The per-patient coverage line (boards' "all 151 patients" /
 * "120 of 151 patients"). All patients covered reads "all N patients";
 * any shortfall reads "E of T patients".
 */
export function formatCoverage(c: TxrCoverageFacts): string {
  if (c.eligible === c.total) return `all ${c.total} patients`
  return `${c.eligible} of ${c.total} patients`
}

/**
 * The run verdict headline (boards verbatim; the FLOW.md shorthand
 * "partly" is deliberately absent — DEC-12).
 */
export function formatRunHeadline(status: TxrRunStatus): string {
  switch (status) {
    case 'can':
      return 'Can run'
    case 'some':
      return 'Can run for some patients'
    case 'cannot':
      return 'Cannot run'
  }
}

/**
 * The first missing item's display name, or the generic fallback
 * `"a required marker"` when the list carries no name (never blank).
 */
export function formatMissingItem(missing: ReadonlyArray<{ display_name?: string }>): string {
  for (const item of missing) {
    const name = item.display_name?.trim()
    if (name && name.length > 0) return name
  }
  return 'a required marker'
}

/**
 * The row's "what is missing" detail line for the FIRST reason in the list
 * (the provider emits the reasons in a deterministic order; the boards show
 * one detail line per row — a host that wants a multi-line detail composes
 * more lines itself). Per-code templates, all board copy (DEC-12):
 *
 * - `REQUIRED_MARKER_MISSING` → "needs LDH, not in your file";
 * - `MIN_DRAWS_UNMET` → "needs 3 or more draws; 120 of 151 have them" —
 *   the met count over the coverage total (the board's own wording;
 *   `unmet_patients` is available to the host but the board says who
 *   meets the minimum, not who does not);
 * - `DECISION_DAY_UNMET` → "36 of 38 patients (2 lack LDH)" — the
 *   coverage shortfall over the first missing marker (the board's
 *   "at day 56" is a design-example detail; the decision day is not in
 *   the structured fields this formatter reads — DEC-5);
 * - `DETECTION_CALL_MISSING` → "needs a detection-call marker, not in
 *   your file";
 * - `MARKER_GROUP_MISSING` → "needs markers from: <groups>" (the missing
 *   groups' display names, joined; the fallback is a constant phrase);
 * - `UNIT_MISMATCH` → with status `can`/`some` the board's warning
 *   composition "all 38 patients, check the scales" (coverage + the
 *   units warning — Pretrained's `landmark-cox-current` row); with
 *   status `cannot` the constant line "units do not match";
 * - `COVARIATE_MISSING` / `COVARIATE_REQUIRED_UNMET` → "needs extra
 *   inputs your file lacks";
 * - `NOT_RUNNABLE` → "not available with this build";
 * - `ENV_IMAGE_MISSING` → "no published environment available"
 *   (CM-1's plain reason — the method cannot start without one);
 * - `RUNNER_UNAVAILABLE` → "methods cannot run yet: see the notice at the
 *   top of the app" — a fact about the deployment (the app's start-up check
 *   found no usable method runner: on Windows, WSL 2 missing, too old or
 *   turned off, the app's WSL runtime missing, or the app's run folder not
 *   creatable), never a problem with the user's study or answers. Like
 *   ENV_IMAGE_MISSING, it is the first reason of every method's verdict, so
 *   the row's one line names the deployment fact and the fix points to the
 *   shell's notice (see `methodRows.ts`). The shell's notice (under the
 *   header on every screen) is where the reason and the fix live — it says
 *   the specific cause and offers "Set up WSL" when a setup exists; the row
 *   stays short;
 * - `TASK_INCOMPATIBLE` → "needs an outcome column your file lacks";
 * - `RESPONSE_LABEL_MISSING` → "needs a response label in your file";
 * - `SURVIVAL_OUTCOME_MISSING` → "needs survival times in your file";
 * - `MARKER_COUNT_UNMET` → "takes a set number of markers; your file has a
 *   different number" (the run engine's marker-count rule; a constant line,
 *   since the templates never read `params`);
 * - `MODEL_REQUIREMENTS_UNRECORDED` → "its requirements weren't
 *   recorded";
 * - `ASSET_NOT_AVAILABLE` → "the model file isn't available";
 * - anything else (or an empty reasons list) → "cannot run with this
 *   file" — the constant fallback, never a blank line.
 */
/**
 * The ONE sentence a method whose environment is not published reads —
 * the method list's reason and the F row's reason say the same words
 * (qa-fixes4 ITEM-3, methods-r3 R3-methods-9): the row's stored engine
 * detail is the old pre-vocabulary sentence ("no published environment
 * for method <id>"), while the list said "no published environment
 * available" for the SAME `ENV_IMAGE_MISSING` code — same fact, two
 * wordings; the shared code is the key, the shared sentence is this one.
 */
export const NO_PUBLISHED_ENVIRONMENT_REASON = 'no published environment available'

/**
 * The one-line fix for `RUNNER_UNAVAILABLE` (the list's cannot-row fix and
 * the picker's runner reason-group fix say the SAME words — one fact, one
 * fix): the notice at the top of the app says the cause and what to do —
 * WSL 2 missing, too old or turned off, the app's WSL runtime missing, or
 * the app's run folder not creatable — and offers "Set up WSL"/"Update WSL"
 * when a setup exists (after one, Windows may need a restart before the app
 * is opened again). The app reads the runner's state when it starts, so it
 * must be opened again.
 */
export const RUNNER_UNAVAILABLE_FIX =
  'Do what the notice at the top of the app says, then open TxResBench again.'

/**
 * The row's one reason line (the FIRST reason only, fine-print plain).
 *
 * The sentence vocabulary (one words-per-code table, TEST-UL-13):
 */
export function formatReasonLine(
  status: TxrRunStatus,
  reasons: ReadonlyArray<TxrReasonFacts>,
  coverage: TxrCoverageFacts,
  minDraws: TxrMinDrawsFacts,
  missingMarkers: ReadonlyArray<{ display_name?: string }>,
  missingGroups: ReadonlyArray<{ display_name?: string }> = [],
  labels: TxrReasonLabels = {},
): string {
  const code = reasons[0]?.code
  if (code === undefined) return 'cannot run with this file'
  switch (code) {
    case 'REQUIRED_MARKER_MISSING':
      return `needs ${formatMissingItem(missingMarkers)}, not in your file`
    case 'MIN_DRAWS_UNMET':
      return `needs ${minDraws.required} or more draws; ${minDraws.met} of ${coverage.total} have them`
    case 'DECISION_DAY_UNMET':
      return `${coverage.eligible} of ${coverage.total} patients (${coverage.total - coverage.eligible} lack ${formatMissingItem(missingMarkers)})`
    case 'DETECTION_CALL_MISSING':
      return 'needs a detection-call marker, not in your file'
    case 'MARKER_GROUP_MISSING': {
      const groups = missingGroups
        .map(g => g.display_name?.trim() ?? '')
        .filter(name => name.length > 0)
      return `needs markers from: ${groups.length > 0 ? groups.join(', ') : 'a missing marker group'}`
    }
    case 'UNIT_MISMATCH':
      if (status === 'cannot') return 'units do not match'
      return `${formatCoverage(coverage)}, check the scales`
    case 'COVARIATE_MISSING':
    case 'COVARIATE_REQUIRED_UNMET':
      return 'needs extra inputs your file lacks'
    case 'NOT_RUNNABLE':
      return 'not available with this build'
    case 'ENV_IMAGE_MISSING':
      return NO_PUBLISHED_ENVIRONMENT_REASON
    case 'RUNNER_UNAVAILABLE':
      return 'methods cannot run yet: see the notice at the top of the app'
    case 'TASK_INCOMPATIBLE':
      return 'needs an outcome column your file lacks'
    case 'RESPONSE_LABEL_MISSING':
      return 'needs a response label in your file'
    case 'SURVIVAL_OUTCOME_MISSING':
      return 'needs survival times in your file'
    case 'MARKER_COUNT_UNMET':
      return 'takes a set number of markers; your file has a different number'
    case 'MODEL_REQUIREMENTS_UNRECORDED':
      return "its requirements weren't recorded"
    case 'ASSET_NOT_AVAILABLE':
      return "the model file isn't available"
    case 'DISEASE_NOT_MATCHED':
      return diseaseNotMatchedLine(reasons[0]?.params)
    case 'TREATMENT_NOT_MATCHED':
      return treatmentNotMatchedLine(reasons[0]?.params, labels)
    case 'OUTCOME_NOT_MATCHED':
      return outcomeNotMatchedLine(reasons[0]?.params)
  }
  // Exhaustive over TxrReasonCode (TEST-UL-13: a code added to the
  // provider's union fails THIS line until a rendering branch covers it).
  // A runtime foreign code — not in the vocabulary — falls to the constant
  // fallback below, never a blank line.
  const _unreachable: never = code
  return 'cannot run with this file'
}

/**
 * The plain sentence-join of the board ("a and b", "a, b and c" — no
 * Oxford comma, the `joinPhrases` rule of the panel sentence).
 */
function joinPlain(parts: ReadonlyArray<string>): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/**
 * The scope names a method's disease fact may use when it is not
 * group-scoped (the server sends them verbatim as `made_for`); the sentence
 * spells them plainly.
 */
const DISEASE_SCOPE_NAMES: Readonly<Record<string, string>> = {
  'any-solid-tumour': 'solid tumours',
  'any-cancer': 'cancers',
}

/** DISEASE_NOT_MATCHED — "Made for melanoma, not your disease"; the coarse
 *  scopes read as the plain words ("solid tumours", "cancers"). A group
 *  scope arrives as a ", " list ("lung cancer, breast cancer") and is
 *  joined the same plain way as the treatment classes (5a3: the old line
 *  rendered the comma list verbatim, never reading after "Made for"). */
export function diseaseNotMatchedLine(params: TxrReasonParams | undefined): string {
  const madeFor = params?.made_for
  if (typeof madeFor === 'string' && madeFor.length > 0) {
    const named = madeFor.split(', ').map(part => DISEASE_SCOPE_NAMES[part] ?? part)
    return `Made for ${joinPlain(named)}, not your disease`
  }
  return 'Made for another disease'
}

/** TREATMENT_NOT_MATCHED — "Made for chemotherapy, not your treatments"
 *  (several classes: "Made for chemotherapy and radiotherapy, not your
 *  treatments"). The classes come as the ids joined with ", "; the
 *  vocabulary's display labels are used when available, the id is the
 *  fallback. */
export function treatmentNotMatchedLine(
  params: TxrReasonParams | undefined,
  labels: TxrReasonLabels = {},
): string {
  const madeFor = params?.made_for
  const classes =
    typeof madeFor === 'string' && madeFor.length > 0
      ? madeFor.split(', ')
      : []
  if (classes.length === 0) return 'Made for other treatments'
  const named = classes.map(id => {
    const label = labels.treatmentClasses?.find(treatment => treatment.id === id)?.label
    return typeof label === 'string' && label.length > 0 ? label : id
  })
  return `Made for ${joinPlain(named)}, not your treatments`
}

/**
 * The method group a method predicts in → the phrase AFTER "Predicts" in
 * the reason sentence (5a3: the plain words, read directly — "Predicts a
 * yes or no response", "Predicts the chance of response", "Predicts the
 * risk by a set day", "Predicts risk over time"). The wire spelling is the
 * fallback for a group the table does not know.
 */
const OUTCOME_GROUP_PHRASES: Readonly<Record<string, string>> = {
  'response-call': 'a yes or no response',
  'response-probability': 'the chance of response',
  'static-risk': 'the risk by a set day',
  'dynamic-risk': 'risk over time',
}

/** OUTCOME_NOT_MATCHED — "Predicts risk over time, not what you chose". */
export function outcomeNotMatchedLine(params: TxrReasonParams | undefined): string {
  const predicts = params?.predicts
  const phrase =
    typeof predicts === 'string' && predicts.length > 0
      ? (OUTCOME_GROUP_PHRASES[predicts] ?? predicts)
      : 'a different outcome'
  return `Predicts ${phrase}, not what you chose`
}

/**
 * The row's FULL reason set, one plain line per reason (qa-fixes4 ITEM-3,
 * methods-r3 R2-6): the eligibility verdict carries every cause — the
 * runtime-env stage pushes `ENV_IMAGE_MISSING` FIRST and the file reasons
 * (a missing marker, the drawn-day coverage, too few draws) FOLLOW it, so
 * a row that reads only the first reason shows "no published environment
 * available" and hides exactly what the user could change. The list keeps
 * the provider's order — the environment fact reads first, the data
 * reasons beside it — and an empty list falls back to the coverage line
 * (the pre-R2-6 byte).
 */
export function formatReasonLines(
  status: TxrRunStatus,
  reasons: ReadonlyArray<TxrReasonFacts>,
  coverage: TxrCoverageFacts,
  minDraws: TxrMinDrawsFacts,
  missingMarkers: ReadonlyArray<{ display_name?: string }>,
  missingGroups: ReadonlyArray<{ display_name?: string }> = [],
  labels: TxrReasonLabels = {},
): string[] {
  if (reasons.length === 0) return [formatCoverage(coverage)]
  return reasons.map(r =>
    formatReasonLine(status, [r], coverage, minDraws, missingMarkers, missingGroups, labels),
  )
}

/**
 * The bottom-bar total (board wording: "about 14 minutes in total").
 * `null` (loading, or an empty selection) renders the board
 * loading ellipsis "…"; anything under a minute renders the short form
 * "under 1 minute in total" rather than "about 0
 * minutes".
 */
export function formatTotalTime(seconds: number | null): string {
  if (seconds === null) return '…'
  if (seconds < 60) return 'under 1 minute in total'
  const minutes = Math.round(seconds / 60)
  return `about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} in total`
}

// ── the redesigned E screen's copy (qa-fixes3 ITEM-1) ───────────────────────
// The picker's strings are the new plain-voice copy; each formatter is pure
// and reads the card's STRUCTURED fields only (DEC-5 — the provider's
// display text is the consumer's, never a param blob).

/** The row's estimate label ("Estimated 12 s" — quality rides the dot). */
export function formatEstimateLabel(seconds: number): string {
  return `Estimated ${formatDurationShort(seconds)}`
}

/** The row's benchmark score ("Benchmark score 0.74 (38 cohorts)"; the
 *  parenthetical is omitted when the aggregate's cohort count is unknown —
 *  a fact that is not there is never invented). */
export function formatBenchmarkScore(rank: TxrMethodRank): string {
  const base = `Benchmark score ${rank.median.toFixed(2)}`
  return rank.nDatasets > 0 ? `${base} (${rank.nDatasets} cohorts)` : base
}

/** The score's tooltip: exactly what the number is (D36's honesty rule). */
export function formatBenchmarkTooltip(rank: TxrMethodRank): string {
  const measure = rank.kind === 'auc' ? 'AUC' : 'concordance'
  return rank.nDatasets > 0
    ? `The median ${measure} across the ${rank.nDatasets} datasets the method was tested on.`
    : `The median ${measure} from the benchmark.`
}

/**
 * The row's quiet needs line ("Needs: 1 marker · covariates optional · 1+
 * draws"); `coverageLine` prefixes the "Runs on 120 of 151 patients" fact
 * when the method runs for a subset (the board's some-patients honesty).
 */
export function formatMethodNeedsLine(
  needs: TxrMethodNeeds,
  coverageText: string | null,
): string {
  const parts: string[] = []
  if (coverageText !== null) parts.push(coverageText)
  parts.push(`Needs: ${needs.markers}`)
  if (needs.covariates !== null) parts.push(needs.covariates)
  parts.push(needs.draws)
  return parts.join(' · ')
}

/** The plain coverage text ("Runs on all 151 patients" / "Runs on 120 of
 *  151 patients") — the picker's ready-to-run rows, not the board's red. */
export function formatMethodCoverage(coverage: TxrCoverageFacts): string {
  if (coverage.eligible === coverage.total) return `Runs on all ${coverage.total} patients`
  return `Runs on ${coverage.eligible} of ${coverage.total} patients`
}

/**
 * The no-environment honesty line (CM-1, one vocabulary for the method list
 * AND the screen-B panel): "N of them cannot run yet." Rendered directly
 * under the fit headline ("176 of 359 methods fit your study"), "them" is
 * the SAME methods that fit — the deployment fact about that count, never a
 * second count over the whole catalogue (R3-intake-1: the old "N of M
 * methods have no published environment and can't start" contradicted the
 * headline and left the two numbers untellable as one story). The count is
 * the env-absent subset of the fit count; the line is shown only when it is
 * non-zero. The location-neutral rule (ITEM-2) keeps the sentence's "yet"
 * without the deployment-place clause the plan's copy carried — the owner's
 * copy guard pins that phrase (see the qa-fixes4 DRIFT entry).
 */
export function formatNoEnvLine(noEnvFit: number): string {
  return `${noEnvFit} of them cannot run yet`
}

/** The itemLabel plural: "method" → "methods" (the singular for n === 1). */
export function pluralize(itemLabel: 'method' | 'model', n: number): string {
  return n === 1 ? itemLabel : `${itemLabel}s`
}

/** The Run button label: "Run 5 methods" / "Run 3 models" (boards verbatim). */
export function runLabel(itemLabel: 'method' | 'model', n: number): string {
  return `Run ${n} ${pluralize(itemLabel, n)}`
}
