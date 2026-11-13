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
 * `coverage`, `min_draws`, `missing_markers[].display_name`), never
 * `reasons[].params` (its key set is unpinned — DEC-5).
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
 * The provider's own 13 codes (PROV-MC-5, `ReasonCode` from the generated
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
 * - `TASK_INCOMPATIBLE` → "needs an outcome column your file lacks";
 * - `RESPONSE_LABEL_MISSING` → "needs a response label in your file";
 * - `SURVIVAL_OUTCOME_MISSING` → "needs survival times in your file";
 * - `MODEL_REQUIREMENTS_UNRECORDED` → "its requirements weren't
 *   recorded";
 * - `ASSET_NOT_AVAILABLE` → "the model file isn't available";
 * - anything else (or an empty reasons list) → "cannot run with this
 *   file" — the constant fallback, never a blank line.
 */
export function formatReasonLine(
  status: TxrRunStatus,
  reasons: ReadonlyArray<{ code: TxrReasonCode }>,
  coverage: TxrCoverageFacts,
  minDraws: TxrMinDrawsFacts,
  missingMarkers: ReadonlyArray<{ display_name?: string }>,
  missingGroups: ReadonlyArray<{ display_name?: string }> = [],
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
      return 'no published environment available'
    case 'TASK_INCOMPATIBLE':
      return 'needs an outcome column your file lacks'
    case 'RESPONSE_LABEL_MISSING':
      return 'needs a response label in your file'
    case 'SURVIVAL_OUTCOME_MISSING':
      return 'needs survival times in your file'
    case 'MODEL_REQUIREMENTS_UNRECORDED':
      return "its requirements weren't recorded"
    case 'ASSET_NOT_AVAILABLE':
      return "the model file isn't available"
  }
  // Exhaustive over TxrReasonCode (TEST-UL-13: a code added to the
  // provider's union fails THIS line until a rendering branch covers it).
  // A runtime foreign code — not in the vocabulary — falls to the constant
  // fallback below, never a blank line.
  const _unreachable: never = code
  return 'cannot run with this file'
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
  reasons: ReadonlyArray<{ code: TxrReasonCode }>,
  coverage: TxrCoverageFacts,
  minDraws: TxrMinDrawsFacts,
  missingMarkers: ReadonlyArray<{ display_name?: string }>,
  missingGroups: ReadonlyArray<{ display_name?: string }> = [],
): string[] {
  if (reasons.length === 0) return [formatCoverage(coverage)]
  return reasons.map(r =>
    formatReasonLine(status, [r], coverage, minDraws, missingMarkers, missingGroups),
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
 * AND the screen-B panel): "N of M methods have no published environment and
 * can't start." The count is `total_no_env` — the catalogue methods with no
 * published environment (the list still shows them; the statement is the
 * deployment fact, stated plainly, never a raw code).
 */
export function formatNoEnvLine(noEnv: number, total: number): string {
  return `${noEnv} of ${total} methods have no published environment and can't start.`
}

/** The itemLabel plural: "method" → "methods" (the singular for n === 1). */
export function pluralize(itemLabel: 'method' | 'model', n: number): string {
  return n === 1 ? itemLabel : `${itemLabel}s`
}

/** The Run button label: "Run 5 methods" / "Run 3 models" (boards verbatim). */
export function runLabel(itemLabel: 'method' | 'model', n: number): string {
  return `Run ${n} ${pluralize(itemLabel, n)}`
}
