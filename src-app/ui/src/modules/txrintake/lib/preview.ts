/**
 * txrintake screen-B preview lib — ITEM-5 (PROV-UI-INTAKE-4).
 *
 * The pure functions between the six study answers / the provider's preview
 * response and the panel:
 *
 * - `buildStudyPreviewRequest` — the exact PROV-MC-5 preview body (DEC-5):
 *   ALL marker-group ids present with explicit booleans (unchecked =
 *   `false`; absent keys are unambiguous under either reading of the
 *   provider's shape) and the schedule answers verbatim. An UNANSWERED
 *   schedule question is OMITTED from the body — R3-intake-2: the old
 *   request sent the board's first options (`always`/`1`/`56`) when
 *   unanswered, so an untouched question narrowed the fit count as if the
 *   user had answered it ("merely ticking 'Chance of response' excluded
 *   every method needing 2+ draws"); the provider reads an absent field as
 *   "any" (no constraint), and the panel then answers only what was asked.
 *   The E run / validation defaults are the store's own parameters, not
 *   this body (DEC-5's "one value, three uses" is the store's decision day).
 * - `fitCounts` — `{total, fit, some, leftOut, noEnvFit}` from the response:
 *   the board's fit / left-out split with the environment fact STRIPPED
 *   (R2-1: a method without a published environment is a deployment fact,
 *   not a study answer). `fit` counts the methods with NO answer cause
 *   (env-absent ones included), `leftOut` counts the methods the ANSWERS
 *   exclude — `fit + leftOut === total`, the one closed arithmetic the
 *   review demanded (the old split left 182 methods unaccounted for: the
 *   heading said "1 methods are left out" beside "176 of 359 fit"), and
 *   `noEnvFit` is the env-absent subset of `fit` ("N of them cannot run
 *   yet" — the deployment fact about the SAME methods, never a second
 *   count over the whole catalogue).
 * - `hasStudyAnswers` — the B panel's gate (R2-1): with nothing answered
 *   the panel shows the invite line and the hook sends no unanswered
 *   request (the old panel reported a count from all-groups-false +
 *   default schedule before the user said anything).
 * - `descriptiveSentence` — the panel headline under the count: the board's
 *   literal template, data-filled ("for colorectal cancer, risk by a day,
 *   with ctDNA, blood counts and LDH"). Answers-not-given render no clause;
 *   nothing here ever renders a count.
 * - `excludedMethods` — the "N methods are left out" list: every method
 *   with an ANSWER cause (a non-environment reason — R3-intake-1: the old
 *   list dropped the env-absent methods whose second reason was the
 *   answer's, leaving the heading to disagree with the count), in response
 *   order, ONE reason line per method: the first NON-ENVIRONMENT reason
 *   (the environment fact has its own line), through the
 *   CONS-UI-INTAKE-9 formatters (the injected txrlist surface), with the
 *   module's own lines for the cases the shared E-vocabulary cannot render
 *   on B (see `excludedReasonLine`).
 */

import type {
  EligibilityResponse,
  MarkerGroup,
  MethodEligibility,
  PreviewEligibilityRequest,
} from '@/api-client/types'
import type { TxrRunStatus } from '@/modules/txrlist/types'
import type {
  TxrCoverageFacts,
  TxrMinDrawsFacts,
  TxrReasonCode,
} from '@/modules/txrlist/lib/format'
import {
  PREVIEW_REASON_FALLBACK,
  diseaseClause,
  groupShortName,
  outcomeClause,
} from './format'
import type { StudyAnswers } from '../types'

/** The schedule answers the preview request carries — each is OPTIONAL:
 *  an unanswered question is OMITTED from the body and the provider reads
 *  it as "any" (R3-intake-2 — the old defaults were the board's first
 *  options and made an untouched question narrow the fit count). */
export interface PreviewSchedule {
  before_treatment?: 'always' | 'sometimes'
  draws_during_treatment?: 1 | 2 | 4
  last_draw_day?: number
}

