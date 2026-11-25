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
 *   the board's fit / left-out split with the MACHINE facts stripped
 *   (R2-1: a method a deployment fact keeps from starting — no published
 *   environment, or the method runner unavailable — is not a study
 *   answer). `fit` counts the methods with NO answer cause (machine-set
 *   ones included), `leftOut` counts the methods the ANSWERS exclude —
 *   `fit + leftOut === total`, the one closed arithmetic the
 *   review demanded (the old split left 182 methods unaccounted for: the
 *   heading said "1 methods are left out" beside "176 of 359 fit"), and
 *   `noEnvFit` is the machine-set subset of `fit` ("N of them cannot run
 *   yet" — the deployment fact about the SAME methods, never a second
 *   count over the whole catalogue).
 * - `hasStudyAnswers` — the B panel's gate (R2-1): with nothing answered
 *   the panel shows the invite line and the hook sends no unanswered
 *   request (the old panel reported a count from all-groups-false +
 *   default schedule before the user said anything).
 * - `descriptiveSentence` — the panel headline under the count: ONE plain
 *   sentence naming every ANSWERED filter in the page's order, data-filled
 *   ("Methods for lung cancer, given with chemotherapy, that predict the
 *   risk by a set day, using tumour markers, with a draw before treatment,
 *   4 or more draws during treatment and the last draw on day 56").
 *   Answers-not-given render no clause; nothing here ever renders a count.
 * - `excludedMethods` — the "N methods are left out" list: every method
 *   with an ANSWER cause (a non-machine reason — R3-intake-1: the old
 *   list dropped the machine-set methods whose second reason was the
 *   answer's, leaving the heading to disagree with the count), in response
 *   order, ONE reason line per method: the first NON-MACHINE reason
 *   (the machine fact has its own line), through the
 *   CONS-UI-INTAKE-9 formatters (the injected txrlist surface), with the
 *   module's own lines for the cases the shared E-vocabulary cannot render
 *   on B (see `excludedReasonLine`).
 */

import type {
  DiseaseCategory,
  EligibilityResponse,
  FilterOptions,
  InventoryEligibilityRequest,
  MarkerGroup,
  MethodEligibility,
  PlanBlock,
  PreviewEligibilityRequest,
  ReasonCode,
  SingleMarkerChoice,
  TreatmentClass,
} from '@/api-client/types'
import type { TxrRunStatus } from '@/modules/txrlist/types'
import type {
  TxrCoverageFacts,
  TxrMinDrawsFacts,
  TxrReasonCode,
  TxrReasonLabels,
  TxrReasonParams,
} from '@/modules/txrlist/lib/format'
import {
  PREVIEW_REASON_FALLBACK,
  diseaseClause,
  groupShortName,
  outcomeClause,
  scheduleClause,
  treatmentClause,
} from './format'
import { buildMethodFilters } from './filters'
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

/** Build the exact PROV-MC-5 preview body (DEC-5: all group ids explicit).
 *  The three method-filter facts ride the SAME body the inventory `filters`
 *  block carries, flattened to the top level (`disease_group`,
 *  `treatment_classes`, `method_group`); an unanswered question is OMITTED
 *  (never `null`, never an empty list — the same rule as the schedule
 *  answers, and the same builder the E screen's `filters` block uses).
 *  The vocabulary is the same builder's answer-validity gate (step2-filters,
 *  brief 5a3): only ids it knows are sent, and while it is not loaded the
 *  disease/treatment fields are omitted (the outcome is still sent).
 *
 *  Single-marker-choice round 2: when the file is in, the VALIDATED inventory
 *  block rides the body (`inventory`) together with the step-3 marker plan
 *  (`markerPlan`), so the panel's marker verdicts are the inventory path's
 *  (the count on the plan's markers / the plan's refusal). The plan is
 *  `mode` + the `marker` only — the ranking needs the endpoint and decision
 *  day, which are step 4's authority, so step 3's plan cannot carry `top`
 *  (and the ranked plan is OMITTED — see [`step3MarkerPlan`]). */
export function buildStudyPreviewRequest(
  answers: StudyAnswers,
  groups: ReadonlyArray<MarkerGroup>,
  vocabulary: FilterOptions | null,
  inventory: InventoryEligibilityRequest | null = null,
  markerPlan: PlanBlock | null = null,
): PreviewEligibilityRequest {
  const marker_groups: Record<string, boolean> = {}
  for (const group of groups) {
    marker_groups[group.id] = answers.markerGroups?.[group.id] ?? false
  }
  const request: PreviewEligibilityRequest = {
    marker_groups,
    ...buildMethodFilters(answers, vocabulary),
  }
  if (answers.beforeTreatment !== null) request.before_treatment = answers.beforeTreatment
  if (answers.drawsDuringTreatment !== null) request.draws_during_treatment = answers.drawsDuringTreatment
  if (answers.lastDrawDay !== null) request.last_draw_day = answers.lastDrawDay
  if (inventory !== null) request.inventory = inventory
  if (markerPlan !== null) request.marker_plan = markerPlan
  return request
}

/**
 * The step-3 preview's marker plan (round 2): the choice's `mode` and, for
 * `chosen`, the marker — and NOTHING else (no `top`/`offered`/`error`: the
 * ranking is step 4's, the file check's day is not the run's day). The
 * `ranked` choice sends NO plan: with a ranked block that carries no top the
 * server's count rule would evaluate every no-list method on zero markers
 * (a multi k=2 method on a two-marker file would flip from fitting to
 * count-refused); without the block the panel keeps today's exact verdicts
 * while step 4's ranking (the authority) fills the order in.
 */
export function step3MarkerPlan(choice: SingleMarkerChoice): PlanBlock | null {
  switch (choice.mode) {
    case 'ranked':
      return null
    case 'chosen':
      return { mode: 'chosen', marker: choice.marker }
    case 'leave_out':
      return { mode: 'leave_out' }
  }
}

/** The fit-count split (board's "N of M methods fit" / "N methods are left out"). */
export interface FitCounts {
  /** The catalogue size the panel's "of M" reads. */
  total: number
  /**
   * The board's fit count — methods with NO answer cause (R2-1 + R3-intake-1):
   * the runnable ones plus the machine-set methods whose ONLY reason is a
   * machine reason (no published environment, or the method runner
   * unavailable — their study verdict is nothing but "can't start yet"; the
   * `noEnvFit` line right below states that fact). The board's own
   * arithmetic is inclusive here (some-fit methods are inside the headline
   * count and `some` is the subset note beneath it).
   */
  fit: number
  /** `total_some` — methods that can run for some patients. */
  some: number
  /**
   * The answer-caused left-out count: the methods whose ANSWERS exclude
   * them (a non-machine reason), machine-set ones with an answer cause
   * INCLUDED — their non-machine reason is the answer's, and the list
   * below shows it (R3-intake-1: the old split left it unaccounted, and
   * `fit + leftOut` was not `total`). A machine reason alone is never
   * a left-out cause (R2-1 — the machine line is its own fact).
   */
  leftOut: number
  /**
   * The machine-set subset of `fit` — the "N of them cannot run yet" line
   * (R3-intake-1: the old env line counted "N of M" over the whole
   * catalogue and contradicted the headline; this is the deployment fact
   * about the SAME methods that fit, stated only when relevant).
   */
  noEnvFit: number
}

/**
 * Derive the panel's count split from the provider's response. The
 * per-method classification is exact: an answer cause is ANY non-machine
 * reason (the eligibility stage pushes the machine reason — RUNNER_UNAVAILABLE,
 * or the runtime stage's `ENV_IMAGE_MISSING` — FIRST, so a method
 * whose answers also exclude it carries both and counts as left-out — the
 * answer's reason is the one the list shows); among the rest, everything
 * fits (machine-set ones are the `noEnvFit` subset — the machine line's fact).
 * The closed arithmetic `fit + leftOut === total` is the panel's one story
 * (R3-intake-1: the old split's `total_cannot − total_no_env` left the
 * machine+answer methods in neither count, so the heading and the count
 * disagreed).
 */
export function fitCounts(response: EligibilityResponse): FitCounts {
  const answerCaused = response.methods.filter(m => m.status === 'cannot_run' && hasAnswerCause(m)).length
  const noEnvFit = response.methods.filter(m => hasMachineReason(m) && !hasAnswerCause(m)).length
  return {
    total: response.methods.length,
    fit: response.methods.length - answerCaused,
    some: response.total_some,
    leftOut: answerCaused,
    noEnvFit,
  }
}

/** The MACHINE reasons — facts about the deployment, never the answers:
 *  `ENV_IMAGE_MISSING` (a method with no published environment image in
 *  the app's manifest) and `RUNNER_UNAVAILABLE` (no method can run at all:
 *  on Windows, WSL 2 missing, too old or turned off, the app's WSL runtime
 *  missing, or the app's run folder not creatable — the start-up check's
 *  verdict). Both are pushed FIRST by the eligibility pipeline — the runner
 *  code ahead of the environment one — so a mixed method's first reason is
 *  always a machine reason, whichever machine fact it carries, and the
 *  panel's machine line ("N of them cannot run yet") owns it. */
function isMachineReason(code: string): boolean {
  return code === 'ENV_IMAGE_MISSING' || code === 'RUNNER_UNAVAILABLE'
}

/** Whether a method's causes include a machine reason (the runtime stage's
 *  `cantRun` reclassification — the reason is pushed FIRST by
 *  `with_runtime_env`, so a mixed method reads as "no published
 *  environment", the fact that keeps it from starting; the runner code is
 *  pushed even earlier by the eligibility stage). */
function hasMachineReason(method: MethodEligibility): boolean {
  return method.reasons.some(reason => isMachineReason(reason.code))
}

/** Whether a method's causes include an answer fact (any non-machine
 *  reason — a missing marker group, too few draws, a task mismatch …).
 *  Exported to the single-marker facts (round 2): the step-3 group's "fits
 *  the answers" is exactly this classification. */
export function hasAnswerCause(method: MethodEligibility): boolean {
  return method.reasons.some(reason => !isMachineReason(reason.code))
}

/**
 * The code one excluded row is grouped by (step2-filters, brief 5b): the
 * row's FIRST non-machine reason — the same code the row's reason line
 * renders (the machine fact has its own line, R3-intake-1; the runtime
 * stage pushes it FIRST — the runner code ahead of the environment one —
 * so a mixed method's grouping reads its answer cause, never the machine
 * fact). `null` only for a method whose EVERY reason is a machine reason —
 * that method is never listed in the first place.
 */
export function excludedReasonCode(method: MethodEligibility): ReasonCode | null {
  return method.reasons.find(reason => !isMachineReason(reason.code))?.code ?? null
}

/** One excluded-method row (the id + the one reason line the list shows). */
export interface ExcludedMethod {
  id: string
  reasonText: string
  /** The code the grouped list buckets the row under (see `excludedReasonCode`). */
  reasonCode: ReasonCode
}

/**
 * The grouped left-out list's bucket codes (step2-filters, brief 5b): the
 * answer-caused three each get their own collapsible section — in this
 * order — and every other reason code shares one section.
 */
export type ExcludedGroupCode =
  | 'DISEASE_NOT_MATCHED'
  | 'TREATMENT_NOT_MATCHED'
  | 'OUTCOME_NOT_MATCHED'
  | 'other'

/** One grouped left-out section: the bucket code + its rows in list order. */
export interface ExcludedGroup {
  code: ExcludedGroupCode
  methods: ExcludedMethod[]
}

/** The fixed section order (disease, treatment, outcome, everything else). */
const EXCLUDED_GROUP_ORDER: readonly ExcludedGroupCode[] = [
  'DISEASE_NOT_MATCHED',
  'TREATMENT_NOT_MATCHED',
  'OUTCOME_NOT_MATCHED',
  'other',
]

/** The bucket of one reason code: the three answer codes keep their names,
 *  everything else (a missing marker, too few draws, a task mismatch …) is
 *  the section's "do not fit" bucket. */
export function excludedGroupCode(code: ReasonCode): ExcludedGroupCode {
  return code === 'DISEASE_NOT_MATCHED' ||
    code === 'TREATMENT_NOT_MATCHED' ||
    code === 'OUTCOME_NOT_MATCHED'
    ? code
    : 'other'
}

/**
 * The excluded list as the grouped sections the panel renders: the
 * answer-caused three first (disease, treatment, outcome), then the
 * one "do not fit" bucket with every other code, each section's rows in
 * the list's own order, empty sections omitted.
 */
export function groupExcludedMethods(methods: ReadonlyArray<ExcludedMethod>): ExcludedGroup[] {
  const byCode = new Map<ExcludedGroupCode, ExcludedMethod[]>()
  for (const method of methods) {
    const code = excludedGroupCode(method.reasonCode)
    const bucket = byCode.get(code)
    if (bucket === undefined) byCode.set(code, [method])
    else bucket.push(method)
  }
  return EXCLUDED_GROUP_ORDER.filter(code => byCode.has(code)).map(code => ({
    code,
    methods: byCode.get(code) ?? [],
  }))
}

/**
 * The panel's descriptive sentence — ONE plain sentence naming every
 * ANSWERED filter, in the page's question order:
 *
 *     Methods for lung cancer, given with chemotherapy, that predict the
 *     risk by a set day, using tumour markers, with a draw before
 *     treatment, 4 or more draws during treatment and the last draw on
 *     day 56. This updates as you answer.
 *
 * Only the ANSWERED parts render clauses; an unanswered question (null, or
 * an empty treatment list) adds nothing. The marker-group clause needs no
 * answer at all (all-false counts as "using no marker groups" — the user
 * saw the checkboxes). The group names are the board's SHORT forms
 * (`groupShortName`); the full `display_name` values belong on the
 * checkboxes, not in a sentence. The disease clause follows "Methods" with
 * a space, every later clause with a comma, except that the first clause
 * never takes one ("Methods given with chemotherapy") — the clause helpers carry
 * their own separators.
 */
/** "a, b and c" — the sentence's list join (no Oxford comma, board style). */
function joinPhrases(phrases: ReadonlyArray<string>): string {
  if (phrases.length <= 1) return phrases.join('')
  return `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`
}

/** The vocabulary the descriptive sentence reads (step3-step4-fixes): the
 *  disease categories (to recognise a category-id answer) and the treatment
 *  classes (the display labels) — either may be empty while the filter
 *  options load, in which case the ids are the honest text. */
export interface SentenceVocabulary {
  categories: ReadonlyArray<DiseaseCategory>
  treatmentClasses: ReadonlyArray<TreatmentClass>
}

export function descriptiveSentence(answers: StudyAnswers, vocab: SentenceVocabulary): string {
  const clauses: string[] = []
  if (answers.disease !== null) {
    clauses.push(` for ${diseaseClause(answers.disease, vocab.categories)}`)
  }
  if (answers.treatments !== null && answers.treatments.length > 0) {
    clauses.push(`, ${treatmentClause(answers.treatments, vocab.treatmentClasses)}`)
  }
  if (answers.outcome !== null) {
    clauses.push(`, that predict ${outcomeClause(answers.outcome)}`)
  }
  if (answers.markerGroups !== null) {
    const checked = Object.keys(answers.markerGroups).filter(
      id => answers.markerGroups?.[id] === true,
    )
    clauses.push(
      checked.length > 0
        ? `, using ${joinPhrases(checked.map(groupShortName))}`
        : ', using no marker groups',
    )
  }
  const schedule = scheduleClause(answers)
  if (schedule !== null) clauses.push(`, ${schedule}`)
  if (clauses.length === 0) return 'This updates as you answer.'
  // The first clause after "Methods" takes no comma ("Methods given with
  // chemotherapy."); only the disease clause starts with a space already.
  return `Methods${clauses.join('').replace(/^,/, '')}. This updates as you answer.`
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
    (answers.treatments !== null && answers.treatments.length > 0) ||
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
 * `labels` is the vocabulary's label table (step2-filters, brief 5a3): the
 * treatment-class display names the reason lines read — the production
 * binding (the preview hook) threads the loaded vocabulary's
 * `treatment_classes` here, so B and E render the same names.
 */
export interface TxrPreviewFormatters {
  formatReasonLine(
    status: TxrRunStatus,
    reasons: ReadonlyArray<{ code: TxrReasonCode; params?: unknown }>,
    coverage: TxrCoverageFacts,
    minDraws: TxrMinDrawsFacts,
    missingMarkers: ReadonlyArray<{ display_name?: string }>,
    missingGroups?: ReadonlyArray<{ display_name?: string }>,
    labels?: TxrReasonLabels,
  ): string
  /** The vocabulary's treatment-class labels for the reason lines. */
  labels?: TxrReasonLabels
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
  'RUNNER_UNAVAILABLE',
  'TASK_INCOMPATIBLE',
  'RESPONSE_LABEL_MISSING',
  'SURVIVAL_OUTCOME_MISSING',
  // step2-filters: the answers' own three verdict causes (disease /
  // treatment / outcome mismatch) — the shared E-vocabulary templates read
  // only the verdict's structured params, so B renders them too.
  'DISEASE_NOT_MATCHED',
  'TREATMENT_NOT_MATCHED',
  'OUTCOME_NOT_MATCHED',
])

/**
 * One excluded method's reason line. The B panel has NO per-patient data, so
 * the shared templates that read coverage counts would render the preview's
 * 1-patient stand-in facts ("0 of 1 have them") — a lie the board never
 * shows ("needs 3 or more draws"). The rendered cause is the first
 * NON-MACHINE reason (R3-intake-1: the runtime stage pushes the machine
 * fact first — the runner code ahead of the environment one — and a mixed
 * method's answer cause is what the list is about; the machine fact has its
 * own line, "N of them cannot run yet"). The schedule rule therefore
 * renders the board's B line from `min_draws.required`; an inventory-only
 * code (`DECISION_DAY_UNMET`, impossible from a preview but possible in a
 * fixture) and anything outside the shared set fall to the module's
 * constant line.
 */
export function excludedReasonLine(
  method: MethodEligibility,
  formatters: TxrPreviewFormatters,
): string {
  const code = excludedReasonCode(method)
  if (code === null) {
    // A method whose ONLY cause is a machine reason never reaches the list
    // (its line is the machine line/fact); the direct line still tells its
    // truth — the shared E-vocabulary sentence, never a blank.
    return formatters.formatReasonLine(
      toRunStatus(method.status),
      method.reasons,
      method.coverage,
      method.min_draws,
      method.missing_markers,
      method.missing_groups,
      formatters.labels,
    )
  }
  if (code === 'MIN_DRAWS_UNMET') return `needs ${method.min_draws.required} or more draws`
  if (!PREVIEW_SHARED_CODES.has(code)) return PREVIEW_REASON_FALLBACK
  return formatters.formatReasonLine(
    toRunStatus(method.status),
    method.reasons.filter(reason => !isMachineReason(reason.code)),
    method.coverage,
    method.min_draws,
    method.missing_markers,
    method.missing_groups,
    formatters.labels,
  )
}

/**
 * The "N methods are left out" list: every `cannot_run` verdict with an
 * ANSWER cause in the response's order (the provider emits deterministic
 * order), one reason line per method. The MACHINE-ONLY verdicts are NOT in
 * it — R2-1 separates the machine facts: those methods fit the answers and
 * read the panel's "N of them cannot run yet" line (their row reason would
 * be the one sentence repeated hundreds of times, the wall the R2-5 fix
 * removes from the file cards) and the choose-methods screen lists them one
 * by one. A method with BOTH causes (machine + answer) IS in it — its
 * answer reason is what the heading counts (R3-intake-1), and its machine
 * fact is the separate line. `can_run_some` methods are NOT in it either —
 * B labels the heads "N of M fit" and "N are left out", and a method that
 * can run for some patients is neither. The board's visible clip + the
 * truthful "Show all N" affordance live in the page (`EXCLUDED_LIST_LIMIT`).
 */
export function excludedMethods(
  response: EligibilityResponse,
  formatters: TxrPreviewFormatters,
): ExcludedMethod[] {
  return response.methods
    .filter(method => method.status === 'cannot_run' && hasAnswerCause(method))
    .map(method => {
      // The grouping code is the FIRST reason the row's line shows — the first
      // non-machine reason (a mixed machine+answer method reads its answer
      // cause; the machine fact has its own line, R3-intake-1). The
      // `hasAnswerCause` filter above guarantees such a reason exists, so the
      // old `?? 'ENV_IMAGE_MISSING'` fallback was unreachable — and worse,
      // naming a machine fact as the grouping code would make the section
      // heading contradict the row it holds (brief 5b2 ITEM-2/5).
      const reasonCode = excludedReasonCode(method)!
      return {
        id: method.id,
        reasonText: excludedReasonLine(method, formatters),
        reasonCode,
      }
    })
}
