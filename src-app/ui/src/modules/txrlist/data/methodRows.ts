/**
 * txrlist method-catalogue adapter — PROV-UI-LIST-3.
 *
 * `buildMethodRows` is the screen-E join: the catalogue's method list
 * (`GET /api/methods`, CONS-UL-1) × the per-method eligibility verdicts
 * (`POST /api/methods/eligibility`, CONS-UL-2) → the module's rows
 * (`TxrListRow[]`). The wire shapes are the provider's generated types
 * (`@/api-client/types` — `MethodSummary`, `EligibilityResponse`); this
 * module never regenerates them and never vendors a copy (DEC-11: a
 * provider regen that renames a type or operation moves the adapter
 * mechanically with it, and the tests fail loudly until the names match).
 *
 * The join is pure and catalogue-driven:
 *
 * - one row per catalogue method, in the catalogue's order (the list's
 *   order is the catalogue's);
 * - `run.status` is the eligibility verdict mapped to the three board
 *   codes (`can_run` → `'can'`, `can_run_some` → `'some'`,
 *   `cannot_run` → `'cannot'`); `disabled` is derived as
 *   `status === 'cannot'` (EXAMPLE-UL-8);
 * - the row's `headline` and `detail` are board copy produced by
 *   `lib/format.ts` from the STRUCTURED fields only — `reasons[].code`,
 *   `coverage`, `min_draws`, `missing_markers[].display_name`,
 *   `missing_groups[].display_name` — never `reasons[].params` (DEC-5:
 *   the provider's display text is the consumer's, and the formatter
 *   reads only pinned fields);
 * - `timeText` comes from the eligibility verdict's `estimated_seconds`
 *   (DEC-6: one estimate call serves the whole list — no per-row
 *   `POST /api/methods/estimate`); a row with no verdict has no time;
 * - `performanceText` renders the board's performance-column copy
 *   (`"other cohorts: AUC 0.64"`) when the summary carries its
 *   `performance` facts, else `null` (OWNER-UL-1 / D36 — render when the
 *   summary carries it; DEC-17's fallback-null when it does not). The
 *   number is the benchmark's primary aggregate, the median c-index
 *   (D35/OWNER-4's "as defined"), pinned by the provider's
 *   `Performance.c_index_median`; `auc_rule_median` is the optional
 *   call-rule fact the model-card builders read (method-catalogue
 *   DEC-13) and is not rendered here;
 * - a catalogue method the eligibility response does not know is a
 *   defensive fallback row — `cannot`, the `NOT_RUNNABLE` reason line
 *   ("not available with this build"), no time — so a method never
 *   silently vanishes from the screen; reconcile asserts count parity
 *   between the two payloads; an eligibility entry whose id has no
 *   catalogue method is dropped (the catalogue is the list source).
 */
import type { EligibilityResponse, EligibilityStatus, MethodSummary } from '@/api-client/types'
import type { TxrListRow, TxrRunStatus } from '../types'
import {
  formatCoverage,
  formatDurationShort,
  formatReasonLine,
  formatRunHeadline,
} from '../lib/format'

/** The provider's three verdict codes → the three board status codes. */
function toRunStatus(status: EligibilityStatus): TxrRunStatus {
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
 * The row's performance column (board copy "other cohorts: AUC 0.64"),
 * `null` when the summary carries no performance facts (DEC-17's safe
 * degradation — the E board itself shows no performance column for rows
 * that have none to show). The value is the benchmark's primary
 * aggregate, formatted to the board's two decimals.
 */
function performanceText(summary: MethodSummary): string | null {
  const performance = summary.performance
  if (performance === undefined) return null
  return `other cohorts: AUC ${performance.c_index_median.toFixed(2)}`
}

/** The defensive row for a catalogue method the eligibility response does not know. */
function unavailableRow(summary: MethodSummary): TxrListRow {
  const status: TxrRunStatus = 'cannot'
  return {
    key: summary.id,
    name: summary.id,
    tag: `Paper ${summary.year}, ${summary.language}`,
    chip: { label: summary.group_label, tone: 'neutral' },
    performanceText: performanceText(summary),
    run: {
      status,
      headline: formatRunHeadline(status),
      // The NOT_RUNNABLE branch renders a constant ("not available with
      // this build") and reads none of the fact arguments; the zeros are
      // the "no verdict was returned" placeholders, never rendered.
      detail: formatReasonLine(
        status,
        [{ code: 'NOT_RUNNABLE' }],
        { eligible: 0, total: 0 },
        { required: 0, met: 0, unmet_patients: 0 },
        [],
        [],
      ),
      disabled: true,
    },
    timeText: null,
    action: { label: 'About' },
  }
}

/**
 * The screen-E join: catalogue method list × eligibility verdicts →
 * `TxrListRow[]` (PROV-UI-LIST-3).
 *
 * Pure: no fetch, no ApiClient, no state — the fetch hooks (`useMethodRows`,
 * `useListEstimate`) call the endpoints and hand the two payloads here, and
 * the gallery and the unit tests feed fixtures over the same wire shapes
 * (TEST-UL-3 needs no ApiClient mock: the shapes are the generated types).
 */
export function buildMethodRows(
  methods: MethodSummary[],
  eligibility: EligibilityResponse,
): TxrListRow[] {
  const verdictById = new Map(eligibility.methods.map(verdict => [verdict.id, verdict]))
  return methods.map(summary => {
    const verdict = verdictById.get(summary.id)
    if (verdict === undefined) return unavailableRow(summary)
    const status = toRunStatus(verdict.status)
    return {
      key: summary.id,
      name: summary.id,
      tag: `Paper ${summary.year}, ${summary.language}`,
      chip: { label: summary.group_label, tone: 'neutral' },
      performanceText: performanceText(summary),
      run: {
        status,
        headline: formatRunHeadline(status),
        // The row's one detail line: the first reason's board line when
        // the verdict carries reasons, the coverage line otherwise (the
        // boards' "all 151 patients" for a clean run).
        detail:
          verdict.reasons.length > 0
            ? formatReasonLine(
                status,
                verdict.reasons,
                verdict.coverage,
                verdict.min_draws,
                verdict.missing_markers,
                verdict.missing_groups,
              )
            : formatCoverage(verdict.coverage),
        disabled: status === 'cannot',
      },
      timeText: formatDurationShort(verdict.estimated_seconds),
      action: { label: 'About' },
    }
  })
}
