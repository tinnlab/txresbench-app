// @vitest-environment jsdom
// The study-answers action (`./intakeActions.ts`, step2-filters): the
// registered metadata the palette and the AI read, the id validation against
// the loaded filter-options vocabulary, and the delegation to the intake
// store's `patchStudy` — the same mutation a human click performs.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FilterOptions } from '@/api-client/types'
import { getActionMeta, runAction } from '../defineAction'
import { Permissions } from '@/api-client/permissions'
import { useTxrIntakeStore } from '@/modules/txrintake/stores/TxrIntake.store'
import { __resetFetchCacheForTests } from '@/modules/txrintake/data/fetchCache'

const api = vi.hoisted(() => ({ filterOptions: vi.fn() }))
vi.mock('@/api-client', () => ({
  ApiClient: {
    MethodCatalogue: {
      filterOptions: api.filterOptions,
    },
  },
}))

import './intakeActions'
import {
  FILTER_OPTIONS_UNREACHABLE,
  MARKER_CHOICE_FILE_NOT_READY,
  MARKER_CHOICE_NO_MARKER,
} from './intakeActions'

const VOCABULARY: FilterOptions = {
  disease_categories: [
    {
      id: 'Solid tumours',
      diseases: [
        { id: 'colorectal cancer', children: [] },
        { id: 'breast cancer', children: ['breast cancer (triple-negative)'] },
      ],
    },
  ],
  treatment_classes: [
    { id: 'immune checkpoint inhibitor', label: 'Immune checkpoint inhibitor' },
    { id: 'chemotherapy', label: 'Chemotherapy' },
  ],
}

const state = () => useTxrIntakeStore.getState()

beforeEach(() => {
  api.filterOptions.mockReset()
  api.filterOptions.mockResolvedValue(VOCABULARY)
  __resetFetchCacheForTests()
  window.localStorage.clear()
  state().reset()
})