/** Build the exact PROV-MC-5 preview body (DEC-5: all group ids explicit). */
export function buildStudyPreviewRequest(
  answers: StudyAnswers,
  groups: ReadonlyArray<MarkerGroup>,
): PreviewEligibilityRequest {
  const marker_groups: Record<string, boolean> = {}
  for (const group of groups) {
    marker_groups[group.id] = answers.markerGroups?.[group.id] ?? false
  }
  const request: PreviewEligibilityRequest = { marker_groups }
  if (answers.beforeTreatment !== null) request.before_treatment = answers.beforeTreatment
  if (answers.drawsDuringTreatment !== null) request.draws_during_treatment = answers.drawsDuringTreatment
  if (answers.lastDrawDay !== null) request.last_draw_day = answers.lastDrawDay
  return request
}

/** The fit-count split (board's "N of M methods fit" / "N methods are left out"). */
export interface FitCounts {
  /** The catalogue size the panel's "of M" reads. */
  total: number
  /**
   * The board's fit count — methods with NO answer cause (R2-1 + R3-intake-1):
   * the runnable ones plus the env-absent methods whose ONLY reason is the
   * environment (their study verdict is nothing but "can't start yet"; the
   * `noEnvFit` line right below states that fact). The board's own
   * arithmetic is inclusive here (some-fit methods are inside the headline
   * count and `some` is the subset note beneath it).
   */
  fit: number
  /** `total_some` — methods that can run for some patients. */
  some: number
  /**
   * The answer-caused left-out count: the methods whose ANSWERS exclude
   * them (a non-environment reason), env-absent ones with an answer cause
   * INCLUDED — their non-environment reason is the answer's, and the list
   * below shows it (R3-intake-1: the old split left it unaccounted, and
   * `fit + leftOut` was not `total`). The environment fact alone is never
   * a left-out cause (R2-1 — the env line is its own fact).
   */
  leftOut: number
  /**
   * The env-absent subset of `fit` — the "N of them cannot run yet" line
   * (R3-intake-1: the old env line counted "N of M" over the whole
   * catalogue and contradicted the headline; this is the deployment fact
   * about the SAME methods that fit, stated only when relevant).
   */
  noEnvFit: number
}

/**
 * Derive the panel's count split from the provider's response. The
 * per-method classification is exact: an answer cause is ANY non-environment
 * reason (the runtime stage pushes `ENV_IMAGE_MISSING` FIRST, so a method
 * whose answers also exclude it carries both and counts as left-out — the
 * answer's reason is the one the list shows); among the rest, everything
 * fits (env-absent ones are the `noEnvFit` subset — the env line's fact).
 * The closed arithmetic `fit + leftOut === total` is the panel's one story
 * (R3-intake-1: the old split's `total_cannot − total_no_env` left the
 * env+answer methods in neither count, so the heading and the count
 * disagreed).
 */
export function fitCounts(response: EligibilityResponse): FitCounts {
  const answerCaused = response.methods.filter(m => m.status === 'cannot_run' && hasAnswerCause(m)).length
  const noEnvFit = response.methods.filter(m => hasEnvReason(m) && !hasAnswerCause(m)).length
  return {
    total: response.methods.length,
    fit: response.methods.length - answerCaused,
    some: response.total_some,
    leftOut: answerCaused,
    noEnvFit,
  }
}

/** Whether a method's causes include the environment (the runtime stage's
 *  `cantRun` reclassification — the reason is pushed FIRST by
 *  `with_runtime_env`, so a mixed method reads as "no published
 *  environment", the fact that keeps it from starting). */
function hasEnvReason(method: MethodEligibility): boolean {
  return method.reasons.some(reason => reason.code === 'ENV_IMAGE_MISSING')
}

/** Whether a method's causes include an answer fact (any non-environment
 *  reason — a missing marker group, too few draws, a task mismatch …). */
function hasAnswerCause(method: MethodEligibility): boolean {
  return method.reasons.some(reason => reason.code !== 'ENV_IMAGE_MISSING')
}

