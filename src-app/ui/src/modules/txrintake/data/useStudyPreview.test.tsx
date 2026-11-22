// @vitest-environment jsdom
/**
 * TEST-INT-4 — the screen-B panel hook (`data/useStudyPreview.ts`, ITEM-5):
 * the 200 ms debounce (one eligibility call for a burst of answer changes,
 * with the `{preview: …}` body), the stale-response guard (an out-of-order
 * response is discarded), the fit/excluded derivation, the error path (no
 * panel data), the empty-answers default request, and `refetch()`.
 *
 * The ApiClient is mocked (the Datasets.store precedent); the request body
 * is asserted byte-for-byte through the REAL `buildStudyPreviewRequest`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { EligibilityResponse, FilterOptions, MarkerGroup } from '@/api-client/types'
import { useStudyPreview, STUDY_PREVIEW_DEBOUNCE_MS } from './useStudyPreview'
import { buildStudyPreviewRequest } from '../lib/preview'
import { __resetFetchCacheForTests } from './fetchCache'
import { useTxrIntakeStore } from '../stores/TxrIntake.store'
import type { StudyAnswers } from '../types'

const api = vi.hoisted(() => ({ eligibility: vi.fn(), filterOptions: vi.fn() }))
vi.mock('@/api-client', () => ({
  ApiClient: {
    MethodCatalogue: {
      eligibility: api.eligibility,
      filterOptions: api.filterOptions,
    },
  },
}))

const GROUPS: MarkerGroup[] = [
  { id: 'ctdna', display_name: 'Tumour DNA in blood (ctDNA)' },
  { id: 'counts', display_name: 'Blood counts (platelets, haemoglobin)' },
  { id: 'ldh', display_name: 'LDH' },
]

const EMPTY_ANSWERS: StudyAnswers = {
  disease: null,
  treatments: null,
  outcome: null,
  markerGroups: null,
  beforeTreatment: null,
  drawsDuringTreatment: null,
  lastDrawDay: null,
}

const ANSWERED: StudyAnswers = {
  disease: 'colorectal cancer',
  treatments: null,
  outcome: 'progression-by-day',
  markerGroups: { ctdna: true, counts: true },
  beforeTreatment: 'always',
  drawsDuringTreatment: 2,
  lastDrawDay: 56,
}

/** The filter-options vocabulary the answers were picked from (5a3: the
 *  request body's disease/treatment facts are valid only against it). */
const VOCABULARY: FilterOptions = {
  disease_categories: [
    {
      id: 'Solid tumours',
      diseases: [
        { id: 'colorectal cancer', children: [] },
        { id: 'lung cancer', children: [] },
      ],
    },
  ],
  treatment_classes: [
    { id: 'chemotherapy', label: 'Chemotherapy' },
    { id: 'immune checkpoint inhibitor', label: 'Immune checkpoint inhibitor' },
  ],
}

function response(overrides: Partial<EligibilityResponse> = {}): EligibilityResponse {
  return {
    methods: [
      {
        id: 'm-a',
        status: 'can_run',
        reasons: [],
        coverage: { eligible: 1, total: 1, fraction: 1 },
        min_draws: { required: 1, met: 1, unmet_patients: 0 },
        missing_markers: [],
        missing_groups: [],
        estimated_seconds: 0,
        estimate_quality: 'estimate',
      },
      {
        id: 'm-b',
        status: 'cannot_run',
        reasons: [{ code: 'MIN_DRAWS_UNMET' }],
        coverage: { eligible: 0, total: 1, fraction: 0 },
        min_draws: { required: 4, met: 0, unmet_patients: 0 },
        missing_markers: [],
        missing_groups: [],
        estimated_seconds: 0,
        estimate_quality: 'estimate',
      },
    ],
    total_fit: 1,
    total_some: 0,
    total_cannot: 1,
    total_no_env: 0,
    ...overrides,
  }
}

