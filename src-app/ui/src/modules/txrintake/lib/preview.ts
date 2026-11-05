/**
 * txrintake screen-B preview lib — ITEM-5 (PROV-UI-INTAKE-4).
 *
 * The pure functions between the six study answers / the provider's preview
 * response and the panel:
 *
 * - `buildStudyPreviewRequest` — the exact PROV-MC-5 preview body (DEC-5):
 *   ALL marker-group ids present with explicit booleans (unchecked =
 *   `false`; absent keys are unambiguous under either reading of the
 *   provider's shape), the schedule answers verbatim, and `last_draw_day`
 *   defaulting to `56` when unanswered (ONE value, three uses: the B panel,
 *   the C/N validation parameters, the E run default).
 * - `fitCounts` — `{total, canRun, some, cannot}` from the response (the
 *   board's fit / left-out split, computed, never hardcoded).
 * - `descriptiveSentence` — the panel headline under the count: the board's
 *   literal template, data-filled ("for colorectal cancer, risk by a day,
 *   with ctDNA, blood counts and LDH"). Answers-not-given render no clause;
 *   nothing here ever renders a count.
 * - `excludedMethods` — the "N methods are left out" list: the `cannot_run`
 *   verdicts in response order, one reason line per method through the
 *   CONS-UI-INTAKE-9 formatters (the injected txrlist surface), with the
 *   module's own lines for the two cases the shared E-vocabulary cannot
 *   render on B (see `excludedReasonLine`).
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

/** The implied schedule of an unanswered B screen (the board's first options). */
export const PREVIEW_DEFAULTS = {
  before_treatment: 'always' as const,
  draws_during_treatment: 1,
  last_draw_day: 56,
}

/** The schedule answers the preview request carries. */
export interface PreviewSchedule {
  before_treatment: 'always' | 'sometimes'
  draws_during_treatment: 1 | 2 | 4
  last_draw_day: number
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
  return {
    marker_groups,
    before_treatment: answers.beforeTreatment ?? PREVIEW_DEFAULTS.before_treatment,
    draws_during_treatment: answers.drawsDuringTreatment ?? PREVIEW_DEFAULTS.draws_during_treatment,
    last_draw_day: answers.lastDrawDay ?? PREVIEW_DEFAULTS.last_draw_day,
  }
}

/** The fit-count split (board's "N of M methods fit" / "N methods are left out"). */
export interface FitCounts {
  /** The catalogue size the panel's "of M" reads. */
  total: number
  /** `total_fit` — methods that can run. */
  canRun: number
  /** `total_some` — methods that can run for some patients. */
  some: number
  /** `total_cannot` — the "left out" count. */
  cannot: number
}

/** Derive the panel's count split from the provider's response. */
export function fitCounts(response: EligibilityResponse): FitCounts {
  return {
    total: response.methods.length,
    canRun: response.total_fit,
    some: response.total_some,
    cannot: response.total_cannot,
  }
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
  'TASK_INCOMPATIBLE',
  'RESPONSE_LABEL_MISSING',
  'SURVIVAL_OUTCOME_MISSING',
])

/**
 * One excluded method's reason line. The B panel has NO per-patient data, so
 * the shared templates that read coverage counts would render the preview's
 * 1-patient stand-in facts ("0 of 1 have them") — a lie the board never
 * shows ("needs 3 or more draws"). The schedule rule therefore renders the
 * board's B line from `min_draws.required`; an inventory-only code
 * (`DECISION_DAY_UNMET`, impossible from a preview but possible in a
 * fixture) and any foreign code fall to the module's constant line.
 * Everything else is the shared E-vocabulary line — one vocabulary for the
 * codes both screens render (DEC-8).
 */
export function excludedReasonLine(
  method: MethodEligibility,
  formatters: TxrPreviewFormatters,
): string {
  const code = method.reasons[0]?.code
  if (code === undefined) return PREVIEW_REASON_FALLBACK
  if (code === 'MIN_DRAWS_UNMET') return `needs ${method.min_draws.required} or more draws`
  if (!PREVIEW_SHARED_CODES.has(code)) return PREVIEW_REASON_FALLBACK
  return formatters.formatReasonLine(
    toRunStatus(method.status),
    method.reasons,
    method.coverage,
    method.min_draws,
    method.missing_markers,
    method.missing_groups,
  )
}

/**
 * The "N methods are left out" list: every `cannot_run` verdict in the
 * response's order (the provider emits deterministic order), one reason line
 * per method. `can_run_some` methods are NOT in it — B labels the heads
 * "N of M fit" and "N are left out", and a method that can run for some
 * patients is neither; the preview can also mark one `can_run_some` with NO
 * reason at all (the "sometimes before-treatment" case), which the board's
 * every-row-has-a-reason list cannot render. The board's visible clip + the
 * truthful "Show all N" affordance live in the page (`EXCLUDED_LIST_LIMIT`).
 */
export function excludedMethods(
  response: EligibilityResponse,
  formatters: TxrPreviewFormatters,
): ExcludedMethod[] {
  return response.methods
    .filter(method => method.status === 'cannot_run')
    .map(method => ({ id: method.id, reasonText: excludedReasonLine(method, formatters) }))
}