/** One excluded-method row (the id + the one reason line the list shows). */
export interface ExcludedMethod {
  id: string
  reasonText: string
}

/**
 * The panel's descriptive sentence — the board's template, data-filled:
 *
 *     for colorectal cancer, risk by a day, with ctDNA, blood counts and LDH.
 *     This updates as you answer.
 *
 * Only the ANSWERED parts render clauses; the marker-group clause needs no
 * answer at all (all-seven-false counts as "with no marker groups" — the
 * user saw the checkboxes). The group names are the board's SHORT forms
 * (`groupShortName`); the full `display_name` values belong on the
 * checkboxes, not in a sentence.
 */
/** "a, b and c" — the sentence's list join (no Oxford comma, board style). */
function joinPhrases(phrases: ReadonlyArray<string>): string {
  if (phrases.length <= 1) return phrases.join('')
  return `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`
}

export function descriptiveSentence(answers: StudyAnswers): string {
  const clauses: string[] = []
  if (answers.disease !== null) clauses.push(`for ${diseaseClause(answers.disease)}`)
  if (answers.outcome !== null) clauses.push(outcomeClause(answers.outcome))
  if (answers.markerGroups !== null) {
    const checked = Object.keys(answers.markerGroups).filter(
      id => answers.markerGroups?.[id] === true,
    )
    clauses.push(
      checked.length > 0
        ? `with ${joinPhrases(checked.map(groupShortName))}`
        : 'with no marker groups',
    )
  }
  const head = clauses.join(', ')
  return head.length > 0 ? `${head}. This updates as you answer.` : 'This updates as you answer.'
}

/** The provider's three verdict codes → the shared list's three board codes. */
export function toRunStatus(status: EligibilityResponse['methods'][number]['status']): TxrRunStatus {
  switch (status) {
    case 'can_run':
      return 'can'
    case 'can_run_some':
      return 'some'
    case 'cannot_run':
      return 'cannot'
  }
}

/**
 * The gate R2-1 adds to screen B: whether ANY study answer exists. The
 * store's birth state is all-null; the first answer (a disease, an outcome
 * pill, a marker-group checkbox, a schedule choice) flips it. With nothing
 * answered the panel renders the invite line and the hook issues NO
 * request — the old page reported "N of M methods fit" from an all-false /
 * default-schedule body the user never composed (the review's (c)).
 */
export function hasStudyAnswers(answers: StudyAnswers): boolean {
  return (
    answers.disease !== null ||
    answers.treatment !== null ||
    answers.outcome !== null ||
    answers.markerGroups !== null ||
    answers.beforeTreatment !== null ||
    answers.drawsDuringTreatment !== null ||
    answers.lastDrawDay !== null
  )
}

/** The panel's line before the first answer (R2-1: the honest no-count state). */
export const PREVIEW_ANSWER_INVITE =
  'Answer the questions above to see which methods fit your study.'

/**
 * The CONS-UI-INTAKE-9 formatter surface `excludedMethods` receives — the
 * real txrlist functions, injected so the pure lib stays testable with the
 * same bytes the page binds. The fallback for B lives HERE (`PREVIEW_REASON_FALLBACK`),
 * not in the formatter: the E-row fallback is file-phrased.
 */
export interface TxrPreviewFormatters {
  formatReasonLine(
    status: TxrRunStatus,
    reasons: ReadonlyArray<{ code: TxrReasonCode }>,
    coverage: TxrCoverageFacts,
    minDraws: TxrMinDrawsFacts,
    missingMarkers: ReadonlyArray<{ display_name?: string }>,
    missingGroups?: ReadonlyArray<{ display_name?: string }>,
  ): string
}

/**
 * The provider's closed reason-code vocabulary the B panel renders through
 * the shared E formatter (CONS-UI-INTAKE-9): every code EXCEPT the two whose
 * templates read per-patient data the preview cannot provide
 * (`MIN_DRAWS_UNMET` gets the board's B line, `DECISION_DAY_UNMET` is
 * inventory-only). A code outside this set — a future provider addition
 * whose E-template may or may not be patient-free — renders the module's
 * fallback: honest, never blank, and pinned by a test until someone proves
 * the shared line is data-supported on B.
 */
