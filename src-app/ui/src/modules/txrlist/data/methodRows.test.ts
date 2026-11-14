/**
 * TEST-UL-3 — txrlist method-catalogue adapter: `buildMethodCards`
 * (PROV-UI-LIST-3, INV-1; the qa-fixes3 ITEM-1 card join).
 *
 * The join is pure, so no ApiClient mock is needed here: the fixtures are
 * the provider's generated wire types (`MethodSummary[]`,
 * `EligibilityResponse` — `@/api-client/types`), so a provider regen that
 * renames or reshapes either payload breaks the typecheck on this file
 * until the join moves with it (DEC-11's mechanical-move contract).
 *
 * Pinned behaviours:
 *
 * - one card per catalogue method, in catalogue order, keyed by the method
 *   id; the card's `title`/`summary`/`paperTitle` are the generator's
 *   human-name fields verbatim (never derived here, never blank);
 * - `run.status` follows the eligibility verdict (can_run / can_run_some /
 *   cannot_run → can / some / cannot), `run.disabled` is `cannot`, the
 *   reason line is FIRST-reason board copy when the verdict carries
 *   reasons, the coverage line otherwise, and the fix line names the
 *   missing marker for REQUIRED_MARKER_MISSING (the plan's "add a column
 *   named …");
 * - `estimate` comes from the verdict's `estimated_seconds` +
 *   `estimate_quality` — except on a `cannot` card, which carries NO
 *   estimate (CM-4: the board shows none and the provider still posts
 *   seconds);
 * - `rank` renders the benchmark fact (D36) when the summary carries it —
 *   the auc median when evaluated, the c-index median otherwise;
 * - the needs line's facts: markers ("any markers"/"N markers"),
 *   covariates segment (omitted when none), draws ("N+ draws");
 * - a catalogue method the eligibility response does not know becomes a
 *   `cannot` card with the NOT_RUNNABLE reason line ("not available with
 *   this build") and no estimate — a method never silently disappears; an
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
import { buildMethodCards } from './methodRows'

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
    title: 'Fixture method title',
    summary: 'The fixture method summary.',
    paper_title: 'The fixture paper title',
    journal: 'J. Methods',
    marker_groups_required: [],
    markers: { kind: 'panel', count: 3 },
    min_draws: 3,
    needs_baseline: true,
    needs_detection_call: false,
    paper_doi: '10.1000/example',
    runnable: true,
    spec_status: 'stable',
    tasks: ['response'],
    timing: TIMING,
    uses_history: 'landmark',
    ...over,
  }
}

/** A verdict fixture; the interesting facts are the overrides. */
function verdict(id: string, over: Partial<MethodEligibility> = {}): MethodEligibility {
  return {
    id,
    status: 'can_run',
    reasons: [],
    missing_markers: [],
    missing_groups: [],
    coverage: { eligible: 151, total: 151, fraction: 1 },
    min_draws: { required: 0, met: 151, unmet_patients: 0 },
    estimated_seconds: 120,
    estimate_quality: 'measured',
    ...over,
  }
}

function eligibility(entries: MethodEligibility[]): EligibilityResponse {
  return {
    methods: entries,
    total_fit: 0,
    total_some: 0,
    total_cannot: 0,
    total_no_env: 0,
  }
}

