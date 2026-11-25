/**
 * single-marker-choice round 2 — the step-3 group's pure facts
 * (`txrintake/lib/singleMarker.ts`): shown/hidden, the n/k counts, the
 * select's marker options and the question sentence's two wordings.
 */
import { describe, expect, it } from 'vitest'
import type {
  InventoryEligibilityRequest,
  InventoryMarker,
  MethodEligibility,
  MethodSummary,
} from '@/api-client/types'
import { markerOptionsOf, singleMarkerFacts, singleMarkerQuestion } from './singleMarker'

function marker(key: string, over: Partial<InventoryMarker> = {}): InventoryMarker {
  return {
    key,
    display_name: key,
    has_detection_companion: false,
    is_detection_call: false,
    n_patients_with_baseline: 0,
    n_patients_with_ontreatment: 0,
    n_patients_with_value: 9,
    standard_ids: [],
    unit_family: 'concentration_mass',
    ...over,
  }
}

function inventory(markers: InventoryMarker[], patients = 10): InventoryEligibilityRequest {
  return {
    patients,
    decision_day: 56,
    baseline_max_day: 0,
    markers,
    covariates: [],
  }
}

function method(
  id: string,
  kind: 'single' | 'multi' | 'any' | 'panel',
  count = 1,
  required: unknown = null,
): MethodSummary {
  return {
    id,
    title: id,
    container: true,
    covariates: 'none',
    disease: { scope: 'any-solid-tumour', groups: [] },
    treatment: { classes: ['chemotherapy'], confidence: 'stated' },
    embeds_training_data: false,
    frozen_model: false,
    group: 'static-risk',
    group_label: 'Static risk',
    journal: 'J. Methods',
    language: 'R',
    marker_groups_required: [],
    markers: { kind, count },
    min_draws: 1,
    needs_baseline: true,
    needs_detection_call: false,
    paper_doi: '10.1000/example',
    runnable: true,
    spec_status: 'stable',
    summary: `Summary of ${id}.`,
    tasks: ['static-risk'],
    timing: { base_seconds_per_fold: 1, benchmarked_units: 1, quality: 'measured' },
    uses_history: 'landmark',
    year: 2020,
    required_markers: required,
  } as unknown as MethodSummary
}

function verdict(id: string, code: string | null = null): MethodEligibility {
  return {
    id,
    status: 'can_run',
    reasons: code === null ? [] : [{ code }],
    coverage: { eligible: 1, total: 1, fraction: 1 },
    min_draws: { required: 1, met: 1, unmet_patients: 0 },
    missing_markers: [],
    missing_groups: [],
    estimated_seconds: 0,
    estimate_quality: 'estimate',
  } as unknown as MethodEligibility
}

function mapOf(methods: MethodEligibility[]): Map<string, MethodEligibility> {
  return new Map(methods.map(m => [m.id, m]))
}

describe('markerOptionsOf', () => {
  it('lists the file main markers with their value counts; companions are never candidates', () => {
    const inv = inventory([
      marker('M3'),
      marker('M1__detected'),
      marker('M1', { display_name: 'CA-125', n_patients_with_value: 7 }),
    ])
    expect(markerOptionsOf(inv)).toEqual([
      { key: 'M3', name: 'M3', a: 9, b: 10 },
      { key: 'M1', name: 'CA-125', a: 7, b: 10 },
    ])
    expect(markerOptionsOf(null)).toEqual([])
  })
})

describe('singleMarkerFacts', () => {
  it('shows only when the file is in, a fitting single/multi no-list method exists, and the file has more than one main marker', () => {
    const inv = inventory([marker('M1'), marker('M2')])
    const single = method('one', 'single')
    // File in, one fitting no-list single, two main markers: visible.
    expect(singleMarkerFacts(inv, [single], mapOf([verdict('one')]))).toMatchObject({
      visible: true,
      n: 1,
      k: 2,
    })
    // No file: hidden.
    expect(singleMarkerFacts(null, [single], mapOf([verdict('one')]))).toMatchObject({
      visible: false,
    })
    // One main marker only: hidden.
    expect(
      singleMarkerFacts(inventory([marker('M1')]), [single], mapOf([verdict('one')])),
    ).toMatchObject({ visible: false })
    // No fitting method: hidden (the answer excludes it).
    expect(singleMarkerFacts(inv, [single], mapOf([verdict('one', 'DISEASE_NOT_MATCHED')]))).toMatchObject({
      visible: false,
      n: 0,
    })
    // An env-only cannot_run method FITS the answers (no answer cause): it counts.
    const envOnly: MethodEligibility = {
      ...verdict('one'),
      status: 'cannot_run',
      reasons: [{ code: 'ENV_IMAGE_MISSING' }],
    }
    expect(singleMarkerFacts(inv, [single], mapOf([envOnly]))).toMatchObject({ visible: true, n: 1 })
    // A fixed-list single and any/panel no-list methods are NOT the group's n.
    const fixed = method('fixed', 'single', 1, {
      list_source: 'x',
      markers: [],
      match: 'all',
      min_fraction: 0,
    })
    const anyNoList = method('any', 'any')
    expect(singleMarkerFacts(inv, [fixed, anyNoList], mapOf([verdict('fixed'), verdict('any')]))).toMatchObject(
      { visible: false, n: 0 },
    )
  })

  it('counts single and multi no-list methods together', () => {
    const inv = inventory([marker('M1'), marker('M2')])
    const facts = singleMarkerFacts(
      inv,
      [method('s', 'single'), method('m', 'multi', 2)],
      mapOf([verdict('s'), verdict('m')]),
    )
    expect(facts).toMatchObject({ n: 2 })
    expect(singleMarkerFacts(inv, [method('m', 'multi', 2)], mapOf([verdict('m')]))).toMatchObject({
      n: 1,
    })
  })
})

describe('singleMarkerQuestion', () => {
  it('spells the n = 1 sentence with k = 3: the one method uses fewer', () => {
    expect(singleMarkerQuestion({ visible: true, n: 1, k: 3, markers: [] })).toBe(
      'Your file has 3 markers, but 1 of the methods that fit uses fewer. Which markers should it use?',
    )
  })

  it('spells the n > 1 sentence for n = 3 with k = 3', () => {
    expect(singleMarkerQuestion({ visible: true, n: 3, k: 3, markers: [] })).toBe(
      'Your file has 3 markers, but 3 of the methods that fit use fewer. Which markers should they use?',
    )
  })
})
