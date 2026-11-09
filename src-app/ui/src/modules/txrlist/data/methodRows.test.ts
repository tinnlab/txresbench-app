/**
 * TEST-UL-3 — txrlist method-catalogue adapter: `buildMethodRows`
 * (PROV-UI-LIST-3, INV-1).
 *
 * The join is pure, so no ApiClient mock is needed here: the fixtures are
 * the provider's generated wire types (`MethodSummary[]`,
 * `EligibilityResponse` — `@/api-client/types`), so a provider regen that
 * renames or reshapes either payload breaks the typecheck on this file
 * until the join moves with it (DEC-11's mechanical-move contract).
 *
 * Pinned behaviours (EXAMPLE-UL-2 + the adapter clauses of PROV-UI-LIST-3):
 *
 * - one row per catalogue method, in catalogue order, keyed by the method
 *   id — the E-row's `name` is the monospace id from the board;
 * - `tag` = "Paper <year>, <language>"; `chip` = the group label with the
 *   board's neutral tone; `action` = { label: 'About' };
 * - `run.status` follows the eligibility verdict (can_run / can_run_some /
 *   cannot_run → can / some / cannot), `run.disabled` is `cannot`, the
 *   headline is the board string, and the detail line is FIRST-reason board
 *   copy when the verdict carries reasons, the coverage line otherwise;
 * - `timeText` comes from the verdict's `estimated_seconds` — except on a
 *   `cannot` row, which carries NO time (CM-4: the board shows none and the
 *   provider still posts seconds);
 * - `performanceText` renders "other cohorts: AUC <2dp>" when the summary
 *   carries its performance facts (OWNER-UL-1 / D36), else null;
 * - a catalogue method the eligibility response does not know becomes a
 *   `cannot` row with the NOT_RUNNABLE reason line ("not available with
 *   this build") and no time — a method never silently disappears; an
 *   eligibility-only id is dropped (the catalogue is the list source);
 * - the join never mutates its inputs.
 */
import { describe, expect, it } from 'vitest'
import type {
  EligibilityResponse,
  MethodEligibility,
  MethodSummary,
  Timing,
} from '@/api-client/types'
import { buildMethodRows } from './methodRows'

const TIMING: Timing = { base_seconds_per_fold: 60, benchmarked_units: 2, quality: 'measured' }

/** A catalogue summary fixture; the interesting facts are the overrides. */
function summary(
  over: Partial<MethodSummary> & Pick<MethodSummary, 'id' | 'year' | 'language'>,
): MethodSummary {
  return {
    container: true,
    covariates: 'none',
    embeds_training_data: false,
    frozen_model: false,
    group: 'response-probability',
    group_label: 'Response probability',
    journal: 'J. Methods',
    marker_groups_required: [],
    markers: { kind: 'panel', count: 3 },
    min_draws: 3,
    needs_baseline: true,
    needs_detection_call: false,
    paper_doi: '10.1000/example',
    runnable: true,
    spec_status: 'shipped',
    tasks: ['response-probability'],
    timing: TIMING,
    uses_history: 'landmark',
    ...over,
  }
}

/** A per-method eligibility verdict fixture. */
function verdict(
  over: Partial<MethodEligibility> & Pick<MethodEligibility, 'id' | 'status'>,
): MethodEligibility {
  return {
    coverage: { eligible: 151, total: 151, fraction: 1 },
    estimate_quality: 'measured',
    estimated_seconds: 120,
    min_draws: { required: 3, met: 151, unmet_patients: 0 },
    missing_groups: [],
    missing_markers: [],
    reasons: [],
    ...over,
  }
}

/** An eligibility response fixture; the totals default to the fixture's one-method shape. */
function eligibility(
  over: Partial<EligibilityResponse> & { methods: MethodEligibility[] },
): EligibilityResponse {
  return {
    total_cannot: 0,
    total_fit: 0,
    total_some: 0,
    total_no_env: 0,
    ...over,
  }
}