describe('intake.setStudyAnswers', () => {
  it('is registered: McpUse, mutating, a global action', () => {
    const meta = getActionMeta('intake.setStudyAnswers')
    expect(meta?.permission).toBe(Permissions.McpUse)
    expect(meta?.mutating).toBe(true)
    expect(meta?.kind).toBe('global')
    expect(meta?.context).toBe('global')
    expect(meta?.surfaces).toEqual({ palette: true, ai: true })
  })

  it('writes the answered fields through the store (the human mutation)', async () => {
    await expect(
      runAction('intake.setStudyAnswers', {
        disease_group: 'colorectal cancer',
        treatment_classes: ['immune checkpoint inhibitor', 'chemotherapy'],
        outcome: 'progression-by-day',
      }),
    ).resolves.toEqual({
      disease_group: 'colorectal cancer',
      treatment_classes: ['immune checkpoint inhibitor', 'chemotherapy'],
      outcome: 'progression-by-day',
    })
    const s = state()
    expect(s.study.disease).toBe('colorectal cancer')
    expect(s.study.treatments).toEqual(['immune checkpoint inhibitor', 'chemotherapy'])
    expect(s.study.outcome).toBe('progression-by-day')
  })

  it('clears with null disease/outcome and an empty treatment list; omitting a field leaves it alone', async () => {
    state().patchStudy({
      disease: 'colorectal cancer',
      treatments: ['chemotherapy'],
      outcome: 'dynamic-risk',
    })
    await runAction('intake.setStudyAnswers', {
      disease_group: null,
      treatment_classes: [],
      outcome: null,
    })
    const s = state()
    expect(s.study.disease).toBeNull()
    expect(s.study.treatments).toBeNull()
    expect(s.study.outcome).toBeNull()

    await runAction('intake.setStudyAnswers', { outcome: 'binary-response' })
    expect(state().study.disease).toBeNull()
    expect(state().study.treatments).toBeNull()
    expect(state().study.outcome).toBe('binary-response')
  })

  it('refuses an unknown disease id, naming it, and writes nothing', async () => {
    await expect(
      runAction('intake.setStudyAnswers', { disease_group: 'made-up cancer' }),
    ).rejects.toThrow('"made-up cancer" is not a disease of the method list.')
    expect(state().study.disease).toBeNull()
  })

  it('refuses an unknown treatment id, naming it', async () => {
    await expect(
      runAction('intake.setStudyAnswers', { treatment_classes: ['chemotherapy', 'made-up drug'] }),
    ).rejects.toThrow('"made-up drug" is not a treatment of the method list.')
    expect(state().study.treatments).toBeNull()
  })

  it('accepts a sub-group id (a disease child) as a disease answer', async () => {
    await runAction('intake.setStudyAnswers', { disease_group: 'breast cancer (triple-negative)' })
    expect(state().study.disease).toBe('breast cancer (triple-negative)')
  })

  it('refuses plainly when the vocabulary cannot be reached', async () => {
    api.filterOptions.mockRejectedValueOnce(new Error('catalogue down'))
    await expect(
      runAction('intake.setStudyAnswers', { disease_group: 'colorectal cancer' }),
    ).rejects.toThrow(FILTER_OPTIONS_UNREACHABLE)
    expect(state().study.disease).toBeNull()
  })

  it('re-uses the vocabulary a screen already cached (one request per catalogue)', async () => {
    await runAction('intake.setStudyAnswers', { disease_group: 'colorectal cancer' })
    expect(api.filterOptions).toHaveBeenCalledTimes(1)
    await runAction('intake.setStudyAnswers', { disease_group: 'breast cancer' })
    expect(api.filterOptions).toHaveBeenCalledTimes(1)
  })

  it('an outcome-only patch never loads the vocabulary — a failed filter-options fetch cannot block the pills (5a3)', async () => {
    api.filterOptions.mockRejectedValueOnce(new Error('catalogue down'))
    await expect(
      runAction('intake.setStudyAnswers', { outcome: 'binary-response' }),
    ).resolves.toEqual({
      disease_group: null,
      treatment_classes: [],
      outcome: 'binary-response',
    })
    expect(api.filterOptions).not.toHaveBeenCalled()
    expect(state().study.outcome).toBe('binary-response')
  })

  it('the return reports the store AFTER the patch — an omitted field is returned as it stands (5a3)', async () => {
    state().patchStudy({
      disease: 'colorectal cancer',
      treatments: ['chemotherapy'],
      outcome: 'dynamic-risk',
    })
    // Only the outcome is patched: the return must carry the store's current
    // disease/treatments, never a guessed default for an omitted field.
    await expect(runAction('intake.setStudyAnswers', { outcome: 'binary-response' })).resolves.toEqual({
      disease_group: 'colorectal cancer',
      treatment_classes: ['chemotherapy'],
      outcome: 'binary-response',
    })
    // Returning from a clear: the empty list is the store's "no filter"
    // spelling, not a guessed answer.
    await expect(
      runAction('intake.setStudyAnswers', { disease_group: null, treatment_classes: [] }),
    ).resolves.toEqual({
      disease_group: null,
      treatment_classes: [],
      outcome: 'binary-response',
    })
  })

  it('de-duplicates repeated treatment ids, keeping the first-seen order (5a3)', async () => {
    await expect(
      runAction('intake.setStudyAnswers', {
        treatment_classes: ['chemotherapy', 'immune checkpoint inhibitor', 'chemotherapy'],
      }),
    ).resolves.toEqual({
      disease_group: null,
      treatment_classes: ['chemotherapy', 'immune checkpoint inhibitor'],
      outcome: null,
    })
    expect(state().study.treatments).toEqual(['chemotherapy', 'immune checkpoint inhibitor'])
  })
})