describe('buildMethodCards — the screen-E catalogue × eligibility join', () => {
  it('joins one card per catalogue method with the human-name fields verbatim, in catalogue order', () => {
    const m1 = summary({ id: 'alpha', year: 2021, language: 'R' })
    const m2 = summary({ id: 'beta', year: 2019, language: 'Python' })
    const cards = buildMethodCards([m1, m2], eligibility([verdict('alpha'), verdict('beta')]))
    expect(cards.map(card => card.key)).toEqual(['alpha', 'beta'])
    const alpha = cards[0]
    expect(alpha.title).toBe('Fixture method title')
    expect(alpha.summary).toBe('The fixture method summary.')
    expect(alpha.paperTitle).toBe('The fixture paper title')
    expect(alpha.groupLabel).toBe('Response probability')
    expect(alpha.run.status).toBe('can')
    expect(alpha.run.disabled).toBe(false)
  })

  it('maps the three verdict codes and carries the estimate + quality from the verdict', () => {
    const m = summary({ id: 'alpha', year: 2021, language: 'R' })
    const cards = buildMethodCards(
      [m],
      eligibility([
        verdict('alpha', {
          status: 'can_run_some',
          estimated_seconds: 12.4,
          estimate_quality: 'estimate',
          coverage: { eligible: 120, total: 151, fraction: 120 / 151 },
        }),
      ]),
    )
    expect(cards[0].run.status).toBe('some')
    expect(cards[0].run.disabled).toBe(false)
    expect(cards[0].estimate).toEqual({ seconds: 12.4, quality: 'estimate' })
  })

  it('a cannot card carries NO estimate and the first reason line + fix (named marker)', () => {
    const m = summary({ id: 'alpha', year: 2021, language: 'R' })
    const cards = buildMethodCards(
      [m],
      eligibility([
        verdict('alpha', {
          status: 'cannot_run',
          estimated_seconds: 45,
          reasons: [{ code: 'REQUIRED_MARKER_MISSING' }],
          missing_markers: [{ id: 'ldh', id_system: 'LOINC', display_name: 'LDH' }],
          coverage: { eligible: 0, total: 151, fraction: 0 },
        }),
      ]),
    )
    expect(cards[0].estimate).toBeNull()
    expect(cards[0].run.disabled).toBe(true)
    expect(cards[0].run.reasonCode).toBe('REQUIRED_MARKER_MISSING')
    expect(cards[0].run.reasonLine).toContain('LDH')
    expect(cards[0].run.reasonFix).toBe('Add a column named LDH')
  })

  it('an unrunnable row carries the DATA reason beside the environment reason (qa-fixes4 ITEM-3, methods-r3 R2-6)', () => {
    // The runtime-env stage pushes ENV_IMAGE_MISSING FIRST; the file's
    // reasons follow — the row must show both, never the env line alone.
    const m = summary({ id: 'alpha', year: 2021, language: 'R' })
    const cards = buildMethodCards(
      [m],
      eligibility([
        verdict('alpha', {
          status: 'cannot_run',
          reasons: [
            { code: 'ENV_IMAGE_MISSING' },
            { code: 'REQUIRED_MARKER_MISSING' },
            { code: 'MIN_DRAWS_UNMET' },
          ],
          missing_markers: [{ id: 'ldh', id_system: 'LOINC', display_name: 'LDH' }],
          coverage: { eligible: 0, total: 151, fraction: 0 },
          min_draws: { required: 3, met: 20, unmet_patients: 131 },
        }),
      ]),
    )
    expect(cards[0].run.reasonCode).toBe('ENV_IMAGE_MISSING')
    expect(cards[0].run.reasonLine).toBe('no published environment available')
    expect(cards[0].run.reasonLines).toEqual([
      'no published environment available',
      'needs LDH, not in your file',
      'needs 3 or more draws; 20 of 151 have them',
    ])
  })

  it('a marker without a display name falls back to a constant fix (never blank)', () => {
    const m = summary({ id: 'alpha', year: 2021, language: 'R' })
    const cards = buildMethodCards(
      [m],
      eligibility([
        verdict('alpha', {
          status: 'cannot_run',
          reasons: [{ code: 'REQUIRED_MARKER_MISSING' }],
          missing_markers: [],
        }),
      ]),
    )
    expect(cards[0].run.reasonFix).toBe('Add a column with the marker the method needs.')
  })

  it('the rank is the benchmark fact when the summary carries it (auc preferred), else null', () => {
    const withRank = summary({
      id: 'ranked',
      year: 2020,
      language: 'R',
      // `auc_rule_median` absent = the "no auc fact" case (the generated
      // type models the wire's null as absence; the rank guard still
      // accepts null at runtime).
      performance: { c_index_median: 0.74, n_units: 38, n_datasets: 38 },
    })
    const withAuc = summary({
      id: 'auc',
      year: 2020,
      language: 'R',
      performance: { c_index_median: 0.62, auc_rule_median: 0.79, n_units: 12, n_datasets: 12 },
    })
    const none = summary({ id: 'none', year: 2020, language: 'R' })
    const cards = buildMethodCards(
      [withRank, withAuc, none],
      eligibility([verdict('ranked'), verdict('auc'), verdict('none')]),
    )
    expect(cards[0].rank).toEqual({ median: 0.74, kind: 'c-index', nDatasets: 38 })
    expect(cards[1].rank).toEqual({ median: 0.79, kind: 'auc', nDatasets: 12 })
    expect(cards[2].rank).toBeNull()
  })

  it('the needs facts assemble from the catalogue summary', () => {
    const m = summary({ id: 'alpha', year: 2021, language: 'R', markers: { kind: 'multi', count: 1 } })
    const cards = buildMethodCards([m], eligibility([verdict('alpha')]))
    expect(cards[0].needs).toEqual({ markers: '1 marker', covariates: null, draws: '3+ draws' })
    const optional = buildMethodCards(
      [
        summary({
          id: 'b',
          year: 2021,
          language: 'R',
          covariates: 'optional',
          markers: { kind: 'any', count: 0 },
        }),
      ],
      eligibility([verdict('b')]),
    )
    expect(optional[0].needs).toEqual({
      markers: 'any markers',
      covariates: 'covariates optional',
      draws: '3+ draws',
    })
  })

  it('a catalogue method the eligibility response does not know is a defensive cannot card; an eligibility-only id is dropped', () => {
    const known = summary({ id: 'known', year: 2021, language: 'R' })
    const cards = buildMethodCards([known], eligibility([verdict('known'), verdict('orphan')]))
    expect(cards).toHaveLength(1)
    expect(cards[0].key).toBe('known')
    const missing = buildMethodCards([known], eligibility([]))
    expect(missing[0].run.status).toBe('cannot')
    expect(missing[0].run.reasonCode).toBe('NOT_RUNNABLE')
    expect(missing[0].estimate).toBeNull()
    expect(missing[0].run.reasonLine).not.toBe('')
  })

  it('never mutates its inputs', () => {
    const m = summary({ id: 'alpha', year: 2021, language: 'R' })
    const eligibilityResponse = eligibility([verdict('alpha')])
    const before = JSON.stringify([m, eligibilityResponse])
    void buildMethodCards([m], eligibilityResponse)
    expect(JSON.stringify([m, eligibilityResponse])).toBe(before)
  })
})
