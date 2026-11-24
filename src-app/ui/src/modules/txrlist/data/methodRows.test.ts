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
import { RUNNER_UNAVAILABLE_FIX, formatMethodNeedsLine } from '../lib/format'

const TIMING: Timing = { base_seconds_per_fold: 60, benchmarked_units: 2, quality: 'measured' }

/** A catalogue summary fixture; the interesting facts are the overrides. */
function summary(
  over: Partial<MethodSummary> & Pick<MethodSummary, 'id' | 'year' | 'language'>,
): MethodSummary {
  return {
    container: true,
    covariates: 'none',
    disease: { scope: 'any-solid-tumour', groups: [] },
    treatment: { classes: ['chemotherapy'], confidence: 'stated' },
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

  it('a method the file gives the wrong number of markers is a cannot card with its own line and fix (FOLLOW-UP 1)', () => {
    const m = summary({ id: 'kelim', year: 2021, language: 'R' })
    const cards = buildMethodCards(
      [m],
      eligibility([
        verdict('kelim', {
          status: 'cannot_run',
          estimated_seconds: 3,
          reasons: [{ code: 'MARKER_COUNT_UNMET', params: { expected: 1, found: 3, markers: ['M1', 'M2', 'M3'] } }],
          coverage: { eligible: 151, total: 151, fraction: 1 },
        }),
      ]),
    )
    expect(cards[0].run.status).toBe('cannot')
    expect(cards[0].run.disabled).toBe(true)
    expect(cards[0].estimate).toBeNull()
    expect(cards[0].run.reasonCode).toBe('MARKER_COUNT_UNMET')
    expect(cards[0].run.reasonLine).toBe('takes a set number of markers; your file has a different number')
    expect(cards[0].run.reasonFix).toBe('Use a file with just the markers this method takes.')
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

  it('a cannot card whose first reason is RUNNER_UNAVAILABLE reads the notice line and the notice fix (w10a2)', () => {
    // The eligibility stage pushes RUNNER_UNAVAILABLE FIRST when no method can
    // run at all (on Windows: WSL 2 missing, too old or turned off, the
    // app's WSL runtime missing, or the app's run folder not creatable): the
    // row's ONE line names the deployment fact and points at the notice at
    // the top of the app, never the study or the answers.
    const m = summary({ id: 'alpha', year: 2021, language: 'R' })
    const cards = buildMethodCards(
      [m],
      eligibility([
        verdict('alpha', {
          status: 'cannot_run',
          reasons: [{ code: 'RUNNER_UNAVAILABLE' }],
          coverage: { eligible: 0, total: 151, fraction: 0 },
        }),
      ]),
    )
    expect(cards[0].run.reasonCode).toBe('RUNNER_UNAVAILABLE')
    expect(cards[0].run.reasonLine).toBe('methods cannot run yet: see the notice at the top of the app')
    expect(cards[0].run.reasonFix).toBe(RUNNER_UNAVAILABLE_FIX)
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
    expect(cards[0].needs).toEqual({
      markers: '1 marker',
      covariates: null,
      covariatesMode: 'none',
      draws: '3+ draws',
      // The single-marker plan's per-kind facts (round 2): the fixture
      // carries no `required_markers` (no fixed list) — the "uses …"
      // needs-line fact is null until the plan is known.
      markerKind: 'multi',
      markerCount: 1,
      noFixedList: true,
      markersUsed: null,
    })
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
      covariatesMode: 'optional',
      draws: '3+ draws',
      markerKind: 'any',
      markerCount: 0,
      noFixedList: true,
      markersUsed: null,
    })
    // The raw mode is the catalogue's own (`required` — the display string is
    // never parsed by the Extra-inputs switch's automatic steps).
    const required = buildMethodCards(
      [summary({ id: 'c', year: 2021, language: 'R', covariates: 'required' })],
      eligibility([verdict('c')]),
    )
    expect(required[0].needs.covariates).toBe('covariates required')
    expect(required[0].needs.covariatesMode).toBe('required')
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

  it('threads the vocabulary labels into the reason lines (the adapter contract, 5a3)', () => {
    const m = summary({ id: 'alpha', year: 2021, language: 'R' })
    const cards = buildMethodCards(
      [m],
      eligibility([
        verdict('alpha', {
          status: 'cannot_run',
          reasons: [
            {
              code: 'TREATMENT_NOT_MATCHED',
              params: { made_for: 'immune checkpoint inhibitor', answer: 'chemotherapy' },
            },
          ],
        }),
      ]),
      {
        treatmentClasses: [
          { id: 'immune checkpoint inhibitor', label: 'Immune checkpoint inhibitor' },
          { id: 'chemotherapy', label: 'Chemotherapy' },
        ],
      },
    )
    expect(cards[0].run.reasonLine).toBe(
      'Made for Immune checkpoint inhibitor, not your treatments',
    )
    expect(cards[0].run.reasonLines).toEqual([
      'Made for Immune checkpoint inhibitor, not your treatments',
    ])
  })

  it('carries the plan facts: the no-list kind and the planned markers on the needs line (single-marker-choice round 2)', () => {
    const plan: import('@/api-client/types').PlanBlock = {
      mode: 'ranked',
      top: ['M2', 'M1', 'M3'],
      offered: ['M2', 'M1', 'M3'],
    }
    const single = summary({ id: 's', year: 2021, language: 'R', markers: { kind: 'single', count: 1 } })
    const multi = summary({ id: 'm', year: 2021, language: 'R', markers: { kind: 'multi', count: 2 } })
    const cards = buildMethodCards(
      [single, multi],
      eligibility([verdict('s'), verdict('m')]),
      {},
      plan,
      ['M1', 'M2', 'M3'],
    )
    // The plan facts ride the card even without a plan (the kind + the
    // fixed-list fact are catalogue facts); `markersUsed` comes with it.
    expect(cards[0].needs.markerKind).toBe('single')
    expect(cards[0].needs.noFixedList).toBe(true)
    expect(cards[0].needs.markersUsed).toEqual(['M2'])
    expect(cards[0].run.reasonLine.includes('uses M2')).toBe(false)
    expect(formatMethodNeedsLine(cards[0].needs, null)).toBe('Needs: 1 marker · 3+ draws · uses M2')
    // multi k gets the top k
    expect(cards[1].needs.markersUsed).toEqual(['M2', 'M1'])
    // Without the plan the fact is unknown (never fabricated).
    const bare = buildMethodCards([single], eligibility([verdict('s')]))
    expect(bare[0].needs.markersUsed).toBeNull()
    // A fixed-list method is not a plan method.
    const fixed = summary({ id: 'f', year: 2021, language: 'R', markers: { kind: 'single', count: 1 }, required_markers: { list_source: 'x', markers: [], match: 'all', min_fraction: 0 } })
    const fixedCards = buildMethodCards([fixed], eligibility([verdict('f')]), {}, plan)
    expect(fixedCards[0].needs.noFixedList).toBe(false)
    expect(fixedCards[0].needs.markersUsed).toBeNull()
  })

  it('the new reason codes get their fix lines (single-marker-choice round 1b)', () => {
    const plan: import('@/api-client/types').PlanBlock = { mode: 'leave_out' }
    const mk = (id: string, reason: string) =>
      buildMethodCards(
        [summary({ id, year: 2021, language: 'R', markers: { kind: 'single', count: 1 } })],
        eligibility([
          verdict(id, { status: 'cannot_run', reasons: [{ code: reason } as never] }),
        ]),
        {},
        plan,
      )[0]
    expect(mk('lost', 'MARKERS_LEFT_OUT').run.reasonFix).toBe('Choose a marker setting for them in step 3.')
    expect(mk('norank', 'MARKER_RANKING_UNAVAILABLE').run.reasonFix).toBe(
      'Use a file with more patients measured before and during treatment.',
    )
    expect(mk('nomarker', 'MARKER_NOT_IN_FILE').run.reasonFix).toBe('Choose another marker in step 3.')
    const missing = buildMethodCards(
      [summary({ id: 'feat', year: 2021, language: 'R' })],
      eligibility([
        verdict('feat', {
          status: 'cannot_run',
          reasons: [{ code: 'MODEL_FEATURE_MISSING' } as never],
          missing_markers: [{ id: 'LDH', id_system: 'other', display_name: 'LDH' }],
        }),
      ]),
    )[0]
    expect(missing.run.reasonLine).toBe(
      'needs the marker LDH it was trained on, which your file does not have',
    )
    expect(missing.run.reasonFix).toBe('Use a file that has LDH.')
  })
})