describe('buildMethodRows', () => {
  it('renders the EXAMPLE-UL-2 can-run row: headline, coverage detail, time, About', () => {
    const methods = [summary({ id: 'direct-on', year: 2021, language: 'R' })]
    const row = buildMethodRows(
      methods,
      eligibility({ methods: [verdict({ id: 'direct-on', status: 'can_run' })] }),
    )[0]

    expect(row.key).toBe('direct-on')
    expect(row.name).toBe('direct-on')
    expect(row.tag).toBe('Paper 2021, R')
    expect(row.chip).toEqual({ label: 'Response probability', tone: 'neutral' })
    expect(row.performanceText).toBeNull()
    expect(row.run).toEqual({
      status: 'can',
      headline: 'Can run',
      detail: 'all 151 patients',
      disabled: false,
    })
    expect(row.timeText).toBe('about 2 min')
    expect(row.action).toEqual({ label: 'About' })
  })

  it('renders the EXAMPLE-UL-2 some-patients row from min_draws + coverage (board line)', () => {
    const row = buildMethodRows(
      [summary({ id: 'dynforest', year: 2022, language: 'Python' })],
      eligibility({
        methods: [
          verdict({
            id: 'dynforest',
            status: 'can_run_some',
            coverage: { eligible: 120, total: 151, fraction: 120 / 151 },
            min_draws: { required: 3, met: 120, unmet_patients: 31 },
            reasons: [{ code: 'MIN_DRAWS_UNMET' }],
          }),
        ],
      }),
    )[0]

    expect(row.run).toEqual({
      status: 'some',
      headline: 'Can run for some patients',
      detail: 'needs 3 or more draws; 120 of 151 have them',
      disabled: false,
    })
  })

  it('renders the EXAMPLE-UL-2 cannot-run row and disables the checkbox', () => {
    const row = buildMethodRows(
      [summary({ id: 'cox-ldh', year: 2020, language: 'R' })],
      eligibility({
        methods: [
          verdict({
            id: 'cox-ldh',
            status: 'cannot_run',
            coverage: { eligible: 0, total: 151, fraction: 0 },
            reasons: [{ code: 'REQUIRED_MARKER_MISSING' }],
            missing_markers: [{ id: 'ldh', id_system: 'catalog', display_name: 'LDH' }],
          }),
        ],
      }),
    )[0]

    expect(row.run).toEqual({
      status: 'cannot',
      headline: 'Cannot run',
      detail: 'needs LDH, not in your file',
      disabled: true,
    })
    // CM-4: a cannot-run row carries no time entry (the board shows none).
    expect(row.timeText).toBeNull()
  })

  it('renders the ENV_IMAGE_MISSING no-published-environment row with the plain reason (CM-1)', () => {
    const row = buildMethodRows(
      [summary({ id: 'bjm', year: 2020, language: 'R' })],
      eligibility({
        methods: [
          verdict({
            id: 'bjm',
            status: 'cannot_run',
            reasons: [{ code: 'ENV_IMAGE_MISSING' }],
          }),
        ],
      }),
    )[0]

    expect(row.run).toEqual({
      status: 'cannot',
      headline: 'Cannot run',
      detail: 'no published environment available',
      disabled: true,
    })
    expect(row.timeText).toBeNull()
  })

  it('maps all three provider verdict codes to the board status codes', () => {
    const rows = buildMethodRows(
      [
        summary({ id: 'a', year: 2021, language: 'R' }),
        summary({ id: 'b', year: 2021, language: 'R' }),
        summary({ id: 'c', year: 2021, language: 'R' }),
      ],
      eligibility({
        methods: [
          verdict({ id: 'a', status: 'can_run' }),
          verdict({ id: 'b', status: 'can_run_some' }),
          verdict({ id: 'c', status: 'cannot_run' }),
        ],
      }),
    )

    expect(rows.map(row => row.run.status)).toEqual(['can', 'some', 'cannot'])
    expect(rows.map(row => row.run.disabled)).toEqual([false, false, true])
  })

  it('shows the coverage line when the verdict carries no reasons', () => {
    const row = buildMethodRows(
      [summary({ id: 'direct-on', year: 2021, language: 'R' })],
      eligibility({
        methods: [
          verdict({
            id: 'direct-on',
            status: 'can_run_some',
            coverage: { eligible: 120, total: 151, fraction: 120 / 151 },
          }),
        ],
      }),
    )[0]

    expect(row.run.detail).toBe('120 of 151 patients')
  })

  it("gives the first reason's board line precedence over the coverage line", () => {
    const row = buildMethodRows(
      [summary({ id: 'landmark-cox', year: 2018, language: 'R' })],
      eligibility({
        methods: [
          verdict({
            id: 'landmark-cox',
            status: 'can_run',
            reasons: [{ code: 'UNIT_MISMATCH' }],
          }),
        ],
      }),
    )[0]

    expect(row.run.detail).toBe('all 151 patients, check the scales')
  })

  it('formats the row time from estimated_seconds (DEC-6: no per-row estimate call)', () => {
    const rows = buildMethodRows(
      [
        summary({ id: 'fast', year: 2021, language: 'R' }),
        summary({ id: 'slow', year: 2021, language: 'R' }),
      ],
      eligibility({
        methods: [
          verdict({ id: 'fast', status: 'can_run', estimated_seconds: 30 }),
          verdict({ id: 'slow', status: 'can_run', estimated_seconds: 840 }),
        ],
      }),
    )

    expect(rows[0].timeText).toBe('under 1 min')
    expect(rows[1].timeText).toBe('about 14 min')
  })

  it('renders the performance column from the summary performance facts when present (D36)', () => {
    const rows = buildMethodRows(
      [
        summary({
          id: 'direct-on',
          year: 2021,
          language: 'R',
          performance: { c_index_median: 0.64, n_units: 5, n_datasets: 3 },
        }),
        summary({
          id: 'cox',
          year: 2019,
          language: 'R',
          performance: { c_index_median: 0.6, auc_rule_median: 0.61, n_units: 4, n_datasets: 2 },
        }),
        summary({
          id: 'dynforest',
          year: 2022,
          language: 'Python',
          performance: { c_index_median: 0.666, n_units: 1, n_datasets: 1 },
        }),
      ],
      eligibility({
        methods: [
          verdict({ id: 'direct-on', status: 'can_run' }),
          verdict({ id: 'cox', status: 'can_run' }),
          verdict({ id: 'dynforest', status: 'can_run' }),
        ],
      }),
    )

    // The board's performance-column copy, two decimals; the number is the
    // benchmark's primary aggregate (the median c-index) and never a
    // call-rule AUC here (that fact stays with the model-card builders).
    expect(rows[0].performanceText).toBe('other cohorts: AUC 0.64')
    expect(rows[1].performanceText).toBe('other cohorts: AUC 0.60')
    expect(rows[2].performanceText).toBe('other cohorts: AUC 0.67')
  })

  it('renders no performance column when the summary carries no performance facts', () => {
    const row = buildMethodRows(
      [summary({ id: 'direct-on', year: 2021, language: 'R' })],
      eligibility({ methods: [verdict({ id: 'direct-on', status: 'can_run' })] }),
    )[0]

    expect(row.performanceText).toBeNull()
  })

  it('keeps a catalogue method missing from the eligibility response as a NOT_RUNNABLE cannot row', () => {
    const row = buildMethodRows(
      [
        summary({
          id: 'ghost',
          year: 2021,
          language: 'R',
          group_label: 'Dynamic risk',
          performance: { c_index_median: 0.58, n_units: 2, n_datasets: 2 },
        }),
      ],
      eligibility({ methods: [] }),
    )[0]

    expect(row.key).toBe('ghost')
    expect(row.tag).toBe('Paper 2021, R')
    expect(row.chip).toEqual({ label: 'Dynamic risk', tone: 'neutral' })
    expect(row.performanceText).toBe('other cohorts: AUC 0.58')
    expect(row.run).toEqual({
      status: 'cannot',
      headline: 'Cannot run',
      detail: 'not available with this build',
      disabled: true,
    })
    expect(row.timeText).toBeNull()
    expect(row.action).toEqual({ label: 'About' })
  })

  it('keeps the catalogue order and drops eligibility-only ids (the catalogue is the list source)', () => {
    const rows = buildMethodRows(
      [
        summary({ id: 'first', year: 2021, language: 'R' }),
        summary({ id: 'second', year: 2020, language: 'Python' }),
      ],
      eligibility({
        methods: [
          verdict({ id: 'second', status: 'can_run' }),
          verdict({ id: 'orphan', status: 'can_run' }),
        ],
      }),
    )

    expect(rows.map(row => row.key)).toEqual(['first', 'second'])
    // The orphan verdict has no catalogue method: no row is created for it.
    expect(rows[0].run.status).toBe('cannot')
    expect(rows[0].run.detail).toBe('not available with this build')
    expect(rows[1].run.status).toBe('can')
  })

  it('returns one row per catalogue method (count parity against the method list)', () => {
    const methods = [
      summary({ id: 'a', year: 2021, language: 'R' }),
      summary({ id: 'b', year: 2021, language: 'R' }),
      summary({ id: 'c', year: 2021, language: 'R' }),
    ]
    // Two verdicts only: the third method must still render (the fallback).
    const rows = buildMethodRows(
      methods,
      eligibility({
        methods: [
          verdict({ id: 'a', status: 'can_run' }),
          verdict({ id: 'b', status: 'can_run' }),
        ],
      }),
    )

    expect(rows).toHaveLength(methods.length)
    expect(new Set(rows.map(row => row.key))).toEqual(new Set(['a', 'b', 'c']))
  })

  it('does not mutate its inputs', () => {
    const methods = [summary({ id: 'direct-on', year: 2021, language: 'R' })]
    const response = eligibility({
      methods: [verdict({ id: 'direct-on', status: 'can_run' })],
    })
    const before = JSON.stringify({ methods, response })

    buildMethodRows(methods, response)

    expect(JSON.stringify({ methods, response })).toBe(before)
  })
})