describe('intake.setSingleMarkerChoice', () => {
  const MAIN_MARKERS = [
    {
      key: 'ctdna_mm',
      display_name: 'ctDNA',
      n_patients_with_value: 8,
      n_patients_with_baseline: 8,
      n_patients_with_ontreatment: 8,
      is_detection_call: false,
      has_detection_companion: false,
      standard_ids: [],
      unit_family: 'ratio',
    },
    {
      key: 'ldh',
      display_name: 'LDH',
      n_patients_with_value: 8,
      n_patients_with_baseline: 8,
      n_patients_with_ontreatment: 8,
      is_detection_call: false,
      has_detection_companion: false,
      standard_ids: [],
      unit_family: 'percent',
    },
  ]

  function seedValidation(markers: unknown[] = MAIN_MARKERS): void {
    useTxrIntakeStore.setState({
      validation: {
        problems: [],
        markers: [],
        measurements: { rows: 8, patients: 8, distinct_draw_days: [21] },
        inventory: {
          patients: 8,
          decision_day: 21,
          baseline_max_day: 0,
          covariates: [],
          markers,
        },
      } as never,
    })
  }

  it('is registered: McpUse, mutating, a global action', () => {
    const meta = getActionMeta('intake.setSingleMarkerChoice')
    expect(meta?.permission).toBe(Permissions.McpUse)
    expect(meta?.mutating).toBe(true)
    expect(meta?.kind).toBe('global')
    expect(meta?.context).toBe('global')
    expect(meta?.surfaces).toEqual({ palette: true, ai: true })
  })

  it('writes ranked and leave_out; chosen trims and stores the marker', async () => {
    seedValidation()
    await expect(runAction('intake.setSingleMarkerChoice', { mode: 'ranked' })).resolves.toEqual({
      mode: 'ranked',
      marker: undefined,
    })
    expect(state().singleMarkerChoice).toEqual({ mode: 'ranked' })
    await expect(runAction('intake.setSingleMarkerChoice', { mode: 'leave_out' })).resolves.toEqual({
      mode: 'leave_out',
      marker: undefined,
    })
    expect(state().singleMarkerChoice).toEqual({ mode: 'leave_out' })
    await expect(
      runAction('intake.setSingleMarkerChoice', { mode: 'chosen', marker: '  ldh  ' }),
    ).resolves.toEqual({ mode: 'chosen', marker: 'ldh' })
    expect(state().singleMarkerChoice).toEqual({ mode: 'chosen', marker: 'ldh' })
  })

  it('refuses chosen without a marker, plainly, and changes nothing', async () => {
    seedValidation()
    await expect(runAction('intake.setSingleMarkerChoice', { mode: 'chosen' })).rejects.toThrow(
      MARKER_CHOICE_NO_MARKER,
    )
    expect(state().singleMarkerChoice).toEqual({ mode: 'ranked' })
  })

  it('refuses a marker that is not one of the file main markers, and a companion name', async () => {
    seedValidation()
    await expect(
      runAction('intake.setSingleMarkerChoice', { mode: 'chosen', marker: 'cea' }),
    ).rejects.toThrow('"cea" is not a marker of your file.')
    expect(state().singleMarkerChoice).toEqual({ mode: 'ranked' })
    // A `__detected` companion is exactly a non-main marker.
    seedValidation([...MAIN_MARKERS, { ...MAIN_MARKERS[0], key: 'ldh__detected', display_name: 'LDH detected' }])
    await expect(
      runAction('intake.setSingleMarkerChoice', { mode: 'chosen', marker: 'ldh__detected' }),
    ).rejects.toThrow('"ldh__detected" is not a marker of your file.')
  })

  it('refuses chosen while the file is not checked (no validated inventory)', async () => {
    useTxrIntakeStore.setState({ validation: null })
    await expect(
      runAction('intake.setSingleMarkerChoice', { mode: 'chosen', marker: 'ldh' }),
    ).rejects.toThrow(MARKER_CHOICE_FILE_NOT_READY)
    expect(state().singleMarkerChoice).toEqual({ mode: 'ranked' })
  })
})