beforeEach(() => {
  api.eligibility.mockReset()
  api.eligibility.mockResolvedValue(response())
  api.filterOptions.mockReset()
  api.filterOptions.mockResolvedValue(VOCABULARY)
  __resetFetchCacheForTests()
  window.localStorage.clear()
  useTxrIntakeStore.getState().reset()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function settle() {
  // First let the filter-options vocabulary land (5a3: the request body is a
  // function of it) — its state flush schedules the debounce timer with the
  // loaded key, so a vocabulary-less request is never fired on the clean path.
  await act(async () => {
    await Promise.resolve()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(STUDY_PREVIEW_DEBOUNCE_MS)
  })
  await act(async () => {
    await Promise.resolve()
  })
}

describe('useStudyPreview (TEST-INT-4, ITEM-5)', () => {
  it('debounces a burst of answer changes into ONE eligibility call with the preview body', async () => {
    const initialProps = { answers: EMPTY_ANSWERS, groups: GROUPS }
    const { rerender } = renderHook(
      ({ answers, groups }) => useStudyPreview(answers, groups),
      { initialProps },
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    rerender({ answers: { ...EMPTY_ANSWERS, disease: 'lung' }, groups: GROUPS })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    rerender({ answers: ANSWERED, groups: GROUPS })
    await settle()

    expect(api.eligibility).toHaveBeenCalledTimes(1)
    expect(api.eligibility).toHaveBeenCalledWith({
      preview: buildStudyPreviewRequest(ANSWERED, GROUPS, VOCABULARY),
    })
  })

  it('derives fit and excluded from the response', async () => {
    const { result } = renderHook(() => useStudyPreview(ANSWERED, GROUPS))
    expect(result.current.loading).toBe(true)
    await settle()
    expect(result.current.fit).toEqual({ total: 2, fit: 1, some: 0, leftOut: 1, noEnvFit: 0 })
    expect(result.current.excluded).toEqual([
      { id: 'm-b', reasonText: 'needs 4 or more draws', reasonCode: 'MIN_DRAWS_UNMET' },
    ])
    expect(result.current.methods.get('m-b')?.status).toBe('cannot_run')
    expect(result.current.error).toBeNull()
  })

  it('discards a stale response (an older request resolving after a newer one)', async () => {
    let resolveFirst!: (value: EligibilityResponse) => void
    api.eligibility
      .mockImplementationOnce(
        () => new Promise<EligibilityResponse>(resolve => (resolveFirst = resolve)),
      )
      .mockResolvedValueOnce(response())

    const initialProps = { answers: { ...EMPTY_ANSWERS, disease: 'lung' } as StudyAnswers, groups: GROUPS }
    const { rerender, result } = renderHook(
      ({ answers, groups }) => useStudyPreview(answers, groups),
      { initialProps },
    )

    // First request (old answers) resolves LATE.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STUDY_PREVIEW_DEBOUNCE_MS)
    })
    rerender({ answers: ANSWERED, groups: GROUPS })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STUDY_PREVIEW_DEBOUNCE_MS)
    })
    await act(async () => {
      resolveFirst(response({ total_fit: 9, total_cannot: 9 }))
      await Promise.resolve()
    })
    expect(result.current.fit?.fit).not.toBe(9)

    // The NEWEST response lands and wins (its own derivation: one answer
    // cause out of the two methods — the totals overrides above are not the
    // panel's source, the per-method reasons are; the stale one is dropped).
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.fit?.fit).toBe(1)
    expect(result.current.fit?.leftOut).toBe(1)
  })

  it('surfaces an API error with no panel data', async () => {
    api.eligibility.mockRejectedValueOnce(new Error('catalogue down'))
    const { result } = renderHook(() => useStudyPreview(ANSWERED, GROUPS))
    await settle()
    expect(result.current.error).toBe('catalogue down')
    expect(result.current.fit).toBeNull()
    expect(result.current.excluded).toEqual([])
    expect(result.current.loading).toBe(false)
  })

  it('fires NOTHING before the first answer, then only the answered parts (R2-1 + R3-intake-2)', async () => {
    // (c): the old page reported "N of M methods fit" from an all-false /
    // default-schedule body the user never composed; now the empty-answers
    // state issues no request at all — and the first answer carries NO
    // schedule defaults (an unanswered draw question is absent = "any",
    // never an assumed 1).
    const { result, rerender } = renderHook(
      ({ answers }) => useStudyPreview(answers, GROUPS),
      { initialProps: { answers: EMPTY_ANSWERS } },
    )
    await settle()
    expect(api.eligibility).not.toHaveBeenCalled()
    expect(result.current.fit).toBeNull()

    // The first answer flips the gate; the unanswered schedule fields stay
    // ABSENT (R3-intake-2), the answered disease rides as the filter fact,
    // and the panel is answering a REAL question now.
    rerender({ answers: { ...EMPTY_ANSWERS, disease: 'lung cancer' } })
    await settle()
    expect(api.eligibility).toHaveBeenCalledTimes(1)
    expect(api.eligibility).toHaveBeenCalledWith({
      preview: {
        disease_group: 'lung cancer',
        marker_groups: { ctdna: false, counts: false, ldh: false },
      },
    })
    expect(result.current.fit).not.toBeNull()
  })

  it('fires nothing until the marker groups are known', async () => {
    const { result } = renderHook(() => useStudyPreview(EMPTY_ANSWERS, null))
    await settle()
    expect(api.eligibility).not.toHaveBeenCalled()
    expect(result.current.fit).toBeNull()
  })

  it('refetch() re-issues the request even for a cache-hit key', async () => {
    const { result } = renderHook(() => useStudyPreview(ANSWERED, GROUPS))
    await settle()
    expect(api.eligibility).toHaveBeenCalledTimes(1)
    act(() => {
      result.current.refetch()
    })
    await settle()
    expect(api.eligibility).toHaveBeenCalledTimes(2)
  })

  it('a persisted id the vocabulary does not know is never sent (5a3 — the server 422 guard)', async () => {
    const stale: StudyAnswers = {
      ...ANSWERED,
      disease: 'dead-cancer',
      treatments: ['chemotherapy', 'obsolete-drug'],
    }
    renderHook(() => useStudyPreview(stale, GROUPS))
    await settle()
    expect(api.eligibility).toHaveBeenCalledTimes(1)
    const body = api.eligibility.mock.calls[0][0].preview as Record<string, unknown>
    expect(body.disease_group).toBeUndefined()
    // The known treatment class rides; the unknown one is dropped.
    expect(body.treatment_classes).toEqual(['chemotherapy'])
    expect(body.method_group).toBe('static-risk')
  })

  it('before the vocabulary loads the disease/treatment facts are omitted; once it lands the request is re-issued (5a3)', async () => {
    let resolveVocab!: (value: FilterOptions) => void
    api.filterOptions.mockImplementationOnce(
      () => new Promise<FilterOptions>(resolve => (resolveVocab = resolve)),
    )
    renderHook(() => useStudyPreview(ANSWERED, GROUPS))
    // The debounce fires while the vocabulary is still in flight: the body
    // omits the disease/treatment facts (never a stale id), outcome rides.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STUDY_PREVIEW_DEBOUNCE_MS)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.eligibility).toHaveBeenCalledTimes(1)
    const first = api.eligibility.mock.calls[0][0].preview as Record<string, unknown>
    expect(first.disease_group).toBeUndefined()
    expect(first.treatment_classes).toBeUndefined()
    expect(first.method_group).toBe('static-risk')
    // The vocabulary lands: the answer facts are now valid and the request
    // is re-issued with them.
    await act(async () => {
      resolveVocab(VOCABULARY)
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STUDY_PREVIEW_DEBOUNCE_MS)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.eligibility).toHaveBeenCalledTimes(2)
    const second = api.eligibility.mock.calls[1][0].preview as Record<string, unknown>
    expect(second.disease_group).toBe('colorectal cancer')
    expect(second.method_group).toBe('static-risk')
  })
})
