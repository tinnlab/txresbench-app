/**
 * txrlist method-catalogue adapter — PROV-UI-LIST-3 (the screen-E join).
 *
 * `buildMethodCards` is the redesigned E screen's join (qa-fixes3 ITEM-1):
 * the catalogue's method list (`GET /api/methods`, CONS-UL-1) × the
 * per-method eligibility verdicts (`POST /api/methods/eligibility`,
 * CONS-UL-2) → the module's cards (`TxrMethodCard[]`). The wire shapes are
 * the provider's generated types (`@/api-client/types` — `MethodSummary`,
 * `EligibilityResponse`); this module never regenerates them and never
 * vendors a copy (DEC-11).
 *
 * The join is pure and catalogue-driven:
 *
 * - one card per catalogue method, in the catalogue's order;
 * - `run.status` is the eligibility verdict mapped to the three board
 *   codes (`can_run` → `'can'`, `can_run_some` → `'some'`,
 *   `cannot_run` → `'cannot'`); `disabled` is derived as
 *   `status === 'cannot'`;
 * - the card's reason fields are self-contained board-voice facts built
 *   from the STRUCTURED fields only — `reasons[].code`, `coverage`,
 *   `min_draws`, `missing_markers[].display_name`,
 *   `missing_groups[].display_name` — never `reasons[].params` (DEC-5);
 * - `estimate` comes from the eligibility verdict's `estimated_seconds` +
 *   `estimate_quality` (DEC-6: one estimate call serves the whole list); a
 *   card with no verdict has no estimate;
 * - `rank` renders the benchmark fact (D36) when the summary carries it:
 *   the benchmark's primary aggregate median (`c_index_median`), with kind
 *   `'auc'` when the call-rule aggregate was evaluated (the catalogues
 *   today carry `c_index_median` only — the kind is the fact's own name,
 *   never asserted as one or the other);
 * - a catalogue method the eligibility response does not know is a
 *   defensive fallback card — `cannot`, the NOT_RUNNABLE reason, no
 *   estimate — so a method never silently vanishes from the screen;
 *   an eligibility entry whose id has no catalogue method is dropped (the
 *   catalogue is the list source).
 */
import type { EligibilityResponse, EligibilityStatus, MethodSummary } from '@/api-client/types'
import type { TxrMethodCard, TxrMethodNeeds } from '../types'
import { formatCoverage, formatMethodCoverage, formatReasonLine } from '../lib/format'

/** The provider's three verdict codes → the three board status codes. */
function toRunStatus(status: EligibilityStatus): TxrMethodCard['run']['status'] {
  switch (status) {
    case 'can_run':
      return 'can'
    case 'can_run_some':
      return 'some'
    case 'cannot_run':
      return 'cannot'
  }
}

/** The card's benchmark rank (D36: render only when the summary carries it). */
function rankOf(summary: MethodSummary): TxrMethodCard['rank'] {
  const performance = summary.performance
  if (performance === undefined || performance === null) return null
  if (performance.auc_rule_median !== undefined && performance.auc_rule_median !== null) {
    return {
      median: performance.auc_rule_median,
      kind: 'auc',
      nDatasets: performance.n_datasets,
    }
  }
  return {
    median: performance.c_index_median,
    kind: 'c-index',
    nDatasets: performance.n_datasets,
  }
}

/** The quiet "Needs:" facts from the catalogue summary. */
function needsOf(summary: MethodSummary): TxrMethodNeeds {
  const markers =
    summary.markers.kind === 'any' ? 'any markers'
    : summary.markers.count === 1 ? '1 marker'
    : `${summary.markers.count} markers`
  const covariates =
    summary.covariates === 'optional' ? 'covariates optional'
    : summary.covariates === 'required' ? 'covariates required'
    : null
  return { markers, covariates, draws: `${summary.min_draws}+ draws` }
}

/** The first missing marker's display name, or null (the fix then falls back). */
function firstMissingName(
  markers: ReadonlyArray<{ display_name?: string }>,
): string | null {
  for (const marker of markers) {
    const name = marker.display_name?.trim()
    if (name && name.length > 0) return name
  }
  return null
}

/** The first reason's one-line fix (plain words, names the marker when the
 *  verdict carries one — the plan's "add a column named …"; never blank). */