const PREVIEW_SHARED_CODES: ReadonlySet<string> = new Set([
  'REQUIRED_MARKER_MISSING',
  'MARKER_GROUP_MISSING',
  'DETECTION_CALL_MISSING',
  'COVARIATE_MISSING',
  'COVARIATE_REQUIRED_UNMET',
  'UNIT_MISMATCH',
  'NOT_RUNNABLE',
  'ENV_IMAGE_MISSING',
  'TASK_INCOMPATIBLE',
  'RESPONSE_LABEL_MISSING',
  'SURVIVAL_OUTCOME_MISSING',
])

/**
 * One excluded method's reason line. The B panel has NO per-patient data, so
 * the shared templates that read coverage counts would render the preview's
 * 1-patient stand-in facts ("0 of 1 have them") — a lie the board never
 * shows ("needs 3 or more draws"). The rendered cause is the first
 * NON-ENVIRONMENT reason (R3-intake-1: the runtime stage pushes the
 * environment fact first, and a mixed method's answer cause is what the
 * list is about — the env fact has its own line, "N of them cannot run
 * yet"). The schedule rule therefore renders the board's B line from
 * `min_draws.required`; an inventory-only code (`DECISION_DAY_UNMET`,
 * impossible from a preview but possible in a fixture) and anything outside
 * the shared set fall to the module's constant line.
 */
export function excludedReasonLine(
  method: MethodEligibility,
  formatters: TxrPreviewFormatters,
): string {
  const code = method.reasons.find(reason => reason.code !== 'ENV_IMAGE_MISSING')?.code
  if (code === undefined) {
    // A method whose ONLY cause is the environment never reaches the list
    // (the env line is its fact); the direct line still tells its truth —
    // the shared E-vocabulary sentence, never a blank.
    return formatters.formatReasonLine(
      toRunStatus(method.status),
      method.reasons,
      method.coverage,
      method.min_draws,
      method.missing_markers,
      method.missing_groups,
    )
  }
  if (code === 'MIN_DRAWS_UNMET') return `needs ${method.min_draws.required} or more draws`
  if (!PREVIEW_SHARED_CODES.has(code)) return PREVIEW_REASON_FALLBACK
  return formatters.formatReasonLine(
    toRunStatus(method.status),
    method.reasons.filter(reason => reason.code !== 'ENV_IMAGE_MISSING'),
    method.coverage,
    method.min_draws,
    method.missing_markers,
    method.missing_groups,
  )
}

/**
 * The "N methods are left out" list: every `cannot_run` verdict with an
 * ANSWER cause in the response's order (the provider emits deterministic
 * order), one reason line per method. The ENV_ONLY verdicts are NOT in it —
 * R2-1 separates the environment fact: those methods fit the answers and
 * read the panel's "N of them cannot run yet" line (their row reason would
 * be the one sentence repeated hundreds of times, the wall the R2-5 fix
 * removes from the file cards) and the choose-methods screen lists them one
 * by one. A method with BOTH causes (env + answer) IS in it — its answer
 * reason is what the heading counts (R3-intake-1), and its env fact is the
 * separate line. `can_run_some` methods are NOT in it either — B labels the
 * heads "N of M fit" and "N are left out", and a method that can run for
 * some patients is neither. The board's visible clip + the truthful "Show
 * all N" affordance live in the page (`EXCLUDED_LIST_LIMIT`).
 */
export function excludedMethods(
  response: EligibilityResponse,
  formatters: TxrPreviewFormatters,
): ExcludedMethod[] {
  return response.methods
    .filter(method => method.status === 'cannot_run' && hasAnswerCause(method))
    .map(method => ({ id: method.id, reasonText: excludedReasonLine(method, formatters) }))
}