function reasonFixOf(code: string | null, missingMarkers: ReadonlyArray<{ display_name?: string }> = []): string {
  switch (code) {
    case 'REQUIRED_MARKER_MISSING': {
      const name = firstMissingName(missingMarkers)
      return name !== null ? `Add a column named ${name}` : 'Add a column with the marker the method needs.'
    }
    case 'DETECTION_CALL_MISSING':
      return 'Add a detection-call column (present or absent)'
    case 'MARKER_GROUP_MISSING':
    case 'UNIT_MISMATCH':
      return 'Add a column with the marker the method needs.'
    case 'TASK_INCOMPATIBLE':
    case 'RESPONSE_LABEL_MISSING':
    case 'SURVIVAL_OUTCOME_MISSING':
      return 'Add the outcome column the method needs.'
    case 'MIN_DRAWS_UNMET':
    case 'DECISION_DAY_UNMET':
      return 'Add more draws per patient or adjust the settings.'
    case 'COVARIATE_MISSING':
    case 'COVARIATE_REQUIRED_UNMET':
      return 'Add the extra inputs the method needs.'
    case 'ENV_IMAGE_MISSING':
    case 'NOT_RUNNABLE':
      return 'This method is not available yet.'
    default:
      return 'Check what the method needs.'
  }
}

/** The defensive card for a catalogue method the eligibility response does not know. */
function unavailableCard(summary: MethodSummary): TxrMethodCard {
  return {
    key: summary.id,
    id: summary.id,
    title: summary.title,
    summary: summary.summary,
    paperTitle: summary.paper_title ?? null,
    group: summary.group,
    groupLabel: summary.group_label,
    language: summary.language,
    journal: summary.journal,
    year: summary.year,
    paperDoi: summary.paper_doi,
    estimate: null,
    rank: rankOf(summary),
    needs: needsOf(summary),
    run: {
      status: 'cannot',
      coverageLine: formatMethodCoverage({ eligible: 0, total: 0 }),
      reasonCode: 'NOT_RUNNABLE',
      reasonLine: formatReasonLine(
        'cannot',
        [{ code: 'NOT_RUNNABLE' }],
        { eligible: 0, total: 0 },
        { required: 0, met: 0, unmet_patients: 0 },
        [],
        [],
      ),
      reasonFix: reasonFixOf('NOT_RUNNABLE'),
      disabled: true,
    },
  }
}

/**
 * The redesigned screen-E join: catalogue method list × eligibility
 * verdicts → `TxrMethodCard[]`.
 *
 * Pure: no fetch, no ApiClient, no state — the fetch hooks (`useMethodRows`,
 * `useListEstimate`) call the endpoints and hand the two payloads here, and
 * the gallery and the unit tests feed fixtures over the same wire shapes.
 */
export function buildMethodCards(
  methods: MethodSummary[],
  eligibility: EligibilityResponse,
): TxrMethodCard[] {
  const verdictById = new Map(eligibility.methods.map(verdict => [verdict.id, verdict]))
  return methods.map(summary => {
    const verdict = verdictById.get(summary.id)
    if (verdict === undefined) return unavailableCard(summary)
    const status = toRunStatus(verdict.status)
    const reasonCode = verdict.reasons.length > 0 ? verdict.reasons[0].code : null
    const reasonLine =
      verdict.reasons.length > 0
        ? formatReasonLine(
            status,
            verdict.reasons,
            verdict.coverage,
            verdict.min_draws,
            verdict.missing_markers,
            verdict.missing_groups,
          )
        : formatCoverage(verdict.coverage)
    return {
      key: summary.id,
      id: summary.id,
      title: summary.title,
      summary: summary.summary,
      paperTitle: summary.paper_title ?? null,
      group: summary.group,
      groupLabel: summary.group_label,
      language: summary.language,
      journal: summary.journal,
      year: summary.year,
      paperDoi: summary.paper_doi,
      // A `cannot` card carries NO estimate (the board's cannot rows show no
      // time entry — CM-4: the provider still posts seconds for them, but a
      // method that will not run has no "how long" fact on the card).
      estimate:
        status === 'cannot'
          ? null
          : { seconds: verdict.estimated_seconds, quality: verdict.estimate_quality },
      rank: rankOf(summary),
      needs: needsOf(summary),
      run: {
        status,
        coverageLine: formatMethodCoverage(verdict.coverage),
        reasonCode,
        reasonLine,
        reasonFix: reasonFixOf(reasonCode, verdict.missing_markers),
        disabled: status === 'cannot',
      },
    }
  })
}
